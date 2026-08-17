use std::collections::HashSet;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter};

use super::TrackRepository;

impl TrackRepository<'_> {
    /// Next generation stamp for a full-resync orphan sweep. Empty scope is
    /// server-wide; a non-empty scope is isolated to that library.
    pub fn next_resync_gen(&self, server_id: &str, library_scope: &str) -> Result<i64, String> {
        self.store.with_conn("track.next_resync_gen", |c| {
            if library_scope.is_empty() {
                c.query_row(
                    "SELECT COALESCE(MAX(resync_gen), 0) + 1 FROM track WHERE server_id = ?1",
                    params![server_id],
                    |r| r.get(0),
                )
            } else {
                c.query_row(
                    "SELECT COALESCE(MAX(resync_gen), 0) + 1 FROM track \
                     WHERE server_id = ?1 AND library_id = ?2",
                    params![server_id, library_scope],
                    |r| r.get(0),
                )
            }
        })
    }

    /// Retire confirmed-gone physical albums in one transaction.
    ///
    /// The census may confirm up to 100 albums in one run. Applying each one
    /// through `apply_tombstone_results` would take the writer 100 times and
    /// rebuild album/composer projections 100 times. This keeps the same
    /// invalidation path but batches the rows and projection refresh.
    pub(crate) fn tombstone_albums(
        &self,
        server_id: &str,
        album_ids: &[String],
    ) -> Result<(usize, usize), String> {
        if album_ids.is_empty() {
            return Ok((0, 0));
        }
        let placeholders = (2..album_ids.len() + 2)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let mut binds = Vec::with_capacity(album_ids.len() + 1);
        binds.push(Value::Text(server_id.to_string()));
        binds.extend(album_ids.iter().cloned().map(Value::Text));

        self.store.with_conn_mut("track.tombstone_albums", |conn| {
            let tx = conn.transaction()?;
            let track_sql = format!(
                "SELECT id, album_id, COALESCE(library_id, '') FROM track INDEXED BY idx_track_album \
                 WHERE server_id = ?1 AND album_id IN ({placeholders}) AND deleted = 0"
            );
            let live_rows: Vec<(String, String, String)> = tx
                .prepare(&track_sql)?
                .query_map(params_from_iter(binds.iter()), |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let retired_albums: HashSet<String> = live_rows
                .iter()
                .map(|(_, album_id, _)| album_id.clone())
                .collect();
            let track_ids: Vec<String> = live_rows
                .iter()
                .map(|(track_id, _, _)| track_id.clone())
                .collect();
            let mut affected: HashSet<crate::browse_projection::AlbumScope> = live_rows
                .iter()
                .map(|(_, album_id, library_id)| {
                    (
                        server_id.to_string(),
                        library_id.clone(),
                        album_id.clone(),
                    )
                })
                .collect();

            let projection_sql = format!(
                "SELECT DISTINCT library_id, album_id FROM album_browse_projection \
                 WHERE server_id = ?1 AND album_id IN ({placeholders})"
            );
            let projection_rows: Vec<(String, String)> = tx
                .prepare(&projection_sql)?
                .query_map(params_from_iter(binds.iter()), |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let projected_albums: HashSet<String> = projection_rows
                .iter()
                .map(|(_, album_id)| album_id.clone())
                .collect();
            affected.extend(
                projection_rows
                    .into_iter()
                    .map(|(library_id, album_id)| {
                        (server_id.to_string(), library_id, album_id)
                    }),
            );

            if !track_ids.is_empty() {
                let now = now_unix_ms();
                let delete_genres_sql = format!(
                    "DELETE FROM track_genre WHERE server_id = ?1 AND track_id IN ( \
                       SELECT id FROM track INDEXED BY idx_track_album \
                       WHERE server_id = ?1 AND album_id IN ({placeholders}) AND deleted = 0 \
                     )"
                );
                tx.execute(&delete_genres_sql, params_from_iter(binds.iter()))?;
                let tombstone_sql = format!(
                    "UPDATE track SET deleted = 1, synced_at = ?{} \
                     WHERE server_id = ?1 AND album_id IN ({placeholders}) AND deleted = 0",
                    album_ids.len() + 2
                );
                let mut update_binds = binds.clone();
                update_binds.push(Value::Integer(now));
                tx.execute(&tombstone_sql, params_from_iter(update_binds.iter()))?;
                crate::identity::record_tracks(
                    &tx,
                    track_ids
                        .iter()
                        .map(|track_id| (server_id, track_id.as_str())),
                )?;
            }
            crate::identity::record_album_scopes(&tx, &affected)?;
            crate::browse_projection::refresh_album_scopes(&tx, affected)?;
            tx.commit()?;

            let stale = projected_albums.difference(&retired_albums).count();
            Ok((retired_albums.len(), stale))
        })
    }

    /// How many live rows the running resync has re-stamped so far. IS-7 uses
    /// this as its completeness signal: the sweep deletes exactly the live rows
    /// this count does *not* cover, so a short ingest is a mass deletion.
    pub fn count_resync_generation(
        &self,
        server_id: &str,
        library_scope: &str,
        resync_gen: i64,
    ) -> Result<i64, String> {
        // Read connection: IS-6 runs this after every ingest batch has been
        // committed, so a reader sees the whole run — and the writer, which on a
        // large resync has just spent minutes under load, is left alone.
        self.store.with_read_conn(|c| {
            if library_scope.is_empty() {
                c.query_row(
                    "SELECT COUNT(*) FROM track \
                     WHERE server_id = ?1 AND deleted = 0 AND COALESCE(resync_gen, 0) = ?2",
                    params![server_id, resync_gen],
                    |row| row.get(0),
                )
            } else {
                c.query_row(
                    "SELECT COUNT(*) FROM track \
                     WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                       AND COALESCE(resync_gen, 0) = ?3",
                    params![server_id, library_scope, resync_gen],
                    |row| row.get(0),
                )
            }
        })
    }

    /// IS-7 — soft-delete live rows not re-stamped during the active resync.
    pub fn sweep_resync_orphans(
        &self,
        server_id: &str,
        library_scope: &str,
        resync_gen: i64,
    ) -> Result<u32, String> {
        let now = now_unix_ms();
        let changed = self
            .store
            .with_conn_mut("track.sweep_resync_orphans", |c| {
                let tx = c.transaction()?;
                let changed = if library_scope.is_empty() {
                    tx.execute(
                        "DELETE FROM track_genre \
                     WHERE server_id = ?1 AND track_id IN ( \
                       SELECT id FROM track \
                       WHERE server_id = ?1 AND deleted = 0 \
                         AND COALESCE(resync_gen, 0) != ?2 \
                     )",
                        params![server_id, resync_gen],
                    )?;
                    tx.execute(
                        "UPDATE track SET deleted = 1, synced_at = ?3 \
                     WHERE server_id = ?1 AND deleted = 0 \
                       AND COALESCE(resync_gen, 0) != ?2",
                        params![server_id, resync_gen, now],
                    )?
                } else {
                    tx.execute(
                        "DELETE FROM track_genre \
                     WHERE server_id = ?1 AND track_id IN ( \
                       SELECT id FROM track \
                       WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                         AND COALESCE(resync_gen, 0) != ?3 \
                     )",
                        params![server_id, library_scope, resync_gen],
                    )?;
                    tx.execute(
                        "UPDATE track SET deleted = 1, synced_at = ?4 \
                     WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
                       AND COALESCE(resync_gen, 0) != ?3",
                        params![server_id, library_scope, resync_gen, now],
                    )?
                };
                if changed > 0 {
                    crate::browse_projection::rebuild_scope(&tx, server_id, library_scope)?;
                    crate::identity::prune_cluster_keys_for_scope(&tx, server_id, library_scope)?;
                    crate::identity::mark_cluster_keys_dirty(&tx, [server_id])?;
                }
                tx.commit()?;
                Ok(changed)
            })?;
        Ok(changed as u32)
    }

    /// Apply one tombstone probe batch atomically, then refresh derived state
    /// once for the whole batch instead of rebuilding per track.
    pub fn apply_tombstone_results(
        &self,
        server_id: &str,
        library_scope: &str,
        alive_ids: &[String],
        deleted_ids: &[String],
    ) -> Result<(), String> {
        if alive_ids.is_empty() && deleted_ids.is_empty() {
            return Ok(());
        }
        let now = now_unix_ms();
        self.store
            .with_conn_mut("track.apply_tombstone_results", |conn| {
                let tx = conn.transaction()?;
                let affected = crate::browse_projection::collect_album_scopes_for_track_ids(
                    &tx,
                    server_id,
                    deleted_ids,
                )?;
                let alive_sql = if library_scope.is_empty() {
                    "UPDATE track SET synced_at = ?3 \
                 WHERE server_id = ?1 AND id = ?2 AND deleted = 0"
                } else {
                    "UPDATE track SET synced_at = ?3 \
                 WHERE server_id = ?1 AND id = ?2 AND library_id = ?4 AND deleted = 0"
                };
                let deleted_sql = if library_scope.is_empty() {
                    "UPDATE track SET deleted = 1, synced_at = ?3 \
                 WHERE server_id = ?1 AND id = ?2 AND deleted = 0"
                } else {
                    "UPDATE track SET deleted = 1, synced_at = ?3 \
                 WHERE server_id = ?1 AND id = ?2 AND library_id = ?4 AND deleted = 0"
                };
                for track_id in alive_ids {
                    if library_scope.is_empty() {
                        tx.execute(alive_sql, params![server_id, track_id, now])?;
                    } else {
                        tx.execute(alive_sql, params![server_id, track_id, now, library_scope])?;
                    }
                }
                for track_id in deleted_ids {
                    if library_scope.is_empty() {
                        tx.execute(deleted_sql, params![server_id, track_id, now])?;
                    } else {
                        tx.execute(
                            deleted_sql,
                            params![server_id, track_id, now, library_scope],
                        )?;
                    }
                    tx.execute(
                        "DELETE FROM track_genre WHERE server_id = ?1 AND track_id = ?2",
                        params![server_id, track_id],
                    )?;
                }
                crate::identity::record_tracks(
                    &tx,
                    deleted_ids
                        .iter()
                        .map(|track_id| (server_id, track_id.as_str())),
                )?;
                crate::identity::record_album_scopes(&tx, &affected)?;
                crate::browse_projection::refresh_album_scopes(&tx, affected)?;
                tx.commit()
            })
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

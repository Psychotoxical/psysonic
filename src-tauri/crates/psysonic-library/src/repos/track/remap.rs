use rusqlite::{params, OptionalExtension};

use super::ingest::{sync_persisted_track_genre_rows, UPSERT_SQL};
use super::{RemapEntry, RemapStats, TrackRepository, TrackRow};

impl TrackRepository<'_> {
    /// Batch upsert with optional §6.9 id-remap detection. When
    /// `unstable_track_ids` is `true`, each incoming row is checked
    /// against the existing `track` table for a collision via
    /// `content_hash` or `server_path` carrying a different id. On
    /// collision, child tables (`track_offline` and the FK-bound
    /// extension / fact / artifact / canonical_link tables) are
    /// retargeted onto the new id, a `track_id_history` row is
    /// recorded, and the old `track` row is deleted — all inside the
    /// same SQLite transaction so partial remaps can't leak.
    pub fn upsert_batch_with_remap(
        &self,
        rows: &[TrackRow],
        unstable_track_ids: bool,
    ) -> Result<RemapStats, String> {
        if rows.is_empty() {
            return Ok(RemapStats::default());
        }
        self.store
            .with_conn_mut("track.upsert_batch_remap", |conn| {
                let tx = conn.transaction()?;
                let mut affected_album_scopes =
                    crate::browse_projection::collect_affected_album_scopes(&tx, rows)?;
                let mut remapped: Vec<RemapEntry> = Vec::new();
                let mut upsert = tx.prepare_cached(UPSERT_SQL)?;
                let mut remap_lookup = if unstable_track_ids {
                    Some((
                        tx.prepare_cached(REMAP_LOOKUP_BY_HASH_SQL)?,
                        tx.prepare_cached(REMAP_LOOKUP_BY_PATH_SQL)?,
                    ))
                } else {
                    None
                };

                for r in rows {
                    // Spec §6.9: detect collision BEFORE the upsert so the
                    // old id is known. The upsert itself comes next; only
                    // then do we retarget children to the new id, since
                    // child tables FK→track(server_id, id) and would refuse
                    // an UPDATE pointing at an id that doesn't exist yet.
                    let detected_old: Option<String> =
                        if let Some((ref mut by_hash, ref mut by_path)) = remap_lookup {
                            detect_remap_target_cached(by_hash, by_path, r)?
                        } else {
                            None
                        };

                    upsert.execute(params![
                        r.server_id,
                        r.id,
                        r.title,
                        r.title_sort,
                        r.artist,
                        r.artist_id,
                        r.album,
                        r.album_id,
                        r.album_artist,
                        r.duration_sec,
                        r.track_number,
                        r.disc_number,
                        r.year,
                        r.genre,
                        r.suffix,
                        r.bit_rate,
                        r.size_bytes,
                        r.cover_art_id,
                        r.starred_at,
                        r.user_rating,
                        r.play_count,
                        r.played_at,
                        r.server_path,
                        r.library_id,
                        r.isrc,
                        r.mbid_recording,
                        r.bpm,
                        r.replay_gain_track_db,
                        r.replay_gain_album_db,
                        r.replay_gain_peak,
                        r.content_hash,
                        r.server_updated_at,
                        r.server_created_at,
                        if r.deleted { 1_i64 } else { 0 },
                        r.synced_at,
                        r.raw_json,
                        0_i64,
                    ])?;

                    if let Some(old_id) = detected_old {
                        affected_album_scopes.extend(
                            crate::browse_projection::collect_album_scopes_for_track_ids(
                                &tx,
                                &r.server_id,
                                std::slice::from_ref(&old_id),
                            )?,
                        );
                        remap_existing_to_new(
                            &tx,
                            &r.server_id,
                            &old_id,
                            &r.id,
                            r.content_hash.as_deref(),
                            r.server_path.as_deref(),
                            r.synced_at,
                        )?;
                        remapped.push(RemapEntry {
                            server_id: r.server_id.clone(),
                            old_id,
                            new_id: r.id.clone(),
                        });
                    }

                    // H2 (§5.5A): link this track to its canonical id by its
                    // strong key (ISRC, else MBID recording). Inline + O(1);
                    // a no-op for tracks that carry neither.
                    crate::canonical::link_track(
                        &tx,
                        &r.server_id,
                        &r.id,
                        r.isrc.as_deref(),
                        r.mbid_recording.as_deref(),
                        r.synced_at,
                    )?;
                }

                drop(upsert);
                drop(remap_lookup);
                sync_persisted_track_genre_rows(&tx, rows)?;
                crate::identity::record_tracks(
                    &tx,
                    rows.iter()
                        .filter(|row| {
                            row.deleted
                                || row
                                    .album_id
                                    .as_deref()
                                    .is_none_or(|album_id| album_id.trim().is_empty())
                        })
                        .map(|row| (row.server_id.as_str(), row.id.as_str())),
                )?;
                crate::identity::record_tracks(
                    &tx,
                    remapped
                        .iter()
                        .map(|entry| (entry.server_id.as_str(), entry.old_id.as_str())),
                )?;
                crate::identity::record_album_scopes(&tx, &affected_album_scopes)?;
                crate::browse_projection::refresh_album_scopes(&tx, affected_album_scopes)?;

                tx.commit()?;
                Ok(RemapStats { remapped })
            })
    }
}

// Two single-column lookups instead of one `OR` across `content_hash`
// and `server_path`. The combined `OR` form could not use the partial
// `idx_track_remap_hash` / `idx_track_remap_path` indexes — SQLite only
// applies a partial index when the query's WHERE provably implies the
// index predicate (`… != ''`), and an `OR` spanning two columns blocks
// the per-branch index plan. The result was a full `track` scan per
// incoming row → O(rows × catalog) on large libraries (observed:
// `upsert_batch_remap exec_ms=162001` on a ~200k-track Navidrome sync).
// Each statement below repeats the index predicate so the planner picks
// the matching partial index (SEARCH, not SCAN); hash wins over path,
// matching §6.9's strong-key priority.
pub(super) const REMAP_LOOKUP_BY_HASH_SQL: &str = r#"
SELECT id FROM track
 WHERE server_id = ?1
   AND deleted = 0
   AND content_hash IS NOT NULL
   AND content_hash != ''
   AND content_hash = ?2
   AND id != ?3
 LIMIT 1
"#;

pub(super) const REMAP_LOOKUP_BY_PATH_SQL: &str = r#"
SELECT id FROM track
 WHERE server_id = ?1
   AND deleted = 0
   AND server_path IS NOT NULL
   AND server_path != ''
   AND server_path = ?2
   AND id != ?3
 LIMIT 1
"#;

/// Run the `SELECT old.id` half of §6.9 — returns `Some(old_id)` if a
/// non-deleted row with a different id on this server matches the
/// incoming row's `content_hash` or `server_path`. Hash is the stronger
/// key, so it is checked first.
fn detect_remap_target_cached(
    by_hash: &mut rusqlite::Statement<'_>,
    by_path: &mut rusqlite::Statement<'_>,
    incoming: &TrackRow,
) -> rusqlite::Result<Option<String>> {
    // Empty-string sentinels are *not* eligible — spec §6.9 explicitly
    // excludes them so the file-tree default never collides.
    let hash = incoming.content_hash.as_deref().filter(|s| !s.is_empty());
    let path = incoming.server_path.as_deref().filter(|s| !s.is_empty());

    if let Some(hash) = hash {
        let old = by_hash
            .query_row(params![incoming.server_id, hash, incoming.id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        if old.is_some() {
            return Ok(old);
        }
    }

    if let Some(path) = path {
        let old = by_path
            .query_row(params![incoming.server_id, path, incoming.id], |row| {
                row.get::<_, String>(0)
            })
            .optional()?;
        if old.is_some() {
            return Ok(old);
        }
    }

    Ok(None)
}

/// Run the §6.9 retarget half — UPDATE every FK-bound child to the
/// new id, INSERT into `track_id_history`, DELETE the old `track` row.
/// `track_offline` has no FK to `track` (spec §5.14) but still needs
/// its row retargeted so the cached file resolves under the new id.
fn remap_existing_to_new(
    tx: &rusqlite::Transaction<'_>,
    server_id: &str,
    old_id: &str,
    new_id: &str,
    content_hash: Option<&str>,
    server_path: Option<&str>,
    remapped_at: i64,
) -> rusqlite::Result<()> {
    for table in [
        "track_offline",
        "track_extension",
        "track_fact",
        "track_artifact",
        "track_canonical_link",
        "play_session",
    ] {
        tx.execute(
            &format!(
                "UPDATE {table} SET track_id = ?1 \
                 WHERE server_id = ?2 AND track_id = ?3"
            ),
            params![new_id, server_id, old_id],
        )?;
    }
    tx.execute(
        "INSERT INTO track_id_history \
         (server_id, old_id, new_id, content_hash, server_path, remapped_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(server_id, old_id) DO UPDATE SET \
           new_id = excluded.new_id, \
           content_hash = excluded.content_hash, \
           server_path = excluded.server_path, \
           remapped_at = excluded.remapped_at",
        params![
            server_id,
            old_id,
            new_id,
            content_hash,
            server_path,
            remapped_at
        ],
    )?;
    tx.execute(
        "DELETE FROM track WHERE server_id = ?1 AND id = ?2",
        params![server_id, old_id],
    )?;
    Ok(())
}

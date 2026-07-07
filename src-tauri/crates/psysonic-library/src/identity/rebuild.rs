//! Batch rebuild of `cluster.track_cluster_key` from live `track` rows.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::store::LibraryStore;

use super::attach::CLUSTER_SCHEMA;
use super::keys::build_track_cluster_keys;
use super::norm::NORM_VERSION;

const UPSERT_CLUSTER_KEY_SQL: &str = "
INSERT INTO cluster.track_cluster_key (
  server_id, library_id, track_id, cluster_key, album_key, artist_key, duration_sec
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(server_id, track_id) DO UPDATE SET
  library_id   = excluded.library_id,
  cluster_key  = excluded.cluster_key,
  album_key    = excluded.album_key,
  artist_key   = excluded.artist_key,
  duration_sec = excluded.duration_sec
";

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `true` when `cluster_meta.norm_version` is missing or differs from [`NORM_VERSION`].
pub fn cluster_rebuild_needed(conn: &Connection) -> rusqlite::Result<bool> {
    let stored: Option<String> = conn
        .query_row(
            &format!(
                "SELECT value FROM {CLUSTER_SCHEMA}.cluster_meta WHERE key = 'norm_version'"
            ),
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(stored.as_deref() != Some(NORM_VERSION))
}

fn set_cluster_meta(conn: &Connection) -> rusqlite::Result<()> {
    let now = now_unix().to_string();
    conn.execute(
        &format!(
            "INSERT INTO {CLUSTER_SCHEMA}.cluster_meta(key, value) VALUES ('norm_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ),
        params![NORM_VERSION],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO {CLUSTER_SCHEMA}.cluster_meta(key, value) VALUES ('build_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ),
        params![now],
    )?;
    Ok(())
}

type SourceTrackRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    String,
    i64,
);

/// Rebuild identity keys for one server or all servers. Returns rows upserted.
pub fn rebuild_cluster_keys(
    store: &LibraryStore,
    server_id: Option<&str>,
) -> Result<u64, String> {
    store.with_conn_mut("identity.rebuild_cluster_keys", |conn| {
        let tx = conn.transaction()?;
        let mut select = String::from(
            "SELECT server_id, COALESCE(library_id, ''), id, artist, title, album_artist, album, duration_sec \
             FROM track WHERE deleted = 0",
        );
        if server_id.is_some() {
            select.push_str(" AND server_id = ?1");
        }
        // Stream rows straight from the `track` SELECT into the sidecar UPSERT
        // (both statements borrow the same tx; the SELECT reads `track`, the
        // UPSERT writes the attached `cluster` table, so they don't contend).
        // Avoids materializing the whole track table (~60–70 MB on 212k rows)
        // before writing.
        let filter_params: Vec<&str> = server_id.into_iter().collect();
        let mut stmt = tx.prepare(&select)?;
        let mut upsert = tx.prepare_cached(UPSERT_CLUSTER_KEY_SQL)?;
        let mut upserted = 0u64;
        let mut rows = stmt.query(rusqlite::params_from_iter(filter_params.iter()))?;
        while let Some(row) = rows.next()? {
            let (server_id, library_id, track_id, artist, title, album_artist, album, duration_sec) =
                map_source_track_row(row)?;
            let keys = build_track_cluster_keys(
                artist.as_deref(),
                &title,
                &album,
                album_artist.as_deref(),
            );
            upsert.execute(params![
                server_id,
                library_id,
                track_id,
                keys.cluster_key,
                keys.album_key,
                keys.artist_key,
                duration_sec,
            ])?;
            upserted = upserted.saturating_add(1);
        }
        drop(rows);
        drop(stmt);
        drop(upsert);
        // Prune keys whose track no longer exists (soft-deleted via tombstone, or
        // dropped when a server mints a fresh id on rename). The UPSERT above only
        // refreshes live rows; without this, orphaned keys accumulate forever and
        // are only reclaimed when the whole sidecar is dropped (swap/restore/import).
        // Reads join `cluster.track_cluster_key` against `track WHERE deleted = 0`,
        // so these rows are inert — this is bloat cleanup, scoped to the rebuilt
        // server(s) so a single-server rebuild never touches other servers' keys.
        if let Some(sid) = server_id {
            tx.execute(
                "DELETE FROM cluster.track_cluster_key \
                 WHERE server_id = ?1 \
                   AND track_id NOT IN (\
                     SELECT id FROM track WHERE deleted = 0 AND server_id = ?1\
                   )",
                params![sid],
            )?;
        } else {
            tx.execute(
                "DELETE FROM cluster.track_cluster_key \
                 WHERE (server_id, track_id) NOT IN (\
                   SELECT server_id, id FROM track WHERE deleted = 0\
                 )",
                [],
            )?;
        }
        set_cluster_meta(&tx)?;
        tx.commit()?;
        Ok(upserted)
    })
}

/// Build cluster keys before a multi-library read. Rebuilds when either:
/// - the stored `norm_version` differs from [`NORM_VERSION`] (normalization rules
///   changed) — then **all** servers are rebuilt, because [`rebuild_cluster_keys`]
///   stamps a single global `norm_version`; a per-server rebuild would flip the
///   gate and strand every other server's stale keys; or
/// - this server has tracks but no keys yet (fresh index / newly synced server).
pub fn ensure_cluster_keys_built(store: &LibraryStore, server_id: &str) -> Result<(), String> {
    let rebuild_all = store
        .with_read_conn(cluster_rebuild_needed)
        .map_err(|e| e.to_string())?;
    if rebuild_all {
        rebuild_cluster_keys(store, None)?;
        return Ok(());
    }
    let needs_rebuild = store
        .with_read_conn(|conn| {
            let track_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                [server_id],
                |r| r.get(0),
            )?;
            if track_count == 0 {
                return Ok(false);
            }
            let key_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM cluster.track_cluster_key WHERE server_id = ?1",
                [server_id],
                |r| r.get(0),
            )?;
            Ok(key_count == 0)
        })
        .map_err(|e| e.to_string())?;
    if needs_rebuild {
        rebuild_cluster_keys(store, Some(server_id))?;
    }
    Ok(())
}

fn map_source_track_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceTrackRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

/// Test helper: read one row from the attached `cluster` schema on any connection.
#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(crate) fn read_cluster_row(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<Option<(Option<String>, Option<String>, Option<String>, i64)>> {
    conn.query_row(
        "SELECT cluster_key, album_key, artist_key, duration_sec \
         FROM cluster.track_cluster_key WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, track_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::norm::{norm_part, NORM_VERSION};
    use crate::repos::track::{TrackRepository, TrackRow};
    use crate::store::LibraryStore;

    #[allow(clippy::too_many_arguments)]
    fn track_row(
        server: &str,
        id: &str,
        title: &str,
        artist: Option<&str>,
        album: &str,
        album_artist: Option<&str>,
        duration: i64,
        library_id: &str,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: artist.map(str::to_string),
            artist_id: None,
            album: album.into(),
            album_id: None,
            album_artist: album_artist.map(str::to_string),
            duration_sec: duration,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: Some(library_id.into()),
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    #[test]
    fn rebuild_populates_keys_and_duration() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row(
                    "s1",
                    "t1",
                    "Café Song",
                    Some("Björk"),
                    "Homogenic",
                    Some("Björk"),
                    312,
                    "lib-a",
                ),
                track_row("s1", "t2", "No Artist", None, "Al", None, 100, "lib-a"),
            ])
            .unwrap();

        let n = rebuild_cluster_keys(&store, Some("s1")).unwrap();
        assert_eq!(n, 2);

        let row = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();
        let (cluster_key, album_key, artist_key, duration) = row;
        assert_eq!(duration, 312);
        assert_eq!(artist_key.as_deref(), norm_part("Björk").as_deref());
        assert!(cluster_key.is_some());
        assert!(album_key.is_some());

        let empty_artist = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t2"))
            .unwrap()
            .unwrap();
        assert!(empty_artist.0.is_none());
        assert!(empty_artist.2.is_none());
    }

    #[test]
    fn rebuild_is_idempotent() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track_row(
                "s1",
                "t1",
                "Title",
                Some("Artist"),
                "Album",
                None,
                200,
                "lib",
            )])
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();
        let first = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();
        let second = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn rebuild_prunes_orphaned_cluster_keys() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T1", Some("A"), "Al", None, 100, "lib"),
                track_row("s1", "t2", "T2", Some("B"), "Al", None, 120, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();
        assert!(store
            .with_read_conn(|c| read_cluster_row(c, "s1", "t2"))
            .unwrap()
            .is_some());

        // Soft-delete t2 (tombstone) → its stale cluster key must be pruned on
        // the next rebuild, not linger forever.
        store
            .with_conn_mut("test.soft_delete", |c| {
                c.execute(
                    "UPDATE track SET deleted = 1 WHERE server_id = 's1' AND id = 't2'",
                    [],
                )
            })
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
                .unwrap()
                .is_some(),
            "live track key must remain"
        );
        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t2"))
                .unwrap()
                .is_none(),
            "orphaned cluster key must be pruned"
        );
    }

    #[test]
    fn global_rebuild_prunes_orphans_across_servers() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T1", Some("A"), "Al", None, 100, "lib"),
                track_row("s2", "t2", "T2", Some("B"), "Al", None, 120, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();
        assert!(store
            .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
            .unwrap()
            .is_some());
        assert!(store
            .with_read_conn(|c| read_cluster_row(c, "s2", "t2"))
            .unwrap()
            .is_some());

        // Both tracks go to tombstone; a global (server_id = None) rebuild must
        // prune the orphan on every server via the tuple-scoped DELETE branch.
        store
            .with_conn_mut("test.del", |c| {
                c.execute("UPDATE track SET deleted = 1 WHERE id IN ('t1', 't2')", [])
            })
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
                .unwrap()
                .is_none(),
            "global rebuild must prune s1 orphan"
        );
        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s2", "t2"))
                .unwrap()
                .is_none(),
            "global rebuild must prune s2 orphan"
        );
    }

    #[test]
    fn per_server_rebuild_leaves_other_server_keys() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T1", Some("A"), "Al", None, 100, "lib"),
                track_row("s2", "t2", "T2", Some("B"), "Al", None, 120, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        // Both tracks go to tombstone, but we rebuild only s1: s1's orphan is
        // pruned while s2's key is untouched (single global norm stamp, but the
        // prune is scoped to the rebuilt server).
        store
            .with_conn_mut("test.del", |c| {
                c.execute("UPDATE track SET deleted = 1 WHERE id IN ('t1', 't2')", [])
            })
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
                .unwrap()
                .is_none(),
            "rebuilt server's orphan must be pruned"
        );
        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s2", "t2"))
                .unwrap()
                .is_some(),
            "single-server rebuild must not prune another server's keys"
        );
    }

    #[test]
    fn norm_version_gate_and_bump() {
        let store = LibraryStore::open_in_memory();
        assert!(
            store
                .with_conn("misc", cluster_rebuild_needed)
                .unwrap(),
            "fresh attach should need rebuild"
        );

        TrackRepository::new(&store)
            .upsert_batch(&[track_row(
                "s1",
                "t1",
                "T",
                Some("A"),
                "Al",
                None,
                1,
                "lib",
            )])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        assert!(
            !store
                .with_conn("misc", cluster_rebuild_needed)
                .unwrap()
        );

        store
            .with_conn_mut("test.stale_norm", |conn| {
                conn.execute(
                    "UPDATE cluster.cluster_meta SET value = '0' WHERE key = 'norm_version'",
                    [],
                )
            })
            .unwrap();
        assert!(
            store
                .with_conn("misc", cluster_rebuild_needed)
                .unwrap()
        );

        rebuild_cluster_keys(&store, None).unwrap();
        let version: String = store
            .with_conn("misc", |conn| {
                conn.query_row(
                    "SELECT value FROM cluster.cluster_meta WHERE key = 'norm_version'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(version, NORM_VERSION);
    }

    #[test]
    fn ensure_cluster_keys_built_rebuilds_on_norm_version_mismatch() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T", Some("A"), "Al", None, 1, "lib"),
                track_row("s2", "t2", "T2", Some("A2"), "Al2", None, 2, "lib"),
            ])
            .unwrap();
        // Build once (stamps the current NORM_VERSION), then simulate keys left
        // over from an older normalization by rewinding the stored version.
        rebuild_cluster_keys(&store, None).unwrap();
        store
            .with_conn_mut("test.stale_norm", |conn| {
                conn.execute(
                    "UPDATE cluster.cluster_meta SET value = 'stale' WHERE key = 'norm_version'",
                    [],
                )
            })
            .unwrap();
        assert!(store.with_conn("misc", cluster_rebuild_needed).unwrap());

        // The read path must notice the mismatch and rebuild even though keys exist.
        ensure_cluster_keys_built(&store, "s1").unwrap();

        assert!(
            !store.with_conn("misc", cluster_rebuild_needed).unwrap(),
            "version mismatch must be reconciled by the read path"
        );
        // All servers rebuilt, not just the one requested (single global stamp).
        let s2_keys: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key WHERE server_id = 's2'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(s2_keys, 1);
    }

    #[test]
    fn cluster_attach_visible_on_read_connection() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track_row(
                "s1",
                "t1",
                "T",
                Some("A"),
                "Al",
                None,
                42,
                "lib",
            )])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        let count: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}

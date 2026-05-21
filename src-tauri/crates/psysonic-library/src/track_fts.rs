//! FTS5 maintenance for bulk initial-sync ingest.
//!
//! Per-row FTS triggers dominate N1/S1 write time at scale. IS-3 suspends
//! them, loads tracks without FTS maintenance, then rebuilds from the
//! external-content table once before restoring triggers.

use rusqlite::Connection;

const RESTORE_TRACK_FTS_TRIGGERS: &str = r#"
CREATE TRIGGER IF NOT EXISTS track_ai AFTER INSERT ON track BEGIN
  INSERT INTO track_fts(rowid, title, artist, album, album_artist, genre)
  VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist, new.genre);
END;

CREATE TRIGGER IF NOT EXISTS track_ad AFTER DELETE ON track BEGIN
  INSERT INTO track_fts(track_fts, rowid, title, artist, album, album_artist, genre)
  VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist, old.genre);
END;

CREATE TRIGGER IF NOT EXISTS track_au AFTER UPDATE ON track BEGIN
  INSERT INTO track_fts(track_fts, rowid, title, artist, album, album_artist, genre)
  VALUES ('delete', old.rowid, old.title, old.artist, old.album, old.album_artist, old.genre);
  INSERT INTO track_fts(rowid, title, artist, album, album_artist, genre)
  VALUES (new.rowid, new.title, new.artist, new.album, new.album_artist, new.genre);
END;
"#;

/// Drop FTS sync triggers so bulk upserts skip per-row FTS maintenance.
pub fn suspend_track_fts_triggers(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS track_ai;
         DROP TRIGGER IF EXISTS track_ad;
         DROP TRIGGER IF EXISTS track_au;",
    )
}

/// Rebuild `track_fts` from the `track` content table (fts5 external content).
pub fn rebuild_track_fts_from_content(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO track_fts(track_fts) VALUES('rebuild')", [])?;
    Ok(())
}

/// Restore FTS sync triggers after bulk ingest + rebuild.
pub fn restore_track_fts_triggers(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(RESTORE_TRACK_FTS_TRIGGERS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;

    #[test]
    fn restore_track_fts_triggers_recreates_migration_triggers() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("misc", |conn| {
                suspend_track_fts_triggers(conn)?;
                restore_track_fts_triggers(conn)?;
                let mut stmt = conn.prepare(
                    "SELECT name FROM sqlite_master \
                     WHERE type = 'trigger' AND name IN ('track_ai', 'track_ad', 'track_au') \
                     ORDER BY name",
                )?;
                let names: Vec<String> = stmt
                    .query_map([], |r| r.get(0))?
                    .filter_map(Result::ok)
                    .collect();
                assert_eq!(names, vec!["track_ad", "track_ai", "track_au"]);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn bulk_ingest_suspend_rebuild_restores_fts_search() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("misc", |conn| suspend_track_fts_triggers(conn))
            .unwrap();
        store
            .with_conn_mut("misc", |conn| {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                     VALUES ('s1', 't1', 'Bulk Title', 'Album', 1, 0, 1, '{}')",
                    [],
                )
            })
            .unwrap();
        let mid: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'Bulk'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(mid, 0, "FTS must not update while triggers are suspended");

        store
            .with_conn_mut("misc", |conn| {
                rebuild_track_fts_from_content(conn)?;
                restore_track_fts_triggers(conn)
            })
            .unwrap();

        let after: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'Bulk'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(after, 1);
    }
}

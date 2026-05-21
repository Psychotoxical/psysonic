//! IS-3 bulk ingest tuning — drop hot-path indexes, restore at end.
//!
//! Secondary `track` indexes (album/artist/remap/…) are useless during the
//! initial upsert-only pass but cost several index inserts per row. Dropping
//! them for IS-3 keeps batch writes flat into the tens-of-ms range on large
//! libraries; they are recreated once before FTS rebuild.

use rusqlite::Connection;

const DROP_TRACK_SECONDARY_INDEXES: &str = r#"
DROP INDEX IF EXISTS idx_track_album;
DROP INDEX IF EXISTS idx_track_artist;
DROP INDEX IF EXISTS idx_track_updated;
DROP INDEX IF EXISTS idx_track_starred;
DROP INDEX IF EXISTS idx_track_library;
DROP INDEX IF EXISTS idx_track_bpm;
DROP INDEX IF EXISTS idx_track_isrc;
DROP INDEX IF EXISTS idx_track_remap_path;
DROP INDEX IF EXISTS idx_track_remap_hash;
DROP INDEX IF EXISTS idx_track_title;
"#;

const RESTORE_TRACK_SECONDARY_INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_track_album   ON track(server_id, album_id)               WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_track_artist  ON track(server_id, artist_id)              WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_track_updated ON track(server_id, server_updated_at DESC) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_track_starred ON track(server_id, starred_at)             WHERE deleted = 0 AND starred_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_track_library ON track(server_id, library_id)             WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_track_bpm     ON track(server_id, bpm)                    WHERE deleted = 0 AND bpm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_track_isrc    ON track(isrc)                              WHERE deleted = 0 AND isrc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_track_remap_path
  ON track(server_id, server_path)
  WHERE deleted = 0 AND server_path IS NOT NULL AND server_path != '';
CREATE INDEX IF NOT EXISTS idx_track_remap_hash
  ON track(server_id, content_hash)
  WHERE deleted = 0 AND content_hash IS NOT NULL AND content_hash != '';
CREATE INDEX IF NOT EXISTS idx_track_title
  ON track(server_id, title COLLATE NOCASE)
  WHERE deleted = 0;
"#;

/// Drop secondary indexes on `track` so bulk upserts only touch the PK.
pub fn suspend_track_secondary_indexes(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(DROP_TRACK_SECONDARY_INDEXES)
}

/// Recreate secondary indexes after bulk ingest (may take tens of seconds on
/// very large libraries — runs once at the end of IS-3, not per batch).
pub fn restore_track_secondary_indexes(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(RESTORE_TRACK_SECONDARY_INDEXES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;

    #[test]
    fn suspend_and_restore_track_indexes_roundtrip() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("misc", |conn| {
                suspend_track_secondary_indexes(conn)?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, album_id, artist_id, \
                     duration_sec, deleted, synced_at, raw_json) \
                     VALUES ('s1', 't1', 'T', 'Al', 'al1', 'ar1', 1, 0, 1, '{}')",
                    [],
                )?;
                restore_track_secondary_indexes(conn)
            })
            .unwrap();
        let n: i64 = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = 's1' AND album_id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(n, 1);
    }
}

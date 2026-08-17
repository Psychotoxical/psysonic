use super::super::LibraryStore;
use super::TestDatabase;

#[test]
fn open_in_memory_creates_all_expected_tables() {
    let store = LibraryStore::open_in_memory();
    let tables = store
        .with_conn("misc", |c| {
            let mut stmt =
                c.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")?;
            let rows: rusqlite::Result<Vec<String>> =
                stmt.query_map([], |r| r.get::<_, String>(0))?.collect();
            rows
        })
        .unwrap();

    for expected in [
        "album",
        "artist",
        "canonical_enrichment_link",
        "canonical_identity",
        "canonical_track",
        "schema_migrations",
        "sync_state",
        "track",
        "track_artifact",
        "track_canonical_link",
        "track_extension",
        "track_fact",
        "track_id_history",
        "track_offline",
        "play_session",
    ] {
        assert!(
            tables.iter().any(|t| t == expected),
            "missing table `{expected}` — got {tables:?}"
        );
    }
}

#[test]
fn fts_virtual_table_exists() {
    let store = LibraryStore::open_in_memory();
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='track_fts'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn reopen_repairs_bulk_indexes_and_missing_fts_triggers() {
    let db = TestDatabase::new("bulk-schema-repair");
    {
        let store = LibraryStore::open_path_for_test(&db.path).expect("initial open");
        store
            .with_conn_mut("test.break_bulk_schema", |conn| {
                crate::track_fts::suspend_track_fts_triggers(conn)?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, \
                     deleted, synced_at, raw_json) \
                     VALUES ('s1', 't1', 'Reopen Repair', 'Album', 1, 0, 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, \
                     deleted, synced_at, raw_json) \
                     VALUES ('s1', 't2', 'Count Repair', 'Album', 1, 0, 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, sync_phase, \
                     initial_sync_cursor_json, local_track_count) \
                     VALUES ('s1', '', 'ready', \
                     '{\"phase\":\"ingest\",\"ingested_count\":1}', 1) \
                     ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                       sync_phase = 'ready', \
                       initial_sync_cursor_json = excluded.initial_sync_cursor_json, \
                       local_track_count = excluded.local_track_count",
                    [],
                )?;
                conn.execute("DROP INDEX idx_track_album", [])?;
                Ok(())
            })
            .unwrap();
    }

    let reopened = LibraryStore::open_path_for_test(&db.path).expect("repairing reopen");
    let (album_index_count, trigger_count, fts_matches, cursor, local_count): (
        i64,
        i64,
        i64,
        String,
        i64,
    ) = reopened
        .with_conn("test.verify_bulk_schema_repair", |conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type = 'index' AND name = 'idx_track_album'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type = 'trigger' AND name IN ('track_ai', 'track_ad', 'track_au')",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM track_fts WHERE track_fts MATCH 'Reopen'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT initial_sync_cursor_json FROM sync_state \
                     WHERE server_id = 's1' AND library_scope = ''",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT local_track_count FROM sync_state \
                     WHERE server_id = 's1' AND library_scope = ''",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(album_index_count, 1);
    assert_eq!(trigger_count, 3);
    assert_eq!(fts_matches, 1, "open repair rebuilds missed FTS rows");
    assert_eq!(cursor, "{}", "ready rows cannot retain ingest cursors");
    assert_eq!(
        local_count, 2,
        "repair refreshes the persisted count snapshot"
    );
    reopened
        .verify_operational_schema()
        .expect("reopened database satisfies backup-import health checks");
}

#[test]
fn operational_schema_verification_rejects_suspended_objects() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.suspend_operational_schema", |conn| {
            crate::bulk_ingest::suspend_track_secondary_indexes(conn)?;
            crate::track_fts::suspend_track_fts_triggers(conn)
        })
        .unwrap();

    let err = store.verify_operational_schema().unwrap_err();
    assert!(
        err.contains("operational indexes") || err.contains("operational triggers"),
        "unexpected verification error: {err}"
    );
}

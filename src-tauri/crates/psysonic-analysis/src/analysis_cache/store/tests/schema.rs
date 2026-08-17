use super::*;

#[test]
fn open_in_memory_creates_all_tables() {
    let cache = AnalysisCache::open_in_memory();
    let conn = cache.conn.lock().unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(
        tables,
        vec![
            "analysis_track",
            "loudness_cache",
            "schema_migrations",
            "waveform_cache"
        ]
    );
    drop(conn);
    cache.verify_operational_schema().unwrap();
}

#[test]
fn operational_schema_rejects_current_head_with_missing_table() {
    let cache = AnalysisCache::open_in_memory();
    {
        let conn = cache.conn.lock().unwrap();
        let head: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(head, ANALYSIS_DB_SCHEMA_VERSION);
        conn.execute_batch("DROP TABLE waveform_cache").unwrap();
    }

    let error = cache.verify_operational_schema().unwrap_err();
    assert!(error.contains("table waveform_cache"));
}

#[test]
fn operational_schema_rejects_current_head_with_v1_table_shapes() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(MIGRATION_001_BASELINE).unwrap();
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
         INSERT INTO schema_migrations(version, applied_at) VALUES (1, 0), (2, 0);",
    )
    .unwrap();

    let error = verify_operational_schema_conn(&conn).unwrap_err();
    for table in ["analysis_track", "waveform_cache", "loudness_cache"] {
        assert!(
            error.contains(&format!("column {table}.server_id")),
            "missing v2 column was not reported for {table}: {error}"
        );
        assert!(
            error.contains(&format!("primary key {table}")),
            "v1 primary key was not rejected for {table}: {error}"
        );
    }
}

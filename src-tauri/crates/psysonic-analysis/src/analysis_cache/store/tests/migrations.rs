use super::*;

#[test]
fn run_migrations_records_all_versions_and_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    run_migrations_with(&mut conn, MIGRATIONS).unwrap();
    // Second run is a no-op (every version already recorded).
    run_migrations_with(&mut conn, MIGRATIONS).unwrap();
    let versions: Vec<i64> = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(
        versions,
        (1..=ANALYSIS_DB_SCHEMA_VERSION).collect::<Vec<_>>()
    );
}

#[test]
fn backup_snapshots_pre_v2_db_and_overwrites_stale() {
    let dir = unique_temp_dir("bkp-create");
    let db_path = dir.join("audio-analysis.sqlite");
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(MIGRATION_001_BASELINE).unwrap();
        conn.execute(
            "INSERT INTO analysis_track (track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at)
             VALUES ('t','m','ready',?1,?2,1)",
            params![WAVEFORM_ALGO_VERSION, LOUDNESS_ALGO_VERSION],
        )
        .unwrap();
    }

    backup_before_pending_migration(&db_path).unwrap();

    let backup = backup_file(&dir);
    assert!(backup.exists(), "backup snapshot must be written");
    // The snapshot is a valid DB carrying the original row.
    let bconn = Connection::open(&backup).unwrap();
    let rows: i64 = bconn
        .query_row("SELECT COUNT(*) FROM analysis_track", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
    drop(bconn);

    // A second call overwrites the stale snapshot (VACUUM INTO needs a free
    // target) instead of failing.
    backup_before_pending_migration(&db_path).unwrap();
    assert!(backup.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn backup_skips_when_db_absent() {
    let dir = unique_temp_dir("bkp-absent");
    let db_path = dir.join("audio-analysis.sqlite");
    backup_before_pending_migration(&db_path).unwrap();
    assert!(
        !backup_file(&dir).exists(),
        "no backup for a fresh (absent) DB"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn backup_skips_when_already_at_head() {
    let dir = unique_temp_dir("bkp-head");
    let db_path = dir.join("audio-analysis.sqlite");
    {
        let mut conn = Connection::open(&db_path).unwrap();
        run_migrations_with(&mut conn, MIGRATIONS).unwrap();
    }
    backup_before_pending_migration(&db_path).unwrap();
    assert!(
        !backup_file(&dir).exists(),
        "no backup when the DB is already at the target version"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn run_migrations_with_applies_unsorted_versions_once() {
    let mut conn = Connection::open_in_memory().unwrap();
    let migrations = [
        (3, "CREATE TABLE IF NOT EXISTS m3 (id INTEGER PRIMARY KEY);"),
        (1, "CREATE TABLE IF NOT EXISTS m1 (id INTEGER PRIMARY KEY);"),
        (2, "CREATE TABLE IF NOT EXISTS m2 (id INTEGER PRIMARY KEY);"),
    ];
    run_migrations_with(&mut conn, &migrations).unwrap();
    run_migrations_with(&mut conn, &migrations).unwrap();

    let versions: Vec<i64> = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(versions, vec![1, 2, 3]);
}

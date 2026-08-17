use super::*;

#[test]
fn inspect_reports_skipped_unknown_rows() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch("CREATE TABLE track (server_id TEXT NOT NULL);")
        .expect("create table");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["legacy-a"])
        .expect("insert known legacy");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["removed-x"])
        .expect("insert unknown");

    let known_legacy_ids = vec!["legacy-a".to_string()];
    let known_index_keys = vec!["idx-a".to_string()];
    let unknown = count_unknown_rows(
        &conn,
        TEST_TRACK_TABLE,
        &known_legacy_ids,
        &known_index_keys,
    )
    .expect("unknown count");
    assert_eq!(unknown, 1);
}

#[test]
fn run_reports_skipped_unknown_rows_without_failure() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch("CREATE TABLE analysis_track (server_id TEXT NOT NULL);")
        .expect("create table");
    conn.execute(
        "INSERT INTO analysis_track(server_id) VALUES (?1)",
        ["legacy-a"],
    )
    .expect("insert known legacy");
    conn.execute(
        "INSERT INTO analysis_track(server_id) VALUES (?1)",
        ["removed-x"],
    )
    .expect("insert unknown");

    let known_legacy_ids = vec!["legacy-a".to_string()];
    let known_index_keys = vec!["idx-a".to_string()];
    let skipped = sum_unknown_rows(
        &conn,
        &[ANALYSIS_TABLES[0]],
        &known_legacy_ids,
        &known_index_keys,
    )
    .expect("sum unknown rows");
    assert_eq!(skipped, 1);
}

#[test]
fn needs_migration_false_when_only_unknown_rows_present() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch("CREATE TABLE track (server_id TEXT NOT NULL);")
        .expect("create table");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["removed-x"])
        .expect("insert unknown");

    let known_legacy_ids = vec!["legacy-a".to_string()];
    let known_index_keys = vec!["idx-a".to_string()];
    let legacy = count_rows_in(&conn, TEST_TRACK_TABLE, &known_legacy_ids).expect("legacy count");
    let unknown = count_unknown_rows(
        &conn,
        TEST_TRACK_TABLE,
        &known_legacy_ids,
        &known_index_keys,
    )
    .expect("unknown count");
    assert_eq!(legacy, 0);
    assert_eq!(unknown, 1);
}

#[test]
fn purge_unknown_rows_removes_only_removed_servers() {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch("CREATE TABLE track (server_id TEXT NOT NULL);")
        .expect("create table");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["legacy-a"])
        .expect("insert legacy");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["idx-a"])
        .expect("insert index key");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", [""])
        .expect("insert empty bucket");
    conn.execute("INSERT INTO track(server_id) VALUES (?1)", ["removed-x"])
        .expect("insert removed server");

    let known_legacy_ids = vec!["legacy-a".to_string()];
    let known_index_keys = vec!["idx-a".to_string()];
    purge_unknown_rows(
        &conn,
        TEST_TRACK_TABLE,
        &known_legacy_ids,
        &known_index_keys,
    )
    .expect("purge unknown rows");

    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM track", [], |row| row.get(0))
        .expect("count remaining");
    let removed_left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM track WHERE server_id = 'removed-x'",
            [],
            |row| row.get(0),
        )
        .expect("count removed server rows");
    assert_eq!(remaining, 3);
    assert_eq!(removed_left, 0);
}

use rusqlite::Connection;

use super::super::migrations::{
    run_migrations, run_migrations_with, MigrationOutcome, INITIAL_SQL,
    LIBRARY_DB_MIN_COMPATIBLE_VERSION, LIBRARY_DB_SCHEMA_VERSION, MIGRATIONS,
};
use super::super::LibraryStore;

/// `ALTER TABLE artist ADD COLUMN bio TEXT;` — minimal additive fixture,
/// nullable column with no default. Mirrors the §5.7 additive-first rule.
/// Numbered above the real embedded head so it stacks on a migrated DB.
const FIXTURE_ADD_BIO: &str = "ALTER TABLE artist ADD COLUMN bio TEXT;";
const FIXTURE_ADD_BIO_VERSION: i64 = LIBRARY_DB_SCHEMA_VERSION + 1;

pub(super) fn no_op_hook(_c: &Connection, _from: i64, _to: i64) -> rusqlite::Result<()> {
    Ok(())
}

fn always_fail_hook(_c: &Connection, _from: i64, _to: i64) -> rusqlite::Result<()> {
    panic!("breaking-bump hook must NOT fire in this test");
}

#[test]
fn schema_migrations_records_head_version() {
    let store = LibraryStore::open_in_memory();
    let versions: Vec<i64> = store
        .with_conn("misc", |c| {
            let mut stmt = c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
            let rows: rusqlite::Result<Vec<i64>> = stmt.query_map([], |r| r.get(0))?.collect();
            rows
        })
        .unwrap();
    let expected: Vec<i64> = MIGRATIONS.iter().map(|(version, _)| *version).collect();
    assert_eq!(versions, expected);
}

#[test]
fn run_migrations_is_idempotent_across_reopens() {
    let store = LibraryStore::open_in_memory();
    let outcome = store
        .with_conn("migrate", run_migrations)
        .expect("second migration pass must be a no-op");
    assert_eq!(outcome, MigrationOutcome::Applied);
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(
        count,
        MIGRATIONS.len() as i64,
        "one schema_migrations row per embedded migration, no duplicates"
    );
}

#[test]
fn additive_migration_preserves_existing_data() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO artist (server_id, id, name, synced_at) \
                 VALUES ('s1', 'a1', 'Existing Artist', 1)",
                [],
            )
        })
        .unwrap();

    let outcome = store
        .with_conn("misc", |c| {
            run_migrations_with(
                c,
                &[(1, INITIAL_SQL), (FIXTURE_ADD_BIO_VERSION, FIXTURE_ADD_BIO)],
                LIBRARY_DB_MIN_COMPATIBLE_VERSION,
                always_fail_hook,
            )
        })
        .unwrap();
    assert_eq!(outcome, MigrationOutcome::Applied);

    let (name, bio): (String, Option<String>) = store
        .with_conn("misc", |c| {
            c.query_row("SELECT name, bio FROM artist WHERE id = 'a1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
        })
        .unwrap();
    assert_eq!(name, "Existing Artist");
    assert!(bio.is_none());

    let versions: Vec<i64> = store
        .with_conn("misc", |c| {
            let mut stmt = c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
            let rows: rusqlite::Result<Vec<i64>> = stmt.query_map([], |r| r.get(0))?.collect();
            rows
        })
        .unwrap();
    let mut expected: Vec<i64> = MIGRATIONS.iter().map(|(version, _)| *version).collect();
    expected.push(FIXTURE_ADD_BIO_VERSION);
    assert_eq!(versions, expected);
}

#[test]
fn runner_sorts_unsorted_migration_slice_before_applying() {
    // If a future contributor lists migrations out of order in the
    // source slice, the runner must still apply them ascending.
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    let outcome = run_migrations_with(
        &conn,
        &[(2, FIXTURE_ADD_BIO), (1, INITIAL_SQL)],
        LIBRARY_DB_MIN_COMPATIBLE_VERSION,
        always_fail_hook,
    )
    .unwrap();
    assert_eq!(outcome, MigrationOutcome::Applied);

    let versions: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT version FROM schema_migrations ORDER BY applied_at, version")
            .unwrap();
        let rows: rusqlite::Result<Vec<i64>> = stmt.query_map([], |r| r.get(0)).unwrap().collect();
        rows.unwrap()
    };
    assert_eq!(versions, vec![1, 2]);
}

#[test]
fn breaking_bump_hook_fires_when_db_below_min_compatible() {
    // Simulate a future code release where MIN_COMPATIBLE was bumped past
    // the version the DB currently carries (the real embedded head).
    let store = LibraryStore::open_in_memory();
    let outcome = store
        .with_conn("misc", |c| {
            run_migrations_with(
                c,
                MIGRATIONS,
                LIBRARY_DB_SCHEMA_VERSION + 1, // bumped past current applied
                no_op_hook,
            )
        })
        .unwrap();
    assert_eq!(outcome, MigrationOutcome::BreakingBump);
}

#[test]
fn breaking_bump_hook_does_not_fire_on_fresh_db() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    let outcome = run_migrations_with(
        &conn,
        MIGRATIONS,
        // Even a wildly future min_compatible must not trip on a fresh DB:
        // no rows in schema_migrations means "nothing to migrate from".
        999,
        always_fail_hook,
    )
    .unwrap();
    assert_eq!(outcome, MigrationOutcome::Applied);
}

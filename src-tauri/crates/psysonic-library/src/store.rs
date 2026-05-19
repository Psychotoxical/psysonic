use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use tauri::Manager;

/// Current head of the embedded migrations. Bump each time a new
/// `migrations/NNN_*.sql` is added.
pub const LIBRARY_DB_SCHEMA_VERSION: i64 = 1;

/// Lowest applied schema version the current code can advance from purely
/// additively. If a DB carries a version below this, the breaking-bump hook
/// fires (spec §5.7 / P22): the library is treated as incompatible, must be
/// dropped, and initial sync must restart.
///
/// At v1 launch this equals `LIBRARY_DB_SCHEMA_VERSION` — no real DB can
/// trip the hook. Bump independently of `SCHEMA_VERSION` only when a
/// migration cannot be expressed additively.
pub const LIBRARY_DB_MIN_COMPATIBLE_VERSION: i64 = 1;

pub(crate) const INITIAL_SQL: &str = include_str!("../migrations/001_initial.sql");

/// Embedded migrations. Ordered ascending by `version`; the runner sorts
/// defensively before applying so the source order can stay readable.
const MIGRATIONS: &[(i64, &str)] = &[(1, INITIAL_SQL)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    /// Every missing migration was applied (or the DB was already at head).
    Applied,
    /// The DB carried a schema below `LIBRARY_DB_MIN_COMPATIBLE_VERSION`,
    /// so the breaking-bump hook fired. Callers should treat the library
    /// data as discarded and trigger a fresh initial sync (P22).
    BreakingBump,
}

pub struct LibraryStore {
    conn: Mutex<Connection>,
}

impl LibraryStore {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let db_path = library_db_path(app)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn).map_err(|e| e.to_string())?;
        run_migrations(&conn).map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Build an in-memory DB with the production schema applied.
    /// WAL pragma is skipped — `:memory:` doesn't support journal-mode changes
    /// (mirrors `psysonic_analysis::AnalysisCache::open_in_memory`).
    pub fn open_in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory connection");
        conn.pragma_update(None, "foreign_keys", "ON").expect("pragma foreign_keys");
        run_migrations(&conn).expect("schema migration");
        Self { conn: Mutex::new(conn) }
    }

    /// Borrow the inner connection. Returned guard locks the mutex — keep the
    /// scope tight so other repo calls don't stall.
    pub(crate) fn with_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "library store lock poisoned".to_string())?;
        f(&conn).map_err(|e| e.to_string())
    }

    pub(crate) fn with_conn_mut<R>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "library store lock poisoned".to_string())?;
        f(&mut conn).map_err(|e| e.to_string())
    }
}

fn library_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("library.sqlite"))
}

fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn run_migrations(conn: &Connection) -> rusqlite::Result<MigrationOutcome> {
    run_migrations_with(
        conn,
        MIGRATIONS,
        LIBRARY_DB_MIN_COMPATIBLE_VERSION,
        handle_breaking_schema_bump,
    )
}

/// Test-friendly entry point. Production code goes through `run_migrations`,
/// which fixes `migrations`, `min_compatible`, and `hook` to the prod values.
pub(crate) fn run_migrations_with(
    conn: &Connection,
    migrations: &[(i64, &str)],
    min_compatible: i64,
    hook: fn(&Connection, i64, i64) -> rusqlite::Result<()>,
) -> rusqlite::Result<MigrationOutcome> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version    INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )?;

    // Breaking-bump detection only meaningful for already-initialised DBs.
    let max_applied: Option<i64> = conn.query_row(
        "SELECT MAX(version) FROM schema_migrations",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    if let Some(max_applied) = max_applied {
        if max_applied < min_compatible {
            hook(conn, max_applied, LIBRARY_DB_SCHEMA_VERSION)?;
            return Ok(MigrationOutcome::BreakingBump);
        }
    }

    let mut ordered: Vec<(i64, &str)> = migrations.iter().map(|(v, s)| (*v, *s)).collect();
    ordered.sort_by_key(|(v, _)| *v);
    for (version, sql) in ordered {
        let already: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            params![version],
            |row| row.get(0),
        )?;
        if already > 0 {
            continue;
        }
        conn.execute_batch(sql)?;
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
            params![version],
        )?;
    }
    Ok(MigrationOutcome::Applied)
}

/// P22 breaking-schema-bump hook. PR-1b ships a no-op stub: the function
/// signature, call site, and `MigrationOutcome::BreakingBump` signal are in
/// place, but the actual library-drop + sync-reset logic lands when the
/// first real breaking bump happens. Until then the constants guarantee the
/// hook never fires on production data.
fn handle_breaking_schema_bump(
    _conn: &Connection,
    _max_applied: i64,
    _target_version: i64,
) -> rusqlite::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_creates_all_expected_tables() {
        let store = LibraryStore::open_in_memory();
        let tables = store
            .with_conn(|c| {
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
        ] {
            assert!(
                tables.iter().any(|t| t == expected),
                "missing table `{expected}` — got {tables:?}"
            );
        }
    }

    #[test]
    fn schema_migrations_records_head_version() {
        let store = LibraryStore::open_in_memory();
        let versions: Vec<i64> = store
            .with_conn(|c| {
                let mut stmt =
                    c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
                let rows: rusqlite::Result<Vec<i64>> =
                    stmt.query_map([], |r| r.get(0))?.collect();
                rows
            })
            .unwrap();
        assert_eq!(versions, vec![LIBRARY_DB_SCHEMA_VERSION]);
    }

    #[test]
    fn run_migrations_is_idempotent_across_reopens() {
        let store = LibraryStore::open_in_memory();
        let outcome = store
            .with_conn(run_migrations)
            .expect("second migration pass must be a no-op");
        assert_eq!(outcome, MigrationOutcome::Applied);
        let count: i64 = store
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            })
            .unwrap();
        assert_eq!(count, 1, "no duplicate schema_migrations rows");
    }

    #[test]
    fn fts_virtual_table_exists() {
        let store = LibraryStore::open_in_memory();
        let count: i64 = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='track_fts'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    // ── PR-1b: edge-case tests via the test-only `run_migrations_with` ─────

    /// `ALTER TABLE artist ADD COLUMN bio TEXT;` — minimal additive fixture,
    /// nullable column with no default. Mirrors the §5.7 additive-first rule.
    const FIXTURE_002_ADD_BIO: &str = "ALTER TABLE artist ADD COLUMN bio TEXT;";

    fn no_op_hook(_c: &Connection, _from: i64, _to: i64) -> rusqlite::Result<()> {
        Ok(())
    }

    fn always_fail_hook(_c: &Connection, _from: i64, _to: i64) -> rusqlite::Result<()> {
        panic!("breaking-bump hook must NOT fire in this test");
    }

    #[test]
    fn additive_migration_preserves_existing_data() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) \
                     VALUES ('s1', 'a1', 'Existing Artist', 1)",
                    [],
                )
            })
            .unwrap();

        let outcome = store
            .with_conn(|c| {
                run_migrations_with(
                    c,
                    &[(1, INITIAL_SQL), (2, FIXTURE_002_ADD_BIO)],
                    LIBRARY_DB_MIN_COMPATIBLE_VERSION,
                    always_fail_hook,
                )
            })
            .unwrap();
        assert_eq!(outcome, MigrationOutcome::Applied);

        let (name, bio): (String, Option<String>) = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT name, bio FROM artist WHERE id = 'a1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(name, "Existing Artist");
        assert!(bio.is_none());

        let versions: Vec<i64> = store
            .with_conn(|c| {
                let mut stmt =
                    c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
                let rows: rusqlite::Result<Vec<i64>> =
                    stmt.query_map([], |r| r.get(0))?.collect();
                rows
            })
            .unwrap();
        assert_eq!(versions, vec![1, 2]);
    }

    #[test]
    fn runner_sorts_unsorted_migration_slice_before_applying() {
        // If a future contributor lists migrations out of order in the
        // source slice, the runner must still apply them ascending.
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        let outcome = run_migrations_with(
            &conn,
            &[(2, FIXTURE_002_ADD_BIO), (1, INITIAL_SQL)],
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            always_fail_hook,
        )
        .unwrap();
        assert_eq!(outcome, MigrationOutcome::Applied);

        let versions: Vec<i64> = {
            let mut stmt = conn
                .prepare("SELECT version FROM schema_migrations ORDER BY applied_at, version")
                .unwrap();
            let rows: rusqlite::Result<Vec<i64>> =
                stmt.query_map([], |r| r.get(0)).unwrap().collect();
            rows.unwrap()
        };
        assert_eq!(versions, vec![1, 2]);
    }

    #[test]
    fn breaking_bump_hook_fires_when_db_below_min_compatible() {
        // Simulate a future code release where MIN_COMPATIBLE was bumped to
        // 2 but the DB still carries only version 1.
        let store = LibraryStore::open_in_memory();
        let outcome = store
            .with_conn(|c| {
                run_migrations_with(
                    c,
                    &[(1, INITIAL_SQL), (2, FIXTURE_002_ADD_BIO)],
                    2, // pretend MIN_COMPATIBLE has been bumped past current applied
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
}

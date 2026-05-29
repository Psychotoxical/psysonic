use std::path::{Path, PathBuf};
use std::{fs, io};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags};
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

/// In-memory tests share one DB across the read/write pair in a single store.
static IN_MEMORY_DB_COUNTER: AtomicU64 = AtomicU64::new(0);

fn in_memory_uri() -> String {
    let n = IN_MEMORY_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("file:psysonic_library_mem_{n}?mode=memory&cache=shared")
}

pub struct LibraryStore {
    /// Writes, migrations, and sync ingest (single writer).
    write_conn: Mutex<Connection>,
    /// Read-only handle for search / status / hydrate while sync writes (WAL).
    read_conn: Mutex<Connection>,
    /// IS-3 bulk ingest in progress — read paths skip write-lock work.
    bulk_ingest_active: AtomicBool,
}

impl LibraryStore {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let db_path = library_db_path(app)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        Self::open_file(&db_path)
    }

    fn open_file(db_path: &Path) -> Result<Self, String> {
        let write_conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        configure_write_connection(&write_conn).map_err(|e| e.to_string())?;
        run_migrations(&write_conn).map_err(|e| e.to_string())?;
        checkpoint_wal_conn(&write_conn, "open").map_err(|e| e.to_string())?;
        let read_conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        configure_read_connection(&read_conn).map_err(|e| e.to_string())?;
        Ok(Self {
            write_conn: Mutex::new(write_conn),
            read_conn: Mutex::new(read_conn),
            bulk_ingest_active: AtomicBool::new(false),
        })
    }

    /// Build an in-memory DB with the production schema applied.
    pub fn open_in_memory() -> Self {
        let uri = in_memory_uri();
        let write_conn = Connection::open(&uri).expect("in-memory write connection");
        configure_write_connection(&write_conn).expect("write pragmas");
        run_migrations(&write_conn).expect("schema migration");
        let read_conn = Connection::open(&uri).expect("in-memory read connection");
        configure_read_connection(&read_conn).expect("read pragmas");
        Self {
            write_conn: Mutex::new(write_conn),
            read_conn: Mutex::new(read_conn),
            bulk_ingest_active: AtomicBool::new(false),
        }
    }

    pub(crate) fn set_bulk_ingest_active(&self, active: bool) {
        self.bulk_ingest_active
            .store(active, Ordering::Release);
    }

    pub(crate) fn bulk_ingest_active(&self) -> bool {
        self.bulk_ingest_active.load(Ordering::Acquire)
    }

    /// Writer connection — sync ingest, migrations, mutations.
    pub(crate) fn with_conn<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let lock_start = std::time::Instant::now();
        let conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned".to_string())?;
        let lock_wait_ms = lock_start.elapsed().as_millis();
        let exec_start = std::time::Instant::now();
        let out = f(&conn).map_err(|e| e.to_string());
        let exec_ms = exec_start.elapsed().as_millis();
        log_write_op(op, lock_wait_ms, exec_ms);
        out
    }

    /// Read-only connection — search, status, hydrate; does not block on sync writes.
    pub(crate) fn with_read_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned".to_string())?;
        f(&conn).map_err(|e| e.to_string())
    }

    pub(crate) fn with_conn_mut<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        self.with_conn_mut_timed(op, f).map(|(value, _)| value)
    }

    pub(crate) fn with_conn_mut_timed<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> Result<(R, WriteOpTiming), String> {
        let lock_start = std::time::Instant::now();
        let mut conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned".to_string())?;
        let lock_wait_ms = lock_start.elapsed().as_millis() as u64;
        let exec_start = std::time::Instant::now();
        let out = f(&mut conn).map_err(|e| e.to_string())?;
        let exec_ms = exec_start.elapsed().as_millis() as u64;
        log_write_op(op, lock_wait_ms as u128, exec_ms as u128);
        Ok((out, WriteOpTiming { lock_wait_ms, exec_ms }))
    }

    pub(crate) fn checkpoint_wal(&self, op: &'static str) -> Result<(), String> {
        self.with_conn_mut(op, |conn| {
            checkpoint_wal_conn(conn, op)?;
            Ok(())
        })
    }

    /// Atomically switch the active sqlite file while replacing long-lived
    /// write/read connections under the same locks so no command can keep
    /// writing to the old inode after the swap.
    pub fn swap_database_file(
        &self,
        active_path: &Path,
        destination_path: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if !destination_path.exists() {
            return Ok(None);
        }
        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned".to_string())?;

        let write_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_write = std::mem::replace(&mut *write_conn, write_tmp);
        let old_read = std::mem::replace(&mut *read_conn, read_tmp);
        drop(old_write);
        drop(old_read);

        let backup = active_path.with_file_name(format!(
            "{}.backup-pre-indexkey",
            active_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("library.sqlite")
        ));
        remove_db_with_sidecars(&backup).ok();
        if active_path.exists() {
            fs::rename(active_path, &backup).map_err(|e| e.to_string())?;
            move_sidecar(active_path, &backup, "-wal")?;
            move_sidecar(active_path, &backup, "-shm")?;
        }
        if let Err(err) = fs::rename(destination_path, active_path) {
            if backup.exists() {
                let _ = fs::rename(&backup, active_path);
                let _ = move_sidecar(&backup, active_path, "-wal");
                let _ = move_sidecar(&backup, active_path, "-shm");
            }
            return Err(err.to_string());
        }

        let reopened_write = Connection::open(active_path).map_err(|e| e.to_string())?;
        configure_write_connection(&reopened_write).map_err(|e| e.to_string())?;
        let reopened_read = Connection::open_with_flags(active_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        configure_read_connection(&reopened_read).map_err(|e| e.to_string())?;
        *write_conn = reopened_write;
        *read_conn = reopened_read;
        Ok(Some(backup))
    }

    pub fn restore_database_backup(&self, backup_path: &Path, active_path: &Path) -> Result<(), String> {
        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned".to_string())?;

        let write_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_write = std::mem::replace(&mut *write_conn, write_tmp);
        let old_read = std::mem::replace(&mut *read_conn, read_tmp);
        drop(old_write);
        drop(old_read);

        if active_path.exists() {
            remove_db_with_sidecars(active_path)?;
        }
        if backup_path.exists() {
            fs::rename(backup_path, active_path).map_err(|e| e.to_string())?;
            move_sidecar(backup_path, active_path, "-wal")?;
            move_sidecar(backup_path, active_path, "-shm")?;
        }

        let reopened_write = Connection::open(active_path).map_err(|e| e.to_string())?;
        configure_write_connection(&reopened_write).map_err(|e| e.to_string())?;
        let reopened_read = Connection::open_with_flags(active_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        configure_read_connection(&reopened_read).map_err(|e| e.to_string())?;
        *write_conn = reopened_write;
        *read_conn = reopened_read;
        Ok(())
    }
}

/// Timing split returned to ingest progress (DevTools / terminal).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WriteOpTiming {
    pub lock_wait_ms: u64,
    pub exec_ms: u64,
}

impl WriteOpTiming {
    pub fn total_ms(&self) -> u64 {
        self.lock_wait_ms.saturating_add(self.exec_ms)
    }
}

fn log_write_op(op: &str, lock_wait_ms: u128, exec_ms: u128) {
    if lock_wait_ms >= 1000 || exec_ms >= 1000 {
        crate::app_eprintln!(
            "[library-db] SLOW write op={op} lock_wait_ms={lock_wait_ms} exec_ms={exec_ms}"
        );
    } else if lock_wait_ms >= 50 || exec_ms >= 200 {
        crate::app_eprintln!("[library-db] write op={op} lock_wait_ms={lock_wait_ms} exec_ms={exec_ms}");
    }
}

fn library_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_dir = base.join("databases").join("library");
    let db_path = db_dir.join("library.sqlite");
    let legacy = base.join("library.sqlite");
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if db_path.exists() {
        cleanup_legacy_db_if_present(&legacy, &db_path)?;
        return Ok(db_path);
    }

    if legacy.exists() {
        migrate_db_file(&legacy, &db_path).map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy, &db_path, "-wal").map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy, &db_path, "-shm").map_err(|e| e.to_string())?;
    }
    cleanup_legacy_db_if_present(&legacy, &db_path)?;

    Ok(db_path)
}

fn cleanup_legacy_db_if_present(legacy_path: &Path, active_path: &Path) -> Result<(), String> {
    if legacy_path == active_path {
        return Ok(());
    }
    remove_db_with_sidecars(legacy_path)
}

fn migrate_db_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(from, to)?;
            fs::remove_file(from)?;
            Ok(())
        }
    }
}

fn migrate_db_sidecar(from: &Path, to: &Path, suffix: &str) -> io::Result<()> {
    let from_path = PathBuf::from(format!("{}{}", from.display(), suffix));
    if !from_path.exists() {
        return Ok(());
    }
    let to_path = PathBuf::from(format!("{}{}", to.display(), suffix));
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(&from_path, &to_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(&from_path, &to_path)?;
            fs::remove_file(&from_path)?;
            Ok(())
        }
    }
}

fn move_sidecar(from_base: &Path, to_base: &Path, suffix: &str) -> Result<(), String> {
    let from = PathBuf::from(format!("{}{}", from_base.display(), suffix));
    if !from.exists() {
        return Ok(());
    }
    let to = PathBuf::from(format!("{}{}", to_base.display(), suffix));
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        if sidecar.exists() {
            fs::remove_file(sidecar).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn configure_write_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn configure_read_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Search / browse hot path on large libraries (read-only handle).
    conn.pragma_update(None, "cache_size", -64_000)?;
    Ok(())
}

fn checkpoint_wal_conn(conn: &Connection, op: &str) -> rusqlite::Result<()> {
    let (busy, log, checkpointed): (i32, i32, i32) =
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy != 0 {
        crate::app_eprintln!(
            "[library-db] wal checkpoint busy op={op} busy={busy} log={log} checkpointed={checkpointed}"
        );
    }
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
    fn read_conn_sees_committed_writes_from_write_conn() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO sync_state (server_id, library_scope, sync_phase) \
                     VALUES ('s1', '', 'ready')",
                    [],
                )
            })
            .unwrap();
        let phase: String = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT sync_phase FROM sync_state WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(phase, "ready");
    }

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
    fn schema_migrations_records_head_version() {
        let store = LibraryStore::open_in_memory();
        let versions: Vec<i64> = store
            .with_conn("misc", |c| {
                let mut stmt =
                    c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
                let rows: rusqlite::Result<Vec<i64>> =
                    stmt.query_map([], |r| r.get(0))?.collect();
                rows
            })
            .unwrap();
        // Embedded migrations are numbered 1..=head, all applied on a fresh DB.
        let expected: Vec<i64> = (1..=LIBRARY_DB_SCHEMA_VERSION).collect();
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
            count, LIBRARY_DB_SCHEMA_VERSION,
            "one schema_migrations row per embedded migration, no duplicates"
        );
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

    // ── PR-1b: edge-case tests via the test-only `run_migrations_with` ─────

    /// `ALTER TABLE artist ADD COLUMN bio TEXT;` — minimal additive fixture,
    /// nullable column with no default. Mirrors the §5.7 additive-first rule.
    /// Numbered above the real embedded head so it stacks on a migrated DB.
    const FIXTURE_ADD_BIO: &str = "ALTER TABLE artist ADD COLUMN bio TEXT;";
    const FIXTURE_ADD_BIO_VERSION: i64 = LIBRARY_DB_SCHEMA_VERSION + 1;

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
            .with_conn("misc", |c| {
                let mut stmt =
                    c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
                let rows: rusqlite::Result<Vec<i64>> =
                    stmt.query_map([], |r| r.get(0))?.collect();
                rows
            })
            .unwrap();
        // Real embedded migrations (1..=head) plus the additive fixture.
        let mut expected: Vec<i64> = (1..=LIBRARY_DB_SCHEMA_VERSION).collect();
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
            let rows: rusqlite::Result<Vec<i64>> =
                stmt.query_map([], |r| r.get(0)).unwrap().collect();
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
}

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use tauri::Manager;

/// Schema version applied to a fresh DB / current head of `migrations/`.
/// Bump whenever a new `NNN_*.sql` is added; PR-1b will tighten the
/// breaking-bump handshake (P22).
pub const LIBRARY_DB_SCHEMA_VERSION: i64 = 1;

/// Embedded migrations. Order matters: ascending `version`, applied once each
/// and recorded in `schema_migrations`.
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../migrations/001_initial.sql"))];

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

fn run_migrations(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version    INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )?;
    for (version, sql) in MIGRATIONS {
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

        // FTS5 creates internal shadow tables (_data, _idx, _docsize, _config).
        // We just assert that every base table from §5.1 is present.
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
        // Same connection, second pass must not re-execute the SQL.
        let store = LibraryStore::open_in_memory();
        store
            .with_conn(run_migrations)
            .expect("second migration pass must be a no-op");
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
}

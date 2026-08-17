use std::path::Path;

use rusqlite::{params, Connection};

use super::ANALYSIS_DB_SCHEMA_VERSION;

pub(super) const MIGRATION_001_BASELINE: &str =
    include_str!("../../../migrations/001_baseline.sql");
const MIGRATION_002_SERVER_ID: &str = include_str!("../../../migrations/002_server_id.sql");

/// Embedded migrations, ascending by version. The runner sorts defensively and
/// applies each missing one in its own transaction (schema change + version
/// marker commit together — see [`run_migrations_with`]).
pub(super) const MIGRATIONS: &[(i64, &str)] =
    &[(1, MIGRATION_001_BASELINE), (2, MIGRATION_002_SERVER_ID)];

/// One-shot safety net before the first table-rewriting migration (002
/// `server_id`). Snapshots the existing DB via `VACUUM INTO` — a transactionally
/// consistent copy even with WAL — to `<db>.pre-v<N>.bak`, so a catastrophic
/// failure the migration transaction can't cover (disk full at COMMIT,
/// filesystem corruption, a rebuild bug) still leaves the original recoverable.
/// Skipped for a fresh DB or one already at the target version. The analysis
/// cache is small (~1 KB/track), so the copy is cheap.
pub(super) fn backup_before_pending_migration(db_path: &Path) -> Result<(), String> {
    if !db_path.exists() {
        return Ok(()); // fresh DB — nothing to protect
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    // `schema_migrations` may not exist yet on a pre-versioning DB → treat the
    // missing table as version 0 so the backup runs before 002 rewrites tables.
    let applied: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if applied >= ANALYSIS_DB_SCHEMA_VERSION {
        return Ok(()); // already at head — no rewrite pending
    }
    let backup_path = db_path.with_file_name(format!(
        "audio-analysis.sqlite.pre-v{ANALYSIS_DB_SCHEMA_VERSION}.bak"
    ));
    // `VACUUM INTO` fails if the target exists; drop a stale backup from an
    // interrupted earlier attempt (the snapshot is re-creatable).
    if backup_path.exists() {
        std::fs::remove_file(&backup_path).map_err(|e| e.to_string())?;
    }
    // Documented literal form `VACUUM INTO '<file>'`; the local path is escaped
    // for the SQL string literal (single-quote doubling) so an apostrophe in a
    // user's home dir can't break or inject the statement.
    let escaped = backup_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
        .map_err(|e| format!("analysis pre-migration backup failed: {e}"))?;
    Ok(())
}

pub(super) fn run_migrations(conn: &mut Connection) -> rusqlite::Result<()> {
    run_migrations_with(conn, MIGRATIONS)
}

/// Applies every embedded migration not yet recorded in `schema_migrations`.
/// Each migration runs in its own transaction that commits the schema change
/// *and* its version marker together — a failure or crash rolls the whole
/// migration back, and the next start retries it cleanly. Idempotent across
/// reopens. Forward-only: an unknown future version on the DB is left alone
/// (the analysis cache is a rebuildable derived store, so there is no
/// breaking-bump drop/resync like the library DB).
///
/// Split out (test-friendly) so the migration set can be exercised against an
/// in-memory connection.
pub(crate) fn run_migrations_with(
    conn: &mut Connection,
    migrations: &[(i64, &str)],
) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version    INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )?;

    let mut ordered: Vec<(i64, &str)> = migrations.to_vec();
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
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
            params![version],
        )?;
        tx.commit()?;
    }
    Ok(())
}

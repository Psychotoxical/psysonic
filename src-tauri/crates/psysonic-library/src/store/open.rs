use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{functions::FunctionFlags, Connection, OpenFlags};

use super::filesystem::library_db_path;
use super::migrations::{
    ensure_composer_browse_projection_schema, ensure_entity_user_rating_schema,
    ensure_genre_tags_schema, ensure_mainstage_feed_indexes, ensure_scope_browse_projection_schema,
    run_migrations, LIBRARY_DB_SCHEMA_VERSION,
};
use super::reconciles::{
    maybe_reconcile_artist_name_fold, maybe_reconcile_artist_name_sort,
    maybe_reconcile_duration_sec_backfill, maybe_reconcile_library_id_backfill,
    maybe_reconcile_orphan_browse_rows, maybe_reconcile_replay_gain_peak,
    reconcile_ready_rows_with_ingest_cursors,
};
use super::LibraryStore;

/// In-memory tests share one DB across the read/write pair in a single store.
static IN_MEMORY_DB_COUNTER: AtomicU64 = AtomicU64::new(0);
/// Shared-cache URI for the attached identity DB (mirrors [`in_memory_uri`]).
static IN_MEMORY_CLUSTER_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) fn in_memory_uri() -> String {
    let n = IN_MEMORY_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("file:psysonic_library_mem_{n}?mode=memory&cache=shared")
}

fn in_memory_cluster_uri() -> String {
    let n = IN_MEMORY_CLUSTER_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("file:psysonic_cluster_mem_{n}?mode=memory&cache=shared")
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
        let (write_conn, read_conn, mainstage_read_conn, scope_detail_read_conn) =
            open_database_connections(db_path).map_err(|e| e.to_string())?;
        Ok(Self {
            write_conn: Mutex::new(write_conn),
            read_conn: Mutex::new(read_conn),
            mainstage_read_conn: Mutex::new(mainstage_read_conn),
            scope_detail_read_conn: Mutex::new(scope_detail_read_conn),
            read_op_owner: Mutex::new(None),
            mainstage_read_op_owner: Mutex::new(None),
            bulk_ingest_active: AtomicBool::new(false),
            swap_in_progress: AtomicBool::new(false),
        })
    }

    /// Open a production library DB file (read/write) — for local perf probes in tests.
    #[cfg(test)]
    pub fn open_path_for_test(db_path: &std::path::Path) -> Result<Self, String> {
        Self::open_file(db_path)
    }

    /// Build an in-memory DB with the production schema applied.
    pub fn open_in_memory() -> Self {
        let uri = in_memory_uri();
        let cluster_uri = in_memory_cluster_uri();
        let write_conn = Connection::open(&uri).expect("in-memory write connection");
        configure_write_connection(&write_conn).expect("write pragmas");
        prepare_write_connection_for_open(&write_conn).expect("schema migration");
        crate::identity::attach_cluster_write_memory(&write_conn, &cluster_uri)
            .expect("cluster attach write");
        let read_conn = Connection::open(&uri).expect("in-memory read connection");
        configure_read_connection(&read_conn).expect("read pragmas");
        configure_in_memory_read_connection(&read_conn).expect("in-memory read pragmas");
        // Shared-cache identity DB: write connection created schema first.
        crate::identity::attach_cluster_read_memory(&read_conn, &cluster_uri)
            .expect("cluster attach read");
        let mainstage_read_conn =
            Connection::open(&uri).expect("in-memory mainstage read connection");
        configure_read_connection(&mainstage_read_conn).expect("mainstage read pragmas");
        configure_in_memory_read_connection(&mainstage_read_conn)
            .expect("in-memory mainstage read pragmas");
        crate::identity::attach_cluster_read_memory(&mainstage_read_conn, &cluster_uri)
            .expect("cluster attach mainstage read");
        let scope_detail_read_conn =
            Connection::open(&uri).expect("in-memory scope detail read connection");
        configure_read_connection(&scope_detail_read_conn).expect("scope detail read pragmas");
        configure_in_memory_read_connection(&scope_detail_read_conn)
            .expect("in-memory scope detail read pragmas");
        crate::identity::attach_cluster_read_memory(&scope_detail_read_conn, &cluster_uri)
            .expect("cluster attach scope detail read");
        Self {
            write_conn: Mutex::new(write_conn),
            read_conn: Mutex::new(read_conn),
            mainstage_read_conn: Mutex::new(mainstage_read_conn),
            scope_detail_read_conn: Mutex::new(scope_detail_read_conn),
            read_op_owner: Mutex::new(None),
            mainstage_read_op_owner: Mutex::new(None),
            bulk_ingest_active: AtomicBool::new(false),
            swap_in_progress: AtomicBool::new(false),
        }
    }

    /// Verify the invariants that must hold after the production open pipeline.
    /// Backup import calls this after swap/reopen so migrations and interrupted
    /// bulk-ingest repair remain owned by one path.
    pub fn verify_operational_schema(&self) -> Result<(), String> {
        let (migration_head, missing_indexes, missing_triggers) =
            self.with_conn("store.verify_operational_schema", |conn| {
                let migration_head =
                    conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                        row.get::<_, Option<i64>>(0)
                    })?;
                Ok((
                    migration_head,
                    crate::bulk_ingest::missing_track_secondary_indexes(conn)?,
                    crate::track_fts::missing_track_fts_triggers(conn)?,
                ))
            })?;

        if migration_head != Some(LIBRARY_DB_SCHEMA_VERSION) {
            return Err(format!(
                "library schema migration head mismatch: expected {}, found {}",
                LIBRARY_DB_SCHEMA_VERSION,
                migration_head
                    .map(|version| version.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ));
        }
        if !missing_indexes.is_empty() {
            return Err(format!(
                "library schema missing operational indexes: {}",
                missing_indexes.join(", ")
            ));
        }
        if !missing_triggers.is_empty() {
            return Err(format!(
                "library schema missing operational triggers: {}",
                missing_triggers.join(", ")
            ));
        }
        Ok(())
    }
}

pub(super) fn configure_write_connection(conn: &Connection) -> rusqlite::Result<()> {
    register_sql_functions(conn)?;
    conn.busy_timeout(Duration::from_secs(30))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// Extra read pragma for the in-memory store only (tests).
///
/// A file-backed database runs in WAL, where a reader and the single writer
/// never block each other. The in-memory store cannot use WAL, so it shares one
/// cache across its connections (`cache=shared`) — and shared-cache mode locks
/// at *table* granularity: a read on a table the write connection is holding
/// fails with `SQLITE_LOCKED` ("database table is locked"). That is not a busy
/// condition, so `busy_timeout` never retries it and the read surfaces as a hard
/// error. Reading uncommitted rows drops the reader's table lock and restores
/// the concurrency the production WAL path has. Test-only: it never touches a
/// file-backed connection.
fn configure_in_memory_read_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "read_uncommitted", true)
}

fn configure_read_connection(conn: &Connection) -> rusqlite::Result<()> {
    register_sql_functions(conn)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    // Search / browse hot path on large libraries (read-only handle).
    conn.pragma_update(None, "cache_size", -64_000)?;
    Ok(())
}

/// Unicode lowercase is applied only to the grouped album credit. The persisted
/// `artist.name_fold` remains the indexed join side, avoiding a full artist scan.
fn register_sql_functions(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "psysonic_lower_name",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let name: String = ctx.get(0)?;
            Ok(name.trim().to_lowercase())
        },
    )
}

pub(super) fn checkpoint_wal_conn(conn: &Connection, op: &str) -> rusqlite::Result<()> {
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

/// Open write + read handles after migrations, one-time repairs, WAL checkpoint,
/// and cluster identity DB attach.
pub(super) fn open_database_connections(
    db_path: &Path,
) -> rusqlite::Result<(Connection, Connection, Connection, Connection)> {
    let write_conn = Connection::open(db_path)?;
    configure_write_connection(&write_conn)?;
    prepare_write_connection_for_open(&write_conn)?;

    let read_conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure_read_connection(&read_conn)?;
    let mainstage_read_conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure_read_connection(&mainstage_read_conn)?;
    let scope_detail_read_conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    configure_read_connection(&scope_detail_read_conn)?;

    // The identity sidecar is fully rebuildable; a corrupt/unwritable
    // `library-cluster.db` must never prevent the library itself from opening.
    // `attach_cluster_pair_file` deletes-and-recreates on failure; if even that
    // fails we log and continue — multi-library dedup degrades until a later
    // successful open, but single-library browse/search is unaffected.
    if let Err(e) = crate::identity::attach_cluster_pair_file(&write_conn, &read_conn, db_path) {
        crate::app_eprintln!(
            "[library-db] identity sidecar unavailable, multi-library dedup disabled: {e}"
        );
    }
    if let Err(e) = crate::identity::attach_cluster_read_file(&mainstage_read_conn, db_path) {
        crate::app_eprintln!(
            "[library-db] mainstage identity sidecar unavailable, multi-library dedup disabled: {e}"
        );
    }
    if let Err(e) = crate::identity::attach_cluster_read_file(&scope_detail_read_conn, db_path) {
        crate::app_eprintln!(
            "[library-db] scope detail identity sidecar unavailable, multi-library dedup disabled: {e}"
        );
    }
    Ok((
        write_conn,
        read_conn,
        mainstage_read_conn,
        scope_detail_read_conn,
    ))
}

fn prepare_write_connection_for_open(conn: &Connection) -> rusqlite::Result<()> {
    run_migrations(conn)?;
    maybe_reconcile_artist_name_sort(conn)?;
    maybe_reconcile_artist_name_fold(conn)?;
    maybe_reconcile_replay_gain_peak(conn)?;
    maybe_reconcile_library_id_backfill(conn)?;
    maybe_reconcile_duration_sec_backfill(conn)?;
    maybe_reconcile_orphan_browse_rows(conn)?;
    ensure_genre_tags_schema(conn)?;
    ensure_mainstage_feed_indexes(conn)?;
    ensure_entity_user_rating_schema(conn)?;
    ensure_scope_browse_projection_schema(conn)?;
    ensure_composer_browse_projection_schema(conn)?;
    crate::bulk_ingest::ensure_track_secondary_indexes(conn)?;
    crate::track_fts::ensure_track_fts_triggers(conn)?;
    reconcile_ready_rows_with_ingest_cursors(conn)?;
    checkpoint_wal_conn(conn, "open")?;
    Ok(())
}

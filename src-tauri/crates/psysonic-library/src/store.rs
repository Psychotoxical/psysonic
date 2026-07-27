use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use std::{fs, io};

use rusqlite::{functions::FunctionFlags, params, Connection, OpenFlags, OptionalExtension};
use tauri::Manager;

/// Current head of the embedded migrations. Bump each time a new
/// `migrations/NNN_*.sql` is added.
///
/// Migration checklist (wiring, data backfill, open/swap path):
/// psysonic-workdocs `ai/agent-rules/08-library-db-migrations.md`.
pub const LIBRARY_DB_SCHEMA_VERSION: i64 = 26;

/// One-time data repair after migration 014 (`artist.name_sort`).
pub(crate) const ARTIST_NAME_SORT_RECONCILE_ID: &str = "artist_name_sort_reconcile_v1";
pub(crate) const ARTIST_NAME_FOLD_RECONCILE_ID: &str = "artist_name_fold_reconcile_v1";

/// One-time backfill after migration 015 (`track.replay_gain_peak`).
pub(crate) const REPLAY_GAIN_PEAK_RECONCILE_ID: &str = "replay_gain_peak_reconcile_v1";

/// One-time backfill after migration 016 (`track.library_id` from `raw_json`).
pub(crate) const LIBRARY_ID_BACKFILL_RECONCILE_ID: &str = "library_id_backfill_reconcile_v1";

/// One-time cleanup of `artist` browse rows orphaned by pre-fix syncs
/// (server-side renames left ghosts that opened to "not found"). Ongoing syncs
/// prune these inline; this clears already-accumulated rows at first open.
pub(crate) const ORPHAN_BROWSE_RECONCILE_ID: &str = "orphan_browse_rows_reconcile_v1";

/// One-time repair of Navidrome decimal durations stored as zero before the
/// native mapper began rounding them to whole seconds.
pub(crate) const DURATION_SEC_BACKFILL_RECONCILE_ID: &str = "duration_sec_decimal_backfill_v1";
const DURATION_SEC_BACKFILL_BATCH_SIZE: i64 = 1_000;

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
/// Version 12 is above the removed legacy migrations 002–011 so existing DBs
/// still pick up `track_genre` + `library_data_migration`.
pub(crate) const MIGRATION_012_TRACK_GENRE_LEGACY: &str =
    include_str!("../migrations/012_track_genre_legacy_repair.sql");
/// Version 13: additive `artist_artwork_lookup` table for external artist
/// artwork (fanart.tv) — image-scraper §12. Pure CREATE TABLE IF NOT EXISTS.
pub(crate) const MIGRATION_013_ARTIST_ARTWORK_LOOKUP: &str =
    include_str!("../migrations/013_artist_artwork_lookup.sql");
pub(crate) const MIGRATION_014_ARTIST_NAME_SORT: &str =
    include_str!("../migrations/014_artist_name_sort.sql");
pub(crate) const MIGRATION_015_REPLAY_GAIN_PEAK: &str =
    include_str!("../migrations/015_replay_gain_peak.sql");
pub(crate) const MIGRATION_016_MULTI_LIBRARY_SCOPE: &str =
    include_str!("../migrations/016_multi_library_scope.sql");
pub(crate) const MIGRATION_017_LIBRARY_TAG_STATE: &str =
    include_str!("../migrations/017_library_tag_state.sql");
/// Version 18: additive `idx_artist_synced(server_id, synced_at)` so the orphan
/// prune's freshness lookup is an index seek instead of a per-server scan.
pub(crate) const MIGRATION_018_ARTIST_SYNCED_INDEX: &str =
    include_str!("../migrations/018_artist_synced_index.sql");
/// Version 19: Mainstage feed indexes, owner-scoped rating cache, and a
/// suffix-selective lossless browse index.
pub(crate) const MIGRATION_019_MAINSTAGE_FEED_INDEXES: &str =
    include_str!("../migrations/019_mainstage_feed_indexes.sql");
/// Version 20: materialized per-library album rows for keyset scope browse.
pub(crate) const MIGRATION_020_SCOPE_BROWSE_PROJECTION: &str =
    include_str!("../migrations/020_scope_browse_projection.sql");
/// Version 21: title keyset index for candidate-first scoped track browse.
pub(crate) const MIGRATION_021_SCOPE_BROWSE_TRACKS: &str =
    include_str!("../migrations/021_scope_browse_tracks.sql");
pub(crate) const MIGRATION_022_ARTIST_NAME_FOLD: &str =
    include_str!("../migrations/022_artist_name_fold.sql");
/// Version 23: partial index for the Favorites initial local snapshot.
pub(crate) const MIGRATION_023_STARRED_BROWSE_INDEXES: &str =
    include_str!("../migrations/023_starred_browse_indexes.sql");
/// Version 24: materialized composer credits by library and album.
pub(crate) const MIGRATION_024_COMPOSER_BROWSE_PROJECTION: &str =
    include_str!("../migrations/024_composer_browse_projection.sql");
/// Version 25: durable invalidation journal for incremental identity maintenance.
pub(crate) const MIGRATION_025_IDENTITY_INVALIDATION: &str =
    include_str!("../migrations/025_identity_invalidation.sql");
/// Version 26: resumable cursor for bounded post-sync library tagging.
pub(crate) const MIGRATION_026_LIBRARY_TAG_CURSOR: &str =
    include_str!("../migrations/026_library_tag_cursor.sql");

/// Embedded migrations. Ordered ascending by `version`; the runner sorts
/// defensively before applying so the source order can stay readable.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, INITIAL_SQL),
    (12, MIGRATION_012_TRACK_GENRE_LEGACY),
    (13, MIGRATION_013_ARTIST_ARTWORK_LOOKUP),
    (14, MIGRATION_014_ARTIST_NAME_SORT),
    (15, MIGRATION_015_REPLAY_GAIN_PEAK),
    (16, MIGRATION_016_MULTI_LIBRARY_SCOPE),
    (17, MIGRATION_017_LIBRARY_TAG_STATE),
    (18, MIGRATION_018_ARTIST_SYNCED_INDEX),
    (19, MIGRATION_019_MAINSTAGE_FEED_INDEXES),
    (20, MIGRATION_020_SCOPE_BROWSE_PROJECTION),
    (21, MIGRATION_021_SCOPE_BROWSE_TRACKS),
    (22, MIGRATION_022_ARTIST_NAME_FOLD),
    (23, MIGRATION_023_STARRED_BROWSE_INDEXES),
    (24, MIGRATION_024_COMPOSER_BROWSE_PROJECTION),
    (25, MIGRATION_025_IDENTITY_INVALIDATION),
    (26, MIGRATION_026_LIBRARY_TAG_CURSOR),
];

/// Idempotent repair — also runs after the migration runner on every open so
/// DBs that recorded the wrong version numbers still get the tables.
pub(crate) fn ensure_genre_tags_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_012_TRACK_GENRE_LEGACY)
}

/// Repairs the rare partial-v19 state where the migration marker was recorded
/// but its additive index did not survive. `CREATE INDEX IF NOT EXISTS` leaves
/// healthy databases and all user library data untouched.
pub(crate) fn ensure_mainstage_feed_indexes(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_019_MAINSTAGE_FEED_INDEXES)
}

/// Repairs a partial-v19 state where its additive indexes or ratings cache did
/// not survive despite the migration marker being recorded.
pub(crate) fn ensure_entity_user_rating_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_019_MAINSTAGE_FEED_INDEXES)
}

pub(crate) fn ensure_scope_browse_projection_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_020_SCOPE_BROWSE_PROJECTION)
}

pub(crate) fn ensure_composer_browse_projection_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_024_COMPOSER_BROWSE_PROJECTION)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationOutcome {
    /// Every missing migration was applied (or the DB was already at head).
    Applied,
    /// The DB carried a schema below `LIBRARY_DB_MIN_COMPATIBLE_VERSION`,
    /// so the breaking-bump hook fired. Callers should treat the library
    /// data as discarded and trigger a fresh initial sync (P22).
    BreakingBump,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReadOpTiming {
    pub lock_wait_ms: u64,
    pub exec_ms: u64,
    pub blocked_by: Option<ReadOpOwner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReadOpOwner {
    pub file: &'static str,
    pub line: u32,
}

struct ReadOpOwnerGuard<'a> {
    owner: &'a Mutex<Option<ReadOpOwner>>,
}

impl Drop for ReadOpOwnerGuard<'_> {
    fn drop(&mut self) {
        match self.owner.lock() {
            Ok(mut current) => *current = None,
            Err(poisoned) => *poisoned.into_inner() = None,
        }
    }
}

/// In-memory tests share one DB across the read/write pair in a single store.
static IN_MEMORY_DB_COUNTER: AtomicU64 = AtomicU64::new(0);
/// Shared-cache URI for the attached identity DB (mirrors [`in_memory_uri`]).
static IN_MEMORY_CLUSTER_COUNTER: AtomicU64 = AtomicU64::new(0);

fn in_memory_uri() -> String {
    let n = IN_MEMORY_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("file:psysonic_library_mem_{n}?mode=memory&cache=shared")
}

fn in_memory_cluster_uri() -> String {
    let n = IN_MEMORY_CLUSTER_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("file:psysonic_cluster_mem_{n}?mode=memory&cache=shared")
}

pub struct LibraryStore {
    /// Writes, migrations, and sync ingest (single writer).
    write_conn: Mutex<Connection>,
    /// Read-only handle for search / status / hydrate while sync writes (WAL).
    read_conn: Mutex<Connection>,
    /// Dedicated read-only handle for Mainstage's wide chronological scans so
    /// genre counts cannot queue short browse and Favorites reads behind them.
    mainstage_read_conn: Mutex<Connection>,
    /// Dedicated reader for heavy derived reads. Scoped artist detail and grouped
    /// album/artist queries can scan large track sets, so they must not stall
    /// startup browse requests.
    scope_detail_read_conn: Mutex<Connection>,
    /// Current holder of `read_conn`, used only to attribute contention in
    /// targeted diagnostics such as the Favorites initial snapshot.
    read_op_owner: Mutex<Option<ReadOpOwner>>,
    /// IS-3 bulk ingest in progress — read paths skip write-lock work.
    bulk_ingest_active: AtomicBool,
    /// `swap_database_file` / `restore_database_backup` — fail fast instead of
    /// touching in-memory placeholder connections while the file is offline.
    swap_in_progress: AtomicBool,
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
            bulk_ingest_active: AtomicBool::new(false),
            swap_in_progress: AtomicBool::new(false),
        }
    }

    pub(crate) fn set_bulk_ingest_active(&self, active: bool) {
        self.bulk_ingest_active.store(active, Ordering::Release);
    }

    pub(crate) fn bulk_ingest_active(&self) -> bool {
        self.bulk_ingest_active.load(Ordering::Acquire)
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

    fn swap_in_progress(&self) -> bool {
        self.swap_in_progress.load(Ordering::Acquire)
    }

    fn lock_write_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.write_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!("[library-db] write lock was poisoned — recovering");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn lock_read_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.read_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!("[library-db] read lock was poisoned — recovering");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn lock_mainstage_read_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.mainstage_read_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!("[library-db] mainstage read lock was poisoned — recovering");
                Ok(poisoned.into_inner())
            }
        }
    }

    fn lock_scope_detail_read_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        if self.swap_in_progress() {
            return Err("library database swap in progress".to_string());
        }
        match self.scope_detail_read_conn.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                crate::app_eprintln!(
                    "[library-db] scope detail read lock was poisoned — recovering"
                );
                Ok(poisoned.into_inner())
            }
        }
    }

    /// Writer connection — sync ingest, migrations, mutations.
    ///
    /// `op` is logged on slow writes (`[library-db] SLOW write op=…`) — use a
    /// stable `module.action` label (e.g. `sync_state.set_sync_phase`,
    /// `track.upsert_batch_remap`), not the generic `"misc"`, so production
    /// stalls can be attributed to a specific call site.
    pub(crate) fn with_conn<R>(
        &self,
        op: &'static str,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let lock_start = std::time::Instant::now();
        let conn = self.lock_write_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis();
        let exec_start = std::time::Instant::now();
        let out = run_conn_closure(&conn, f);
        let exec_ms = exec_start.elapsed().as_millis();
        log_write_op(op, lock_wait_ms, exec_ms);
        out
    }

    /// Read-only connection — search, status, hydrate; does not block on sync writes.
    #[track_caller]
    pub(crate) fn with_read_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self.lock_read_conn()?;
        let _owner = self.mark_read_owner(std::panic::Location::caller());
        run_conn_closure(&conn, f)
    }

    #[track_caller]
    pub(crate) fn with_read_conn_timed<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<(R, ReadOpTiming), String> {
        let blocked_by = self.read_op_owner();
        let lock_start = std::time::Instant::now();
        let conn = self.lock_read_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis() as u64;
        let _owner = self.mark_read_owner(std::panic::Location::caller());
        let exec_start = std::time::Instant::now();
        let value = run_conn_closure(&conn, f)?;
        let exec_ms = exec_start.elapsed().as_millis() as u64;
        Ok((
            value,
            ReadOpTiming {
                lock_wait_ms,
                exec_ms,
                blocked_by: (lock_wait_ms > 0).then_some(blocked_by).flatten(),
            },
        ))
    }

    /// Isolated reader for wide Mainstage scans. All other browse paths retain
    /// `read_conn`, keeping short local reads responsive while Home loads.
    pub(crate) fn with_mainstage_read_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self.lock_mainstage_read_conn()?;
        run_conn_closure(&conn, f)
    }

    /// Isolated reader for heavy derived reads, which can be much wider than
    /// ordinary browse reads even when their result page is small.
    pub(crate) fn with_scope_detail_read_conn<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        let conn = self.lock_scope_detail_read_conn()?;
        run_conn_closure(&conn, f)
    }

    fn read_op_owner(&self) -> Option<ReadOpOwner> {
        match self.read_op_owner.lock() {
            Ok(owner) => *owner,
            Err(poisoned) => *poisoned.into_inner(),
        }
    }

    fn mark_read_owner(
        &self,
        caller: &'static std::panic::Location<'static>,
    ) -> ReadOpOwnerGuard<'_> {
        let owner = ReadOpOwner {
            file: caller.file(),
            line: caller.line(),
        };
        match self.read_op_owner.lock() {
            Ok(mut current) => *current = Some(owner),
            Err(poisoned) => *poisoned.into_inner() = Some(owner),
        }
        ReadOpOwnerGuard {
            owner: &self.read_op_owner,
        }
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
        let mut conn = self.lock_write_conn()?;
        let lock_wait_ms = lock_start.elapsed().as_millis() as u64;
        let exec_start = std::time::Instant::now();
        let out = run_conn_mut_closure(&mut conn, f)?;
        let exec_ms = exec_start.elapsed().as_millis() as u64;
        log_write_op(op, lock_wait_ms as u128, exec_ms as u128);
        Ok((
            out,
            WriteOpTiming {
                lock_wait_ms,
                exec_ms,
            },
        ))
    }

    pub(crate) fn checkpoint_wal(&self, op: &'static str) -> Result<(), String> {
        self.with_conn_mut(op, |conn| {
            checkpoint_wal_conn(conn, op)?;
            Ok(())
        })
    }

    /// Atomically switch the active sqlite file while replacing long-lived
    /// write/read connections. Other threads see `library database swap in
    /// progress` while the file is offline instead of touching placeholder DBs.
    pub fn swap_database_file(
        &self,
        active_path: &Path,
        destination_path: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if !destination_path.exists() {
            return Ok(None);
        }

        let mut swap_guard = SwapInProgressGuard::new(self);
        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database swap".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database swap".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database swap".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database swap".to_string()
        })?;

        let write_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let mainstage_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let scope_detail_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_write = std::mem::replace(&mut *write_conn, write_tmp);
        let old_read = std::mem::replace(&mut *read_conn, read_tmp);
        let old_mainstage_read = std::mem::replace(&mut *mainstage_read_conn, mainstage_read_tmp);
        let old_scope_detail_read =
            std::mem::replace(&mut *scope_detail_read_conn, scope_detail_read_tmp);
        drop(old_write);
        drop(old_read);
        drop(old_mainstage_read);
        drop(old_scope_detail_read);

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
            drop(read_conn);
            drop(mainstage_read_conn);
            drop(scope_detail_read_conn);
            drop(write_conn);
            let (
                reopened_write,
                reopened_read,
                reopened_mainstage_read,
                reopened_scope_detail_read,
            ) = open_database_connections(active_path)
                .map_err(|e| format!("library swap reopen failed after rename error: {e}"))?;
            let mut write_conn = self.write_conn.lock().map_err(|_| {
                "library store write lock poisoned during database swap".to_string()
            })?;
            let mut read_conn = self
                .read_conn
                .lock()
                .map_err(|_| "library store read lock poisoned during database swap".to_string())?;
            let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
                "library store mainstage read lock poisoned during database swap".to_string()
            })?;
            let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
                "library store scope detail read lock poisoned during database swap".to_string()
            })?;
            *write_conn = reopened_write;
            *read_conn = reopened_read;
            *mainstage_read_conn = reopened_mainstage_read;
            *scope_detail_read_conn = reopened_scope_detail_read;
            swap_guard.release();
            return Err(err.to_string());
        }

        drop(read_conn);
        drop(mainstage_read_conn);
        drop(scope_detail_read_conn);
        drop(write_conn);

        // The freshly-installed library file has different track ids; the
        // fixed-name identity sidecar in this dir is now stale (its norm_version
        // + key count still satisfy the rebuild gate, so nothing else triggers a
        // rebuild). Delete it so the reopen recreates it empty and keys rebuild
        // lazily against the new content.
        crate::identity::remove_cluster_files_for_library(active_path);

        let reopen = open_database_connections(active_path);

        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database swap".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database swap".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database swap".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database swap".to_string()
        })?;

        match reopen {
            Ok((
                reopened_write,
                reopened_read,
                reopened_mainstage_read,
                reopened_scope_detail_read,
            )) => {
                *write_conn = reopened_write;
                *read_conn = reopened_read;
                *mainstage_read_conn = reopened_mainstage_read;
                *scope_detail_read_conn = reopened_scope_detail_read;
                swap_guard.release();
                Ok(Some(backup))
            }
            Err(open_err) => {
                if backup.exists() {
                    if active_path.exists() {
                        remove_db_with_sidecars(active_path).ok();
                    }
                    let _ = fs::rename(&backup, active_path);
                    let _ = move_sidecar(&backup, active_path, "-wal");
                    let _ = move_sidecar(&backup, active_path, "-shm");
                }
                let (
                    reopened_write,
                    reopened_read,
                    reopened_mainstage_read,
                    reopened_scope_detail_read,
                ) = open_database_connections(active_path)
                    .map_err(|e| format!("library swap reopen failed after revert: {e}"))?;
                *write_conn = reopened_write;
                *read_conn = reopened_read;
                *mainstage_read_conn = reopened_mainstage_read;
                *scope_detail_read_conn = reopened_scope_detail_read;
                swap_guard.release();
                Err(format!("library swap failed: {open_err}"))
            }
        }
    }

    pub fn restore_database_backup(
        &self,
        backup_path: &Path,
        active_path: &Path,
    ) -> Result<(), String> {
        let mut swap_guard = SwapInProgressGuard::new(self);
        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database restore".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database restore".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database restore".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database restore".to_string()
        })?;

        let write_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let mainstage_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let scope_detail_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_write = std::mem::replace(&mut *write_conn, write_tmp);
        let old_read = std::mem::replace(&mut *read_conn, read_tmp);
        let old_mainstage_read = std::mem::replace(&mut *mainstage_read_conn, mainstage_read_tmp);
        let old_scope_detail_read =
            std::mem::replace(&mut *scope_detail_read_conn, scope_detail_read_tmp);
        drop(old_write);
        drop(old_read);
        drop(old_mainstage_read);
        drop(old_scope_detail_read);

        if active_path.exists() {
            remove_db_with_sidecars(active_path)?;
        }
        if backup_path.exists() {
            fs::rename(backup_path, active_path).map_err(|e| e.to_string())?;
            move_sidecar(backup_path, active_path, "-wal")?;
            move_sidecar(backup_path, active_path, "-shm")?;
        }

        drop(read_conn);
        drop(mainstage_read_conn);
        drop(scope_detail_read_conn);
        drop(write_conn);

        // Restored library file → the fixed-name identity sidecar is stale; drop
        // it so keys rebuild lazily against the restored content (see swap).
        crate::identity::remove_cluster_files_for_library(active_path);

        let (reopened_write, reopened_read, reopened_mainstage_read, reopened_scope_detail_read) =
            open_database_connections(active_path).map_err(|e| e.to_string())?;

        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database restore".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database restore".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database restore".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database restore".to_string()
        })?;
        *write_conn = reopened_write;
        *read_conn = reopened_read;
        *mainstage_read_conn = reopened_mainstage_read;
        *scope_detail_read_conn = reopened_scope_detail_read;
        swap_guard.release();
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
        crate::app_eprintln!(
            "[library-db] write op={op} lock_wait_ms={lock_wait_ms} exec_ms={exec_ms}"
        );
    }
}

struct SwapInProgressGuard<'a> {
    store: &'a LibraryStore,
    released: bool,
}

impl<'a> SwapInProgressGuard<'a> {
    fn new(store: &'a LibraryStore) -> Self {
        store.swap_in_progress.store(true, Ordering::Release);
        Self {
            store,
            released: false,
        }
    }

    fn release(&mut self) {
        if !self.released {
            self.store.swap_in_progress.store(false, Ordering::Release);
            self.released = true;
        }
    }
}

impl Drop for SwapInProgressGuard<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

fn run_conn_closure<R>(
    conn: &Connection,
    f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
) -> Result<R, String> {
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(conn)));
    match out {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(payload) => {
            let detail = panic_payload_to_string(payload);
            crate::app_eprintln!("[library-db] connection query panicked: {detail}");
            Err(format!("library connection query panicked: {detail}"))
        }
    }
}

fn run_conn_mut_closure<R>(
    conn: &mut Connection,
    f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
) -> Result<R, String> {
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(conn)));
    match out {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(payload) => {
            let detail = panic_payload_to_string(payload);
            crate::app_eprintln!("[library-db] connection mutation panicked: {detail}");
            Err(format!("library connection mutation panicked: {detail}"))
        }
    }
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(msg) = payload.downcast_ref::<&str>() {
        msg.to_string()
    } else if let Some(msg) = payload.downcast_ref::<String>() {
        msg.clone()
    } else {
        "unknown panic payload".to_string()
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

/// Open write + read handles after migrations, one-time repairs, WAL checkpoint,
/// and cluster identity DB attach.
fn open_database_connections(
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

/// Repair the narrow crash window used by older builds where `sync_phase`
/// became ready before the ingest cursor was cleared. The non-empty cursor is
/// the one-time guard, so the potentially large count runs only for anomalous
/// rows and the repair can also heal the same interruption in future databases.
fn reconcile_ready_rows_with_ingest_cursors(conn: &Connection) -> rusqlite::Result<()> {
    let candidates = {
        let mut stmt = conn.prepare(
            "SELECT server_id, library_scope, initial_sync_cursor_json \
             FROM sync_state WHERE sync_phase = 'ready'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let tx = conn.unchecked_transaction()?;
    for (server_id, library_scope, raw_cursor) in candidates {
        let has_ingest_cursor = raw_cursor.as_deref().is_some_and(|raw| {
            match serde_json::from_str::<serde_json::Value>(raw) {
                Ok(serde_json::Value::Object(cursor)) => !cursor.is_empty(),
                Ok(serde_json::Value::Null) => false,
                Ok(_) | Err(_) => true,
            }
        });
        if !has_ingest_cursor {
            continue;
        }
        let local_track_count: i64 = if library_scope.is_empty() {
            tx.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                [&server_id],
                |row| row.get(0),
            )?
        } else {
            tx.query_row(
                "SELECT COUNT(*) FROM track \
                 WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0",
                params![server_id, library_scope],
                |row| row.get(0),
            )?
        };
        tx.execute(
            "UPDATE sync_state SET initial_sync_cursor_json = '{}', local_track_count = ?3 \
             WHERE server_id = ?1 AND library_scope = ?2 AND sync_phase = 'ready'",
            params![server_id, library_scope, local_track_count],
        )?;
    }
    tx.commit()
}

fn artist_name_sort_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('artist') WHERE name = 'name_sort'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

fn artist_name_fold_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('artist') WHERE name = 'name_fold'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

fn sync_state_ignored_articles_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name = 'ignored_articles'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

/// Apply schema 014 idempotently — mirrors `migrations/014_artist_name_sort.sql`
/// but tolerates a partial prior apply (missing one column / re-run).
fn apply_migration_14(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_sort_column_exists(conn)? {
        conn.execute_batch("ALTER TABLE artist ADD COLUMN name_sort TEXT;")?;
    }
    if !sync_state_ignored_articles_column_exists(conn)? {
        conn.execute_batch("ALTER TABLE sync_state ADD COLUMN ignored_articles TEXT;")?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_artist_name_sort ON artist(server_id, name_sort);",
    )?;
    finish_migration_14_reconcile(conn)?;
    Ok(())
}

/// Apply schema 022 idempotently so a crash after `ADD COLUMN` can recover.
fn apply_migration_22(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_fold_column_exists(conn)? {
        conn.execute_batch("ALTER TABLE artist ADD COLUMN name_fold TEXT;")?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_artist_name_fold ON artist(server_id, name_fold);",
    )?;
    maybe_reconcile_artist_name_fold(conn)?;
    Ok(())
}

fn record_schema_migration(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
        params![version],
    )?;
    Ok(())
}

fn finish_migration_14_reconcile(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_sort_reconcile_completed(conn)? {
        repair_artist_name_sort_keys(conn)?;
        mark_artist_name_sort_reconcile_completed(conn)?;
    }
    Ok(())
}

fn artist_name_sort_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![ARTIST_NAME_SORT_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_artist_name_sort_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![ARTIST_NAME_SORT_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time reconcile after schema 014 — not on every open (avoids long write locks at startup).
fn maybe_reconcile_artist_name_sort(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_sort_column_exists(conn)? {
        return Ok(());
    }
    if artist_name_sort_reconcile_completed(conn)? {
        return Ok(());
    }
    repair_artist_name_sort_keys(conn)?;
    mark_artist_name_sort_reconcile_completed(conn)?;
    Ok(())
}

/// Reconcile `artist.name_sort` with display `name` (upgrade / stale rows).
fn repair_artist_name_sort_keys(conn: &Connection) -> rusqlite::Result<()> {
    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'artist'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if table_exists == 0 {
        return Ok(());
    }
    if !artist_name_sort_column_exists(conn)? {
        return Ok(());
    }
    let ignored = crate::artist_sort::DEFAULT_IGNORED_ARTICLES;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("SELECT server_id, id, name, name_sort FROM artist")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let server_id: String = row.get(0)?;
            let id: String = row.get(1)?;
            let name: String = row.get(2)?;
            let current: Option<String> = row.get(3)?;
            let expected = crate::artist_sort::sort_key_for_display_name(&name, ignored);
            if current.as_deref() == Some(&expected) {
                continue;
            }
            tx.execute(
                "UPDATE artist SET name_sort = ?1 WHERE server_id = ?2 AND id = ?3",
                rusqlite::params![expected, server_id, id],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn artist_name_fold_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![ARTIST_NAME_FOLD_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn maybe_reconcile_artist_name_fold(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_fold_column_exists(conn)? || artist_name_fold_reconcile_completed(conn)? {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("SELECT server_id, id, name, name_fold FROM artist")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let server_id: String = row.get(0)?;
            let id: String = row.get(1)?;
            let name: String = row.get(2)?;
            let current: Option<String> = row.get(3)?;
            let expected = name.trim().to_lowercase();
            if current.as_deref() == Some(&expected) {
                continue;
            }
            tx.execute(
                "UPDATE artist SET name_fold = ?1 WHERE server_id = ?2 AND id = ?3",
                params![expected, server_id, id],
            )?;
        }
    }
    tx.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![ARTIST_NAME_FOLD_RECONCILE_ID],
    )?;
    tx.commit()
}

fn replay_gain_peak_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('track') WHERE name = 'replay_gain_peak'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

fn replay_gain_peak_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![REPLAY_GAIN_PEAK_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_replay_gain_peak_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![REPLAY_GAIN_PEAK_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time backfill after schema 015 — project peak from stored `raw_json`.
fn repair_replay_gain_peak_from_raw_json(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE track SET replay_gain_peak = json_extract(raw_json, '$.replayGain.trackPeak') \
         WHERE replay_gain_peak IS NULL \
           AND json_type(json_extract(raw_json, '$.replayGain.trackPeak')) = 'real'",
        [],
    )?;
    conn.execute(
        "UPDATE track SET replay_gain_peak = json_extract(raw_json, '$.rgTrackPeak') \
         WHERE replay_gain_peak IS NULL \
           AND json_type(json_extract(raw_json, '$.rgTrackPeak')) = 'real'",
        [],
    )?;
    Ok(())
}

/// One-time reconcile after schema 015 — not on every open.
fn maybe_reconcile_replay_gain_peak(conn: &Connection) -> rusqlite::Result<()> {
    if !replay_gain_peak_column_exists(conn)? {
        return Ok(());
    }
    if replay_gain_peak_reconcile_completed(conn)? {
        return Ok(());
    }
    repair_replay_gain_peak_from_raw_json(conn)?;
    mark_replay_gain_peak_reconcile_completed(conn)?;
    Ok(())
}

fn library_id_backfill_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_library_id_backfill_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time backfill after schema 016 — project `library_id` from stored `raw_json`.
fn repair_library_id_from_raw_json(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE track SET library_id = COALESCE( \
           CAST(json_extract(raw_json, '$.libraryId') AS TEXT), \
           CAST(json_extract(raw_json, '$.library_id') AS TEXT), \
           CAST(json_extract(raw_json, '$.musicFolderId') AS TEXT) \
         ) \
         WHERE (library_id IS NULL OR library_id = '') \
           AND COALESCE( \
             CAST(json_extract(raw_json, '$.libraryId') AS TEXT), \
             CAST(json_extract(raw_json, '$.library_id') AS TEXT), \
             CAST(json_extract(raw_json, '$.musicFolderId') AS TEXT) \
           ) IS NOT NULL",
        [],
    )?;
    // Only `track` (and its indexes) changed here, so a table-scoped ANALYZE is
    // enough to refresh the planner stats — cheaper than a whole-DB ANALYZE on a
    // large library at first open.
    conn.execute_batch("ANALYZE track;")?;
    Ok(())
}

/// One-time reconcile after schema 016 — not on every open.
fn maybe_reconcile_library_id_backfill(conn: &Connection) -> rusqlite::Result<()> {
    if library_id_backfill_reconcile_completed(conn)? {
        return Ok(());
    }
    repair_library_id_from_raw_json(conn)?;
    mark_library_id_backfill_reconcile_completed(conn)?;
    Ok(())
}

fn duration_sec_backfill_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

/// Restore zeroed decimal durations from `raw_json` in bounded transactions.
/// `cursor_rowid` lets an interrupted startup continue from the last batch.
fn maybe_reconcile_duration_sec_backfill(conn: &Connection) -> rusqlite::Result<()> {
    if duration_sec_backfill_completed(conn)? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
         VALUES (?1, 0, strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET \
           started_at = COALESCE(library_data_migration.started_at, excluded.started_at)",
        params![DURATION_SEC_BACKFILL_RECONCILE_ID],
    )?;

    loop {
        let cursor: i64 = conn.query_row(
            "SELECT cursor_rowid FROM library_data_migration WHERE id = ?1",
            params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )?;
        let last_rowid: Option<i64> = conn.query_row(
            "SELECT MAX(rowid) FROM ( \
               SELECT rowid FROM track \
               WHERE rowid > ?1 \
                 AND duration_sec = 0 \
                 AND json_valid(raw_json) \
                 AND json_type(raw_json, '$.duration') IN ('integer', 'real') \
                 AND CAST(json_extract(raw_json, '$.duration') AS REAL) > 0 \
               ORDER BY rowid LIMIT ?2 \
             )",
            params![cursor, DURATION_SEC_BACKFILL_BATCH_SIZE],
            |row| row.get(0),
        )?;
        let Some(last_rowid) = last_rowid else {
            conn.execute(
                "UPDATE library_data_migration \
                 SET completed_at = strftime('%s','now') WHERE id = ?1",
                params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            )?;
            return Ok(());
        };

        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE track \
             SET duration_sec = CAST(ROUND(CAST(json_extract(raw_json, '$.duration') AS REAL)) AS INTEGER) \
             WHERE rowid > ?1 AND rowid <= ?2 \
               AND duration_sec = 0 \
               AND json_valid(raw_json) \
               AND json_type(raw_json, '$.duration') IN ('integer', 'real') \
               AND CAST(json_extract(raw_json, '$.duration') AS REAL) > 0",
            params![cursor, last_rowid],
        )?;
        tx.execute(
            "UPDATE library_data_migration SET cursor_rowid = ?2 WHERE id = ?1",
            params![DURATION_SEC_BACKFILL_RECONCILE_ID, last_rowid],
        )?;
        tx.commit()?;
    }
}

fn orphan_browse_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![ORPHAN_BROWSE_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_orphan_browse_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![ORPHAN_BROWSE_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time cleanup of orphaned `artist` browse rows for existing DBs — clears
/// ghosts left by server-side renames before inline pruning landed. Runs once
/// (guarded by `library_data_migration`); ongoing syncs prune inline.
fn maybe_reconcile_orphan_browse_rows(conn: &Connection) -> rusqlite::Result<()> {
    if orphan_browse_reconcile_completed(conn)? {
        return Ok(());
    }
    crate::orphan_cleanup::prune_orphan_artists_all(conn)?;
    mark_orphan_browse_reconcile_completed(conn)?;
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

fn mark_projection_migration_complete_if_empty(
    conn: &Connection,
    migration_id: &str,
) -> rusqlite::Result<()> {
    let required_tables: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('track', 'library_data_migration')",
        [],
        |row| row.get(0),
    )?;
    if required_tables != 2 {
        return Ok(());
    }
    let has_live_tracks: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM track WHERE deleted = 0)",
        [],
        |row| row.get(0),
    )?;
    if has_live_tracks {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![migration_id],
    )?;
    Ok(())
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
    let max_applied: Option<i64> =
        conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?;
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
        if version == 14 {
            // Applied idempotently (per-column ADD + IF NOT EXISTS index) so a
            // partial DDL apply — one ALTER landed before a crash, no
            // schema_migrations row — recovers instead of failing on a
            // duplicate-column re-run of the batch.
            apply_migration_14(conn)?;
            record_schema_migration(conn, version)?;
            continue;
        }
        if version == 22 {
            apply_migration_22(conn)?;
            record_schema_migration(conn, version)?;
            continue;
        }
        conn.execute_batch(sql)?;
        match version {
            20 => mark_projection_migration_complete_if_empty(
                conn,
                crate::browse_projection::MIGRATION_ID,
            )?,
            24 => mark_projection_migration_complete_if_empty(
                conn,
                crate::composer_projection::MIGRATION_ID,
            )?,
            _ => {}
        }
        record_schema_migration(conn, version)?;
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
    use std::sync::mpsc;

    struct TestDatabase {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TestDatabase {
        fn new(label: &str) -> Self {
            let nonce = IN_MEMORY_DB_COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "psysonic-library-{label}-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("create test database directory");
            let path = dir.join("library.sqlite");
            Self { dir, path }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

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
    fn mainstage_reader_does_not_block_the_shared_browse_reader() {
        let store = std::sync::Arc::new(LibraryStore::open_in_memory());
        let (started_tx, started_rx) = mpsc::channel();
        let mainstage_store = std::sync::Arc::clone(&store);
        let mainstage = std::thread::spawn(move || {
            mainstage_store
                .with_mainstage_read_conn(|_| {
                    started_tx.send(()).expect("signal mainstage read start");
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(())
                })
                .unwrap();
        });
        started_rx.recv().expect("wait for mainstage read");

        let started_at = std::time::Instant::now();
        let value: i64 = store
            .with_read_conn(|conn| conn.query_row("SELECT 1", [], |row| row.get(0)))
            .unwrap();

        assert_eq!(value, 1);
        assert!(
            started_at.elapsed() < Duration::from_millis(50),
            "shared read was blocked by the mainstage reader"
        );
        mainstage.join().expect("mainstage reader thread");
    }

    #[test]
    fn scope_detail_reader_does_not_block_the_shared_browse_reader() {
        let store = std::sync::Arc::new(LibraryStore::open_in_memory());
        let (started_tx, started_rx) = mpsc::channel();
        let detail_store = std::sync::Arc::clone(&store);
        let detail = std::thread::spawn(move || {
            detail_store
                .with_scope_detail_read_conn(|_| {
                    started_tx.send(()).expect("signal scope detail read start");
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(())
                })
                .unwrap();
        });
        started_rx.recv().expect("wait for scope detail read");

        let started_at = std::time::Instant::now();
        let value: i64 = store
            .with_read_conn(|conn| conn.query_row("SELECT 1", [], |row| row.get(0)))
            .unwrap();

        assert_eq!(value, 1);
        assert!(
            started_at.elapsed() < Duration::from_millis(50),
            "shared read was blocked by the scope detail reader"
        );
        detail.join().expect("scope detail reader thread");
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
    fn migration_026_adds_tag_cursor_without_rewriting_completion_state() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations_with(
            &conn,
            &MIGRATIONS[..MIGRATIONS.len() - 1],
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            handle_breaking_schema_bump,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library_tag_state \
             (server_id, folders_hash, last_untagged_count, completed_at) \
             VALUES ('s1', 'folders', 7, 123)",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let state: (String, i64, i64) = conn
            .query_row(
                "SELECT folders_hash, last_untagged_count, completed_at \
                 FROM library_tag_state WHERE server_id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state, ("folders".into(), 7, 123));
        let cursor_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type = 'table' AND name = 'library_tag_cursor'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cursor_table, 1);
    }

    #[test]
    fn fresh_database_marks_projection_backfills_complete() {
        let store = LibraryStore::open_in_memory();
        let completed: i64 = store
            .with_conn("test", |conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM library_data_migration \
                     WHERE id IN (?1, ?2) AND completed_at IS NOT NULL",
                    params![
                        crate::browse_projection::MIGRATION_ID,
                        crate::composer_projection::MIGRATION_ID,
                    ],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(completed, 2);
    }

    #[test]
    fn migration_022_backfills_unicode_artist_name_fold() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn("test", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, name_fold, synced_at) \
                     VALUES ('s1', 'ar-kino', 'КИНО-пробы', NULL, 1)",
                    [],
                )?;
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![ARTIST_NAME_FOLD_RECONCILE_ID],
                )?;
                maybe_reconcile_artist_name_fold(conn)
            })
            .unwrap();
        let name_fold: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT name_fold FROM artist WHERE server_id = 's1' AND id = 'ar-kino'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(name_fold, "кино-пробы");
    }

    #[test]
    fn migration_012_repairs_db_that_recorded_legacy_versions_without_genre_tables() {
        let uri = in_memory_uri();
        let conn = Connection::open(&uri).expect("connection");
        configure_write_connection(&conn).expect("pragmas");
        conn.execute_batch(INITIAL_SQL).expect("initial");
        conn.execute("DROP TABLE IF EXISTS track_genre", [])
            .expect("drop track_genre");
        conn.execute("DROP TABLE IF EXISTS library_data_migration", [])
            .expect("drop cursor table");
        for version in 1..=11_i64 {
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?1)",
                params![version],
            )
            .expect("seed legacy versions");
        }

        let outcome = run_migrations_with(
            &conn,
            MIGRATIONS,
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            no_op_hook,
        )
        .expect("apply v12 repair");
        assert_eq!(outcome, MigrationOutcome::Applied);
        ensure_genre_tags_schema(&conn).expect("ensure");

        for table in ["track_genre", "library_data_migration"] {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master \
                     WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .expect("table probe");
            assert_eq!(exists, 1, "missing table {table}");
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
        assert_eq!(local_count, 2, "repair refreshes the persisted count snapshot");
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
                c.query_row("SELECT name, bio FROM artist WHERE id = 'a1'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
            })
            .unwrap();
        assert_eq!(name, "Existing Artist");
        assert!(bio.is_none());

        let versions: Vec<i64> = store
            .with_conn("misc", |c| {
                let mut stmt =
                    c.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
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

    #[test]
    fn artist_name_sort_reconcile_runs_once_and_sets_name_sort() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                     VALUES ('s1', 'ar1', 'The Beatles', 'the beatles', 1)",
                    [],
                )?;
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![ARTIST_NAME_SORT_RECONCILE_ID],
                )?;
                Ok(())
            })
            .expect("seed artist");

        store
            .with_conn("test.reconcile", maybe_reconcile_artist_name_sort)
            .expect("reconcile");

        let name_sort: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT name_sort FROM artist WHERE server_id = 's1' AND id = 'ar1'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("read name_sort");
        assert_eq!(name_sort, "beatles");

        let completed_before: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT completed_at FROM library_data_migration WHERE id = ?1",
                    params![ARTIST_NAME_SORT_RECONCILE_ID],
                    |r| r.get(0),
                )
            })
            .expect("reconcile marker");
        assert!(completed_before > 0);

        store
            .with_conn("test.reconcile_again", maybe_reconcile_artist_name_sort)
            .expect("reconcile again");

        let name_sort_after: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT name_sort FROM artist WHERE server_id = 's1' AND id = 'ar1'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("read name_sort again");
        assert_eq!(name_sort_after, "beatles");
    }

    #[test]
    fn migration_14_recovers_partial_schema_without_schema_migrations_row() {
        let uri = in_memory_uri();
        let conn = Connection::open(&uri).expect("connection");
        configure_write_connection(&conn).expect("pragmas");
        let migrations_through_13: &[(i64, &str)] = &[
            (1, INITIAL_SQL),
            (12, MIGRATION_012_TRACK_GENRE_LEGACY),
            (13, MIGRATION_013_ARTIST_ARTWORK_LOOKUP),
        ];
        run_migrations_with(
            &conn,
            migrations_through_13,
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            no_op_hook,
        )
        .expect("migrate through v13");
        conn.execute_batch(MIGRATION_014_ARTIST_NAME_SORT)
            .expect("apply ddl only");

        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 14",
                [],
                |r| r.get(0),
            )
            .expect("count migration");
        assert_eq!(recorded, 0);

        run_migrations_with(
            &conn,
            MIGRATIONS,
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            no_op_hook,
        )
        .expect("recover partial migration");

        let recorded_after: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 14",
                [],
                |r| r.get(0),
            )
            .expect("count migration after");
        assert_eq!(recorded_after, 1);
    }

    #[test]
    fn migration_22_recovers_partial_schema_without_schema_migrations_row() {
        let uri = in_memory_uri();
        let conn = Connection::open(&uri).expect("connection");
        configure_write_connection(&conn).expect("pragmas");
        let migrations_through_21: Vec<(i64, &str)> = MIGRATIONS
            .iter()
            .copied()
            .filter(|(version, _)| *version <= 21)
            .collect();
        run_migrations_with(
            &conn,
            &migrations_through_21,
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            no_op_hook,
        )
        .expect("migrate through v21");
        conn.execute(
            "INSERT INTO artist (server_id, id, name, synced_at) VALUES ('s1', 'ar1', 'КИНО', 1)",
            [],
        )
        .expect("seed artist");
        conn.execute_batch("ALTER TABLE artist ADD COLUMN name_fold TEXT;")
            .expect("apply partial migration ddl");

        run_migrations_with(
            &conn,
            MIGRATIONS,
            LIBRARY_DB_MIN_COMPATIBLE_VERSION,
            no_op_hook,
        )
        .expect("recover partial migration");

        let recorded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 22",
                [],
                |row| row.get(0),
            )
            .expect("migration marker");
        assert_eq!(recorded, 1);
        let index_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_artist_name_fold'",
                [],
                |row| row.get(0),
            )
            .expect("index marker");
        assert_eq!(index_exists, 1);
        let name_fold: String = conn
            .query_row(
                "SELECT name_fold FROM artist WHERE server_id = 's1' AND id = 'ar1'",
                [],
                |row| row.get(0),
            )
            .expect("backfilled fold");
        assert_eq!(name_fold, "кино");
    }

    const LIBRARY_SCOPE_INDEXES: [&str; 4] = [
        "idx_track_library_album",
        "idx_track_library_artist",
        "idx_track_library_title",
        "idx_track_library_genre",
    ];

    #[test]
    fn migration_016_creates_library_scope_indexes() {
        let store = LibraryStore::open_in_memory();
        for index_name in LIBRARY_SCOPE_INDEXES {
            let exists: i64 = store
                .with_conn("misc", |c| {
                    c.query_row(
                        "SELECT COUNT(*) FROM sqlite_master \
                         WHERE type = 'index' AND name = ?1",
                        params![index_name],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert_eq!(exists, 1, "missing index {index_name}");
        }
        let stat_rows: i64 = store
            .with_conn("misc", |c| {
                c.query_row("SELECT COUNT(*) FROM sqlite_stat1", [], |r| r.get(0))
            })
            .unwrap();
        assert!(stat_rows > 0, "ANALYZE should populate sqlite_stat1");
    }

    #[test]
    fn migration_019_creates_mainstage_created_index() {
        let store = LibraryStore::open_in_memory();
        let sql: String = store
            .with_conn("test.mainstage_index", |conn| {
                conn.query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    params!["idx_track_library_created_album"],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(sql.contains("server_id, library_id, server_created_at DESC, album_id, id"));
        assert!(sql.contains("server_created_at IS NOT NULL"));
    }

    #[test]
    fn migration_019_creates_mainstage_rating_and_lossless_schema_idempotently() {
        let store = LibraryStore::open_in_memory();
        let version: i64 = store
            .with_conn("test.entity_user_rating_version", |conn| {
                conn.query_row(
                    "SELECT version FROM schema_migrations WHERE version = 19",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(version, 19);

        store
            .with_conn(
                "test.entity_user_rating_ensure",
                ensure_entity_user_rating_schema,
            )
            .expect("repeated schema repair succeeds");
        let table_count: i64 = store
            .with_conn("test.entity_user_rating_table", |conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'entity_user_rating'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(table_count, 1);

        let index_count: i64 = store
            .with_conn("test.lossless_browse_index", |conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_track_lossless_album_browse'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(index_count, 1);
    }

    #[test]
    fn library_id_backfill_reconcile_populates_from_raw_json() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_tracks", |conn| {
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                     VALUES ('s1', 't1', 'A', 'Al', 1, 0, 1, '{\"libraryId\":\"lib-a\"}', '')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                     VALUES ('s1', 't2', 'B', 'Al', 1, 0, 1, '{\"library_id\":\"lib-b\"}', NULL)",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                     VALUES ('s1', 't3', 'C', 'Al', 1, 0, 1, '{\"musicFolderId\":\"lib-c\"}', '')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                     VALUES ('s1', 't4', 'D', 'Al', 1, 0, 1, '{}', 'already-set')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed tracks");

        store
            .with_conn("test.reconcile", maybe_reconcile_library_id_backfill)
            .expect("reconcile");

        let lib_a: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't1'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("t1 library_id");
        assert_eq!(lib_a, "lib-a");

        let lib_b: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't2'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("t2 library_id");
        assert_eq!(lib_b, "lib-b");

        let lib_c: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't3'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("t3 library_id");
        assert_eq!(lib_c, "lib-c");

        let unchanged: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't4'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("t4 library_id");
        assert_eq!(unchanged, "already-set");
    }

    #[test]
    fn orphan_browse_reconcile_prunes_ghosts_once() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed", |conn| {
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![ORPHAN_BROWSE_RECONCILE_ID],
                )?;
                // Confirmed-this-pass artist with a live track → keep.
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                     VALUES ('s1', 'ar_new', 'New', 'new', 100)",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, artist_id, album, album_id, \
                       duration_sec, deleted, synced_at, raw_json) \
                     VALUES ('s1', 'tr_1', 'S', 'ar_new', 'Al', 'al_live', 1, 0, 1, '{}')",
                    [],
                )?;
                // Renamed-away ghost: stale synced_at, no live track → prune.
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                     VALUES ('s1', 'ar_old', 'Old', 'old', 1)",
                    [],
                )?;
                Ok(())
            })
            .expect("seed");

        store
            .with_conn("test.reconcile", maybe_reconcile_orphan_browse_rows)
            .expect("reconcile");

        let artists: i64 = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM artist WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(artists, 1, "ghost artist pruned, live kept");

        // Re-running with the marker set is a no-op even if a new ghost appears.
        store
            .with_conn_mut("test.seed_more_ghosts", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                     VALUES ('s1', 'ar_old2', 'Old2', 'old2', 1)",
                    [],
                )
            })
            .unwrap();
        store
            .with_conn("test.reconcile_again", maybe_reconcile_orphan_browse_rows)
            .expect("reconcile again");
        let artists_after: i64 = store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT COUNT(*) FROM artist WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            artists_after, 2,
            "guarded: does not re-run after completion"
        );
    }

    #[test]
    fn library_id_backfill_reconcile_is_idempotent() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_track", |conn| {
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                     VALUES ('s1', 't1', 'A', 'Al', 1, 0, 1, '{\"libraryId\":\"lib-a\"}', '')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed track");

        store
            .with_conn("test.reconcile", maybe_reconcile_library_id_backfill)
            .expect("reconcile");

        let completed_before: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT completed_at FROM library_data_migration WHERE id = ?1",
                    params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
                    |r| r.get(0),
                )
            })
            .expect("reconcile marker");
        assert!(completed_before > 0);

        store
            .with_conn_mut("test.clear_library_id", |conn| {
                conn.execute(
                    "UPDATE track SET library_id = '' WHERE server_id = 's1' AND id = 't1'",
                    [],
                )?;
                Ok(())
            })
            .expect("clear library_id");

        store
            .with_conn("test.reconcile_again", maybe_reconcile_library_id_backfill)
            .expect("reconcile again");

        let library_id_after: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't1'",
                    [],
                    |r| r.get(0),
                )
            })
            .expect("library_id after second reconcile");
        assert_eq!(library_id_after, "");
    }

    #[test]
    fn duration_sec_backfill_rounds_decimal_raw_duration_once() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_duration_backfill", |conn| {
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![DURATION_SEC_BACKFILL_RECONCILE_ID],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                     VALUES ('s1', 'decimal', 'Decimal', 'Al', 0, 0, 1, '{\"duration\":229.85}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                     VALUES ('s1', 'zero', 'Zero', 'Al', 0, 0, 1, '{\"duration\":0}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                     VALUES ('s1', 'set', 'Set', 'Al', 100, 0, 1, '{\"duration\":200}')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed tracks");

        store
            .with_conn(
                "test.duration_backfill",
                maybe_reconcile_duration_sec_backfill,
            )
            .expect("duration backfill");

        let durations: Vec<(String, i64)> = store
            .with_read_conn(|conn| {
                conn.prepare(
                    "SELECT id, duration_sec FROM track WHERE server_id = 's1' ORDER BY id",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
            })
            .expect("backfilled durations");
        assert_eq!(
            durations,
            vec![
                ("decimal".into(), 230),
                ("set".into(), 100),
                ("zero".into(), 0)
            ]
        );

        store
            .with_conn_mut("test.clear_decimal_duration", |conn| {
                conn.execute("UPDATE track SET duration_sec = 0 WHERE id = 'decimal'", [])
            })
            .expect("clear duration");
        store
            .with_conn(
                "test.duration_backfill_again",
                maybe_reconcile_duration_sec_backfill,
            )
            .expect("guarded duration backfill");
        let duration_after: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT duration_sec FROM track WHERE id = 'decimal'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("duration after guarded re-run");
        assert_eq!(duration_after, 0);
    }

    #[test]
    fn read_conn_recovers_after_closure_panic() {
        let store = LibraryStore::open_in_memory();
        let first: Result<i64, String> = store.with_read_conn(|_conn| {
            panic!("simulated read panic");
        });
        assert!(first.is_err());

        let ok: i64 = store
            .with_read_conn(|conn| conn.query_row("SELECT 1", [], |r| r.get(0)))
            .expect("read after panic recovery");
        assert_eq!(ok, 1);
    }
}

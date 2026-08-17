use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use rusqlite::Connection;

mod connection;
mod filesystem;
mod lifecycle;
mod migrations;
mod open;
mod reconciles;

pub use connection::WriteOpTiming;
#[allow(unused_imports)]
pub(crate) use connection::{ReadOpOwner, ReadOpTiming};
#[allow(unused_imports)]
pub(crate) use migrations::{
    ensure_composer_browse_projection_schema, ensure_entity_user_rating_schema,
    ensure_genre_tags_schema, ensure_mainstage_feed_indexes, ensure_scope_browse_projection_schema,
    run_migrations_with, MigrationOutcome, INITIAL_SQL, MIGRATION_012_TRACK_GENRE_LEGACY,
    MIGRATION_013_ARTIST_ARTWORK_LOOKUP, MIGRATION_014_ARTIST_NAME_SORT,
    MIGRATION_015_REPLAY_GAIN_PEAK, MIGRATION_016_MULTI_LIBRARY_SCOPE,
    MIGRATION_017_LIBRARY_TAG_STATE, MIGRATION_018_ARTIST_SYNCED_INDEX,
    MIGRATION_019_MAINSTAGE_FEED_INDEXES, MIGRATION_020_SCOPE_BROWSE_PROJECTION,
    MIGRATION_021_SCOPE_BROWSE_TRACKS, MIGRATION_022_ARTIST_NAME_FOLD,
    MIGRATION_023_STARRED_BROWSE_INDEXES, MIGRATION_024_COMPOSER_BROWSE_PROJECTION,
    MIGRATION_025_IDENTITY_INVALIDATION, MIGRATION_026_LIBRARY_TAG_CURSOR,
};
pub use migrations::{LIBRARY_DB_MIN_COMPATIBLE_VERSION, LIBRARY_DB_SCHEMA_VERSION};
#[allow(unused_imports)]
pub(crate) use reconciles::{
    ARTIST_NAME_FOLD_RECONCILE_ID, ARTIST_NAME_SORT_RECONCILE_ID,
    DURATION_SEC_BACKFILL_RECONCILE_ID, LIBRARY_ID_BACKFILL_RECONCILE_ID,
    ORPHAN_BROWSE_RECONCILE_ID, REPLAY_GAIN_PEAK_RECONCILE_ID,
};

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
    /// Same, for `mainstage_read_conn`. That connection is shared by the
    /// chronological feeds, their genre counts, the hot-release overlay and the
    /// sidebar unread badge, so "who is holding it" is the question worth
    /// answering when a browse page stalls.
    mainstage_read_op_owner: Mutex<Option<ReadOpOwner>>,
    /// IS-3 bulk ingest in progress — read paths skip write-lock work.
    bulk_ingest_active: AtomicBool,
    /// `swap_database_file` / `restore_database_backup` — fail fast instead of
    /// touching in-memory placeholder connections while the file is offline.
    swap_in_progress: AtomicBool,
}

#[cfg(test)]
mod tests;

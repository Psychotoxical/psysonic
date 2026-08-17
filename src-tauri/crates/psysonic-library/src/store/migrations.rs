use rusqlite::{params, Connection};

use super::reconciles::{
    artist_name_fold_column_exists, artist_name_sort_column_exists, finish_migration_14_reconcile,
    maybe_reconcile_artist_name_fold, sync_state_ignored_articles_column_exists,
};

/// Current head of the embedded migrations. Bump each time a new
/// `migrations/NNN_*.sql` is added.
///
/// Migration checklist (wiring, data backfill, open/swap path):
/// psysonic-workdocs `ai/agent-rules/08-library-db-migrations.md`.
pub const LIBRARY_DB_SCHEMA_VERSION: i64 = 26;

/// Lowest applied schema version the current code can advance from purely
/// additively. If a DB carries a version below this, the breaking-bump hook
/// fires (spec §5.7 / P22): the library is treated as incompatible, must be
/// dropped, and initial sync must restart.
///
/// At v1 launch this equals `LIBRARY_DB_SCHEMA_VERSION` — no real DB can
/// trip the hook. Bump independently of `SCHEMA_VERSION` only when a
/// migration cannot be expressed additively.
pub const LIBRARY_DB_MIN_COMPATIBLE_VERSION: i64 = 1;

pub(crate) const INITIAL_SQL: &str = include_str!("../../migrations/001_initial.sql");
/// Version 12 is above the removed legacy migrations 002–011 so existing DBs
/// still pick up `track_genre` + `library_data_migration`.
pub(crate) const MIGRATION_012_TRACK_GENRE_LEGACY: &str =
    include_str!("../../migrations/012_track_genre_legacy_repair.sql");
/// Version 13: additive `artist_artwork_lookup` table for external artist
/// artwork (fanart.tv) — image-scraper §12. Pure CREATE TABLE IF NOT EXISTS.
pub(crate) const MIGRATION_013_ARTIST_ARTWORK_LOOKUP: &str =
    include_str!("../../migrations/013_artist_artwork_lookup.sql");
pub(crate) const MIGRATION_014_ARTIST_NAME_SORT: &str =
    include_str!("../../migrations/014_artist_name_sort.sql");
pub(crate) const MIGRATION_015_REPLAY_GAIN_PEAK: &str =
    include_str!("../../migrations/015_replay_gain_peak.sql");
pub(crate) const MIGRATION_016_MULTI_LIBRARY_SCOPE: &str =
    include_str!("../../migrations/016_multi_library_scope.sql");
pub(crate) const MIGRATION_017_LIBRARY_TAG_STATE: &str =
    include_str!("../../migrations/017_library_tag_state.sql");
/// Version 18: additive `idx_artist_synced(server_id, synced_at)` so the orphan
/// prune's freshness lookup is an index seek instead of a per-server scan.
pub(crate) const MIGRATION_018_ARTIST_SYNCED_INDEX: &str =
    include_str!("../../migrations/018_artist_synced_index.sql");
/// Version 19: Mainstage feed indexes, owner-scoped rating cache, and a
/// suffix-selective lossless browse index.
pub(crate) const MIGRATION_019_MAINSTAGE_FEED_INDEXES: &str =
    include_str!("../../migrations/019_mainstage_feed_indexes.sql");
/// Version 20: materialized per-library album rows for keyset scope browse.
pub(crate) const MIGRATION_020_SCOPE_BROWSE_PROJECTION: &str =
    include_str!("../../migrations/020_scope_browse_projection.sql");
/// Version 21: title keyset index for candidate-first scoped track browse.
pub(crate) const MIGRATION_021_SCOPE_BROWSE_TRACKS: &str =
    include_str!("../../migrations/021_scope_browse_tracks.sql");
pub(crate) const MIGRATION_022_ARTIST_NAME_FOLD: &str =
    include_str!("../../migrations/022_artist_name_fold.sql");
/// Version 23: partial index for the Favorites initial local snapshot.
pub(crate) const MIGRATION_023_STARRED_BROWSE_INDEXES: &str =
    include_str!("../../migrations/023_starred_browse_indexes.sql");
/// Version 24: materialized composer credits by library and album.
pub(crate) const MIGRATION_024_COMPOSER_BROWSE_PROJECTION: &str =
    include_str!("../../migrations/024_composer_browse_projection.sql");
/// Version 25: durable invalidation journal for incremental identity maintenance.
pub(crate) const MIGRATION_025_IDENTITY_INVALIDATION: &str =
    include_str!("../../migrations/025_identity_invalidation.sql");
/// Version 26: resumable cursor for bounded post-sync library tagging.
pub(crate) const MIGRATION_026_LIBRARY_TAG_CURSOR: &str =
    include_str!("../../migrations/026_library_tag_cursor.sql");

/// Embedded migrations. Ordered ascending by `version`; the runner sorts
/// defensively before applying so the source order can stay readable.
pub(super) const MIGRATIONS: &[(i64, &str)] = &[
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

pub(super) fn run_migrations(conn: &Connection) -> rusqlite::Result<MigrationOutcome> {
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

/// P22 breaking-schema-bump hook. PR-1b ships a no-op stub: the function
/// signature, call site, and `MigrationOutcome::BreakingBump` signal are in
/// place, but the actual library-drop + sync-reset logic lands when the
/// first real breaking bump happens. Until then the constants guarantee the
/// hook never fires on production data.
pub(super) fn handle_breaking_schema_bump(
    _conn: &Connection,
    _max_applied: i64,
    _target_version: i64,
) -> rusqlite::Result<()> {
    Ok(())
}

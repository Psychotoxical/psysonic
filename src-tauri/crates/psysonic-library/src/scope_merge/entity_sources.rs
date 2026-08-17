use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;

use super::common::{
    ensure_cluster_keys_for_all_scopes, keyed_detail_track_source, non_empty_scopes, scope_cte_sql,
};
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::dto::{
    LibraryArtistDto, LibraryEntitySourceDto, LibraryResolveEntitySourcesRequest, LibraryScopePair,
    LibrarySourceEntityType,
};
use crate::store::LibraryStore;

/// The album's cluster key, or `None` when its tracks disagree on one.
///
/// `INDEXED BY idx_track_album` is load-bearing. Without it the planner drives
/// this join from `cluster.track_cluster_key` — an attached database, whose
/// statistics it weighs separately — and scans `track` on every probe. Measured
/// against a ~172k-track library that is ~830ms per call, and the New Releases
/// overlay makes one call per album: 24 albums accounted for **19.9s of a 19.9s
/// request**, with the rest of that request costing 2ms.
///
/// The index is partial (`WHERE deleted = 0`), so the predicate below is part of
/// the contract rather than just a filter: without it the index does not apply
/// and SQLite rejects the hint outright.
pub(crate) const LOOKUP_ALBUM_KEY_SQL: &str = "SELECT CASE WHEN COUNT(*) = COUNT(ck.album_key) \
                       AND COUNT(DISTINCT ck.album_key) = 1 \
                 THEN MIN(ck.album_key) END \
     FROM track t INDEXED BY idx_track_album \
     INNER JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
     WHERE t.server_id = ? AND t.album_id = ? AND t.deleted = 0";

pub(crate) fn lookup_album_key(
    conn: &rusqlite::Connection,
    server_id: &str,
    album_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        LOOKUP_ALBUM_KEY_SQL,
        rusqlite::params![server_id, album_id],
        |r| r.get::<_, Option<String>>(0),
    )
}

pub(super) fn lookup_artist_key(
    conn: &rusqlite::Connection,
    server_id: &str,
    artist_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT ck.artist_key FROM track t \
         INNER JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? AND t.artist_id = ? AND t.deleted = 0 LIMIT 1",
        rusqlite::params![server_id, artist_id],
        // NULL artist_key is by design (empty artist → NULL); read as Option so
        // artist detail for such an entity opens un-merged instead of erroring.
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

/// Canonical name of an artist entity from the `artist` table (the same source the
/// browse list and header use). Independent of whether any track is tagged with the
/// id — needed to detect the "Various Artists" entity even when its compilations
/// link only through `album_artist` and no track carries the VA performer id. Kept
/// name-only so the common artist-detail load does not parse `raw_json`.
pub(super) fn lookup_artist_name(
    conn: &rusqlite::Connection,
    server_id: &str,
    artist_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT name FROM artist WHERE server_id = ? AND id = ? LIMIT 1",
        rusqlite::params![server_id, artist_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

/// The anchor's own `artist` row, used as a header fallback when no track in the
/// scope carries the anchor `artist_id`. Various Artists compilations attach via
/// the `album_artist` label only, so the track-backed candidate query returns
/// nothing for them and the merged header would otherwise have an empty `id` —
/// which the frontend loader treats as "no result" and discards the whole payload.
pub(super) fn lookup_artist_row(
    conn: &rusqlite::Connection,
    server_id: &str,
    artist_id: &str,
) -> rusqlite::Result<Option<LibraryArtistDto>> {
    conn.query_row(
        "SELECT server_id, id, name, album_count, synced_at, raw_json \
         FROM artist WHERE server_id = ? AND id = ? LIMIT 1",
        rusqlite::params![server_id, artist_id],
        |r| {
            let raw: Option<String> = r.get(5)?;
            let name: String = r.get(2)?;
            Ok(LibraryArtistDto {
                server_id: r.get(0)?,
                id: r.get(1)?,
                // Derive the sort key from the name, matching every other candidate
                // builder in this file — otherwise the seeded VA/track-less header
                // reaches the frontend with no `nameSort` and sorts inconsistently.
                name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
                name,
                album_count: r.get(3)?,
                synced_at: r.get(4)?,
                raw_json: raw
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                    .unwrap_or(Value::Null),
            })
        },
    )
    .optional()
}

fn lookup_track_partition(
    conn: &rusqlite::Connection,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<Option<(Option<String>, i64, i64)>> {
    conn.query_row(
        "SELECT ck.cluster_key, ck.duration_sec / 5, ck.occurrence_rank FROM track t \
         INNER JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? AND t.id = ? AND t.deleted = 0 LIMIT 1",
        rusqlite::params![server_id, track_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
}

fn map_entity_source_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryEntitySourceDto> {
    let priority = r.get::<_, i64>(3)?;
    Ok(LibraryEntitySourceDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        library_id: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        priority: u32::try_from(priority).unwrap_or(u32::MAX),
        duration_sec: r.get(4)?,
        suffix: r.get(5)?,
        bit_rate: r.get(6)?,
        size_bytes: r.get(7)?,
        starred_at: r.get(8)?,
        user_rating: r.get(9)?,
    })
}

fn fetch_track_sources(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    cluster_key: Option<&str>,
    duration_bucket: i64,
    occurrence_rank: i64,
    anchor_server: &str,
    anchor_id: &str,
) -> rusqlite::Result<Vec<LibraryEntitySourceDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        cluster_key.map(|_| "cluster_key"),
        "AND t.server_id = ? AND t.id = ?",
    );
    let bucket_filter = if cluster_key.is_some() {
        "AND ck.duration_sec / 5 = ? AND ck.occurrence_rank = ?"
    } else {
        ""
    };
    let sql = format!(
        "{cte} SELECT t.server_id, t.id, t.library_id, {priority}, t.duration_sec, t.suffix, \
         t.bit_rate, t.size_bytes, t.starred_at, t.user_rating \
         {scoped} {key_filter} {bucket_filter} \
         ORDER BY {priority} ASC, t.server_id ASC, t.id ASC"
    );
    let mut binds = scope_binds;
    if let Some(key) = cluster_key {
        binds.push(SqlValue::Text(key.to_string()));
        binds.push(SqlValue::Integer(duration_bucket));
        binds.push(SqlValue::Integer(occurrence_rank));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), map_entity_source_row)?
        .collect();
    rows
}

fn fetch_grouped_entity_sources(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    entity_type: LibrarySourceEntityType,
    identity_key: Option<&str>,
    anchor_server: &str,
    anchor_id: &str,
) -> rusqlite::Result<Vec<LibraryEntitySourceDto>> {
    let (entity_column, cluster_column) = match entity_type {
        LibrarySourceEntityType::Album => ("album_id", "album_key"),
        LibrarySourceEntityType::Artist => ("artist_id", "artist_key"),
        LibrarySourceEntityType::Track => unreachable!("track sources use fetch_track_sources"),
    };
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let fallback_filter = match entity_type {
        LibrarySourceEntityType::Album => "AND t.server_id = ? AND t.album_id = ?",
        LibrarySourceEntityType::Artist => "AND t.server_id = ? AND t.artist_id = ?",
        LibrarySourceEntityType::Track => unreachable!(),
    };
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        identity_key.map(|_| cluster_column),
        fallback_filter,
    );
    let (metadata_join, duration_column, starred_column) = match entity_type {
        LibrarySourceEntityType::Album => (
            "LEFT JOIN album e ON e.server_id = candidates.server_id AND e.id = candidates.entity_id",
            "e.duration_sec",
            "e.starred_at",
        ),
        LibrarySourceEntityType::Artist => ("", "NULL", "NULL"),
        LibrarySourceEntityType::Track => unreachable!(),
    };
    let sql = format!(
        "{cte}, candidates AS ( \
           SELECT t.server_id, t.{entity_column} AS entity_id, t.library_id, {priority} AS pr, \
                  ROW_NUMBER() OVER ( \
                    PARTITION BY t.server_id, t.{entity_column} \
                    ORDER BY {priority} ASC, t.id ASC \
                  ) AS rn \
           {scoped} AND t.{entity_column} IS NOT NULL AND t.{entity_column} != '' {key_filter} \
         ) \
         SELECT candidates.server_id, candidates.entity_id, candidates.library_id, candidates.pr, \
                {duration_column}, NULL, NULL, NULL, {starred_column}, NULL \
         FROM candidates {metadata_join} \
         WHERE candidates.rn = 1 \
         ORDER BY candidates.pr ASC, candidates.server_id ASC, candidates.entity_id ASC"
    );
    let mut binds = scope_binds;
    if let Some(key) = identity_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), map_entity_source_row)?
        .collect();
    rows
}

/// Resolve a concrete anchor to all matching concrete rows in caller-supplied
/// pair priority. Track identity includes browse's fixed five-second bucket.
pub fn resolve_entity_sources(
    store: &LibraryStore,
    request: &LibraryResolveEntitySourcesRequest,
) -> Result<Vec<LibraryEntitySourceDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    let anchor_server = request.anchor_server_id.trim();
    let anchor_id = request.anchor_id.trim();
    if anchor_server.is_empty() || anchor_id.is_empty() {
        return Err("anchor_server_id and anchor_id are required".into());
    }
    crate::identity::ensure_cluster_keys_built(store, anchor_server)?;
    ensure_cluster_keys_for_all_scopes(store, scopes)?;

    store.with_scope_detail_read_conn(|conn| match request.entity_type {
        LibrarySourceEntityType::Track => {
            let Some((cluster_key, duration_bucket, occurrence_rank)) =
                lookup_track_partition(conn, anchor_server, anchor_id)?
            else {
                return Ok(Vec::new());
            };
            fetch_track_sources(
                conn,
                scopes,
                cluster_key.as_deref(),
                duration_bucket,
                occurrence_rank,
                anchor_server,
                anchor_id,
            )
        }
        LibrarySourceEntityType::Album => {
            let key = lookup_album_key(conn, anchor_server, anchor_id)?;
            fetch_grouped_entity_sources(
                conn,
                scopes,
                request.entity_type,
                key.as_deref(),
                anchor_server,
                anchor_id,
            )
        }
        LibrarySourceEntityType::Artist => {
            let key = lookup_artist_key(conn, anchor_server, anchor_id)?;
            fetch_grouped_entity_sources(
                conn,
                scopes,
                request.entity_type,
                key.as_deref(),
                anchor_server,
                anchor_id,
            )
        }
    })
}

//! Advanced Search SQL builder (spec §5.13). PR-5d ships the backend only —
//! the `SearchBrowsePage.tsx` UI wiring stays PR-7 (F2). Cross-server search
//! (§5.5B) lives in the sibling `cross_server` module.
//!
//! The builder turns a `LibraryAdvancedSearchRequest` into one parameterised
//! query per requested entity (track / album / artist), each sharing a WHERE
//! built from the `FilterFieldRegistry` resolution in `filter.rs`. Only
//! builder-supplied column expressions ever reach the SQL string; every value
//! is bound (§5.13.5: parameterised only).

use std::collections::{BTreeSet, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use crate::dto::{
    LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse, LibraryAlbumDto, LibraryArtistDto,
    LibraryFilterClause, LibrarySearchTotals, LibrarySortClause, LibraryTrackDto, SortDir,
};
use crate::filter::{self, EntityKind, FilterOp, SqlFragment};
use crate::repos;
use crate::search::{
    aliased_track_columns, aliased_track_columns_resolved_bpm, bpm_resolved_expr,
    fts_album_prefix_match_query, fts_album_title_prefix_match_query, fts_column_prefix_query, fts_query_meets_min_len,
    fts_track_prefix_match_query, library_scope_equals_sql, like_contains, PAGE_LIMIT_MAX,
};
use crate::store::LibraryStore;

/// `bpm` dual-storage resolution (§5.13.4): prefer analysis `track_fact(bpm)`,
/// then hot `track.bpm` tag, then other fact sources.
fn bpm_resolved_sql() -> String {
    bpm_resolved_expr("t")
}

const ALBUM_COLUMNS: &str = "a.server_id, a.id, a.name, a.artist, a.artist_id, \
  a.song_count, a.duration_sec, \
  COALESCE(a.year, (SELECT MAX(t.year) FROM track t \
    WHERE t.server_id = a.server_id AND t.album_id = a.id AND t.deleted = 0)), \
  a.genre, a.cover_art_id, a.starred_at, a.synced_at, a.raw_json";

const ARTIST_COLUMNS: &str = "ar.server_id, ar.id, ar.name, ar.name_sort, ar.album_count, \
  ar.synced_at, ar.raw_json";

/// Flat track projection used when browsing albums in advanced search.
type AlbumBrowseTrackRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<i64>,
    i64,
);

fn fts_candidate_pool_size(limit: u32, offset: u32) -> i64 {
    let need = limit.saturating_add(offset) as i64;
    need.saturating_mul(20).clamp(256, 10_000)
}

/// FTS rowid pick scoped to the active server (and optional library folder).
fn scoped_fts_rowid_subquery_sql(pool: i64, library_scope: Option<&str>) -> String {
    let alias = "t_fts";
    let mut sql = format!(
        "SELECT f.rowid FROM track_fts f \
         JOIN track {alias} ON {alias}.rowid = f.rowid \
         WHERE track_fts MATCH ? \
           AND {alias}.server_id = ? \
           AND {alias}.deleted = 0"
    );
    if library_scope.is_some() {
        sql.push_str(" AND ");
        sql.push_str(&library_scope_equals_sql(alias));
    }
    sql.push_str(&format!(" ORDER BY bm25(track_fts) LIMIT {pool}"));
    sql
}

fn scoped_fts_pick_join_sql(pool: i64, library_scope: Option<&str>) -> String {
    let alias = "t_fts";
    let mut scope_sql = String::new();
    if library_scope.is_some() {
        scope_sql = format!(" AND {}", library_scope_equals_sql(alias));
    }
    format!(
        "track t INNER JOIN (\
           SELECT f.rowid, bm25(track_fts) AS fts_rank \
           FROM track_fts f \
           JOIN track {alias} ON {alias}.rowid = f.rowid \
           WHERE track_fts MATCH ? \
             AND {alias}.server_id = ? \
             AND {alias}.deleted = 0{scope_sql} \
           ORDER BY fts_rank \
           LIMIT {pool}\
         ) fts_pick ON t.rowid = fts_pick.rowid"
    )
}

fn scoped_fts_subquery_bind(
    server_id: &str,
    library_scope: Option<&str>,
) -> Vec<SqlValue> {
    let mut params = vec![SqlValue::Text(server_id.to_string())];
    if let Some(scope) = library_scope.filter(|s| !s.trim().is_empty()) {
        params.push(SqlValue::Text(scope.to_string()));
    }
    params
}

/// `library_advanced_search` (§5.13). Runs only the queries named in
/// `entityTypes`; absent entities return empty + zero totals.
pub fn run_advanced_search(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
) -> Result<LibraryAdvancedSearchResponse, String> {
    // `query` shorthand → text input; a `text` filter clause is an alias for
    // the same thing. Everything else is a scalar filter.
    let mut text_input: Option<String> = trimmed_nonempty(req.query.as_deref());
    let mut scalar: Vec<&LibraryFilterClause> = Vec::new();
    for c in &req.filters {
        if c.field == "text" {
            if text_input.is_none() {
                if let Some(Value::String(s)) = &c.value {
                    text_input = trimmed_nonempty(Some(s));
                }
            }
        } else {
            scalar.push(c);
        }
    }

    // Up-front validation: an unknown field or an op the registry doesn't
    // declare is an error regardless of entity routing (§5.13.5).
    for c in &scalar {
        let field = filter::lookup(&c.field)
            .ok_or_else(|| filter::FilterError::UnknownField(c.field.clone()).to_string())?;
        if !field.ops.contains(&c.op) {
            return Err(filter::FilterError::UnsupportedOp {
                field: c.field.clone(),
                op: c.op.as_str(),
            }
            .to_string());
        }
    }

    if text_input
        .as_deref()
        .is_some_and(|t| !fts_query_meets_min_len(t))
    {
        return Ok(LibraryAdvancedSearchResponse {
            artists: Vec::new(),
            albums: Vec::new(),
            tracks: Vec::new(),
            totals: LibrarySearchTotals {
                artists: 0,
                albums: 0,
                tracks: 0,
            },
            applied_filters: Vec::new(),
            source: "local".to_string(),
        });
    }

    let limit = req.limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = req.offset;
    let skip_totals = req.skip_totals;
    let text = text_input.as_deref();
    let want = |k: EntityKind| req.entity_types.contains(&k);
    let mut applied: BTreeSet<String> = BTreeSet::new();

    let (artists, artists_total) = if want(EntityKind::Artist) {
        build_artist(store, req, text, &scalar, limit, offset, skip_totals, &mut applied)?
    } else {
        (Vec::new(), 0)
    };
    let (albums, albums_total) = if want(EntityKind::Album) {
        build_album(store, req, text, &scalar, limit, offset, skip_totals, &mut applied)?
    } else {
        (Vec::new(), 0)
    };
    let (tracks, tracks_total) = if want(EntityKind::Track) {
        build_track(store, req, text, &scalar, limit, offset, skip_totals, &mut applied)?
    } else {
        (Vec::new(), 0)
    };

    Ok(LibraryAdvancedSearchResponse {
        artists,
        albums,
        tracks,
        totals: LibrarySearchTotals {
            artists: artists_total,
            albums: albums_total,
            tracks: tracks_total,
        },
        applied_filters: applied.into_iter().collect(),
        source: "local".to_string(),
    })
}

// ── per-entity builders ────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn build_track(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    if req.starred_only == Some(true) {
        w.push_raw("t.starred_at IS NOT NULL");
        applied.insert("starred".to_string());
    }

    let bpm_resolved = scalar.iter().any(|c| c.field == "bpm");
    let cols = if bpm_resolved {
        aliased_track_columns_resolved_bpm("t")
    } else {
        aliased_track_columns("t")
    };
    let map_track = if bpm_resolved {
        map_track_row_resolved_bpm
    } else {
        map_track_row_default
    };
    if let Some(q) = text.and_then(fts_track_prefix_match_query) {
        applied.insert("text".to_string());
        let pool = fts_candidate_pool_size(limit, offset);
        let scope = trimmed_nonempty(req.library_scope.as_deref());
        let from = scoped_fts_pick_join_sql(pool, scope.as_deref());
        let order = order_clause(&req.sort, EntityKind::Track)
            .unwrap_or_else(|| "ORDER BY fts_pick.fts_rank".to_string());
        return query_rows_fts(
            store,
            &cols,
            &from,
            &q,
            &scoped_fts_subquery_bind(&req.server_id, scope.as_deref()),
            &w,
            &order,
            limit,
            offset,
            skip_totals,
            map_track,
        );
    }

    let order = order_clause(&req.sort, EntityKind::Track)
        .unwrap_or_else(|| "ORDER BY t.title COLLATE NOCASE ASC, t.id ASC".to_string());
    query_rows(
        store,
        &cols,
        "track t",
        &w,
        &order,
        limit,
        offset,
        skip_totals,
        map_track,
    )
}

fn map_track_row_default(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrackDto> {
    repos::row_to_track_row(row).map(|r| LibraryTrackDto::from_row(&r))
}

fn map_track_row_resolved_bpm(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrackDto> {
    crate::search::row_to_track_dto_resolved_bpm(row)
}

/// Sync is track-first; the `album` table is often empty or holds only
/// patch-on-use stubs. Normal browse must not treat a handful of album rows
/// as the full catalog.
fn server_has_indexed_tracks(store: &LibraryStore, server_id: &str) -> Result<bool, String> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT 1 FROM track WHERE server_id = ?1 AND deleted = 0 LIMIT 1",
                params![server_id],
                |_| Ok(()),
            )
            .optional()
            .map(|r| r.is_some())
        })
        .map_err(|e| e.to_string())
}

fn fts_album_text_match_query(req: &LibraryAdvancedSearchRequest, text: &str) -> Option<String> {
    if req.query_album_title_only == Some(true) {
        fts_album_title_prefix_match_query(text)
    } else {
        fts_album_prefix_match_query(text)
    }
}

#[allow(clippy::too_many_arguments)]
fn build_album(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    if scalar_requires_lossless_track_grouping(scalar) {
        return build_album_from_tracks(
            store, req, text, scalar, limit, offset, skip_totals, applied, true,
        );
    }
    // Album browse favorites: album-level stars only (`a.starred_at`), not
    // track-derived groups with `t.starred_at`.
    if req.starred_only == Some(true) {
        return build_album_from_table(store, req, text, scalar, limit, offset, skip_totals, applied);
    }
    if server_has_indexed_tracks(store, &req.server_id)? {
        if let Some(q) = text.and_then(|t| fts_album_text_match_query(req, t)) {
            return build_album_from_fts(store, req, &q, scalar, limit, offset, skip_totals, applied);
        }
        return build_album_from_tracks(
            store, req, text, scalar, limit, offset, skip_totals, applied, false,
        );
    }
    if !scalar_requires_track_derived_entities(scalar) {
        let table = build_album_from_table(store, req, text, scalar, limit, offset, skip_totals, applied)?;
        if !table.0.is_empty() || table.1 > 0 {
            return Ok(table);
        }
    }
    if let Some(q) = text.and_then(|t| fts_album_text_match_query(req, t)) {
        return build_album_from_fts(store, req, &q, scalar, limit, offset, skip_totals, applied);
    }
    build_album_from_tracks(
        store, req, text, scalar, limit, offset, skip_totals, applied, false,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_album_from_table(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    // `album` has no `library_id` / `deleted` columns, so `libraryScope` is
    // a track-only filter (P20) and does not narrow album-table results.
    let mut w = WhereBuilder::new();
    w.push_param("a.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(t) = text {
        w.push_param("a.name LIKE ? ESCAPE '\\'", SqlValue::Text(like_contains(t)));
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Album)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    if req.starred_only == Some(true) {
        w.push_raw("a.starred_at IS NOT NULL");
        applied.insert("starred".to_string());
    }
    push_album_id_allowlist(
        &mut w,
        "a.id",
        req.restrict_album_ids.as_deref(),
        applied,
    );

    let order = order_clause(&req.sort, EntityKind::Album)
        .unwrap_or_else(|| "ORDER BY a.name COLLATE NOCASE ASC, a.id ASC".to_string());
    query_rows(
        store,
        ALBUM_COLUMNS,
        "album a",
        &w,
        &order,
        limit,
        offset,
        skip_totals,
        map_album,
    )
}

/// Album rows derived from synced tracks when the dedicated `album` table
/// has no matching rows (N1 / S1 ingest only writes tracks today).
#[allow(clippy::too_many_arguments)]
fn build_album_from_tracks(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
    include_album_table_rows: bool,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.album_id IS NOT NULL AND t.album_id != ''");
    if !include_album_table_rows {
        // Skip track groups only when the album table has a full row (synced
        // metadata). Patch-on-use stubs omit `song_count` and must not hide the
        // track-derived catalog entry.
        w.push_raw(
            "NOT EXISTS (SELECT 1 FROM album a WHERE a.server_id = t.server_id \
             AND a.id = t.album_id AND a.song_count IS NOT NULL)",
        );
    }
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    if let Some(t) = text {
        w.push_param("t.album LIKE ? ESCAPE '\\'", SqlValue::Text(like_contains(t)));
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    if req.starred_only == Some(true) {
        w.push_raw("t.starred_at IS NOT NULL");
        applied.insert("starred".to_string());
    }
    push_album_id_allowlist(
        &mut w,
        "t.album_id",
        req.restrict_album_ids.as_deref(),
        applied,
    );

    let select = "t.server_id, t.album_id, MAX(t.album), MAX(t.artist), MAX(t.artist_id), \
        MAX(t.album_artist), COUNT(*), SUM(t.duration_sec), MAX(t.year), MAX(t.genre), \
        MAX(t.cover_art_id), MAX(t.starred_at), MAX(t.synced_at)";
    let order = album_order_from_track_groups(&req.sort).unwrap_or_else(|| {
        "ORDER BY MAX(t.album) COLLATE NOCASE ASC, t.album_id ASC".to_string()
    });
    query_grouped_rows(
        store,
        select,
        "track t",
        &w,
        "GROUP BY t.album_id",
        &order,
        limit,
        offset,
        skip_totals,
        map_album_from_tracks,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_artist(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    if !scalar_requires_track_derived_entities(scalar) {
        let table = build_artist_from_table(store, req, text, scalar, limit, offset, skip_totals, applied)?;
        if !table.0.is_empty() || table.1 > 0 {
            return Ok(table);
        }
    }
    if let Some(q) = text.and_then(|t| fts_column_prefix_query("artist", t)) {
        return build_artist_from_fts(store, req, &q, scalar, limit, offset, skip_totals, applied);
    }
    build_artist_from_tracks(store, req, text, scalar, limit, offset, skip_totals, applied)
}

#[allow(clippy::too_many_arguments)]
fn build_artist_from_table(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_param("ar.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(t) = text {
        w.push_param("ar.name LIKE ? ESCAPE '\\'", SqlValue::Text(like_contains(t)));
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Artist)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    let order = order_clause(&req.sort, EntityKind::Artist)
        .unwrap_or_else(|| {
            "ORDER BY COALESCE(ar.name_sort, ar.name) COLLATE NOCASE ASC, ar.id ASC".to_string()
        });
    query_rows(
        store,
        ARTIST_COLUMNS,
        "artist ar",
        &w,
        &order,
        limit,
        offset,
        skip_totals,
        map_artist,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_artist_from_tracks(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.artist_id IS NOT NULL AND t.artist_id != ''");
    w.push_raw(
        "NOT EXISTS (SELECT 1 FROM artist ar WHERE ar.server_id = t.server_id AND ar.id = t.artist_id)",
    );
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    if let Some(t) = text {
        w.push_param("t.artist LIKE ? ESCAPE '\\'", SqlValue::Text(like_contains(t)));
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let select = "t.server_id, t.artist_id, MAX(t.artist), COUNT(DISTINCT t.album_id), MAX(t.synced_at)";
    let order = order_clause(&req.sort, EntityKind::Artist).unwrap_or_else(|| {
        "ORDER BY MAX(t.artist) COLLATE NOCASE ASC, t.artist_id ASC".to_string()
    });
    query_grouped_rows(
        store,
        select,
        "track t",
        &w,
        "GROUP BY t.artist_id",
        &order,
        limit,
        offset,
        skip_totals,
        map_artist_from_tracks,
    )
}

/// Text search for albums when the `album` table is empty — one FTS pass +
/// in-memory dedupe by `album_id` (same strategy as live search / §5.9).
#[allow(clippy::too_many_arguments)]
fn build_album_from_fts(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    fts: &str,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    applied.insert("text".to_string());
    let need = limit.saturating_add(offset) as i64;
    let pool = (need.saturating_mul(8)).clamp(64, 2_000);
    let scope = trimmed_nonempty(req.library_scope.as_deref());

    let mut w = WhereBuilder::new();
    w.push_params(
        &format!(
            "t.rowid IN ({})",
            scoped_fts_rowid_subquery_sql(pool, scope.as_deref())
        ),
        {
            let mut p = vec![SqlValue::Text(fts.to_string())];
            p.extend(scoped_fts_subquery_bind(&req.server_id, scope.as_deref()));
            p
        },
    );
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.album_id IS NOT NULL AND t.album_id != ''");
    if let Some(scope) = scope {
        let clause = library_scope_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    if req.starred_only == Some(true) {
        w.push_raw("t.starred_at IS NOT NULL");
        applied.insert("starred".to_string());
    }
    push_album_id_allowlist(
        &mut w,
        "t.album_id",
        req.restrict_album_ids.as_deref(),
        applied,
    );

    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT t.server_id, t.album_id, t.album, t.artist, t.album_artist, t.artist_id, \
                    t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at \
             FROM track t \
             WHERE {where_sql}"
        );
        let params = w.params.clone();
        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<AlbumBrowseTrackRow> =
            stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut seen = HashSet::new();
        let mut deduped: Vec<LibraryAlbumDto> = Vec::new();
        for (
            server_id,
            album_id,
            album,
            track_artist,
            album_artist,
            artist_id,
            year,
            genre,
            cover_art_id,
            starred_at,
            synced_at,
        ) in rows
        {
            if !seen.insert(album_id.clone()) {
                continue;
            }
            deduped.push(LibraryAlbumDto {
                server_id,
                id: album_id,
                name: album,
                artist: crate::album_compilation_filter::pick_album_group_artist(
                    track_artist,
                    album_artist,
                ),
                artist_id,
                song_count: None,
                duration_sec: None,
                year,
                genre,
                cover_art_id,
                starred_at,
                synced_at,
                raw_json: Value::Null,
            });
            if deduped.len() >= need as usize {
                break;
            }
        }

        let total = if skip_totals {
            0
        } else {
            deduped.len() as u32
        };
        let page = deduped
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        Ok((page, total))
    })
}

/// Text search for artists when the `artist` table is empty — FTS + dedupe.
#[allow(clippy::too_many_arguments)]
fn build_artist_from_fts(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    fts: &str,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    applied.insert("text".to_string());
    let need = limit.saturating_add(offset) as i64;
    let pool = (need.saturating_mul(8)).clamp(64, 2_000);
    let scope = trimmed_nonempty(req.library_scope.as_deref());

    let mut w = WhereBuilder::new();
    w.push_params(
        &format!(
            "t.rowid IN ({})",
            scoped_fts_rowid_subquery_sql(pool, scope.as_deref())
        ),
        {
            let mut p = vec![SqlValue::Text(fts.to_string())];
            p.extend(scoped_fts_subquery_bind(&req.server_id, scope.as_deref()));
            p
        },
    );
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.artist_id IS NOT NULL AND t.artist_id != ''");
    if let Some(scope) = scope {
        let clause = library_scope_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT t.server_id, t.artist_id, t.artist, t.synced_at \
             FROM track t \
             WHERE {where_sql}"
        );
        let params = w.params.clone();
        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<(String, String, Option<String>, i64)> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut seen = HashSet::new();
        let mut deduped: Vec<LibraryArtistDto> = Vec::new();
        for (server_id, artist_id, artist, synced_at) in rows {
            if !seen.insert(artist_id.clone()) {
                continue;
            }
            let name = artist.unwrap_or_default();
            let name_sort = crate::artist_sort::sort_key_for_display_name(
                &name,
                crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
            );
            deduped.push(LibraryArtistDto {
                server_id,
                id: artist_id,
                name,
                name_sort: Some(name_sort),
                album_count: None,
                synced_at,
                raw_json: Value::Null,
            });
            if deduped.len() >= need as usize {
                break;
            }
        }

        let total = if skip_totals {
            0
        } else {
            deduped.len() as u32
        };
        let page = deduped
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        Ok((page, total))
    })
}

// ── clause resolution ──────────────────────────────────────────────────

/// Track-only filters that require joining through `track` (mood enrichment facts).
/// Other track-only fields (e.g. `bpm`) are skipped silently on album/artist queries.
fn scalar_requires_track_derived_entities(scalar: &[&LibraryFilterClause]) -> bool {
    scalar
        .iter()
        .any(|c| matches!(c.field.as_str(), "mood_group" | "mood_tag"))
}

/// Lossless is defined on track `suffix`; year/genre filters must apply to the
/// same track rows, not stale `album` table metadata.
fn scalar_requires_lossless_track_grouping(scalar: &[&LibraryFilterClause]) -> bool {
    scalar.iter().any(|c| c.field == "lossless")
}

/// Resolve one scalar clause to a WHERE fragment for `entity`. `Ok(None)`
/// means the field is known but doesn't route to this entity (§5.13.3 skip).
fn resolve_clause(
    c: &LibraryFilterClause,
    entity: EntityKind,
) -> Result<Option<SqlFragment>, String> {
    let applies = filter::validate_for_entity(&c.field, c.op, entity).map_err(|e| e.to_string())?;
    if !applies {
        return Ok(None);
    }
    if c.field == "bpm" && entity == EntityKind::Track {
        let col = bpm_resolved_sql();
        let value = json_to_opt_i64(&c.field, c.value.as_ref())?;
        let value_to = json_to_opt_i64(&c.field, c.value_to.as_ref())?;
        return filter::compare_fragment(&c.field, &col, c.op, value, value_to)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    let col = match (c.field.as_str(), entity) {
        ("genre", EntityKind::Track) => "t.genre",
        ("genre", EntityKind::Album) => "a.genre",
        ("year", EntityKind::Track) => "t.year",
        ("year", EntityKind::Album) => "a.year",
        ("starred", EntityKind::Track) => "t.starred_at",
        ("starred", EntityKind::Album) => "a.starred_at",
        // `artist` has no `starred_at` column — favorites use the network list.
        ("starred", EntityKind::Artist) => return Ok(None),
        ("mood_group" | "mood_tag", EntityKind::Track) => {
            return crate::advanced_search_mood::resolve_mood_clause(c);
        }
        ("lossless", EntityKind::Track) => {
            return Ok(Some(SqlFragment {
                sql: crate::lossless_formats::track_is_lossless_sql("t"),
                params: vec![],
            }));
        }
        ("lossless", EntityKind::Album) => {
            return Ok(Some(SqlFragment {
                sql: crate::lossless_formats::album_has_lossless_track_sql("a"),
                params: vec![],
            }));
        }
        ("lossless", EntityKind::Artist) => {
            return Ok(Some(SqlFragment {
                sql: crate::lossless_formats::artist_has_lossless_track_sql("ar"),
                params: vec![],
            }));
        }
        ("compilation", EntityKind::Album) => {
            return compilation_filter_fragment(&c.field, c.op, c.value.as_ref(), EntityKind::Album);
        }
        ("compilation", EntityKind::Track) => {
            return compilation_filter_fragment(&c.field, c.op, c.value.as_ref(), EntityKind::Track);
        }
        ("compilation", _) => return Ok(None),
        // `text` is handled by the entity builder (FTS / LIKE), never here.
        ("text", _) => return Ok(None),
        // Registered but no v1 SQL builder (user_rating / suffix / bit_rate).
        _ => return Err(filter::FilterError::NotQueryable(c.field.clone()).to_string()),
    };

    if c.field == "genre" {
        let v = json_to_text(&c.field, c.value.as_ref())?;
        let sql = match entity {
            EntityKind::Track => {
                "EXISTS (SELECT 1 FROM track_genre tg \
                 WHERE tg.server_id = t.server_id AND tg.track_id = t.id \
                   AND tg.genre = ? COLLATE NOCASE)"
                    .to_string()
            }
            EntityKind::Album => {
                "EXISTS (SELECT 1 FROM track_genre tg \
                 WHERE tg.server_id = a.server_id AND tg.album_id = a.id \
                   AND tg.genre = ? COLLATE NOCASE)"
                    .to_string()
            }
            _ => {
                return Err(filter::FilterError::NotQueryable(c.field.clone()).to_string());
            }
        };
        return Ok(Some(SqlFragment {
            sql,
            params: vec![v],
        }));
    }
    if c.field == "starred" {
        return filter::compare_fragment(&c.field, col, FilterOp::IsTrue, None, None)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    // Numeric fields: year / bpm.
    let value = json_to_opt_i64(&c.field, c.value.as_ref())?;
    let value_to = json_to_opt_i64(&c.field, c.value_to.as_ref())?;
    filter::compare_fragment(&c.field, col, c.op, value, value_to)
        .map(Some)
        .map_err(|e| e.to_string())
}

// ── query execution ────────────────────────────────────────────────────

/// Cap full-table FTS counts — exact totals on 100k+ hits are not worth
/// blocking the UI for tens of seconds (§5.9 p95 budget).
const FTS_MATCH_COUNT_CAP: i64 = 10_001;

fn count_matching_rows(
    conn: &rusqlite::Connection,
    from: &str,
    where_sql: &str,
    params: &[SqlValue],
    skip_totals: bool,
) -> Result<u32, rusqlite::Error> {
    if skip_totals {
        return Ok(0);
    }
    if from.contains("track_fts") {
        let mut bound: Vec<SqlValue> = params.to_vec();
        bound.push(SqlValue::Integer(FTS_MATCH_COUNT_CAP));
        let count_sql = format!(
            "SELECT COUNT(*) FROM (SELECT 1 FROM {from} WHERE {where_sql} LIMIT ?)"
        );
        let n: i64 = conn.query_row(
            &count_sql,
            rusqlite::params_from_iter(bound.iter()),
            |r| r.get(0),
        )?;
        return Ok(n.max(0) as u32);
    }
    let count_sql = format!("SELECT COUNT(*) FROM {from} WHERE {where_sql}");
    let n: i64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u32)
}

/// Restrict album browse to an explicit id set (server favorites ∩ local filters).
fn push_album_id_allowlist(
    w: &mut WhereBuilder,
    column: &str,
    ids: Option<&[String]>,
    applied: &mut BTreeSet<String>,
) {
    let Some(ids) = ids else {
        return;
    };
    applied.insert("albumIds".to_string());
    if ids.is_empty() {
        w.push_raw("1 = 0");
        return;
    }
    let placeholders = std::iter::repeat_n("?", ids.len()).collect::<Vec<_>>().join(", ");
    let sql = format!("{column} IN ({placeholders})");
    let params = ids
        .iter()
        .map(|id| SqlValue::Text(id.clone()))
        .collect();
    w.push_params(&sql, params);
}

/// Accumulates `AND`-joined WHERE clauses and their positional params in
/// lockstep so anonymous `?` placeholders bind left-to-right.
struct WhereBuilder {
    clauses: Vec<String>,
    params: Vec<SqlValue>,
}

impl WhereBuilder {
    fn new() -> Self {
        Self {
            clauses: Vec::new(),
            params: Vec::new(),
        }
    }
    fn push(&mut self, frag: SqlFragment) {
        self.clauses.push(frag.sql);
        self.params.extend(frag.params);
    }
    fn push_raw(&mut self, sql: &str) {
        self.clauses.push(sql.to_string());
    }
    fn push_param(&mut self, sql: &str, param: SqlValue) {
        self.clauses.push(sql.to_string());
        self.params.push(param);
    }
    fn push_params(&mut self, sql: &str, params: Vec<SqlValue>) {
        self.clauses.push(sql.to_string());
        self.params.extend(params);
    }
    fn where_sql(&self) -> String {
        self.clauses.join(" AND ")
    }
}

/// Run the COUNT (full match total) + the paged SELECT in one connection
/// borrow. Both share `where`'s params; the page appends `LIMIT ? OFFSET ?`.
#[allow(clippy::too_many_arguments)]
fn query_rows<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    w: &WhereBuilder,
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let total = count_matching_rows(conn, from, &where_sql, &w.params, skip_totals)?;

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        let mut page_params: Vec<SqlValue> = w.params.clone();
        page_params.push(SqlValue::Integer(limit as i64));
        page_params.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        let collected: rusqlite::Result<Vec<T>> = stmt
            .query_map(rusqlite::params_from_iter(page_params.iter()), |r| map(r))?
            .collect();
        let rows = collected?;
        Ok((rows, total))
    })
}

/// Track search with FTS rowid prefilter — MATCH param is bound first (subquery in `from`).
#[allow(clippy::too_many_arguments)]
fn query_rows_fts<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    fts_match: &str,
    fts_subquery_params: &[SqlValue],
    w: &WhereBuilder,
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let mut bind: Vec<SqlValue> = vec![SqlValue::Text(fts_match.to_string())];
        bind.extend(fts_subquery_params.iter().cloned());
        bind.extend(w.params.iter().cloned());

        let total = count_matching_rows(conn, from, &where_sql, &bind, skip_totals)?;

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        bind.push(SqlValue::Integer(limit as i64));
        bind.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), |r| map(r))?
            .collect::<rusqlite::Result<Vec<T>>>()?;
        Ok((rows, total))
    })
}

/// Grouped SELECT (album/artist rows derived from `track`). Skips COUNT when
/// `skip_totals` — Live Search only needs the first page.
#[allow(clippy::too_many_arguments)]
fn query_grouped_rows<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    w: &WhereBuilder,
    group_sql: &str,
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let total = if skip_totals {
            0u32
        } else {
            // Grouped browse totals must count distinct groups (album/artist rows),
            // not raw track rows matching the WHERE clause.
            let count_sql = format!(
                "SELECT COUNT(*) FROM (SELECT 1 FROM {from} WHERE {where_sql} {group_sql})"
            );
            let n: i64 = conn.query_row(
                &count_sql,
                rusqlite::params_from_iter(w.params.iter()),
                |r| r.get(0),
            )?;
            n.max(0) as u32
        };

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {group_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        let mut page_params: Vec<SqlValue> = w.params.clone();
        page_params.push(SqlValue::Integer(limit as i64));
        page_params.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        let collected: rusqlite::Result<Vec<T>> = stmt
            .query_map(rusqlite::params_from_iter(page_params.iter()), |r| map(r))?
            .collect();
        let rows = collected?;
        Ok((rows, total))
    })
}

// ── row mappers ────────────────────────────────────────────────────────

fn map_album(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    let raw: Option<String> = r.get(12)?;
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: r.get(3)?,
        artist_id: r.get(4)?,
        song_count: r.get(5)?,
        duration_sec: r.get(6)?,
        year: r.get(7)?,
        genre: r.get(8)?,
        cover_art_id: r.get(9)?,
        starred_at: r.get(10)?,
        synced_at: r.get(11)?,
        raw_json: parse_raw_json(raw),
    })
}

fn map_artist(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    let raw: Option<String> = r.get(6)?;
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        name_sort: r.get(3)?,
        album_count: r.get(4)?,
        synced_at: r.get(5)?,
        raw_json: parse_raw_json(raw),
    })
}

fn map_album_from_tracks(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    let track_artist: Option<String> = r.get(3)?;
    let album_artist: Option<String> = r.get(5)?;
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: crate::album_compilation_filter::pick_album_group_artist(track_artist, album_artist),
        artist_id: r.get(4)?,
        song_count: Some(r.get(6)?),
        duration_sec: Some(r.get(7)?),
        year: r.get(8)?,
        genre: r.get(9)?,
        cover_art_id: r.get(10)?,
        starred_at: r.get(11)?,
        synced_at: r.get(12)?,
        raw_json: Value::Null,
    })
}

fn map_artist_from_tracks(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    let name: String = r.get(2)?;
    let name_sort = crate::artist_sort::sort_key_for_display_name(
        &name,
        crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
    );
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name,
        name_sort: Some(name_sort),
        album_count: Some(r.get(3)?),
        synced_at: r.get(4)?,
        raw_json: Value::Null,
    })
}

fn parse_raw_json(raw: Option<String>) -> Value {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

// ── small helpers ──────────────────────────────────────────────────────

fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn order_clause(sort: &[LibrarySortClause], entity: EntityKind) -> Option<String> {
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        if let Some(col) = sort_column(&s.field, entity) {
            let dir = match s.dir {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            keys.push(format!("{col} {dir}"));
        }
    }
    if keys.is_empty() {
        None
    } else {
        Some(format!("ORDER BY {}", keys.join(", ")))
    }
}

/// Sort for album rows aggregated from `track t` (`GROUP BY t.album_id`).
/// Must not reference `album a` — that alias is absent in this query shape.
fn album_order_from_track_groups(sort: &[LibrarySortClause]) -> Option<String> {
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        let col = match s.field.as_str() {
            "name" => "MAX(t.album) COLLATE NOCASE",
            "artist" => "MAX(t.artist) COLLATE NOCASE",
            "year" => "MAX(t.year)",
            "random" => "RANDOM()",
            _ => continue,
        };
        let dir = match s.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        keys.push(format!("{col} {dir}"));
    }
    if keys.is_empty() {
        None
    } else {
        Some(format!("ORDER BY {}", keys.join(", ")))
    }
}

/// Allowlist of sortable fields per entity → trusted column expression.
/// Unknown sort fields are ignored (fall back to the default order).
fn sort_column(field: &str, entity: EntityKind) -> Option<&'static str> {
    match (field, entity) {
        ("title", EntityKind::Track) => Some("t.title COLLATE NOCASE"),
        ("year", EntityKind::Track) => Some("t.year"),
        ("duration", EntityKind::Track) => Some("t.duration_sec"),
        ("artist", EntityKind::Track) => Some("t.artist COLLATE NOCASE"),
        ("album", EntityKind::Track) => Some("t.album COLLATE NOCASE"),
        ("track_number", EntityKind::Track) => Some("t.track_number"),
        ("play_count", EntityKind::Track) => Some("t.play_count"),
        ("name", EntityKind::Album) => Some("a.name COLLATE NOCASE"),
        ("year", EntityKind::Album) => Some("a.year"),
        ("artist", EntityKind::Album) => Some("a.artist COLLATE NOCASE"),
        ("name", EntityKind::Artist) => Some("COALESCE(ar.name_sort, ar.name) COLLATE NOCASE"),
        // SQLite built-in: ORDER BY RANDOM() LIMIT N — fast pseudo-random sample,
        // no index scan needed beyond the row-id range. Direction is ignored.
        ("random", _) => Some("RANDOM()"),
        _ => None,
    }
}

fn compilation_filter_fragment(
    field: &str,
    op: FilterOp,
    value: Option<&Value>,
    kind: EntityKind,
) -> Result<Option<SqlFragment>, String> {
    let comp_sql = match kind {
        EntityKind::Album => crate::album_compilation_filter::compilation_predicate_sql(
            "a",
            Some("a.artist"),
            None,
        ),
        EntityKind::Track => crate::album_compilation_filter::compilation_predicate_sql(
            "t",
            Some("t.artist"),
            Some("t.album_artist"),
        ),
        _ => crate::album_compilation_filter::compilation_raw_json_sql("t"),
    };
    match op {
        FilterOp::IsTrue => Ok(Some(SqlFragment {
            sql: comp_sql,
            params: vec![],
        })),
        FilterOp::Eq => {
            let want_comp = json_to_bool(field, value)?;
            let sql = if want_comp {
                comp_sql
            } else {
                format!("NOT ({comp_sql})")
            };
            Ok(Some(SqlFragment { sql, params: vec![] }))
        }
        _ => Err(filter::FilterError::UnsupportedOp {
            field: field.to_string(),
            op: op.as_str(),
        }
        .to_string()),
    }
}

fn json_to_bool(field: &str, v: Option<&Value>) -> Result<bool, String> {
    match v {
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::Number(n)) => Ok(n.as_i64() == Some(1)),
        Some(Value::String(s)) => Ok(matches!(s.as_str(), "1" | "true" | "TRUE")),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected boolean".to_string(),
        }
        .to_string()),
    }
}

fn json_to_text(field: &str, v: Option<&Value>) -> Result<SqlValue, String> {
    match v {
        Some(Value::String(s)) => Ok(SqlValue::Text(s.clone())),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected a string value".to_string(),
        }
        .to_string()),
    }
}

fn json_to_opt_i64(field: &str, v: Option<&Value>) -> Result<Option<SqlValue>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(|i| Some(SqlValue::Integer(i)))
            .ok_or_else(|| {
                filter::FilterError::BadValue {
                    field: field.to_string(),
                    detail: "expected an integer value".to_string(),
                }
                .to_string()
            }),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected a numeric value".to_string(),
        }
        .to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::SortDir;
    use crate::repos::{TrackRepository, TrackRow};
    use serde_json::json;

    // ── fixtures ───────────────────────────────────────────────────────

    fn track(server: &str, id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(format!("ar_{artist}")),
            album: album.into(),
            album_id: Some(format!("al_{album}")),
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn insert_album(store: &LibraryStore, server: &str, id: &str, name: &str, year: Option<i64>, genre: Option<&str>) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, year, genre, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, '{}')",
                    rusqlite::params![server, id, name, year, genre],
                )
            })
            .unwrap();
    }

    fn insert_artist(store: &LibraryStore, server: &str, id: &str, name: &str) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, 1, '{}')",
                    rusqlite::params![server, id, name],
                )
            })
            .unwrap();
    }

    fn req(server: &str, entities: &[EntityKind]) -> LibraryAdvancedSearchRequest {
        LibraryAdvancedSearchRequest {
            server_id: server.into(),
            library_scope: None,
            query: None,
            entity_types: entities.to_vec(),
            filters: Vec::new(),
            starred_only: None,
            restrict_album_ids: None,
            query_album_title_only: None,
            sort: Vec::new(),
            limit: 50,
            offset: 0,
            skip_totals: false,
        }
    }

    fn clause(field: &str, op: FilterOp, value: Option<Value>, value_to: Option<Value>) -> LibraryFilterClause {
        LibraryFilterClause {
            field: field.into(),
            op,
            value,
            value_to,
        }
    }

    // ── text / FTS ─────────────────────────────────────────────────────

    #[test]
    fn text_prefix_query_matches_partial_artist_name() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Enter Sandman", "Metallica", "Metallica"),
                track("s1", "t2", "Other", "Other Artist", "Other Album"),
            ])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.query = Some("metal".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].artist.as_deref(), Some("Metallica"));
    }

    #[test]
    fn text_query_matches_track_via_fts() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora", "Anna", "Skylines"),
                track("s1", "t2", "Sunset", "Beth", "Skylines"),
            ])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.query = Some("aurora".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
        assert_eq!(resp.totals.tracks, 1);
        assert!(resp.applied_filters.contains(&"text".to_string()));
        assert_eq!(resp.source, "local");
    }

    #[test]
    fn text_query_matches_album_and_artist_via_like() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Aurora Nights", None, None);
        insert_album(&store, "s1", "al2", "Other", None, None);
        insert_artist(&store, "s1", "ar1", "Aurora Quartet");
        let mut r = req("s1", &[EntityKind::Album, EntityKind::Artist]);
        r.query = Some("aurora".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al1");
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].id, "ar1");
    }

    #[test]
    fn text_query_derives_album_and_artist_from_tracks_when_tables_empty() {
        let store = LibraryStore::open_in_memory();
        let mut t1 = track("s1", "t1", "Song One", "Aurora Quartet", "Aurora Nights");
        t1.cover_art_id = Some("cv1".into());
        TrackRepository::new(&store)
            .upsert_batch(&[
                t1,
                track("s1", "t2", "Song Two", "Other Artist", "Other Album"),
            ])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album, EntityKind::Artist]);
        r.query = Some("aurora".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_Aurora Nights");
        assert_eq!(resp.albums[0].cover_art_id.as_deref(), Some("cv1"));
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].id, "ar_Aurora Quartet");
    }

    #[test]
    fn special_chars_in_query_do_not_crash_fts() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Hello World", "A", "B")])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        // Each of these is a raw FTS5 syntax error if passed unescaped; the
        // builder must quote them into safe terms so the call returns Ok.
        for q in ["\"", "AND", "foo*", "a OR b", "((", "near/"] {
            r.query = Some(q.to_string());
            assert!(
                run_advanced_search(&store, &r).is_ok(),
                "query `{q}` must not raise an FTS syntax error"
            );
        }
    }

    #[test]
    fn quoted_token_query_still_matches_clean_terms() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Hello World", "A", "B")])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        // Multi-token query AND-s its terms — both present → one hit.
        r.query = Some("hello world".into());
        assert_eq!(run_advanced_search(&store, &r).unwrap().tracks.len(), 1);
    }

    // ── genre / year / starred ─────────────────────────────────────────

    #[test]
    fn genre_filter_is_case_insensitive() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.genre = Some("Ambient".into());
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.genre = Some("Techno".into());
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("genre", FilterOp::Eq, Some(json!("ambient")), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
        assert!(resp.applied_filters.contains(&"genre".to_string()));
    }

    #[test]
    fn grouped_album_totals_count_distinct_albums_not_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut rows: Vec<TrackRow> = Vec::new();
        for i in 0..6 {
            let mut t = track("s1", &format!("t{i}"), &format!("Song {i}"), "X", "Alb One");
            t.genre = Some("Rock".into());
            rows.push(t);
        }
        for i in 6..10 {
            let mut t = track("s1", &format!("t{i}"), &format!("Song {i}"), "Y", "Alb Two");
            t.genre = Some("Rock".into());
            rows.push(t);
        }
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("genre", FilterOp::Eq, Some(json!("rock")), None)];
        r.limit = 1;
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1, "page is capped by limit");
        assert_eq!(
            resp.totals.albums, 2,
            "total must be distinct album groups, not matching track rows"
        );
        assert_eq!(resp.totals.tracks, 0);
    }

    #[test]
    fn year_between_is_inclusive() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.year = Some(2000);
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.year = Some(2010);
        let mut c = track("s1", "t3", "C", "X", "Alb");
        c.year = Some(2011);
        TrackRepository::new(&store).upsert_batch(&[a, b, c]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("year", FilterOp::Between, Some(json!(2000)), Some(json!(2010)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t1", "t2"]);
    }

    #[test]
    fn year_only_branch_runs_without_fts() {
        // Genre/year-only (no query) must not require an FTS join (§5.13.7).
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.year = Some(1999);
        TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("year", FilterOp::Gte, Some(json!(1999)), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert!(!resp.applied_filters.contains(&"text".to_string()));
    }

    #[test]
    fn starred_only_filters_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.starred_at = Some(123);
        let b = track("s1", "t2", "B", "X", "Alb");
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.starred_only = Some(true);
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn normal_album_browse_uses_track_catalog_when_album_table_is_sparse() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al_stub", "Starred Stub", None, None);
        store
            .with_conn("misc", |c| {
                c.execute(
                    "UPDATE album SET starred_at = 100 WHERE server_id = 's1' AND id = 'al_stub'",
                    [],
                )
            })
            .unwrap();
        let mut a = track("s1", "t1", "A", "X", "Album A");
        a.album_id = Some("al_a".into());
        let mut b = track("s1", "t2", "B", "Y", "Album B");
        b.album_id = Some("al_b".into());
        TrackRepository::new(&store)
            .upsert_batch(&[a, b])
            .unwrap();
        let r = req("s1", &[EntityKind::Album]);
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.albums.iter().map(|a| a.id.as_str()).collect();
        assert!(ids.contains(&"al_a"));
        assert!(ids.contains(&"al_b"));
        assert!(!ids.contains(&"al_stub"));
    }

    #[test]
    fn starred_only_album_entity_uses_album_star_not_track_star() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al_star", "Starred Album", None, None);
        store
            .with_conn("misc", |c| {
                c.execute(
                    "UPDATE album SET starred_at = 100 WHERE server_id = 's1' AND id = 'al_star'",
                    [],
                )
            })
            .unwrap();
        let mut track_star = track("s1", "t1", "T", "X", "TrackStar Alb");
        track_star.album_id = Some("al_track_only".into());
        track_star.starred_at = Some(200);
        TrackRepository::new(&store)
            .upsert_batch(&[track_star])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.starred_only = Some(true);
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_star");
    }

    // ── bpm dual storage ───────────────────────────────────────────────

    #[test]
    fn bpm_filter_matches_hot_column() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.bpm = Some(125);
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.bpm = Some(90);
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(120)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn bpm_filter_falls_back_to_track_fact() {
        let store = LibraryStore::open_in_memory();
        // No hot `bpm`; an analysis fact carries it instead.
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
            .unwrap();
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO track_fact \
                     (server_id, track_id, fact_kind, value_int, source_kind, source_id, confidence, fetched_at) \
                     VALUES ('s1', 't1', 'bpm', 128, 'analysis', 'seed', 1.0, 1)",
                    [],
                )
            })
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(125)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1, "bpm should resolve via track_fact fallback");
        assert_eq!(resp.tracks[0].bpm, Some(128));
        assert_eq!(resp.tracks[0].bpm_source.as_deref(), Some("analysis"));
    }

    #[test]
    fn bpm_filter_prefers_analysis_fact_over_hot_tag() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.bpm = Some(90);
        TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO track_fact \
                     (server_id, track_id, fact_kind, value_int, source_kind, source_id, confidence, fetched_at) \
                     VALUES ('s1', 't1', 'bpm', 128, 'analysis', 'oximedia-60s-center', 1.0, 1)",
                    [],
                )
            })
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(125)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].bpm, Some(128));
        assert_eq!(resp.tracks[0].bpm_source.as_deref(), Some("analysis"));
    }

    #[test]
    fn bpm_source_is_tag_when_only_hot_column_set() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.bpm = Some(125);
        TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(120)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].bpm_source.as_deref(), Some("tag"));
    }

    // ── mood tag / group filters ─────────────────────────────────────

    fn insert_mood_tag(store: &LibraryStore, server: &str, track: &str, tag: &str) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO track_fact \
                     (server_id, track_id, fact_kind, value_text, source_kind, source_id, confidence, fetched_at) \
                     VALUES (?1, ?2, 'mood_tag', ?3, 'analysis', ?4, 1.0, 1)",
                    rusqlite::params![server, track, tag, format!("oximedia-60s-center:{tag}")],
                )
            })
            .unwrap();
    }

    #[test]
    fn mood_group_joy_matches_happy_mood_tag() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "A", "X", "Alb"),
                track("s1", "t2", "B", "X", "Alb"),
            ])
            .unwrap();
        insert_mood_tag(&store, "s1", "t1", "happy");
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("mood_group", FilterOp::Eq, Some(json!("joy")), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn mood_groups_overlap_work_and_romance_on_calm_peaceful_track() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Calm", "X", "Alb")])
            .unwrap();
        insert_mood_tag(&store, "s1", "t1", "calm");
        insert_mood_tag(&store, "s1", "t1", "peaceful");
        for group in ["work", "romance"] {
            let mut r = req("s1", &[EntityKind::Track]);
            r.filters = vec![clause("mood_group", FilterOp::Eq, Some(json!(group)), None)];
            let resp = run_advanced_search(&store, &r).unwrap();
            assert_eq!(resp.tracks.len(), 1, "group `{group}` should match calm/peaceful");
        }
    }

    #[test]
    fn mood_group_in_joy_matches_happy_tag() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "A", "X", "Alb"),
                track("s1", "t2", "B", "X", "Alb"),
            ])
            .unwrap();
        insert_mood_tag(&store, "s1", "t1", "happy");
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause(
            "mood_group",
            FilterOp::In,
            Some(json!(["joy"])),
            None,
        )];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn mood_tag_eq_calm_matches_calm_fact() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "A", "X", "Alb"),
                track("s1", "t2", "B", "X", "Alb"),
            ])
            .unwrap();
        insert_mood_tag(&store, "s1", "t2", "calm");
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("mood_tag", FilterOp::Eq, Some(json!("calm")), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t2");
    }

    // ── entity routing / errors ────────────────────────────────────────

    #[test]
    fn track_only_filter_is_ignored_for_album_entity_no_error() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Some Album", Some(2001), None);
        let mut r = req("s1", &[EntityKind::Album]);
        // bpm is track-only; for an album query it must be skipped, not error.
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(120)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert!(!resp.applied_filters.contains(&"bpm".to_string()));
    }

    #[test]
    fn unknown_field_is_an_error() {
        let store = LibraryStore::open_in_memory();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("nope", FilterOp::Eq, Some(json!("x")), None)];
        let err = run_advanced_search(&store, &r).unwrap_err();
        assert!(err.contains("unknown filter field"), "got: {err}");
    }

    #[test]
    fn lossless_filter_returns_only_lossless_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut flac = track("s1", "t1", "A", "X", "Alb");
        flac.suffix = Some("flac".into());
        let mut mp3 = track("s1", "t2", "B", "X", "Alb");
        mp3.suffix = Some("mp3".into());
        TrackRepository::new(&store)
            .upsert_batch(&[flac, mp3])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
        assert!(resp.applied_filters.contains(&"lossless".to_string()));
    }

    #[test]
    fn lossless_filter_on_album_entity_requires_lossless_track() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Lossless Album", None, None);
        insert_album(&store, "s1", "al2", "Lossy Album", None, None);
        let mut flac = track("s1", "t1", "A", "X", "Alb");
        flac.album_id = Some("al1".into());
        flac.suffix = Some("flac".into());
        let mut mp3 = track("s1", "t2", "B", "Y", "Alb2");
        mp3.album_id = Some("al2".into());
        mp3.suffix = Some("mp3".into());
        TrackRepository::new(&store)
            .upsert_batch(&[flac, mp3])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al1");
    }

    #[test]
    fn restrict_album_ids_intersects_with_lossless_filter() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al_fav_lossless", "Fav Lossless", None, None);
        insert_album(&store, "s1", "al_fav_lossy", "Fav Lossy", None, None);
        insert_album(&store, "s1", "al_other_lossless", "Other Lossless", None, None);
        let mut flac_fav = track("s1", "t1", "A", "X", "Alb");
        flac_fav.album_id = Some("al_fav_lossless".into());
        flac_fav.suffix = Some("flac".into());
        let mut mp3_fav = track("s1", "t2", "B", "Y", "Alb2");
        mp3_fav.album_id = Some("al_fav_lossy".into());
        mp3_fav.suffix = Some("mp3".into());
        let mut flac_other = track("s1", "t3", "C", "Z", "Alb3");
        flac_other.album_id = Some("al_other_lossless".into());
        flac_other.suffix = Some("flac".into());
        TrackRepository::new(&store)
            .upsert_batch(&[flac_fav, mp3_fav, flac_other])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
        r.restrict_album_ids = Some(vec![
            "al_fav_lossless".into(),
            "al_fav_lossy".into(),
        ]);
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_fav_lossless");
        assert!(resp.applied_filters.contains(&"albumIds".to_string()));
    }

    #[test]
    fn lossless_and_year_filters_use_track_year_when_album_table_differs() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Hi-Res Album", Some(1990), None);
        let mut flac = track("s1", "t1", "Track", "Art", "Alb");
        flac.album_id = Some("al1".into());
        flac.suffix = Some("flac".into());
        flac.year = Some(2022);
        TrackRepository::new(&store)
            .upsert_batch(&[flac])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![
            clause("year", FilterOp::Between, Some(json!(2020)), Some(json!(2024))),
            clause("lossless", FilterOp::IsTrue, None, None),
        ];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al1");
    }

    #[test]
    fn lossless_album_browse_with_name_sort_returns_rows() {
        let store = LibraryStore::open_in_memory();
        let mut flac = track("s1", "t1", "Track", "Art", "Zebra Album");
        flac.suffix = Some("flac".into());
        TrackRepository::new(&store)
            .upsert_batch(&[flac])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
        r.sort = vec![LibrarySortClause {
            field: "name".into(),
            dir: SortDir::Asc,
        }];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
    }

    #[test]
    fn lossless_filter_on_artist_entity_requires_lossless_track() {
        let store = LibraryStore::open_in_memory();
        insert_artist(&store, "s1", "ar1", "Lossless Artist");
        insert_artist(&store, "s1", "ar2", "Lossy Artist");
        let mut flac = track("s1", "t1", "A", "Lossless Artist", "Alb");
        flac.artist_id = Some("ar1".into());
        flac.suffix = Some("flac".into());
        let mut mp3 = track("s1", "t2", "B", "Lossy Artist", "Alb2");
        mp3.artist_id = Some("ar2".into());
        mp3.suffix = Some("mp3".into());
        TrackRepository::new(&store)
            .upsert_batch(&[flac, mp3])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Artist]);
        r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].id, "ar1");
    }

    fn insert_album_raw(
        store: &LibraryStore,
        server: &str,
        id: &str,
        name: &str,
        raw_json: &str,
    ) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, 1, ?4)",
                    rusqlite::params![server, id, name, raw_json],
                )
            })
            .unwrap();
    }

    #[test]
    fn compilation_filter_only_returns_compilation_albums() {
        let store = LibraryStore::open_in_memory();
        insert_album_raw(
            &store,
            "s1",
            "al_comp",
            "Greatest Hits",
            r#"{"compilation":true}"#,
        );
        insert_album_raw(&store, "s1", "al_regular", "Studio", "{}");
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("compilation", FilterOp::IsTrue, None, None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_comp");
    }

    #[test]
    fn compilation_filter_matches_va_album_artist_on_track_groups() {
        let store = LibraryStore::open_in_memory();
        let mut comp = track("s1", "t_comp", "Hit", "Alice", "Comp Album");
        comp.album_id = Some("al_comp".into());
        comp.album_artist = Some("Various Artists".into());
        comp.raw_json = "{}".into();
        let mut reg = track("s1", "t_reg", "Song", "Band", "Studio");
        reg.album_id = Some("al_reg".into());
        reg.raw_json = "{}".into();
        TrackRepository::new(&store)
            .upsert_batch(&[comp, reg])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("compilation", FilterOp::IsTrue, None, None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_comp");
        assert_eq!(resp.albums[0].artist.as_deref(), Some("Various Artists"));
    }

    #[test]
    fn track_grouped_album_browse_prefers_album_artist_over_track_artist() {
        let store = LibraryStore::open_in_memory();
        let mut t1 = track("s1", "t1", "Anthem", "Groove Armada", "Back to Mine");
        t1.album_id = Some("al_mix".into());
        t1.album_artist = Some("Underworld".into());
        let mut t2 = track("s1", "t2", "Zebra", "UNKLE", "Back to Mine");
        t2.album_id = Some("al_mix".into());
        t2.album_artist = Some("Underworld".into());
        TrackRepository::new(&store)
            .upsert_batch(&[t1, t2])
            .unwrap();
        let r = req("s1", &[EntityKind::Album]);
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].artist.as_deref(), Some("Underworld"));
    }

    #[test]
    fn compilation_filter_on_track_grouped_album_browse() {
        let store = LibraryStore::open_in_memory();
        let mut comp = track("s1", "t_comp", "Hit", "VA", "Comp Album");
        comp.album_id = Some("al_comp".into());
        comp.raw_json = r#"{"compilation":true}"#.into();
        let mut reg = track("s1", "t_reg", "Song", "Band", "Studio");
        reg.album_id = Some("al_reg".into());
        reg.raw_json = "{}".into();
        TrackRepository::new(&store)
            .upsert_batch(&[comp, reg])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("compilation", FilterOp::IsTrue, None, None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_comp");
        assert!(resp.applied_filters.contains(&"compilation".to_string()));
    }

    #[test]
    fn compilation_eq_false_hides_compilations() {
        let store = LibraryStore::open_in_memory();
        insert_album_raw(
            &store,
            "s1",
            "al_comp",
            "Greatest Hits",
            r#"{"releaseTypes":["Compilation"]}"#,
        );
        insert_album_raw(&store, "s1", "al_regular", "Studio", "{}");
        let mut r = req("s1", &[EntityKind::Album]);
        r.filters = vec![clause("compilation", FilterOp::Eq, Some(json!(false)), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_regular");
    }

    #[test]
    fn planned_but_unbuilt_field_is_an_error() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        // `suffix` is registered (Planned) but has no v1 SQL builder.
        r.filters = vec![clause("suffix", FilterOp::Eq, Some(json!("flac")), None)];
        let err = run_advanced_search(&store, &r).unwrap_err();
        assert!(err.contains("not queryable"), "got: {err}");
    }

    #[test]
    fn undeclared_op_for_known_field_is_an_error() {
        let store = LibraryStore::open_in_memory();
        let mut r = req("s1", &[EntityKind::Track]);
        // `genre` only declares `eq`.
        r.filters = vec![clause("genre", FilterOp::Gte, Some(json!("rock")), None)];
        let err = run_advanced_search(&store, &r).unwrap_err();
        assert!(err.contains("not supported"), "got: {err}");
    }

    // ── scope / pagination / totals ────────────────────────────────────

    #[test]
    fn library_scope_narrows_track_results() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.library_id = Some("lib1".into());
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.library_id = Some("lib2".into());
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.library_scope = Some("lib1".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn library_scope_reads_library_id_from_raw_json_when_column_null() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.raw_json = serde_json::json!({"libraryId": 3}).to_string();
        TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.library_scope = Some("3".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn totals_reflect_full_match_count_not_page_size() {
        let store = LibraryStore::open_in_memory();
        let rows: Vec<TrackRow> = (0..10)
            .map(|i| track("s1", &format!("t{i}"), "Common Title", "X", "Alb"))
            .collect();
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.query = Some("common".into());
        r.limit = 3;
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 3, "page is capped by limit");
        assert_eq!(resp.totals.tracks, 10, "total is the full match count");
    }

    #[test]
    fn offset_pages_through_results() {
        let store = LibraryStore::open_in_memory();
        let rows: Vec<TrackRow> = (0..5)
            .map(|i| track("s1", &format!("t{i}"), &format!("Title {i}"), "X", "Alb"))
            .collect();
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.sort = vec![LibrarySortClause { field: "title".into(), dir: SortDir::Asc }];
        r.limit = 2;
        r.offset = 2;
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t2", "t3"]);
        assert_eq!(resp.totals.tracks, 5);
    }

    #[test]
    fn unrequested_entities_are_empty() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
            .unwrap();
        insert_album(&store, "s1", "al1", "Alb", None, None);
        let resp = run_advanced_search(&store, &req("s1", &[EntityKind::Track])).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert!(resp.albums.is_empty());
        assert!(resp.artists.is_empty());
        assert_eq!(resp.totals.albums, 0);
    }

    #[test]
    fn sort_desc_orders_results() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.year = Some(2000);
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.year = Some(2020);
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.sort = vec![LibrarySortClause { field: "year".into(), dir: SortDir::Desc }];
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t2", "t1"]);
    }
}

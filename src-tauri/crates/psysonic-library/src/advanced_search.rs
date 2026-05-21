//! Advanced Search SQL builder (spec §5.13). PR-5d ships the backend only —
//! the `AdvancedSearch.tsx` UI wiring stays PR-7 (F2). Cross-server search
//! (§5.5B) lives in the sibling `cross_server` module.
//!
//! The builder turns a `LibraryAdvancedSearchRequest` into one parameterised
//! query per requested entity (track / album / artist), each sharing a WHERE
//! built from the `FilterFieldRegistry` resolution in `filter.rs`. Only
//! builder-supplied column expressions ever reach the SQL string; every value
//! is bound (§5.13.5: parameterised only).

use std::collections::{BTreeSet, HashSet};

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::dto::{
    LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse, LibraryAlbumDto, LibraryArtistDto,
    LibraryFilterClause, LibrarySearchTotals, LibrarySortClause, LibraryTrackDto, SortDir,
};
use crate::filter::{self, EntityKind, FilterOp, SqlFragment};
use crate::repos;
use crate::search::{
    aliased_track_columns, fts_album_prefix_match_query, fts_column_prefix_query,
    fts_query_meets_min_len, fts_track_prefix_match_query, library_scope_equals_sql,
    like_contains, PAGE_LIMIT_MAX,
};
use crate::store::LibraryStore;

/// `bpm` dual-storage resolution (§5.13.4): prefer the hot `track.bpm`
/// column, fall back to the highest-priority `track_fact(bpm)` value. The
/// spec's `not_found = 0` guard is dropped — the live `track_fact` schema
/// has no such column (that lives on `track_artifact`).
const BPM_RESOLVED_EXPR: &str = "COALESCE(t.bpm, (SELECT f.value_int FROM track_fact f \
  WHERE f.server_id = t.server_id AND f.track_id = t.id AND f.fact_kind = 'bpm' \
  ORDER BY CASE f.source_kind WHEN 'user' THEN 0 WHEN 'server_tag' THEN 1 \
  WHEN 'analysis' THEN 2 ELSE 3 END LIMIT 1))";

const ALBUM_COLUMNS: &str = "a.server_id, a.id, a.name, a.artist, a.artist_id, \
  a.song_count, a.duration_sec, a.year, a.genre, a.cover_art_id, a.starred_at, \
  a.synced_at, a.raw_json";

const ARTIST_COLUMNS: &str = "ar.server_id, ar.id, ar.name, ar.album_count, \
  ar.synced_at, ar.raw_json";

/// Flat track projection used when browsing albums in advanced search.
type AlbumBrowseTrackRow = (
    String,
    String,
    String,
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

    let cols = aliased_track_columns("t");
    if let Some(q) = text.and_then(fts_track_prefix_match_query) {
        applied.insert("text".to_string());
        let pool = fts_candidate_pool_size(limit, offset);
        let from = format!(
            "track t INNER JOIN (\
               SELECT rowid, bm25(track_fts) AS fts_rank FROM track_fts \
               WHERE track_fts MATCH ? ORDER BY fts_rank LIMIT {pool}\
             ) fts_pick ON t.rowid = fts_pick.rowid"
        );
        let order = order_clause(&req.sort, EntityKind::Track)
            .unwrap_or_else(|| "ORDER BY fts_pick.fts_rank".to_string());
        return query_rows_fts(
            store,
            &cols,
            &from,
            &q,
            &w,
            &order,
            limit,
            offset,
            skip_totals,
            |r| repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row)),
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
        |r| repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row)),
    )
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
    let table = build_album_from_table(store, req, text, scalar, limit, offset, skip_totals, applied)?;
    if !table.0.is_empty() || table.1 > 0 {
        return Ok(table);
    }
    if let Some(q) = text.and_then(fts_album_prefix_match_query) {
        return build_album_from_fts(store, req, &q, scalar, limit, offset, skip_totals, applied);
    }
    build_album_from_tracks(store, req, text, scalar, limit, offset, skip_totals, applied)
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
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.album_id IS NOT NULL AND t.album_id != ''");
    w.push_raw(
        "NOT EXISTS (SELECT 1 FROM album a WHERE a.server_id = t.server_id AND a.id = t.album_id)",
    );
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

    let select = "t.server_id, t.album_id, MAX(t.album), MAX(t.artist), MAX(t.artist_id), \
        COUNT(*), SUM(t.duration_sec), MAX(t.year), MAX(t.genre), MAX(t.cover_art_id), \
        MAX(t.starred_at), MAX(t.synced_at)";
    let order = order_clause(&req.sort, EntityKind::Album).unwrap_or_else(|| {
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
    let table = build_artist_from_table(store, req, text, scalar, limit, offset, skip_totals, applied)?;
    if !table.0.is_empty() || table.1 > 0 {
        return Ok(table);
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
    // Only `text` routes to artist with a real column; other registered
    // fields resolve to `None` (skip). `starredOnly` has no artist column.
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Artist)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let order = order_clause(&req.sort, EntityKind::Artist)
        .unwrap_or_else(|| "ORDER BY ar.name COLLATE NOCASE ASC, ar.id ASC".to_string());
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

    let mut w = WhereBuilder::new();
    w.push_param(
        &format!(
            "t.rowid IN (SELECT rowid FROM track_fts WHERE track_fts MATCH ? ORDER BY bm25(track_fts) LIMIT {pool})"
        ),
        SqlValue::Text(fts.to_string()),
    );
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.album_id IS NOT NULL AND t.album_id != ''");
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

    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.year, \
                    t.genre, t.cover_art_id, t.starred_at, t.synced_at \
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
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut seen = HashSet::new();
        let mut deduped: Vec<LibraryAlbumDto> = Vec::new();
        for (server_id, album_id, album, artist, artist_id, year, genre, cover_art_id, starred_at, synced_at) in rows {
            if !seen.insert(album_id.clone()) {
                continue;
            }
            deduped.push(LibraryAlbumDto {
                server_id,
                id: album_id,
                name: album,
                artist,
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

    let mut w = WhereBuilder::new();
    w.push_param(
        &format!(
            "t.rowid IN (SELECT rowid FROM track_fts WHERE track_fts MATCH ? ORDER BY bm25(track_fts) LIMIT {pool})"
        ),
        SqlValue::Text(fts.to_string()),
    );
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.artist_id IS NOT NULL AND t.artist_id != ''");
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
            deduped.push(LibraryArtistDto {
                server_id,
                id: artist_id,
                name: artist.unwrap_or_default(),
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
    let col = match (c.field.as_str(), entity) {
        ("genre", EntityKind::Track) => "t.genre",
        ("genre", EntityKind::Album) => "a.genre",
        ("year", EntityKind::Track) => "t.year",
        ("year", EntityKind::Album) => "a.year",
        ("starred", EntityKind::Track) => "t.starred_at",
        ("starred", EntityKind::Album) => "a.starred_at",
        // `starred` routes to artist in the registry, but the `artist`
        // table has no `starred_at` column — skip rather than error.
        ("starred", EntityKind::Artist) => return Ok(None),
        ("bpm", EntityKind::Track) => BPM_RESOLVED_EXPR,
        // `text` is handled by the entity builder (FTS / LIKE), never here.
        ("text", _) => return Ok(None),
        // Registered but no v1 SQL builder (user_rating / suffix / bit_rate).
        _ => return Err(filter::FilterError::NotQueryable(c.field.clone()).to_string()),
    };

    if c.field == "genre" {
        let v = json_to_text(&c.field, c.value.as_ref())?;
        return Ok(Some(SqlFragment {
            sql: format!("{col} = ? COLLATE NOCASE"),
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
            count_matching_rows(conn, from, &where_sql, &w.params, false)?
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
    let raw: Option<String> = r.get(5)?;
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        album_count: r.get(3)?,
        synced_at: r.get(4)?,
        raw_json: parse_raw_json(raw),
    })
}

fn map_album_from_tracks(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: r.get(3)?,
        artist_id: r.get(4)?,
        song_count: Some(r.get(5)?),
        duration_sec: Some(r.get(6)?),
        year: r.get(7)?,
        genre: r.get(8)?,
        cover_art_id: r.get(9)?,
        starred_at: r.get(10)?,
        synced_at: r.get(11)?,
        raw_json: Value::Null,
    })
}

fn map_artist_from_tracks(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
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
        ("name", EntityKind::Artist) => Some("ar.name COLLATE NOCASE"),
        _ => None,
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

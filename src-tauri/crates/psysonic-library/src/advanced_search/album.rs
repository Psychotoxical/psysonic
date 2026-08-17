use std::collections::{BTreeSet, HashSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::filters::{
    push_album_id_allowlist, resolve_clause, scalar_requires_lossless_track_grouping,
    scalar_requires_track_derived_entities, WhereBuilder,
};
use super::sql::{
    album_order_from_track_groups, fts_album_text_match_query, order_clause, parse_raw_json,
    query_grouped_rows, query_rows, scoped_fts_rowid_subquery_sql, scoped_fts_subquery_bind,
    trimmed_nonempty,
};
use crate::browse_support::{overlay_album_artist_links_for_store, overlay_album_level_starred_at};
use crate::dto::{LibraryAdvancedSearchRequest, LibraryAlbumDto, LibraryFilterClause};
use crate::filter::EntityKind;
use crate::search::{library_scope_sargable_equals_sql, like_contains};
use crate::store::LibraryStore;

const ALBUM_COLUMNS: &str = "a.server_id, a.id, a.name, a.artist, a.artist_id, \
  a.song_count, a.duration_sec, \
  COALESCE(a.year, (SELECT MAX(t.year) FROM track t \
    WHERE t.server_id = a.server_id AND t.album_id = a.id AND t.deleted = 0)), \
  a.genre, \
  COALESCE(a.cover_art_id, (SELECT t.cover_art_id FROM track t \
    WHERE t.server_id = a.server_id AND t.album_id = a.id AND t.deleted = 0 \
      AND NULLIF(TRIM(t.cover_art_id), '') IS NOT NULL \
    ORDER BY t.id ASC LIMIT 1)), \
  a.starred_at, a.synced_at, a.raw_json";

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

#[allow(clippy::too_many_arguments)]
pub(super) fn build_album(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    // Album browse favorites: album-level stars only (`a.starred_at`), not
    // track-derived groups with `t.starred_at`. Must win over the lossless
    // track-grouping fast path so starred + lossless browse stays consistent.
    if req.starred_only == Some(true) {
        return build_album_from_table(
            store,
            req,
            text,
            scalar,
            limit,
            offset,
            skip_totals,
            applied,
        );
    }
    if scalar_requires_lossless_track_grouping(scalar) {
        return build_album_from_tracks(
            store,
            req,
            text,
            scalar,
            limit,
            offset,
            skip_totals,
            applied,
            true,
        );
    }
    if server_has_indexed_tracks(store, &req.server_id)? {
        if let Some(q) = text.and_then(|t| fts_album_text_match_query(req, t)) {
            return build_album_from_fts(
                store,
                req,
                &q,
                scalar,
                limit,
                offset,
                skip_totals,
                applied,
            );
        }
        return build_album_from_tracks(
            store,
            req,
            text,
            scalar,
            limit,
            offset,
            skip_totals,
            applied,
            false,
        );
    }
    if !scalar_requires_track_derived_entities(scalar) {
        let table = build_album_from_table(
            store,
            req,
            text,
            scalar,
            limit,
            offset,
            skip_totals,
            applied,
        )?;
        if !table.0.is_empty() || table.1 > 0 {
            return Ok(table);
        }
    }
    if let Some(q) = text.and_then(|t| fts_album_text_match_query(req, t)) {
        return build_album_from_fts(store, req, &q, scalar, limit, offset, skip_totals, applied);
    }
    build_album_from_tracks(
        store,
        req,
        text,
        scalar,
        limit,
        offset,
        skip_totals,
        applied,
        false,
    )
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
        w.push_param(
            "a.name LIKE ? ESCAPE '\\'",
            SqlValue::Text(like_contains(t)),
        );
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
    push_album_id_allowlist(&mut w, "a.id", req.restrict_album_ids.as_deref(), applied);

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
        let clause = library_scope_sargable_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    if let Some(t) = text {
        w.push_param(
            "t.album LIKE ? ESCAPE '\\'",
            SqlValue::Text(like_contains(t)),
        );
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
    let order = album_order_from_track_groups(&req.sort)
        .unwrap_or_else(|| "ORDER BY MAX(t.album) COLLATE NOCASE ASC, t.album_id ASC".to_string());
    let (mut albums, total) = query_grouped_rows(
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
    )?;
    overlay_album_level_starred_at(store, &req.server_id, &mut albums)?;
    overlay_album_artist_links_for_store(store, &mut albums)?;
    Ok((albums, total))
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
        let clause = library_scope_sargable_equals_sql("t");
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
    let (mut albums, total): (Vec<LibraryAlbumDto>, u32) = store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT t.server_id, t.album_id, t.album, t.artist, t.album_artist, t.artist_id, \
                    t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at \
             FROM track t \
             WHERE {where_sql}"
        );
        let params = w.params.clone();
        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<AlbumBrowseTrackRow> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
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
            .collect::<rusqlite::Result<Vec<AlbumBrowseTrackRow>>>()?;

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

        let total = if skip_totals { 0 } else { deduped.len() as u32 };
        let albums = deduped
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect::<Vec<LibraryAlbumDto>>();
        Ok((albums, total))
    })?;
    overlay_album_level_starred_at(store, &req.server_id, &mut albums)?;
    overlay_album_artist_links_for_store(store, &mut albums)?;
    Ok((albums, total))
}

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

fn map_album_from_tracks(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    let track_artist: Option<String> = r.get(3)?;
    let album_artist: Option<String> = r.get(5)?;
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: crate::album_compilation_filter::pick_album_group_artist(
            track_artist,
            album_artist,
        ),
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

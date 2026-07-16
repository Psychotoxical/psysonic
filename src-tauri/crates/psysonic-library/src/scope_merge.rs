//! Merged, priority-deduped reads over an ordered `(server_id, library_id)` scope
//! (multi-library filter WO-4). Joins `track` with the attached `cluster.track_cluster_key`
//! table and keeps the lowest `priority_rank` winner per identity key.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use crate::album_compilation_filter::pick_album_group_artist;
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::browse_support::{overlay_album_starred_at_rows, read_album_starred_at};
use crate::dto::{
    LibraryAlbumDto, LibraryArtistDto, LibraryEntitySourceDto,
    LibraryResolveEntitySourcesRequest, LibraryScopeAlbumDetailRequest,
    LibraryScopeAlbumDetailResponse, LibraryScopeArtistDetailRequest,
    LibraryScopeArtistDetailResponse, LibraryScopeListRequest, LibraryScopePair,
    LibraryScopeSearchRequest, LibrarySourceEntityType, LibraryTrackDto,
};
use crate::repos::row_to_track_row;
use crate::search::{
    aliased_track_columns, fts_query_meets_min_len, fts_track_match_query, PAGE_LIMIT_MAX,
};
use crate::store::LibraryStore;

/// NULL `album_key` rows never merge — fall back to a per-server album id.
pub(crate) const ALBUM_DEDUP_KEY: &str = "CASE WHEN ck.album_key IS NOT NULL THEN ck.album_key \
    ELSE ('null:' || t.server_id || ':' || COALESCE(NULLIF(t.album_id, ''), t.id)) END";

/// NULL `artist_key` rows never merge.
const ARTIST_DEDUP_KEY: &str = "CASE WHEN ck.artist_key IS NOT NULL THEN ck.artist_key \
    ELSE ('null:' || t.server_id || ':' || COALESCE(NULLIF(t.artist_id, ''), t.id)) END";

/// Track dedup: `cluster_key` + a fixed 5-second duration bucket (`duration_sec / 5`).
/// This is a bucket, not a symmetric ±5 s window: two rips whose durations straddle
/// a bucket edge (e.g. 314 s → bucket 62, 316 s → bucket 63) stay separate, while
/// two up to ~4 s apart inside a bucket merge. Kept as a single GROUP BY key for
/// speed; a true tolerance window would need a self-join. Encoder-padding drift at
/// boundaries is the known trade-off.
pub(crate) const TRACK_DEDUP_KEY: &str = "CASE WHEN ck.cluster_key IS NOT NULL \
    THEN ck.cluster_key || ':' || CAST((ck.duration_sec / 5) AS TEXT) \
    ELSE ('null:' || t.server_id || ':' || t.id) END";

/// Sortable representative key so a single `MIN()` (SQLite bare-column rule) picks the
/// priority winner per album group without a second window pass: (pr ASC, album_id ASC, id ASC).
/// `pr` is zero-padded so lexical order matches numeric order.
const ALBUM_PICK_KEY: &str = "printf('%08d|%s|%s', pr, album_id, id)";

/// Same representative trick for artist groups: (pr ASC, artist_id ASC).
const ARTIST_PICK_KEY: &str = "printf('%08d|%s', pr, artist_id)";

const TRACK_FTS_BM25_RANK: &str = "bm25(track_fts, 10.0, 3.0, 5.0, 3.0, 0.0)";

pub(crate) fn normalize_scope_pairs(
    scopes: &[LibraryScopePair],
) -> Result<Vec<LibraryScopePair>, String> {
    let mut normalized = Vec::with_capacity(scopes.len());
    let mut seen = HashSet::new();
    let mut server_modes: HashMap<String, bool> = HashMap::new();
    for pair in scopes {
        let server_id = pair.server_id.trim();
        if server_id.is_empty() {
            return Err("scope server_id must not be empty".into());
        }
        let whole = pair.library_id.is_none();
        if let Some(previous_whole) = server_modes.insert(server_id.to_string(), whole) {
            if previous_whole != whole {
                return Err(format!(
                    "server {server_id} cannot mix whole-server and exact-library scopes"
                ));
            }
        }
        let normalized_pair = LibraryScopePair {
            server_id: server_id.to_string(),
            library_id: pair.library_id.clone(),
        };
        if seen.insert((normalized_pair.server_id.clone(), normalized_pair.library_id.clone())) {
            normalized.push(normalized_pair);
        }
    }
    Ok(normalized)
}

fn non_empty_scopes(scopes: &[LibraryScopePair]) -> Result<&[LibraryScopePair], String> {
    if scopes.is_empty() {
        return Err("scopes must not be empty".into());
    }
    let normalized = normalize_scope_pairs(scopes)?;
    if normalized.len() != scopes.len() {
        return Err("duplicate scope pair".into());
    }
    Ok(scopes)
}

fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(50).clamp(1, PAGE_LIMIT_MAX)
}

fn clamp_offset(offset: Option<u32>) -> u32 {
    offset.unwrap_or(0)
}

/// Compile exact-library and whole-server sources into separate indexed branches.
/// `scoped_track` contains only rowids and pair priority so downstream readers keep
/// their existing `s.pr` / `t.*` shape without an OR predicate on `track`.
pub(crate) fn scope_cte_sql(scopes: &[LibraryScopePair]) -> (String, Vec<SqlValue>) {
    let exact = scopes
        .iter()
        .enumerate()
        .filter(|(_, pair)| pair.library_id.is_some())
        .collect::<Vec<_>>();
    let whole = scopes
        .iter()
        .enumerate()
        .filter(|(_, pair)| pair.library_id.is_none())
        .collect::<Vec<_>>();
    let exact_values = if exact.is_empty() {
        "SELECT NULL, NULL, NULL WHERE 0".to_string()
    } else {
        format!(
            "VALUES {}",
            exact
                .iter()
                .map(|(i, _)| format!("(?, ?, {i})"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let whole_values = if whole.is_empty() {
        "SELECT NULL, NULL WHERE 0".to_string()
    } else {
        format!(
            "VALUES {}",
            whole
                .iter()
                .map(|(i, _)| format!("(?, {i})"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let sql = format!(
        "WITH exact_scope(server_id, library_id, pr) AS ({exact_values}), \
         whole_scope(server_id, pr) AS ({whole_values}), \
         scoped_track(rowid, pr) AS ( \
           SELECT t.rowid, s.pr FROM exact_scope s \
           CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
           WHERE t.deleted = 0 \
           UNION ALL \
           SELECT t.rowid, s.pr FROM whole_scope s \
           CROSS JOIN track t ON t.server_id = s.server_id \
           WHERE t.deleted = 0 \
         )"
    );
    let mut binds = Vec::with_capacity(exact.len() * 2 + whole.len());
    for (_, pair) in exact {
        binds.push(SqlValue::Text(pair.server_id.clone()));
        binds.push(SqlValue::Text(pair.library_id.clone().unwrap_or_default()));
    }
    for (_, pair) in whole {
        binds.push(SqlValue::Text(pair.server_id.clone()));
    }
    (sql, binds)
}

fn scoped_track_join_layer1() -> &'static str {
    "FROM scoped_track s \
     CROSS JOIN track t ON t.rowid = s.rowid \
     WHERE t.deleted = 0"
}

fn scoped_track_join() -> &'static str {
    // Drive from the tiny `scope` VALUES table and CROSS JOIN so SQLite cannot
    // reorder to a full `track` scan: each scope row seeks its library's tracks
    // via idx_track_library_* instead of scanning all tracks and probing scope.
    // This only visits tracks in the selected libraries, so a subset of libraries
    // is proportionally cheaper than the whole server.
    "FROM scoped_track s \
     CROSS JOIN track t ON t.rowid = s.rowid \
     LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
     WHERE t.deleted = 0"
}

fn append_extra_where(base: &str, extra: &str) -> String {
    if extra.trim().is_empty() {
        base.to_string()
    } else {
        format!("{base} AND {extra}")
    }
}

fn merge_binds(mut scope_binds: Vec<SqlValue>, extra: &[SqlValue]) -> Vec<SqlValue> {
    scope_binds.extend_from_slice(extra);
    scope_binds
}

fn plain_track_columns_sql() -> &'static str {
    crate::repos::track_columns()
}

fn album_order_sql(sort: Option<&str>) -> String {
    match sort.map(str::trim).filter(|s| !s.is_empty()) {
        Some("year") => "ORDER BY year DESC NULLS LAST, album COLLATE NOCASE ASC, album_id ASC".into(),
        Some("artist") => {
            "ORDER BY artist COLLATE NOCASE ASC NULLS LAST, album COLLATE NOCASE ASC, album_id ASC"
                .into()
        }
        _ => "ORDER BY album COLLATE NOCASE ASC, album_id ASC".into(),
    }
}

fn artist_order_sql(sort: Option<&str>) -> String {
    match sort.map(str::trim).filter(|s| !s.is_empty()) {
        Some("albumCount") | Some("album_count") => {
            "ORDER BY album_count DESC NULLS LAST, artist COLLATE NOCASE ASC, artist_id ASC".into()
        }
        _ => "ORDER BY artist COLLATE NOCASE ASC, artist_id ASC".into(),
    }
}

type AlbumListRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<i64>,
    i64,
);

fn map_album_list_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumListRow> {
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
        r.get(11)?,
        r.get(12)?,
    ))
}

fn album_row_to_dto(row: AlbumListRow) -> LibraryAlbumDto {
    let (
        server_id,
        id,
        name,
        track_artist,
        artist_id,
        album_artist,
        song_count,
        duration_sec,
        year,
        genre,
        cover_art_id,
        starred_at,
        synced_at,
    ) = row;
    LibraryAlbumDto {
        server_id,
        id,
        name,
        artist: pick_album_group_artist(track_artist, album_artist),
        artist_id,
        song_count: Some(song_count),
        duration_sec: Some(duration_sec),
        year,
        genre,
        cover_art_id,
        starred_at,
        synced_at,
        raw_json: Value::Null,
    }
}

/// `library_scope_list_albums` — dedup by `album_key`, priority winner metadata.
///
/// Track copies are reduced to their priority winner before album totals are computed,
/// so song count and duration describe the same deduped recording set.
/// Build cluster identity keys for every server in a >1-library scope before a
/// browse that dedups via `cluster.track_cluster_key`. Without this the album/
/// artist dedup keys are uniformly NULL on a cold index (no prior search / sync
/// rebuild) and cross-library duplicates are not merged.
fn overlay_scope_album_stars(
    store: &LibraryStore,
    albums: &mut [LibraryAlbumDto],
) -> Result<(), String> {
    if albums.is_empty() {
        return Ok(());
    }
    store
        .with_read_conn(|conn| {
            overlay_album_starred_at_rows(conn, albums);
            Ok(())
        })
        .map_err(|e| e.to_string())
}

fn finish_scope_album_list(
    store: &LibraryStore,
    mut albums: Vec<LibraryAlbumDto>,
    total: u32,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    overlay_scope_album_stars(store, &mut albums)?;
    Ok((albums, total))
}

pub(crate) fn ensure_cluster_keys_for_scopes(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
) -> Result<(), String> {
    if !crate::dto::multi_library_merge_enabled(scopes) {
        return Ok(());
    }
    let mut seen: Vec<&str> = Vec::new();
    for pair in scopes {
        if !seen.contains(&pair.server_id.as_str()) {
            seen.push(pair.server_id.as_str());
            crate::identity::ensure_cluster_keys_built(store, &pair.server_id)?;
        }
    }
    Ok(())
}

pub fn list_albums(
    store: &LibraryStore,
    request: &LibraryScopeListRequest,
) -> Result<Vec<LibraryAlbumDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_scopes(store, scopes)?;
    let order = album_order_sql(request.sort.as_deref());
    let limit = clamp_limit(request.limit);
    let offset = clamp_offset(request.offset);
    if crate::dto::scoped_layer1_eligible(scopes) {
        // Plain-identifier keys (`ORDER BY artist COLLATE NOCASE`), which SQLite
        // resolves to the `MAX(...) AS x` aliases in the grouped shape and to the
        // projected columns in the dedup shape — correct either way, so one string
        // serves both.
        let (albums, _) = list_albums_layer1_filtered(
            store,
            scopes,
            "",
            &[],
            &order,
            &order,
            limit,
            offset,
            true,
            true,
        )?;
        return Ok(albums);
    }

    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                   t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                  s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
           {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' \
         ), \
         track_winners AS ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, duration_sec, id, pr, album_dedup, \
                  MIN(printf('%08d|%s|%s', pr, server_id, id)) AS _track_pick \
           FROM base GROUP BY album_dedup, track_dedup \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                 song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
         FROM ( \
            SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                    year, genre, cover_art_id, starred_at, synced_at, \
                   COUNT(*) AS song_count, SUM(duration_sec) AS duration_total, \
                   MIN({ALBUM_PICK_KEY}) AS _pick \
            FROM track_winners GROUP BY album_dedup \
          ) \
         {order} \
         LIMIT ? OFFSET ?",
        scoped = scoped_track_join(),
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_album_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut albums: Vec<LibraryAlbumDto> = rows.into_iter().map(album_row_to_dto).collect();
        overlay_album_starred_at_rows(conn, &mut albums);
        Ok(albums)
    })
}

type ArtistListRow = (String, String, String, i64, i64);

fn map_artist_list_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ArtistListRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn artist_row_to_dto(row: ArtistListRow) -> LibraryArtistDto {
    let (server_id, id, name, album_count, synced_at) = row;
    LibraryArtistDto {
        server_id,
        id,
        name: name.clone(),
        name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
        album_count: Some(album_count),
        synced_at,
        raw_json: Value::Null,
    }
}

/// `library_scope_list_artists` — dedup by `artist_key`, priority winner metadata.
pub fn list_artists(
    store: &LibraryStore,
    request: &LibraryScopeListRequest,
) -> Result<Vec<LibraryArtistDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_scopes(store, scopes)?;
    let limit = clamp_limit(request.limit);
    let offset = clamp_offset(request.offset);
    let order = artist_order_sql(request.sort.as_deref());

    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.artist_id, t.artist, t.album_id, t.synced_at, s.pr, \
                  {ARTIST_DEDUP_KEY} AS artist_dedup \
           {scoped} AND t.artist_id IS NOT NULL AND t.artist_id != '' \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at \
         FROM ( \
           SELECT server_id, artist_id, artist, synced_at, \
                  COUNT(DISTINCT album_id) AS album_count, \
                  MIN({ARTIST_PICK_KEY}) AS _pick \
           FROM base GROUP BY artist_dedup \
         ) \
         {order} \
         LIMIT ? OFFSET ?",
        scoped = scoped_track_join(),
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })
}

/// Layer-1 scoped album browse: sargable `library_id` join, no cluster on single-library
/// scopes; two-stage per-library → `album_key` merge when multiple libraries share a server.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_albums_layer1_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    // `GROUP BY t.album_id` shapes. A sort key that is a plain identifier may be
    // passed as-is (SQLite resolves it to the `MAX(...) AS x` result alias), but a
    // key that wraps the name in an expression — our display-artist `CASE` — must
    // carry the aggregates itself, or the name resolves to the table column and is
    // read from an arbitrary row of the group.
    grouped_order_sql: &str,
    // Dedup shape: the outer select projects plain columns, so plain names are right.
    deduped_order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    merge_by_album_key: bool,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    if scopes.len() == 1 {
        let pair = &scopes[0];
        let mut where_parts = vec![
            "t.deleted = 0".to_string(),
            "t.server_id = ?".to_string(),
            "t.album_id IS NOT NULL AND t.album_id != ''".to_string(),
        ];
        if pair.library_id.is_some() {
            where_parts.push("t.library_id = ?".to_string());
        }
        if !extra_where.trim().is_empty() {
            where_parts.push(extra_where.to_string());
        }
        let where_sql = where_parts.join(" AND ");
        let mut params = vec![SqlValue::Text(pair.server_id.clone())];
        if let Some(library_id) = &pair.library_id {
            params.push(SqlValue::Text(library_id.clone()));
        }
        params.extend_from_slice(extra_params);

        let count_sql = format!("SELECT COUNT(DISTINCT t.album_id) FROM track t WHERE {where_sql}");
        // Grouped shape: the ORDER BY must carry the aggregates itself. Aliasing the
        // sort columns is not enough — SQLite substitutes a result alias only when the
        // whole ORDER BY term is a plain identifier, so a bare name inside the
        // display-artist CASE would resolve to the table column and be read from an
        // arbitrary row of the group.
        let sql = format!(
            "SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                    MAX(t.artist_id), MAX(t.album_artist) AS album_artist, COUNT(*), \
                    SUM(t.duration_sec), MAX(t.year) AS year, MAX(t.genre), \
                    MAX(t.cover_art_id), MAX(t.starred_at), MAX(t.synced_at) \
             FROM track t WHERE {where_sql} \
             GROUP BY t.album_id \
             {grouped_order_sql} \
             LIMIT ? OFFSET ?"
        );
        let total = if skip_totals {
            0u32
        } else {
            store.with_read_conn(|conn| {
                let n: i64 = conn.query_row(
                    &count_sql,
                    params_from_iter(params.iter()),
                    |r| r.get(0),
                )?;
                Ok(n.max(0) as u32)
            })?
        };
        params.push(SqlValue::Integer(i64::from(limit)));
        params.push(SqlValue::Integer(i64::from(offset)));
        let albums = store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(params.iter()), map_album_list_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(album_row_to_dto).collect())
        })?;
        return finish_scope_album_list(store, albums, total);
    }

    if !merge_by_album_key && extra_where.trim().is_empty() {
        let server_id = &scopes[0].server_id;
        if scopes.iter().all(|p| &p.server_id == server_id) {
            let in_clause = scopes
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            let where_sql = format!(
                "t.deleted = 0 AND t.server_id = ? AND t.library_id IN ({in_clause}) \
                 AND t.album_id IS NOT NULL AND t.album_id != ''"
            );
            let mut params = vec![SqlValue::Text(server_id.clone())];
            for p in scopes {
                params.push(SqlValue::Text(p.library_id.clone().unwrap_or_default()));
            }
            let count_sql = format!("SELECT COUNT(DISTINCT t.album_id) FROM track t WHERE {where_sql}");
            // Grouped shape — same reasoning as the single-scope branch above.
            let sql = format!(
                "SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                        MAX(t.artist_id), MAX(t.album_artist) AS album_artist, COUNT(*), \
                        SUM(t.duration_sec), MAX(t.year) AS year, MAX(t.genre), \
                        MAX(t.cover_art_id), MAX(t.starred_at), MAX(t.synced_at) \
                 FROM track t WHERE {where_sql} \
                 GROUP BY t.album_id \
                 {grouped_order_sql} \
                 LIMIT ? OFFSET ?"
            );
            let total = if skip_totals {
                0u32
            } else {
                store.with_read_conn(|conn| {
                    let n: i64 = conn.query_row(
                        &count_sql,
                        params_from_iter(params.iter()),
                        |r| r.get(0),
                    )?;
                    Ok(n.max(0) as u32)
                })?
            };
            params.push(SqlValue::Integer(i64::from(limit)));
            params.push(SqlValue::Integer(i64::from(offset)));
            let albums = store.with_read_conn(|conn| {
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params_from_iter(params.iter()), map_album_list_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.into_iter().map(album_row_to_dto).collect())
            })?;
            return finish_scope_album_list(store, albums, total);
        }
    }

    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped = scoped_track_join();
    let base_where = append_extra_where(
        &format!("{scoped} AND t.album_id IS NOT NULL AND t.album_id != ''"),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let (count_sql, sql) = (
        format!(
            "{cte}, \
             per_lib AS ( \
               SELECT t.server_id, t.album_id, s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, \
                      MIN({ALBUM_PICK_KEY}) AS _pick \
               {base_where} \
               GROUP BY album_dedup, t.server_id, t.album_id, s.pr \
             ) \
             SELECT COUNT(DISTINCT album_dedup) FROM per_lib"
        ),
        format!(
            "{cte}, \
             base AS ( \
                SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                       t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                       s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
                {base_where} \
             ), track_winners AS ( \
               SELECT server_id, album_id, album, artist, artist_id, album_artist, year, genre, \
                      cover_art_id, starred_at, synced_at, duration_sec, id, pr, album_dedup, \
                      MIN(printf('%08d|%s|%s', pr, server_id, id)) AS _track_pick \
               FROM base GROUP BY album_dedup, track_dedup \
              ) \
              SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                     song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
              FROM ( \
                SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                       year, genre, cover_art_id, starred_at, synced_at, \
                       COUNT(*) AS song_count, SUM(duration_sec) AS duration_total, \
                       MIN({ALBUM_PICK_KEY}) AS _pick \
                FROM track_winners GROUP BY album_dedup \
              ) \
             {deduped_order_sql} \
             LIMIT ? OFFSET ?"
        ),
    );

    let total = if skip_totals {
        0u32
    } else {
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let albums = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_album_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(album_row_to_dto).collect())
    })?;
    finish_scope_album_list(store, albums, total)
}

/// Layer-1 scoped artist browse — sargable scope join; two-stage merge when `scopes.len() > 1`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_artists_layer1_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped = if scopes.len() == 1 {
        scoped_track_join_layer1()
    } else {
        scoped_track_join()
    };
    let base_where = append_extra_where(
        &format!("{scoped} AND t.artist_id IS NOT NULL AND t.artist_id != ''"),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let (count_sql, sql) = if scopes.len() == 1 {
        (
            format!("{cte} SELECT COUNT(DISTINCT t.artist_id) {base_where}"),
            format!(
                "{cte} \
                 SELECT t.server_id, t.artist_id, MAX(t.artist), COUNT(DISTINCT t.album_id), MAX(t.synced_at) \
                 {base_where} \
                 GROUP BY t.artist_id \
                 {order_sql} \
                 LIMIT ? OFFSET ?"
            ),
        )
    } else {
        (
            format!(
                "{cte}, \
                 per_lib AS ( \
                   SELECT t.server_id, t.artist_id, s.pr, {ARTIST_DEDUP_KEY} AS artist_dedup, \
                          MIN({ARTIST_PICK_KEY}) AS _pick \
                   {base_where} \
                   GROUP BY artist_dedup, t.server_id, t.artist_id, s.pr \
                 ) \
                 SELECT COUNT(DISTINCT artist_dedup) FROM per_lib"
            ),
            format!(
                "{cte}, \
                 per_lib AS ( \
                   SELECT t.server_id, t.artist_id, t.artist, t.album_id, t.synced_at, s.pr, \
                          {ARTIST_DEDUP_KEY} AS artist_dedup, MIN({ARTIST_PICK_KEY}) AS _pick \
                   {base_where} \
                   GROUP BY artist_dedup, t.server_id, t.artist_id, s.pr \
                 ) \
                 SELECT server_id, artist_id, artist, album_count, synced_at \
                 FROM ( \
                   SELECT server_id, artist_id, artist, synced_at, \
                          COUNT(DISTINCT album_id) AS album_count, MIN(_pick) AS _pick \
                   FROM per_lib GROUP BY artist_dedup \
                 ) \
                 {order_sql} \
                 LIMIT ? OFFSET ?"
            ),
        )
    };

    let total = if skip_totals {
        0u32
    } else {
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let artists = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })?;
    Ok((artists, total))
}

/// Layer-1 scoped browse over the `artist` table (#1209) — drive from the scoped
/// track set (sargable `scope` CTE join), then join `artist` rows. Avoids a
/// correlated EXISTS over the full server-wide `artist` table.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_index_artists_layer1_filtered(
    store: &LibraryStore,
    server_id: &str,
    scopes: &[LibraryScopePair],
    album_artists_only: bool,
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped_from = "FROM scoped_track s CROSS JOIN track t ON t.rowid = s.rowid";
    let credited_cte = if album_artists_only {
        // #1209: album credit = one row per album-level credit in scope, not every
        // track performer with a server-wide `album_count` index row.
        format!(
            "{cte}, \
             album_scoped AS ( \
               SELECT t.album_id, \
                      lower(trim(COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)))) \
                        AS credit_name \
               {scoped_from} \
               WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
               GROUP BY t.album_id \
             ), \
             scoped_ids AS ( \
               SELECT DISTINCT ar.id \
               FROM album_scoped ac \
               INNER JOIN artist ar ON ar.server_id = ? AND ar.album_count IS NOT NULL \
                 AND lower(trim(coalesce(ar.name, ''))) = ac.credit_name \
             )"
        )
    } else {
        format!(
            "{cte}, \
             scoped_ids AS ( \
               SELECT DISTINCT t.artist_id AS id \
               {scoped_from} \
               WHERE t.deleted = 0 AND t.artist_id IS NOT NULL AND t.artist_id != '' \
             )"
        )
    };
    let mut ar_where = "FROM artist ar \
         INNER JOIN scoped_ids si ON si.id = ar.id \
         WHERE ar.server_id = ?"
        .to_string();
    if album_artists_only {
        ar_where.push_str(" AND ar.album_count IS NOT NULL");
    }
    if !extra_where.trim().is_empty() {
        ar_where = append_extra_where(&ar_where, extra_where);
    }

    let count_sql = format!("{credited_cte} SELECT COUNT(*) {ar_where}");
    let select_sql = format!(
        "{credited_cte} SELECT ar.server_id, ar.id, ar.name, ar.album_count, ar.synced_at \
         {ar_where} {order_sql} LIMIT ? OFFSET ?"
    );

    let mut binds = scope_binds;
    if album_artists_only {
        binds.push(SqlValue::Text(server_id.to_string()));
    }
    binds.push(SqlValue::Text(server_id.to_string()));
    binds.extend_from_slice(extra_params);

    let total = if skip_totals {
        0u32
    } else {
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let artists = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&select_sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })?;
    Ok((artists, total))
}

/// Layer-1 scoped track browse — sargable join, no cross-library dedup window.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_tracks_layer1_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    bpm_resolved: bool,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(scoped_track_join_layer1(), extra_where);
    let mut binds = merge_binds(scope_binds, extra_params);

    let cols = if bpm_resolved {
        crate::search::aliased_track_columns_resolved_bpm("t")
    } else {
        aliased_track_columns("t")
    };

    let total = if skip_totals {
        0u32
    } else {
        let count_sql = format!("{cte} SELECT COUNT(*) {base_where}");
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    let sql = format!("{cte} SELECT {cols} {base_where} {order_sql} LIMIT ? OFFSET ?");
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let tracks = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                if bpm_resolved {
                    crate::search::row_to_track_dto_resolved_bpm(r)
                } else {
                    row_to_track_row(r).map(|tr| LibraryTrackDto::from_row(&tr))
                }
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    Ok((tracks, total))
}

/// Multi-scope album browse with track-level filters (advanced search / genre).
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_albums_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(
        &format!(
            "{scoped} AND t.album_id IS NOT NULL AND t.album_id != ''",
            scoped = scoped_track_join()
        ),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let total = if skip_totals {
        0u32
    } else {
        let count_sql = format!(
            "{cte} \
             SELECT COUNT(DISTINCT {ALBUM_DEDUP_KEY}) \
             {base_where}"
        );
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                  s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
           {base_where} \
         ), \
         track_winners AS ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, duration_sec, id, pr, album_dedup, \
                  MIN(printf('%08d|%s|%s', pr, server_id, id)) AS _track_pick \
           FROM base GROUP BY album_dedup, track_dedup \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                 song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
         FROM ( \
            SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                    year, genre, cover_art_id, starred_at, synced_at, \
                   COUNT(*) AS song_count, SUM(duration_sec) AS duration_total, \
                   MIN({ALBUM_PICK_KEY}) AS _pick \
            FROM track_winners GROUP BY album_dedup \
          ) \
         {order_sql} \
         LIMIT ? OFFSET ?",
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let albums = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_album_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(album_row_to_dto).collect())
    })?;
    finish_scope_album_list(store, albums, total)
}

/// Multi-scope artist browse with track-level filters (advanced search).
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_artists_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(
        &format!(
            "{scoped} AND t.artist_id IS NOT NULL AND t.artist_id != ''",
            scoped = scoped_track_join()
        ),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let total = if skip_totals {
        0u32
    } else {
        let count_sql = format!(
            "{cte} \
             SELECT COUNT(DISTINCT {ARTIST_DEDUP_KEY}) \
             {base_where}"
        );
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.artist_id, t.artist, t.album_id, t.synced_at, s.pr, \
                  {ARTIST_DEDUP_KEY} AS artist_dedup \
           {base_where} \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at \
         FROM ( \
           SELECT server_id, artist_id, artist, synced_at, \
                  COUNT(DISTINCT album_id) AS album_count, \
                  MIN({ARTIST_PICK_KEY}) AS _pick \
           FROM base GROUP BY artist_dedup \
         ) \
         {order_sql} \
         LIMIT ? OFFSET ?",
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let artists = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })?;
    Ok((artists, total))
}

/// Multi-scope track browse (no FTS) with track-level filters.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_tracks_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    bpm_resolved: bool,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(scoped_track_join(), extra_where);
    let mut binds = merge_binds(scope_binds, extra_params);

    let cols = if bpm_resolved {
        crate::search::aliased_track_columns_resolved_bpm("t")
    } else {
        aliased_track_columns("t")
    };
    let plain_cols = plain_track_columns_sql();

    let total = if skip_totals {
        0u32
    } else {
        let count_sql = format!(
            "{cte} \
             SELECT COUNT(DISTINCT {TRACK_DEDUP_KEY}) \
             {base_where}"
        );
        store.with_read_conn(|conn| {
            let n: i64 = conn.query_row(
                &count_sql,
                params_from_iter(binds.iter()),
                |r| r.get(0),
            )?;
            Ok(n.max(0) as u32)
        })?
    };

    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, s.pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY s.pr ASC, t.id ASC) AS rn \
           {base_where} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 \
         {order_sql} \
         LIMIT ? OFFSET ?",
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let tracks = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                if bpm_resolved {
                    crate::search::row_to_track_dto_resolved_bpm(r)
                } else {
                    row_to_track_row(r).map(|tr| LibraryTrackDto::from_row(&tr))
                }
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    Ok((tracks, total))
}

pub(crate) fn collect_scope_fts_rowids(
    conn: &rusqlite::Connection,
    fts: &str,
    scopes: &[LibraryScopePair],
    limit: i64,
) -> rusqlite::Result<Vec<i64>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte} \
         SELECT f.rowid FROM track_fts f \
         WHERE track_fts MATCH ? \
           AND EXISTS ( \
              SELECT 1 FROM scoped_track sc \
              WHERE sc.rowid = f.rowid \
           ) \
         ORDER BY {TRACK_FTS_BM25_RANK} LIMIT ?",
    );
    let mut binds = scope_binds;
    binds.push(SqlValue::Text(fts.to_string()));
    binds.push(SqlValue::Integer(limit));
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<i64> = stmt
        .query_map(params_from_iter(binds.iter()), |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn row_to_track_row_at(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<crate::repos::track::TrackRow> {
    Ok(crate::repos::track::TrackRow {
        server_id: row.get(offset)?,
        id: row.get(offset + 1)?,
        title: row.get(offset + 2)?,
        title_sort: row.get(offset + 3)?,
        artist: row.get(offset + 4)?,
        artist_id: row.get(offset + 5)?,
        album: row.get(offset + 6)?,
        album_id: row.get(offset + 7)?,
        album_artist: row.get(offset + 8)?,
        duration_sec: row.get(offset + 9)?,
        track_number: row.get(offset + 10)?,
        disc_number: row.get(offset + 11)?,
        year: row.get(offset + 12)?,
        genre: row.get(offset + 13)?,
        suffix: row.get(offset + 14)?,
        bit_rate: row.get(offset + 15)?,
        size_bytes: row.get(offset + 16)?,
        cover_art_id: row.get(offset + 17)?,
        starred_at: row.get(offset + 18)?,
        user_rating: row.get(offset + 19)?,
        play_count: row.get(offset + 20)?,
        played_at: row.get(offset + 21)?,
        server_path: row.get(offset + 22)?,
        library_id: row.get(offset + 23)?,
        isrc: row.get(offset + 24)?,
        mbid_recording: row.get(offset + 25)?,
        bpm: row.get(offset + 26)?,
        replay_gain_track_db: row.get(offset + 27)?,
        replay_gain_album_db: row.get(offset + 28)?,
        replay_gain_peak: row.get(offset + 29)?,
        content_hash: row.get(offset + 30)?,
        server_updated_at: row.get(offset + 31)?,
        server_created_at: row.get(offset + 32)?,
        deleted: row.get::<_, i64>(offset + 33)? != 0,
        synced_at: row.get(offset + 34)?,
        raw_json: row.get(offset + 35)?,
    })
}

fn fetch_deduped_tracks_by_rowids(
    conn: &rusqlite::Connection,
    rowids: &[i64],
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (0..rowids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let base_where = append_extra_where(
        &format!(
            "{scoped} AND t.rowid IN ({placeholders})",
            scoped = scoped_track_join()
        ),
        extra_where,
    );
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT t.rowid AS fts_rowid, {cols}, s.pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY s.pr ASC, t.id ASC) AS rn \
           {base_where} \
         ) \
         SELECT fts_rowid, {plain_cols} FROM ranked WHERE rn = 1",
    );
    let mut binds: Vec<SqlValue> = scope_binds;
    binds.extend(rowids.iter().copied().map(SqlValue::Integer));
    binds.extend_from_slice(extra_params);

    let mut stmt = conn.prepare(&sql)?;
    let mut by_rowid: std::collections::HashMap<i64, LibraryTrackDto> = std::collections::HashMap::new();
    for row in stmt.query_map(params_from_iter(binds.iter()), |r| {
        let fts_rowid: i64 = r.get(0)?;
        let track_row = row_to_track_row_at(r, 1)?;
        Ok((fts_rowid, LibraryTrackDto::from_row(&track_row)))
    })? {
        let (rowid, dto) = row?;
        by_rowid.insert(rowid, dto);
    }
    Ok(rowids
        .iter()
        .filter_map(|rid| by_rowid.get(rid).cloned())
        .collect())
}

/// FTS-first multi-scope track search with optional scalar filters.
pub(crate) fn search_tracks_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    fts_match: &str,
    extra_where: &str,
    extra_params: &[SqlValue],
    limit: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let pool = (i64::from(limit) * 4).clamp(64, i64::from(PAGE_LIMIT_MAX) * 4);

    store.with_read_conn(|conn| {
        let rowids = collect_scope_fts_rowids(conn, fts_match, scopes, pool)?;
        let mut tracks =
            fetch_deduped_tracks_by_rowids(conn, &rowids, scopes, extra_where, extra_params)?;
        let total = if skip_totals {
            0u32
        } else {
            tracks.len() as u32
        };
        tracks.truncate(limit as usize);
        Ok((tracks, total))
    })
}

/// Live-search songs over multi-scope with dedup + bm25 order preserved.
pub(crate) fn live_search_songs(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    fts_match: &str,
    limit: u32,
) -> Result<Vec<LibraryTrackDto>, String> {
    let scopes = non_empty_scopes(scopes)?;
    let pool = i64::from(limit.max(4));
    store.with_read_conn(|conn| {
        let rowids = collect_scope_fts_rowids(conn, fts_match, scopes, pool)?;
        let mut tracks = fetch_deduped_tracks_by_rowids(conn, &rowids, scopes, "", &[])?;
        tracks.truncate(limit as usize);
        Ok(tracks)
    })
}

/// Live-search albums over multi-scope — dedup by `album_key`, priority winner metadata.
pub(crate) fn live_search_albums(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    fts_match: &str,
    limit: u32,
) -> Result<Vec<LibraryAlbumDto>, String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         fts_hits AS ( \
           SELECT f.rowid, {TRACK_FTS_BM25_RANK} AS rank \
           FROM track_fts f \
           WHERE track_fts MATCH ? \
             AND EXISTS ( \
                SELECT 1 FROM scoped_track sc \
                INNER JOIN track c ON c.rowid = sc.rowid \
                WHERE c.rowid = f.rowid AND c.deleted = 0 \
                 AND c.album_id IS NOT NULL AND c.album_id != '' \
             ) \
           ORDER BY rank \
           LIMIT ? \
         ), \
         base AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.album_artist, t.artist_id, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, s.pr, \
                  MIN(h.rank) AS best_rank, {ALBUM_DEDUP_KEY} AS album_dedup \
           FROM fts_hits h \
           INNER JOIN track t ON t.rowid = h.rowid \
            INNER JOIN scoped_track s ON t.rowid = s.rowid \
           LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
           WHERE t.deleted = 0 \
           GROUP BY album_dedup, t.server_id, t.album_id, s.pr \
         ), \
         album_pick AS ( \
           SELECT server_id, album_id, album, artist, album_artist, artist_id, year, genre, \
                  cover_art_id, starred_at, synced_at, best_rank, album_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY album_dedup ORDER BY pr ASC, best_rank ASC, album_id ASC) AS rn \
           FROM base \
         ) \
         SELECT server_id, album_id, album, artist, album_artist, artist_id, year, genre, \
                cover_art_id, starred_at, synced_at, best_rank \
         FROM album_pick WHERE rn = 1 \
         ORDER BY best_rank \
         LIMIT ?",
    );
    binds.push(SqlValue::Text(fts_match.to_string()));
    binds.push(SqlValue::Integer(crate::live_search::LIVE_SEARCH_FTS_CANDIDATE_CAP));
    binds.push(SqlValue::Integer(i64::from(limit)));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                let track_artist: Option<String> = r.get(3)?;
                let album_artist: Option<String> = r.get(4)?;
                Ok(LibraryAlbumDto {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    name: r.get(2)?,
                    artist: pick_album_group_artist(track_artist, album_artist),
                    artist_id: r.get(5)?,
                    song_count: None,
                    duration_sec: None,
                    year: r.get(6)?,
                    genre: r.get(7)?,
                    cover_art_id: r.get(8)?,
                    starred_at: r.get(9)?,
                    synced_at: r.get(10)?,
                    raw_json: Value::Null,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .map_err(|e| e.to_string())
}

/// Live-search artists over multi-scope — dedup by `artist_key`, priority winner metadata.
pub(crate) fn live_search_artists(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    fts_match: &str,
    limit: u32,
) -> Result<Vec<LibraryArtistDto>, String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         fts_hits AS ( \
           SELECT f.rowid, {TRACK_FTS_BM25_RANK} AS rank \
           FROM track_fts f \
           WHERE track_fts MATCH ? \
             AND EXISTS ( \
                SELECT 1 FROM scoped_track sc \
                INNER JOIN track c ON c.rowid = sc.rowid \
                WHERE c.rowid = f.rowid AND c.deleted = 0 \
                 AND c.artist_id IS NOT NULL AND c.artist_id != '' \
             ) \
           ORDER BY rank \
           LIMIT ? \
         ), \
         base AS ( \
           SELECT t.server_id, t.artist_id, t.artist, t.synced_at, s.pr, \
                  MIN(h.rank) AS best_rank, {ARTIST_DEDUP_KEY} AS artist_dedup \
           FROM fts_hits h \
           INNER JOIN track t ON t.rowid = h.rowid \
            INNER JOIN scoped_track s ON t.rowid = s.rowid \
           LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
           WHERE t.deleted = 0 \
           GROUP BY t.server_id, t.artist_id, t.artist, t.synced_at, s.pr, artist_dedup \
         ), \
         artist_pick AS ( \
           SELECT *, ROW_NUMBER() OVER (PARTITION BY artist_dedup ORDER BY pr ASC, best_rank ASC, artist_id ASC) AS rn \
           FROM base \
         ) \
         SELECT server_id, artist_id, artist, synced_at, best_rank \
         FROM artist_pick WHERE rn = 1 \
         ORDER BY best_rank \
         LIMIT ?",
    );
    binds.push(SqlValue::Text(fts_match.to_string()));
    binds.push(SqlValue::Integer(crate::live_search::LIVE_SEARCH_FTS_CANDIDATE_CAP));
    binds.push(SqlValue::Integer(i64::from(limit)));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                let name: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
                Ok(LibraryArtistDto {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    name: name.clone(),
                    name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
                    album_count: None,
                    synced_at: r.get(3)?,
                    raw_json: Value::Null,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// `library_scope_search_tracks` — FTS-first `EXISTS`, then scope dedup.
pub fn search_tracks(
    store: &LibraryStore,
    request: &LibraryScopeSearchRequest,
) -> Result<Vec<LibraryTrackDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    let query = request.query.trim();
    if !fts_query_meets_min_len(query) {
        return Ok(Vec::new());
    }
    let fts = fts_track_match_query(query).ok_or_else(|| "empty query".to_string())?;
    let limit = clamp_limit(request.limit);
    // Over-fetch before dedup collapse.
    let pool = (i64::from(limit) * 4).clamp(64, i64::from(PAGE_LIMIT_MAX) * 4);

    store.with_read_conn(|conn| {
        let rowids = collect_scope_fts_rowids(conn, &fts, scopes, pool)?;
        let mut tracks = fetch_deduped_tracks_by_rowids(conn, &rowids, scopes, "", &[])?;
        tracks.truncate(limit as usize);
        Ok(tracks)
    })
}

fn lookup_album_key(
    conn: &rusqlite::Connection,
    server_id: &str,
    album_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT ck.album_key FROM track t \
         INNER JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? AND t.album_id = ? AND t.deleted = 0 LIMIT 1",
        rusqlite::params![server_id, album_id],
        // The row exists but `album_key` is SQL NULL by design (any empty name
        // part → NULL key). Read it as `Option` so a NULL key yields `None`
        // instead of an `InvalidColumnType` error that would fail detail open.
        |r| r.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

fn lookup_artist_key(
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

fn lookup_track_partition(
    conn: &rusqlite::Connection,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<Option<(Option<String>, i64)>> {
    conn.query_row(
        "SELECT ck.cluster_key, ck.duration_sec / 5 FROM track t \
         INNER JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? AND t.id = ? AND t.deleted = 0 LIMIT 1",
        rusqlite::params![server_id, track_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
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
    anchor_server: &str,
    anchor_id: &str,
) -> rusqlite::Result<Vec<LibraryEntitySourceDto>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if cluster_key.is_some() {
        "ck.cluster_key = ? AND ck.duration_sec / 5 = ?"
    } else {
        "t.server_id = ? AND t.id = ? AND ck.cluster_key IS NULL"
    };
    let sql = format!(
        "{cte} SELECT t.server_id, t.id, t.library_id, s.pr, t.duration_sec, t.suffix, \
         t.bit_rate, t.size_bytes, t.starred_at, t.user_rating \
         {scoped} AND {key_filter} \
         ORDER BY s.pr ASC, t.id ASC",
        scoped = scoped_track_join(),
    );
    let mut binds = scope_binds;
    if let Some(key) = cluster_key {
        binds.push(SqlValue::Text(key.to_string()));
        binds.push(SqlValue::Integer(duration_bucket));
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
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if identity_key.is_some() {
        format!("ck.{cluster_column} = ?")
    } else {
        format!(
            "t.server_id = ? AND t.{entity_column} = ? AND ck.{cluster_column} IS NULL"
        )
    };
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
           SELECT t.server_id, t.{entity_column} AS entity_id, t.library_id, s.pr, \
                  ROW_NUMBER() OVER ( \
                    PARTITION BY t.server_id, t.{entity_column} \
                    ORDER BY s.pr ASC, t.id ASC \
                  ) AS rn \
           {scoped} AND t.{entity_column} IS NOT NULL AND t.{entity_column} != '' AND {key_filter} \
         ) \
         SELECT candidates.server_id, candidates.entity_id, candidates.library_id, candidates.pr, \
                {duration_column}, NULL, NULL, NULL, {starred_column}, NULL \
         FROM candidates {metadata_join} \
         WHERE candidates.rn = 1 ORDER BY candidates.pr ASC, candidates.entity_id ASC",
        scoped = scoped_track_join(),
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
    for pair in scopes {
        if pair.server_id != anchor_server {
            crate::identity::ensure_cluster_keys_built(store, &pair.server_id)?;
        }
    }

    store.with_read_conn(|conn| match request.entity_type {
        LibrarySourceEntityType::Track => {
            let Some((cluster_key, duration_bucket)) =
                lookup_track_partition(conn, anchor_server, anchor_id)?
            else {
                return Ok(Vec::new());
            };
            fetch_track_sources(
                conn,
                scopes,
                cluster_key.as_deref(),
                duration_bucket,
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

fn priority_album_owner(candidates: &[LibraryAlbumDto]) -> LibraryAlbumDto {
    candidates.first().cloned().unwrap_or_else(|| LibraryAlbumDto {
        server_id: String::new(),
        id: String::new(),
        name: String::new(),
        artist: None,
        artist_id: None,
        song_count: None,
        duration_sec: None,
        year: None,
        genre: None,
        cover_art_id: None,
        starred_at: None,
        synced_at: 0,
        raw_json: Value::Null,
    })
}

fn priority_artist_owner(candidates: &[LibraryArtistDto]) -> LibraryArtistDto {
    candidates.first().cloned().unwrap_or_else(|| LibraryArtistDto {
        server_id: String::new(),
        id: String::new(),
        name: String::new(),
        name_sort: None,
        album_count: None,
        synced_at: 0,
        raw_json: Value::Null,
    })
}

fn fetch_album_candidates(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    album_key: Option<&str>,
    anchor_server: &str,
    anchor_album_id: &str,
) -> rusqlite::Result<Vec<(i64, LibraryAlbumDto)>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if album_key.is_some() {
        "AND ck.album_key = ?"
    } else {
        "AND t.server_id = ? AND t.album_id = ? AND ck.album_key IS NULL"
    };
    let sql = format!(
        "{cte}, \
         grouped AS ( \
           SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                  MAX(t.artist_id) AS artist_id, MAX(t.album_artist) AS album_artist, \
                  MAX(t.year) AS year, MAX(t.genre) AS genre, MAX(t.cover_art_id) AS cover_art_id, \
                  MAX(t.starred_at) AS starred_at, MAX(t.synced_at) AS synced_at, \
                  COUNT(*) AS song_count, SUM(t.duration_sec) AS duration_total, MIN(s.pr) AS best_pr \
           {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
           GROUP BY t.server_id, t.album_id \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, song_count, duration_total, \
                year, genre, cover_art_id, starred_at, synced_at, best_pr \
         FROM grouped ORDER BY best_pr ASC",
        scoped = scoped_track_join(),
    );
    let mut binds = scope_binds;
    if let Some(key) = album_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_album_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            let track_artist: Option<String> = r.get(3)?;
            let album_artist: Option<String> = r.get(5)?;
            let pr: i64 = r.get(13)?;
            Ok((
                pr,
                LibraryAlbumDto {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    name: r.get(2)?,
                    artist: pick_album_group_artist(track_artist, album_artist),
                    artist_id: r.get(4)?,
                    song_count: Some(r.get(6)?),
                    duration_sec: Some(r.get(7)?),
                    year: r.get(8)?,
                    genre: r.get(9)?,
                    cover_art_id: r.get(10)?,
                    starred_at: r.get(11)?,
                    synced_at: r.get(12)?,
                    raw_json: Value::Null,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn fetch_scope_deduped_tracks_for_album_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    album_key: Option<&str>,
    anchor_server: &str,
    anchor_album_id: &str,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if album_key.is_some() {
        "AND ck.album_key = ?"
    } else {
        "AND t.server_id = ? AND t.album_id = ? AND ck.album_key IS NULL"
    };
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, s.pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY s.pr ASC, t.id ASC) AS rn \
           {scoped} AND t.album_id IS NOT NULL {key_filter} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 \
         ORDER BY track_number ASC NULLS LAST, disc_number ASC NULLS LAST, title COLLATE NOCASE ASC",
        scoped = scoped_track_join(),
    );
    let mut binds = scope_binds;
    if let Some(key) = album_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_album_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(LibraryTrackDto::from_row(&row_to_track_row(r)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// `library_scope_album_detail` — resolve anchor → `album_key`, aggregate tracks + metadata.
pub fn album_detail(
    store: &LibraryStore,
    request: &LibraryScopeAlbumDetailRequest,
) -> Result<LibraryScopeAlbumDetailResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    let server_id = request.server_id.trim();
    let album_id = request.album_id.trim();
    if server_id.is_empty() || album_id.is_empty() {
        return Err("server_id and album_id are required".into());
    }

    store.with_read_conn(|conn| {
        let album_key = lookup_album_key(conn, server_id, album_id)?;
        let candidates = fetch_album_candidates(conn, scopes, album_key.as_deref(), server_id, album_id)?;
        let albums: Vec<LibraryAlbumDto> = candidates.into_iter().map(|(_, a)| a).collect();
        let mut album = priority_album_owner(&albums);
        album.starred_at = read_album_starred_at(conn, &album.server_id, &album.id).unwrap_or(None);
        let tracks = fetch_scope_deduped_tracks_for_album_key(
            conn,
            scopes,
            album_key.as_deref(),
            server_id,
            album_id,
        )?;
        Ok(LibraryScopeAlbumDetailResponse { album, tracks })
    })
}

fn fetch_artist_candidates(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Vec<(i64, LibraryArtistDto)>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if artist_key.is_some() {
        "AND ck.artist_key = ?"
    } else {
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL"
    };
    let sql = format!(
        "{cte}, \
         grouped AS ( \
           SELECT t.server_id, t.artist_id, MAX(t.artist) AS artist, \
                  COUNT(DISTINCT t.album_id) AS album_count, MAX(t.synced_at) AS synced_at, \
                  MIN(s.pr) AS best_pr \
           {scoped} AND t.artist_id IS NOT NULL AND t.artist_id != '' {key_filter} \
           GROUP BY t.server_id, t.artist_id \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at, best_pr \
         FROM grouped ORDER BY best_pr ASC",
        scoped = scoped_track_join(),
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            let name: String = r.get(2)?;
            Ok((
                r.get(5)?,
                LibraryArtistDto {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    name: name.clone(),
                    name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
                    album_count: Some(r.get(3)?),
                    synced_at: r.get(4)?,
                    raw_json: Value::Null,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn fetch_albums_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Vec<LibraryAlbumDto>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if artist_key.is_some() {
        "AND ck.artist_key = ?"
    } else {
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL"
    };
    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                  s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
           {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
         ), \
         deduped_tracks AS ( \
           SELECT *, ROW_NUMBER() OVER (PARTITION BY track_dedup ORDER BY pr ASC, id ASC) AS trn \
           FROM base \
         ), \
         album_stats AS ( \
           SELECT album_dedup, COUNT(*) AS song_count, SUM(duration_sec) AS duration_total \
           FROM deduped_tracks WHERE trn = 1 GROUP BY album_dedup \
         ), \
         album_pick AS ( \
           SELECT b.server_id, b.album_id, b.album, b.artist, b.artist_id, b.album_artist, \
                  b.year, b.genre, b.cover_art_id, b.starred_at, b.synced_at, b.album_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY b.album_dedup ORDER BY b.pr ASC, b.album_id ASC, b.id ASC) AS rn \
           FROM base b \
         ) \
         SELECT p.server_id, p.album_id, p.album, p.artist, p.artist_id, p.album_artist, \
                st.song_count, st.duration_total, p.year, p.genre, p.cover_art_id, p.starred_at, p.synced_at \
         FROM album_pick p \
         INNER JOIN album_stats st ON p.album_dedup = st.album_dedup \
         WHERE p.rn = 1 \
         ORDER BY p.album COLLATE NOCASE ASC",
        scoped = scoped_track_join(),
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), map_album_list_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(album_row_to_dto).collect())
}

fn fetch_scope_deduped_tracks_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let key_filter = if artist_key.is_some() {
        "AND ck.artist_key = ?"
    } else {
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL"
    };
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, s.pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY s.pr ASC, t.id ASC) AS rn \
           {scoped} AND t.artist_id IS NOT NULL {key_filter} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 \
         ORDER BY album COLLATE NOCASE ASC, track_number ASC NULLS LAST, title COLLATE NOCASE ASC",
        scoped = scoped_track_join(),
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(LibraryTrackDto::from_row(&row_to_track_row(r)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// `library_scope_artist_detail` — resolve anchor → `artist_key`, aggregate albums + tracks.
pub fn artist_detail(
    store: &LibraryStore,
    request: &LibraryScopeArtistDetailRequest,
) -> Result<LibraryScopeArtistDetailResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    let server_id = request.server_id.trim();
    let artist_id = request.artist_id.trim();
    if server_id.is_empty() || artist_id.is_empty() {
        return Err("server_id and artist_id are required".into());
    }

    store.with_read_conn(|conn| {
        let artist_key = lookup_artist_key(conn, server_id, artist_id)?;
        let candidates = fetch_artist_candidates(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
        )?;
        let candidates: Vec<LibraryArtistDto> = candidates.into_iter().map(|(_, a)| a).collect();
        let artist = priority_artist_owner(&candidates);
        let albums = fetch_albums_for_artist_key(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
        )?;
        let tracks = fetch_scope_deduped_tracks_for_artist_key(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
        )?;
        Ok(LibraryScopeArtistDetailResponse {
            artist,
            albums,
            tracks,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::rebuild_cluster_keys;
    use crate::repos::track::{TrackRepository, TrackRow};

    fn scope_pair(server: &str, lib: &str) -> LibraryScopePair {
        LibraryScopePair {
            server_id: server.into(),
            library_id: Some(lib.into()),
        }
    }

    fn whole_scope(server: &str) -> LibraryScopePair {
        LibraryScopePair {
            server_id: server.into(),
            library_id: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn track(
        server: &str,
        id: &str,
        title: &str,
        artist: Option<&str>,
        album: &str,
        album_id: &str,
        artist_id: Option<&str>,
        duration: i64,
        library_id: &str,
        year: Option<i64>,
        genre: Option<&str>,
        cover: Option<&str>,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: artist.map(str::to_string),
            artist_id: artist_id.map(str::to_string),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: artist.map(str::to_string),
            duration_sec: duration,
            track_number: Some(1),
            disc_number: Some(1),
            year,
            genre: genre.map(str::to_string),
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: cover.map(str::to_string),
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: Some(library_id.into()),
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn seed_and_rebuild(store: &LibraryStore, rows: &[TrackRow]) {
        TrackRepository::new(store).upsert_batch(rows).unwrap();
        rebuild_cluster_keys(store, None).unwrap();
    }

    #[test]
    fn dedup_collapses_same_album_and_priority_winner_flips() {
        let store = LibraryStore::open_in_memory();
        let rows = [
            track(
                "s1",
                "t-a1",
                "Song",
                Some("Artist"),
                "Album",
                "alb-a",
                Some("art1"),
                200,
                "lib-a",
                Some(2001),
                Some("Rock"),
                Some("cover-a"),
            ),
            track(
                "s1",
                "t-b1",
                "Song",
                Some("Artist"),
                "Album",
                "alb-b",
                Some("art1"),
                200,
                "lib-b",
                Some(1999),
                Some("Pop"),
                Some("cover-b"),
            ),
        ];
        seed_and_rebuild(&store, &rows);

        let req_a_first = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            sort: None,
            limit: Some(50),
            offset: Some(0),
        };
        let albums_a = list_albums(&store, &req_a_first).unwrap();
        assert_eq!(albums_a.len(), 1);
        assert_eq!(albums_a[0].id, "alb-a");
        assert_eq!(albums_a[0].year, Some(2001));
        assert_eq!(albums_a[0].genre.as_deref(), Some("Rock"));
        assert_eq!(albums_a[0].song_count, Some(1));
        assert_eq!(albums_a[0].duration_sec, Some(200));

        let req_b_first = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-b"), scope_pair("s1", "lib-a")],
            sort: None,
            limit: Some(50),
            offset: Some(0),
        };
        let albums_b = list_albums(&store, &req_b_first).unwrap();
        assert_eq!(albums_b.len(), 1);
        assert_eq!(albums_b[0].id, "alb-b");
        assert_eq!(albums_b[0].year, Some(1999));
    }

    #[test]
    fn null_album_key_stays_individual() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1",
                    "t1",
                    "No Artist",
                    None,
                    "Al1",
                    "alb1",
                    None,
                    100,
                    "lib-a",
                    None,
                    None,
                    None,
                ),
                track(
                    "s1",
                    "t2",
                    "Also None",
                    None,
                    "Al2",
                    "alb2",
                    None,
                    100,
                    "lib-b",
                    None,
                    None,
                    None,
                ),
            ],
        );
        let req = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            sort: None,
            limit: Some(50),
            offset: None,
        };
        let albums = list_albums(&store, &req).unwrap();
        assert_eq!(albums.len(), 2);
    }

    #[test]
    fn duration_guard_splits_cluster_key_group() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1",
                    "t-short",
                    "Same",
                    Some("A"),
                    "Al",
                    "alb1",
                    Some("ar1"),
                    100,
                    "lib-a",
                    None,
                    None,
                    None,
                ),
                track(
                    "s1",
                    "t-long",
                    "Same",
                    Some("A"),
                    "Al",
                    "alb2",
                    Some("ar1"),
                    200,
                    "lib-b",
                    None,
                    None,
                    None,
                ),
            ],
        );
        let req = LibraryScopeSearchRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            query: "Same".into(),
            limit: Some(10),
        };
        let hits = search_tracks(&store, &req).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn single_scope_returns_correct_album() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[track(
                "s1",
                "t1",
                "Only",
                Some("A"),
                "Solo",
                "alb-solo",
                Some("ar1"),
                180,
                "lib-a",
                None,
                None,
                None,
            )],
        );
        let req = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            sort: None,
            limit: Some(10),
            offset: None,
        };
        let albums = list_albums(&store, &req).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].id, "alb-solo");
    }

    #[test]
    fn pagination_and_order_stable() {
        let store = LibraryStore::open_in_memory();
        let rows = [
            track(
                "s1",
                "t1",
                "A",
                Some("X"),
                "Zebra",
                "alb-z",
                Some("ar1"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t2",
                "B",
                Some("X"),
                "Alpha",
                "alb-a",
                Some("ar1"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t3",
                "C",
                Some("X"),
                "Middle",
                "alb-m",
                Some("ar1"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
        ];
        seed_and_rebuild(&store, &rows);
        let req = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            sort: None,
            limit: Some(2),
            offset: Some(1),
        };
        let page = list_albums(&store, &req).unwrap();
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].name, "Middle");
        assert_eq!(page[1].name, "Zebra");
    }

    #[test]
    fn album_detail_uses_one_priority_owner_record() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1",
                    "t-a1",
                    "Song",
                    Some("Artist"),
                    "Album",
                    "alb-a",
                    Some("art1"),
                    200,
                    "lib-a",
                    Some(2001),
                    None,
                    None,
                ),
                track(
                    "s1",
                    "t-b1",
                    "Song",
                    Some("Artist"),
                    "Album",
                    "alb-b",
                    Some("art1"),
                    200,
                    "lib-b",
                    None,
                    Some("Jazz"),
                    Some("cov-b"),
                ),
            ],
        );
        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
                album_id: "alb-a".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.album.year, Some(2001));
        assert_eq!(detail.album.genre, None);
        assert_eq!(detail.album.cover_art_id, None);
        assert_eq!(detail.tracks.len(), 1);
    }

    #[test]
    fn artist_detail_owner_uses_full_pair_priority_within_one_server() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "t-low", "One", Some("Shared Artist"), "Low", "al-low",
                    Some("artist-low"), 100, "lib-low", None, None, None,
                ),
                track(
                    "s1", "t-high", "Two", Some("Shared Artist"), "High", "al-high",
                    Some("artist-high"), 100, "lib-high", None, None, None,
                ),
            ],
        );
        let detail = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-high"), scope_pair("s1", "lib-low")],
                artist_id: "artist-low".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.artist.id, "artist-high");
        assert_eq!(detail.albums.len(), 2);
        assert_eq!(detail.tracks.len(), 2);
    }

    #[test]
    fn scope_normalization_keeps_empty_library_and_rejects_overlap() {
        let duplicate = vec![scope_pair("s1", ""), scope_pair("s1", "")];
        let normalized = normalize_scope_pairs(&duplicate).unwrap();
        assert_eq!(normalized, vec![scope_pair("s1", "")]);

        let overlap = vec![whole_scope("s1"), scope_pair("s1", "lib-a")];
        assert!(normalize_scope_pairs(&overlap)
            .unwrap_err()
            .contains("cannot mix whole-server and exact-library"));
    }

    #[test]
    fn whole_server_scope_includes_empty_library_but_exact_empty_does_not_include_others() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "t-empty", "Empty", Some("A"), "Empty Album", "al-empty",
                    Some("ar1"), 100, "", None, None, None,
                ),
                track(
                    "s1", "t-lib", "Named", Some("B"), "Named Album", "al-lib",
                    Some("ar2"), 100, "lib-a", None, None, None,
                ),
            ],
        );
        let whole = list_albums(
            &store,
            &LibraryScopeListRequest {
                scopes: vec![whole_scope("s1")],
                sort: None,
                limit: Some(10),
                offset: None,
            },
        )
        .unwrap();
        assert_eq!(whole.len(), 2);

        let exact_empty = list_albums(
            &store,
            &LibraryScopeListRequest {
                scopes: vec![scope_pair("s1", "")],
                sort: None,
                limit: Some(10),
                offset: None,
            },
        )
        .unwrap();
        assert_eq!(exact_empty.len(), 1);
        assert_eq!(exact_empty[0].id, "al-empty");
    }

    #[test]
    fn cross_server_whole_scope_priority_and_duration_bucket_are_stable() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "t-a", "Shared", Some("Artist"), "Album", "al-a",
                    Some("ar-a"), 104, "lib-a", Some(2001), None, None,
                ),
                track(
                    "s2", "t-b", "Shared", Some("Artist"), "Album", "al-b",
                    Some("ar-b"), 104, "", Some(1999), None, None,
                ),
                track(
                    "s2", "t-boundary", "Shared", Some("Artist"), "Album", "al-b",
                    Some("ar-b"), 105, "", Some(1999), None, None,
                ),
            ],
        );
        let first = search_tracks(
            &store,
            &LibraryScopeSearchRequest {
                scopes: vec![whole_scope("s1"), whole_scope("s2")],
                query: "Shared".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(first.len(), 2, "104s copies merge; 105s starts a new bucket");
        assert_eq!(first[0].server_id, "s1");

        let flipped = search_tracks(
            &store,
            &LibraryScopeSearchRequest {
                scopes: vec![whole_scope("s2"), whole_scope("s1")],
                query: "Shared".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert!(flipped.iter().any(|track| track.id == "t-b"));
        assert!(!flipped.iter().any(|track| track.id == "t-a"));
    }

    #[test]
    fn source_resolver_track_matches_browse_partition_priority_and_metadata() {
        let store = LibraryStore::open_in_memory();
        let mut high = track(
            "s1", "t-high", "Shared", Some("Artist"), "Album", "al-high",
            Some("ar-high"), 104, "lib-high", None, None, None,
        );
        high.suffix = Some("flac".into());
        high.bit_rate = Some(1_000);
        high.size_bytes = Some(30_000_000);
        high.starred_at = Some(1_700_000_000);
        high.user_rating = Some(5);
        let mut low = track(
            "s2", "t-low", "Shared", Some("Artist"), "Album", "al-low",
            Some("ar-low"), 104, "lib-low", None, None, None,
        );
        low.suffix = Some("mp3".into());
        low.bit_rate = Some(320);
        low.size_bytes = Some(8_000_000);
        let boundary = track(
            "s3", "t-boundary", "Shared", Some("Artist"), "Album", "al-boundary",
            Some("ar-boundary"), 105, "lib-boundary", None, None, None,
        );
        seed_and_rebuild(&store, &[high, low, boundary]);

        let scopes = vec![
            scope_pair("s2", "lib-low"),
            scope_pair("s1", "lib-high"),
            scope_pair("s3", "lib-boundary"),
        ];
        let sources = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Track,
                anchor_server_id: "s1".into(),
                anchor_id: "t-high".into(),
                scopes: scopes.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            sources.iter().map(|source| source.id.as_str()).collect::<Vec<_>>(),
            vec!["t-low", "t-high"]
        );
        assert_eq!(sources[0].priority, 0);
        assert_eq!(sources[1].priority, 1);
        assert_eq!(sources[1].library_id, "lib-high");
        assert_eq!(sources[1].duration_sec, Some(104));
        assert_eq!(sources[1].suffix.as_deref(), Some("flac"));
        assert_eq!(sources[1].bit_rate, Some(1_000));
        assert_eq!(sources[1].size_bytes, Some(30_000_000));
        assert_eq!(sources[1].starred_at, Some(1_700_000_000));
        assert_eq!(sources[1].user_rating, Some(5));

        let browse = search_tracks(
            &store,
            &LibraryScopeSearchRequest {
                scopes,
                query: "Shared".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(browse.len(), 2, "the 105-second boundary remains a separate partition");
        assert_eq!(browse[0].id, "t-low", "browse and resolver use pair priority");
    }

    #[test]
    fn source_resolver_album_and_artist_use_browse_identity_and_pair_priority() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "t-a", "One", Some("Shared Artist"), "Shared Album", "al-a",
                    Some("ar-a"), 100, "lib-a", None, None, None,
                ),
                track(
                    "s2", "t-b", "Two", Some("Shared Artist"), "Shared Album", "al-b",
                    Some("ar-b"), 110, "lib-b", None, None, None,
                ),
            ],
        );
        store
            .with_conn_mut("test.source_resolver_album_metadata", |conn| {
                conn.execute(
                    "INSERT INTO album(server_id, id, name, duration_sec, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al-a', 'Shared Album', 100, 11, 1, '{}'), \
                            ('s2', 'al-b', 'Shared Album', 110, 22, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let scopes = vec![scope_pair("s2", "lib-b"), scope_pair("s1", "lib-a")];

        let albums = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Album,
                anchor_server_id: "s1".into(),
                anchor_id: "al-a".into(),
                scopes: scopes.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            albums.iter().map(|source| source.id.as_str()).collect::<Vec<_>>(),
            vec!["al-b", "al-a"]
        );
        assert_eq!(albums[0].priority, 0);
        assert_eq!(albums[0].duration_sec, Some(110));
        assert_eq!(albums[0].starred_at, Some(22));
        assert_eq!(albums[0].suffix, None);

        let artists = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Artist,
                anchor_server_id: "s1".into(),
                anchor_id: "ar-a".into(),
                scopes,
            },
        )
        .unwrap();
        assert_eq!(
            artists.iter().map(|source| source.id.as_str()).collect::<Vec<_>>(),
            vec!["ar-b", "ar-a"]
        );
        assert!(artists.iter().all(|source| source.duration_sec.is_none()));
        assert!(artists.iter().all(|source| source.starred_at.is_none()));
    }

    #[test]
    fn source_resolver_returns_only_selected_concrete_sources_and_handles_missing_anchor() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "anchor", "t-anchor", "Shared", Some("Artist"), "Album", "al-anchor",
                    Some("ar-anchor"), 100, "lib-anchor", None, None, None,
                ),
                track(
                    "selected", "t-selected", "Shared", Some("Artist"), "Album", "al-selected",
                    Some("ar-selected"), 100, "", None, None, None,
                ),
                track(
                    "excluded", "t-excluded", "Shared", Some("Artist"), "Album", "al-excluded",
                    Some("ar-excluded"), 100, "lib-excluded", None, None, None,
                ),
            ],
        );

        let sources = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Track,
                anchor_server_id: "anchor".into(),
                anchor_id: "t-anchor".into(),
                scopes: vec![whole_scope("selected")],
            },
        )
        .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "t-selected");
        assert_eq!(sources[0].library_id, "");

        let missing = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Track,
                anchor_server_id: "anchor".into(),
                anchor_id: "missing".into(),
                scopes: vec![whole_scope("selected")],
            },
        )
        .unwrap();
        assert!(missing.is_empty());
    }

    #[test]
    fn source_resolver_null_identity_does_not_merge_unrelated_entities() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "t-anchor", "No Artist", None, "Album", "al-anchor", None, 100,
                    "lib-a", None, None, None,
                ),
                track(
                    "s2", "t-other", "No Artist", None, "Album", "al-other", None, 100,
                    "lib-b", None, None, None,
                ),
            ],
        );
        let sources = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Track,
                anchor_server_id: "s1".into(),
                anchor_id: "t-anchor".into(),
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            },
        )
        .unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].id, "t-anchor");
    }

    #[test]
    fn scope_compiler_keeps_separate_indexed_branches_and_fts_exists() {
        let scopes = vec![scope_pair("s1", "lib-a"), whole_scope("s2")];
        let (cte, _) = scope_cte_sql(&scopes);
        assert!(cte.contains("exact_scope"));
        assert!(cte.contains("whole_scope"));
        assert!(cte.contains("UNION ALL"));
        assert!(!cte.contains("IS NULL OR"));

        let store = LibraryStore::open_in_memory();
        let plan_sql = format!(
            "EXPLAIN QUERY PLAN {cte} SELECT f.rowid FROM track_fts f \
             WHERE track_fts MATCH ? AND EXISTS (SELECT 1 FROM scoped_track sc WHERE sc.rowid = f.rowid) \
             ORDER BY {TRACK_FTS_BM25_RANK} LIMIT 10"
        );
        let plan = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(&plan_sql)?;
                let rows = stmt
                    .query_map(["s1", "lib-a", "s2", "shared"], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.join("\n"))
            })
            .unwrap();
        assert!(plan.contains("VIRTUAL TABLE INDEX"), "{plan}");
        assert!(plan.contains("SEARCH t") || plan.contains("COVERING INDEX"), "{plan}");
    }

    #[test]
    fn scope_list_album_star_uses_album_row_not_track_aggregate() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[track(
                "s1",
                "t1",
                "Song",
                Some("Artist"),
                "Album",
                "alb1",
                Some("art1"),
                200,
                "lib-a",
                None,
                None,
                None,
            )],
        );
        store
            .with_conn("test", |c| {
                c.execute(
                    "UPDATE track SET starred_at = 999 WHERE server_id = 's1' AND id = 't1'",
                    [],
                )?;
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'alb1', 'Album', 1700, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let req = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            sort: None,
            limit: Some(10),
            offset: None,
        };
        let albums = list_albums(&store, &req).unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].starred_at, Some(1700));

        store
            .with_conn("test", |c| {
                c.execute(
                    "UPDATE album SET starred_at = NULL WHERE server_id = 's1' AND id = 'alb1'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let albums = list_albums(&store, &req).unwrap();
        assert_eq!(albums[0].starred_at, None);
    }

    #[test]
    fn album_detail_star_reads_anchor_album_id() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1",
                    "t-a1",
                    "Song",
                    Some("Artist"),
                    "Album",
                    "alb-a",
                    Some("art1"),
                    200,
                    "lib-a",
                    None,
                    None,
                    None,
                ),
                track(
                    "s1",
                    "t-b1",
                    "Song",
                    Some("Artist"),
                    "Album",
                    "alb-b",
                    Some("art1"),
                    200,
                    "lib-b",
                    None,
                    None,
                    None,
                ),
            ],
        );
        store
            .with_conn("test", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'alb-a', 'Album', 1111, 1, '{}'), \
                            ('s1', 'alb-b', 'Album', 2222, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
                album_id: "alb-a".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.album.starred_at, Some(1111));
    }

    #[test]
    fn artist_dedup_collapses_across_libraries() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1",
                    "t-a1",
                    "S1",
                    Some("Shared"),
                    "Al1",
                    "alb1",
                    Some("artist-x"),
                    100,
                    "lib-a",
                    None,
                    None,
                    None,
                ),
                track(
                    "s1",
                    "t-b1",
                    "S2",
                    Some("Shared"),
                    "Al2",
                    "alb2",
                    Some("artist-y"),
                    100,
                    "lib-b",
                    None,
                    None,
                    None,
                ),
            ],
        );
        let req = LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            sort: None,
            limit: Some(10),
            offset: None,
        };
        let artists = list_artists(&store, &req).unwrap();
        assert_eq!(artists.len(), 1);
        assert_eq!(artists[0].name, "Shared");
    }

    /// Manual perf probe:
    /// `cargo test --workspace scope_merge::tests::perf_probe_album_browse -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_probe_album_browse() {
        use std::time::Instant;

        let store = LibraryStore::open_in_memory();
        // User-reported scale: ~4000 albums × 5 tracks = 20000 tracks over 3 libs.
        let albums = 4000usize;
        let tracks_per_album = 5usize;
        let artists = 200usize;
        let mut rows = Vec::with_capacity(albums * tracks_per_album);
        for a in 0..albums {
            let lib = match a % 3 {
                0 => "lib-a",
                1 => "lib-b",
                _ => "lib-c",
            };
            for t in 0..tracks_per_album {
                rows.push(track(
                    "s1",
                    &format!("t-{a}-{t}"),
                    &format!("Song {t}"),
                    Some(&format!("Artist {}", a % artists)),
                    &format!("Album {a:05}"),
                    &format!("alb-{a:05}"),
                    Some(&format!("ar-{}", a % artists)),
                    180 + t as i64,
                    lib,
                    Some(1990 + (a % 30) as i64),
                    Some("Rock"),
                    Some(&format!("cov-{a:05}")),
                ));
            }
        }
        seed_and_rebuild(&store, &rows);
        let scopes = vec![
            scope_pair("s1", "lib-a"),
            scope_pair("s1", "lib-b"),
            scope_pair("s1", "lib-c"),
        ];

        // Exact FE album path: `libraryAdvancedSearch` (empty filter) -> multi-scope
        // -> `list_albums_filtered` with skip_totals = true, PAGE_SIZE ~ 100.
        let time_albums = |offset: u32| {
            let start = Instant::now();
            let (rows, _total) = list_albums_filtered(
                &store,
                &scopes,
                "",
                &[],
                "ORDER BY album COLLATE NOCASE ASC, album_id ASC",
                100,
                offset,
                true,
            )
            .unwrap();
            (start.elapsed(), rows.len())
        };
        let _ = time_albums(0);
        let (t_first, n_first) = time_albums(0);
        let (t_deep, n_deep) = time_albums(2000);
        println!("--- list_albums_filtered (4000 albums, 20000 tracks, 3 libs, skip_totals) ---");
        println!("  offset 0    -> {:?} ({n_first} rows)", t_first);
        println!("  offset 2000 -> {:?} ({n_deep} rows)", t_deep);

        let two = vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")];
        let time_two = || {
            let start = Instant::now();
            let (rows, _t) = list_albums_filtered(
                &store,
                &two,
                "",
                &[],
                "ORDER BY album COLLATE NOCASE ASC, album_id ASC",
                100,
                0,
                true,
            )
            .unwrap();
            (start.elapsed(), rows.len())
        };
        let _ = time_two();
        let (t_two, n_two) = time_two();
        println!("  2-lib subset offset 0 -> {t_two:?} ({n_two} rows)");

        let time_artists = || {
            let req = LibraryScopeListRequest {
                scopes: scopes.clone(),
                sort: None,
                limit: Some(100),
                offset: Some(0),
            };
            let start = Instant::now();
            let n = list_artists(&store, &req).unwrap().len();
            (start.elapsed(), n)
        };
        let _ = time_artists();
        let (a_first, an_first) = time_artists();
        println!("--- list_artists ({artists} artists, 20000 tracks, 3 libs) ---");
        println!("  run -> {:?} ({an_first} rows)", a_first);

        let (cte, _b) = scope_cte_sql(&scopes);
        let plan_sql = format!(
            "EXPLAIN QUERY PLAN {cte}, base AS ( \
               SELECT t.album_id, t.duration_sec, t.id, s.pr, \
                      {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
               {join} AND t.album_id IS NOT NULL AND t.album_id != '' \
             ) SELECT album_dedup FROM base GROUP BY album_dedup LIMIT 100",
            join = scoped_track_join(),
        );
        let plan: Vec<String> = store
            .with_read_conn(|c| {
                let mut stmt = c.prepare(&plan_sql)?;
                let rows = stmt
                    .query_map(["s1", "lib-a", "s1", "lib-b", "s1", "lib-c"], |r| {
                        r.get::<_, String>(3)
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        println!("--- multi-scope album query plan ---");
        for step in plan {
            println!("  {step}");
        }
    }

    /// Local benchmark on a real library DB:
    /// `PSYSONIC_LIBRARY_DB=~/.local/share/.../library.sqlite cargo test --workspace perf_probe_stellmacher_db -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_probe_stellmacher_db() {
        use std::path::PathBuf;
        use std::time::Instant;

        let db = std::env::var("PSYSONIC_LIBRARY_DB").unwrap_or_else(|_| {
            format!(
                "{}/.local/share/dev.psysonic.player/databases/library/library.sqlite",
                std::env::var("HOME").unwrap_or_default()
            )
        });
        let path = PathBuf::from(&db);
        if !path.exists() {
            println!("skip: DB not found at {db}");
            return;
        }
        let store = LibraryStore::open_path_for_test(&path).expect("open db");
        let server_id: String = std::env::var("PSYSONIC_LIBRARY_SERVER").unwrap_or_else(|_| {
            store
                .with_read_conn(|c| {
                    c.query_row(
                        "SELECT server_id FROM track WHERE deleted = 0 \
                         GROUP BY server_id ORDER BY COUNT(*) DESC LIMIT 1",
                        [],
                        |r| r.get(0),
                    )
                })
                .expect("server id")
        });
        let libs: Vec<(String, i64)> = store
            .with_read_conn(|c| {
                let mut stmt = c.prepare(
                    "SELECT library_id, COUNT(*) FROM track \
                     WHERE deleted = 0 AND server_id = ?1 AND COALESCE(library_id, '') != '' \
                     GROUP BY library_id ORDER BY 2 DESC LIMIT 5",
                )?;
                let rows = stmt
                    .query_map([&server_id], |r| Ok((r.get::<_, String>(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("libs");
        println!("server={server_id} libs={libs:?}");
        if libs.len() < 2 {
            println!("need at least 2 tagged libraries");
            return;
        }
        let scopes: Vec<LibraryScopePair> = libs[..2]
            .iter()
            .map(|(lib, _)| scope_pair(&server_id, lib))
            .collect();
        let order = "ORDER BY album COLLATE NOCASE ASC, album_id ASC".to_string();

        let bench = |label: &str, scopes: &[LibraryScopePair]| {
            let _ =
                list_albums_layer1_filtered(&store, scopes, "", &[], &order, &order, 100, 0, true, false);
            let start = Instant::now();
            let (rows, _) = list_albums_layer1_filtered(
                &store, scopes, "", &[], &order, &order, 100, 0, true, false,
            )
            .unwrap();
            println!("  {label}: {:?} ({} albums)", start.elapsed(), rows.len());
        };

        let bench_all_libs = || {
            let sql = "SELECT t.album_id FROM track t \
                WHERE t.deleted = 0 AND t.server_id = ?1 AND t.album_id IS NOT NULL AND t.album_id != '' \
                GROUP BY t.album_id ORDER BY MAX(t.album) COLLATE NOCASE ASC LIMIT 100";
            let _ = store.with_read_conn(|c| {
                let mut s = c.prepare(sql)?;
                let rows = s
                    .query_map([&server_id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.len())
            });
            let start = Instant::now();
            let n = store
                .with_read_conn(|c| {
                    let mut s = c.prepare(sql)?;
                    let rows = s
                        .query_map([&server_id], |r| r.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(rows.len())
                })
                .unwrap();
            println!("  all libs (legacy GROUP BY): {:?} ({n} albums)", start.elapsed());
        };

        println!("--- layer1 album browse (real DB) ---");
        bench_all_libs();
        bench("1 lib", &[scopes[0].clone()]);
        bench("2 libs", &scopes);
    }
}

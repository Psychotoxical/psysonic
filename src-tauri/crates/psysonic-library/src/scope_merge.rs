//! Merged, priority-deduped reads over an ordered `(server_id, library_id)` scope
//! (multi-library filter WO-4). Joins `track` with the attached `cluster.track_cluster_key`
//! table and keeps the lowest `priority_rank` winner per identity key.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};

use crate::album_compilation_filter::{
    album_credits_artist, compilation_predicate_sql, json_guarded, pick_album_group_artist,
    pick_album_group_artist_id, resolve_album_credit, various_artists_label,
    various_artists_like_sql,
};
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::browse_support::{
    overlay_album_artist_links, overlay_album_starred_at_rows, read_album_starred_at,
};
use crate::dto::{
    LibraryAlbumDto, LibraryArtistDto, LibraryScopeAlbumDetailRequest,
    LibraryScopeAlbumDetailResponse, LibraryScopeArtistDetailRequest,
    LibraryScopeArtistDetailResponse, LibraryScopeListRequest, LibraryScopePair,
    LibraryScopeSearchRequest, LibraryTrackDto, LibraryEntitySourceDto,
    LibraryResolveEntitySourcesRequest, LibrarySourceEntityType,
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

/// Track dedup combines `cluster_key`, a fixed 5-second duration bucket
/// (`duration_sec / 5`), and a deterministic per-server occurrence rank. The
/// rank preserves repeated same-server tracks while still pairing corresponding
/// copies across servers.
///
/// This is a bucket, not a symmetric ±5 s window: two rips whose durations straddle
/// a bucket edge (e.g. 314 s → bucket 62, 316 s → bucket 63) stay separate, while
/// two up to ~4 s apart inside a bucket merge. Kept as a single GROUP BY key for
/// speed; a true tolerance window would need a self-join. Encoder-padding drift at
/// boundaries is the known trade-off.
pub(crate) const TRACK_CLUSTER_PARTITION_KEY: &str = "ck.cluster_key || ':' \
    || CAST((ck.duration_sec / 5) AS TEXT) || ':' || CAST(ck.occurrence_rank AS TEXT)";

pub(crate) const TRACK_DEDUP_KEY: &str = "CASE WHEN ck.cluster_key IS NOT NULL \
    THEN ck.cluster_key || ':' || CAST((ck.duration_sec / 5) AS TEXT) \
         || ':' || CAST(ck.occurrence_rank AS TEXT) \
    ELSE ('null:' || t.server_id || ':' || t.id) END";

/// Sortable representative key so a single `MIN()` (SQLite bare-column rule) picks the
/// priority winner per album group without a second window pass: (pr ASC, album_id ASC, id ASC).
/// `pr` is zero-padded so lexical order matches numeric order.
pub(crate) const ALBUM_PICK_KEY: &str = "printf('%08d|%s|%s', pr, album_id, id)";

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
        let whole_server = pair.library_id.is_none();
        if let Some(previous_whole_server) = server_modes.insert(server_id.to_string(), whole_server) {
            if previous_whole_server != whole_server {
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

pub(crate) fn non_empty_scopes(scopes: &[LibraryScopePair]) -> Result<&[LibraryScopePair], String> {
    if scopes.is_empty() {
        return Err("scopes must not be empty".into());
    }
    if normalize_scope_pairs(scopes)?.len() != scopes.len() {
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
/// `scoped_track` carries rowids and priority for track readers; `scope` expands
/// whole-server pairs to concrete library ids for projection-table readers.
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
                .map(|(priority, _)| format!("(?, ?, {priority})"))
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
                .map(|(priority, _)| format!("(?, {priority})"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let sql = format!(
        "WITH exact_scope(server_id, library_id, pr) AS ({exact_values}), \
         whole_scope(server_id, pr) AS ({whole_values}), \
         scope(server_id, library_id, pr) AS ( \
           SELECT server_id, library_id, pr FROM exact_scope \
           UNION ALL \
           SELECT t.server_id, t.library_id, s.pr FROM whole_scope s \
           CROSS JOIN track t ON t.server_id = s.server_id \
           WHERE t.deleted = 0 GROUP BY t.server_id, t.library_id, s.pr \
         ), \
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
    // `scoped_track` already compiled exact-library and whole-server scans into
    // separate indexed branches. Rejoin by rowid so downstream SQL keeps one
    // track shape without broad OR predicates.
    "FROM scoped_track s \
     CROSS JOIN track t ON t.rowid = s.rowid \
     LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
     WHERE t.deleted = 0"
}

fn keyed_detail_track_source(
    scope_cte: String,
    key_column: Option<&'static str>,
    fallback_filter: &'static str,
) -> (String, &'static str, &'static str, &'static str) {
    if let Some(key_column) = key_column {
        let index_suffix = match key_column {
            "cluster_key" => "track",
            "album_key" => "album",
            "artist_key" => "artist",
            _ => key_column,
        };
        let scope_index = format!("idx_ck_scope_{index_suffix}");
        let server_index = format!("idx_ck_server_{index_suffix}");
        let cte = format!(
            "{scope_cte}, \
             detail_key(value) AS (VALUES (?)), \
             detail_tracks AS MATERIALIZED ( \
                SELECT ck.server_id, ck.library_id, ck.track_id, ck.cluster_key, \
                       ck.album_key, ck.artist_key, ck.duration_sec, ck.occurrence_rank, s.pr \
                FROM exact_scope s \
                CROSS JOIN detail_key key \
                CROSS JOIN cluster.track_cluster_key ck INDEXED BY {scope_index} \
                  ON ck.server_id = s.server_id \
                 AND ck.library_id = s.library_id \
                 AND ck.{key_column} = key.value \
                UNION ALL \
                SELECT ck.server_id, ck.library_id, ck.track_id, ck.cluster_key, \
                       ck.album_key, ck.artist_key, ck.duration_sec, ck.occurrence_rank, s.pr \
                FROM whole_scope s \
                CROSS JOIN detail_key key \
                CROSS JOIN cluster.track_cluster_key ck INDEXED BY {server_index} \
                  ON ck.server_id = s.server_id \
                 AND ck.{key_column} = key.value \
              )"
        );
        (
            cte,
            "FROM detail_tracks ck \
             CROSS JOIN track t INDEXED BY sqlite_autoindex_track_1 \
               ON t.server_id = ck.server_id AND t.id = ck.track_id \
             WHERE t.deleted = 0",
            "",
            "ck.pr",
        )
    } else {
        (
            scope_cte,
            scoped_track_join(),
            fallback_filter,
            "s.pr",
        )
    }
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

pub(crate) type AlbumListRow = (
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

pub(crate) fn album_row_to_dto(row: AlbumListRow) -> LibraryAlbumDto {
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
    // Credit name only. Which entity that credit links to is resolved afterwards by
    // `overlay_album_artist_links` from the complete physical album, because no single
    // representative row (and no window over this query's own candidate pool) can be
    // trusted for a server-local id: cross-server dedup merges equivalent albums,
    // track-level filters hide siblings, and compound-select arms do not share windows.
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
/// Aggregated in a single `GROUP BY album_dedup` (no per-track window): `song_count`
/// is exact via `COUNT(DISTINCT track_dedup)`; `duration_total` is `SUM(duration_sec)`,
/// which double-counts a track only when the *same* recording is present in multiple
/// selected libraries. The album-list duration is not surfaced in the grid (detail and
/// now-playing recompute from the real track list), so this trade buys a ~2x browse
/// speedup on large multi-library scopes without a user-visible effect.
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
            overlay_album_artist_links(conn, albums);
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

/// Detail and artist reads use identity keys even for a single library, so they
/// must apply version upgrades without relying on multi-library dedup being enabled.
fn ensure_cluster_keys_for_all_scopes(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
) -> Result<(), String> {
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
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
         FROM ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, \
                  COUNT(DISTINCT track_dedup) AS song_count, SUM(duration_sec) AS duration_total, \
                  MIN({ALBUM_PICK_KEY}) AS _pick \
           FROM base GROUP BY album_dedup \
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
        overlay_album_artist_links(conn, &mut albums);
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
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
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
            "t.library_id = ?".to_string(),
            "t.album_id IS NOT NULL AND t.album_id != ''".to_string(),
        ];
        if !extra_where.trim().is_empty() {
            where_parts.push(extra_where.to_string());
        }
        let where_sql = where_parts.join(" AND ");
        let mut params = vec![
            SqlValue::Text(pair.server_id.clone()),
            SqlValue::Text(pair.library_id.clone().unwrap_or_default()),
        ];
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
                       t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, \
                       t.duration_sec, t.id, s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, \
                       {TRACK_DEDUP_KEY} AS track_dedup \
                {base_where} \
             ), \
             track_winners AS ( \
               SELECT * FROM ( \
                 SELECT base.*, ROW_NUMBER() OVER ( \
                   PARTITION BY album_dedup, track_dedup \
                   ORDER BY pr, server_id, album_id, id \
                 ) AS track_rank \
                 FROM base \
               ) WHERE track_rank = 1 \
             ) \
             SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                    song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
             FROM ( \
                SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                       year, genre, cover_art_id, starred_at, synced_at, \
                       COUNT(*) AS song_count, SUM(duration_sec) AS duration_total, \
                       MIN(_pick) AS _pick \
                FROM ( \
                  SELECT track_winners.*, {ALBUM_PICK_KEY} AS _pick \
                  FROM track_winners \
                ) GROUP BY album_dedup \
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
    ensure_cluster_keys_for_scopes(store, scopes)?;
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
///
/// The `CROSS JOIN` in `scoped_ids` is what makes that description true rather
/// than merely intended. `album_scoped` is a CTE, so SQLite has no row estimate
/// for it, and the only thing tying `artist` to it is a function call
/// (`psysonic_lower_name`) — not a column it can index on. Left as a plain
/// `INNER JOIN` the planner drove from `artist` instead and re-scanned the whole
/// CTE per artist row: on a 172k-track library that is 4.9k × 11.2k rows and the
/// query never returns. `CROSS JOIN` fixes the order; the `INDEXED BY` then
/// guarantees the inner lookup uses `(server_id, name_fold)` and fails loudly if
/// that index is ever dropped.
///
/// The multi-scope sibling does not need this: its join carries
/// `ar.server_id = ac.server_id`, a real column equality the planner can cost.
///
/// Held as a constant so a test can assert the two keywords are still there —
/// dropping either one produces a query that is correct and never returns, which
/// no result-based test can catch.
pub(crate) const LAYER1_ARTIST_CREDIT_JOIN_SQL: &str =
    "CROSS JOIN artist ar INDEXED BY idx_artist_name_fold \
       ON ar.server_id = ? AND ar.album_count IS NOT NULL \
       AND ar.name_fold = psysonic_lower_name(ac.credit_name)";

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
    ensure_cluster_keys_for_scopes(store, scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped_from = "FROM scope s \
         CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id";
    let credited_cte = if album_artists_only {
        // #1209: album credit = one row per album-level credit in scope, not every
        // track performer with a server-wide `album_count` index row.
        format!(
            "{cte}, \
             album_scoped AS ( \
                 SELECT t.album_id, \
                        COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
               {scoped_from} \
               WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
               GROUP BY t.album_id \
             ), \
             scoped_ids AS ( \
               SELECT DISTINCT ar.id \
               FROM album_scoped ac \
                {LAYER1_ARTIST_CREDIT_JOIN_SQL} \
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

/// Multi-server Album artists browse. Album credits can differ from every track
/// performer, so derive them from `album_artist` and resolve the matching indexed
/// artist row by its persisted Unicode fold before priority-deduplicating names.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_index_artists_multi_scope_album_filtered(
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
    let artist_where = if extra_where.trim().is_empty() {
        "ar.album_count IS NOT NULL".to_string()
    } else {
        format!("ar.album_count IS NOT NULL AND {extra_where}")
    };
    let credits_cte = format!(
        "{cte}, \
         album_credits AS ( \
           SELECT t.server_id, t.album_id, s.pr, \
                  COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
           FROM scope s \
           CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
           WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
           GROUP BY t.server_id, t.album_id, s.pr \
         ), \
         matched AS ( \
           SELECT ar.server_id, ar.id AS artist_id, ar.name AS artist, ar.name_fold, \
                  ac.album_id, ac.pr, ar.synced_at \
           FROM album_credits ac \
           INNER JOIN artist ar ON ar.server_id = ac.server_id \
             AND ar.name_fold = psysonic_lower_name(ac.credit_name) \
           WHERE {artist_where} \
         ), \
         deduped AS ( \
           SELECT server_id, artist_id, artist, synced_at, \
                  COUNT(DISTINCT server_id || ':' || album_id) AS album_count, \
                  MIN(printf('%08d|%s|%s', pr, server_id, artist_id)) AS _pick \
           FROM matched GROUP BY name_fold \
         )"
    );
    let count_sql = format!("{credits_cte} SELECT COUNT(*) FROM deduped");
    let select_sql = format!(
        "{credits_cte} SELECT server_id, artist_id, artist, album_count, synced_at \
         FROM deduped {order_sql} LIMIT ? OFFSET ?"
    );
    let mut binds = merge_binds(scope_binds, extra_params);
    let total = if skip_totals {
        0
    } else {
        store.with_read_conn(|conn| {
            let count: i64 = conn.query_row(&count_sql, params_from_iter(binds.iter()), |row| row.get(0))?;
            Ok(count.max(0) as u32)
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
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
         FROM ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, \
                  COUNT(DISTINCT track_dedup) AS song_count, SUM(duration_sec) AS duration_total, \
                  MIN({ALBUM_PICK_KEY}) AS _pick \
           FROM base GROUP BY album_dedup \
         ) \
         {order_sql} \
         LIMIT ? OFFSET ?"
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
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
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
             SELECT 1 FROM track c \
             INNER JOIN scope sc ON c.server_id = sc.server_id AND c.library_id = sc.library_id \
             WHERE c.rowid = f.rowid AND c.deleted = 0 \
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
               SELECT 1 FROM track c \
               INNER JOIN scope sc ON c.server_id = sc.server_id AND c.library_id = sc.library_id \
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
           INNER JOIN scope s ON t.server_id = s.server_id AND t.library_id = s.library_id \
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
         LIMIT ?"
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
        let mut albums = rows;
        overlay_album_artist_links(conn, &mut albums);
        Ok(albums)
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
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         fts_hits AS ( \
           SELECT f.rowid, {TRACK_FTS_BM25_RANK} AS rank \
           FROM track_fts f \
           WHERE track_fts MATCH ? \
             AND EXISTS ( \
               SELECT 1 FROM track c \
               INNER JOIN scope sc ON c.server_id = sc.server_id AND c.library_id = sc.library_id \
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
           INNER JOIN scope s ON t.server_id = s.server_id AND t.library_id = s.library_id \
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
pub(crate) const LOOKUP_ALBUM_KEY_SQL: &str =
    "SELECT CASE WHEN COUNT(*) = COUNT(ck.album_key) \
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

/// Canonical name of an artist entity from the `artist` table (the same source the
/// browse list and header use). Independent of whether any track is tagged with the
/// id — needed to detect the "Various Artists" entity even when its compilations
/// link only through `album_artist` and no track carries the VA performer id. Kept
/// name-only so the common artist-detail load does not parse `raw_json`.
fn lookup_artist_name(
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
fn lookup_artist_row(
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

/// Caller must pre-sort `candidates` by full scope-pair priority (lowest index first).
fn priority_album_candidate(candidates: &[LibraryAlbumDto]) -> LibraryAlbumDto {
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

fn overlay_priority_album_row(
    conn: &rusqlite::Connection,
    album: &mut LibraryAlbumDto,
) -> rusqlite::Result<()> {
    let row = conn
        .query_row(
            "SELECT name, artist, artist_id, song_count, duration_sec, year, genre, cover_art_id, \
                    starred_at, synced_at, raw_json \
             FROM album WHERE server_id = ?1 AND id = ?2",
            rusqlite::params![&album.server_id, &album.id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()?;
    let Some((
        name,
        artist,
        artist_id,
        song_count,
        duration_sec,
        year,
        genre,
        cover_art_id,
        starred_at,
        synced_at,
        raw_json,
    )) = row
    else {
        return Ok(());
    };
    album.name = name;
    // Album-artist identity from the standalone row. `upsert_album_from_get_album`
    // persists getAlbum's album-artist *name* correctly (e.g. "Various Artists") but
    // the sync `Album` type maps only the legacy `artistId`, which on a compilation
    // is a representative performer. So take the name from `albumArtist`/the legacy
    // `artist` column (never the track-derived candidate — that would resurface a
    // "feat." credit), and run the id through the same VA-aware rule used everywhere
    // else: prefer `albumArtistId`, and leave a Various Artists credit unlinked
    // rather than pointing it at a guest performer.
    let parsed_raw: Option<Value> = raw_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    let raw_field = |key: &str| -> Option<String> {
        parsed_raw
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let derived_name = album.artist.take().filter(|s| !s.trim().is_empty());
    let derived_id = album.artist_id.take().filter(|s| !s.trim().is_empty());
    // Name: server `albumArtist`, then the standalone row's clean album-artist column
    // (getAlbum's album artist), then — only if both are empty — the track-derived
    // candidate. The clean column must beat the candidate, or a per-track "feat."
    // credit resurfaces in the header.
    let final_name = raw_field("albumArtist").or(artist).or(derived_name.clone());
    // Id resolution runs `pick_album_group_artist_id` against the FINAL name, so a
    // Various Artists header without a real album-artist id stays unlinked instead of
    // opening a guest. The only value trusted as an album-artist id is one that came
    // from an album-artist source: the server's `albumArtistId`, or the candidate's
    // id *when the candidate itself resolved a VA/album-artist name* — a candidate id
    // paired with a performer name is a performer, not an album artist, and must not
    // survive under a VA header sourced from the album row. `artist_id` (legacy row
    // column) / the candidate id serve only as the non-VA performer fallback.
    let candidate_album_artist_id = derived_id
        .clone()
        .filter(|_| derived_name.as_deref().is_some_and(various_artists_label));
    album.artist_id = pick_album_group_artist_id(
        artist_id.or(derived_id),
        final_name.as_deref(),
        raw_field("albumArtistId").or(candidate_album_artist_id),
    );
    album.artist = final_name;
    album.song_count = song_count;
    album.duration_sec = duration_sec;
    album.year = year;
    album.genre = genre;
    album.cover_art_id = cover_art_id;
    album.starred_at = starred_at;
    album.synced_at = synced_at;
    album.raw_json = parsed_raw.unwrap_or(Value::Null);
    Ok(())
}

fn merge_optional_text(dst: &mut String, src: &str) {
    if dst.trim().is_empty() && !src.trim().is_empty() {
        *dst = src.to_string();
    }
}

fn merge_optional(dst: &mut Option<String>, src: &Option<String>) {
    if dst.as_ref().is_none_or(|s| s.trim().is_empty()) {
        if let Some(s) = src.as_ref().filter(|s| !s.trim().is_empty()) {
            *dst = Some(s.clone());
        }
    }
}

fn merge_optional_i64(dst: &mut Option<i64>, src: Option<i64>) {
    if dst.is_none() {
        *dst = src;
    }
}

/// Caller must pre-sort `candidates` by scope priority (lowest index first).
fn merge_artist_by_priority(candidates: &[LibraryArtistDto]) -> LibraryArtistDto {
    let mut out = candidates.first().cloned().unwrap_or_else(|| LibraryArtistDto {
        server_id: String::new(),
        id: String::new(),
        name: String::new(),
        name_sort: None,
        album_count: None,
        synced_at: 0,
        raw_json: Value::Null,
    });
    for c in candidates.iter().skip(1) {
        merge_optional_text(&mut out.name, &c.name);
        merge_optional(&mut out.name_sort, &c.name_sort);
        merge_optional_i64(&mut out.album_count, c.album_count);
        if out.synced_at < c.synced_at {
            out.synced_at = c.synced_at;
        }
    }
    out
}

fn fetch_album_candidates(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    album_key: Option<&str>,
    anchor_server: &str,
    anchor_album_id: &str,
) -> rusqlite::Result<Vec<(i64, LibraryAlbumDto)>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        album_key.map(|_| "album_key"),
        "AND t.server_id = ? AND t.album_id = ?",
    );
    let sql = format!(
        "{cte}, \
         grouped AS ( \
           SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                   MAX(t.artist_id) AS artist_id, MAX(t.album_artist) AS album_artist, \
                   MAX(t.year) AS year, MAX(t.genre) AS genre, MAX(t.cover_art_id) AS cover_art_id, \
                   MAX(t.starred_at) AS starred_at, MAX(t.synced_at) AS synced_at, \
                   COUNT(*) AS song_count, SUM(t.duration_sec) AS duration_total, MIN({priority}) AS best_pr, \
                   MAX({album_artist_id}) AS album_artist_id \
            {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
           GROUP BY t.server_id, t.album_id \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, song_count, duration_total, \
                year, genre, cover_art_id, starred_at, synced_at, best_pr, album_artist_id \
         FROM grouped ORDER BY best_pr ASC",
        scoped = scoped,
        album_artist_id = album_artist_id_expr("t.raw_json"),
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
            let pr: i64 = r.get(13)?;
            // Same shared VA-aware rule as every other album-DTO mapper: the hero
            // credit prefers the album-artist name and the linked id follows the same
            // choice (`album_artist_id` = the server's `raw_json.albumArtistId`).
            let (artist, artist_id) =
                resolve_album_credit(r.get(3)?, r.get(4)?, r.get(5)?, r.get(14)?);
            Ok((
                pr,
                LibraryAlbumDto {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    name: r.get(2)?,
                    artist,
                    artist_id,
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
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        album_key.map(|_| "album_key"),
        "AND t.server_id = ? AND t.album_id = ?",
    );
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY {priority} ASC, t.id ASC) AS rn \
            {scoped} AND t.album_id IS NOT NULL {key_filter} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 \
         ORDER BY COALESCE(disc_number, 1) ASC, track_number ASC NULLS LAST, id ASC, server_id ASC",
        scoped = scoped,
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
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let server_id = request.server_id.trim();
    let album_id = request.album_id.trim();
    if server_id.is_empty() || album_id.is_empty() {
        return Err("server_id and album_id are required".into());
    }

    store.with_read_conn(|conn| {
        let album_key = lookup_album_key(conn, server_id, album_id)?;
        let candidates = fetch_album_candidates(conn, scopes, album_key.as_deref(), server_id, album_id)?;
        let albums: Vec<LibraryAlbumDto> = candidates
            .into_iter()
            .map(|(_, album)| album)
            .collect();
        let mut album = priority_album_candidate(&albums);
        overlay_priority_album_row(conn, &mut album)?;
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
) -> rusqlite::Result<Vec<LibraryArtistDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    // Display name = the canonical `artist.name` for each (server, artist_id) — the
    // same source the artist browse list uses. Deriving it from the tracks via
    // `MAX(t.artist)` picked up per-track "feat." credits (one guest feature in a
    // discography would rename the whole artist header); `COALESCE` keeps the old
    // track-derived fallback for artist_ids without an indexed artist row.
    let sql = format!(
        "{cte}, \
         grouped AS ( \
           SELECT t.server_id, t.artist_id, \
                  COALESCE( \
                    (SELECT ar.name FROM artist ar \
                      WHERE ar.server_id = t.server_id AND ar.id = t.artist_id), \
                    MAX(t.artist)) AS artist, \
                  COUNT(DISTINCT t.album_id) AS album_count, MAX(t.synced_at) AS synced_at, \
                  MIN({priority}) AS best_pr \
           {scoped} AND t.artist_id IS NOT NULL AND t.artist_id != '' {key_filter} \
           GROUP BY t.server_id, t.artist_id \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at, best_pr \
         FROM grouped ORDER BY best_pr ASC",
        scoped = scoped,
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
            Ok(LibraryArtistDto {
                server_id: r.get(0)?,
                id: r.get(1)?,
                name: name.clone(),
                name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
                album_count: Some(r.get(3)?),
                synced_at: r.get(4)?,
                raw_json: Value::Null,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// SQL expression selecting a track's *usable* release-type array from `raw_json`,
/// or NULL when neither representation is usable. A candidate is usable only when it
/// is a non-empty JSON array whose members are all strings; that check is applied to
/// each representation *before* precedence, so an empty or malformed top-level
/// OpenSubsonic `releaseTypes` (the ingest copies empty album arrays verbatim) cannot
/// suppress a valid Navidrome-native `tags.releasetype`, and a non-string member
/// cannot survive to the frontend, where `ArtistDetail.tsx` lowercases each entry.
/// The top-level API field stays preferred when it is itself usable.
///
/// Wrapped in [`json_guarded`] so a malformed row contributes no release types (and a
/// later valid track still wins) instead of aborting the whole artist-detail query.
fn usable_release_types_expr(json_col: &str) -> String {
    let candidate = |path: &str| {
        format!(
            "CASE WHEN json_type({c}, '{p}') = 'array' \
                   AND json_array_length({c}, '{p}') > 0 \
                   AND NOT EXISTS (SELECT 1 FROM json_each({c}, '{p}') je WHERE je.type <> 'text') \
                  THEN json_extract({c}, '{p}') END",
            c = json_col,
            p = path,
        )
    };
    json_guarded(
        json_col,
        &format!(
            "COALESCE({top}, {nested})",
            top = candidate("$.releaseTypes"),
            nested = candidate("$.tags.releasetype"),
        ),
        "NULL",
    )
}

/// The server's album-artist id from a track's `raw_json.albumArtistId`, guarded the
/// same way as [`usable_release_types_expr`]: JSON1 raises `malformed JSON` on invalid
/// TEXT, and `track.raw_json` is unconstrained, so one bad row would otherwise abort
/// the whole query instead of contributing nothing.
pub(crate) fn album_artist_id_expr(json_col: &str) -> String {
    format!(
        "CASE WHEN json_valid({c}) \
              THEN CASE WHEN json_type({c}, '$.albumArtistId') = 'text' \
                        THEN json_extract({c}, '$.albumArtistId') END \
              END",
        c = json_col,
    )
}

/// Split inputs for one of the artist's track-derived albums: whether any track
/// carries an OpenSubsonic/Navidrome compilation signal, and whether the album has
/// a real album-artist tag (vs. an S2 ingest where the display credit falls back to
/// the track artist). The caller feeds both to [`album_credits_artist`] to route own
/// releases (main discography) from appears-on entries.
pub(crate) struct AlbumSplitMeta {
    pub is_compilation: bool,
    /// The album's own `album_artist` tag, read across **all** of the album's scoped
    /// tracks — not just the ones by the artist being viewed. The artist's single
    /// guest track is often the untagged row, so reading the tag off that row alone
    /// would report "no album artist" for an album that is plainly credited to
    /// somebody else, and file it under this artist's discography.
    pub album_artist: Option<String>,
}

/// Returns each of the artist's track-derived albums paired with its
/// [`AlbumSplitMeta`]. The caller uses that plus [`album_credits_artist`] to split
/// own releases from appears-on entries.
fn fetch_albums_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
    va_mode: bool,
) -> rusqlite::Result<Vec<(LibraryAlbumDto, AlbumSplitMeta)>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let release_types_expr = usable_release_types_expr("tt.raw_json");
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    // "Various Artists" is not a real performer: its compilations are linked to the
    // VA entity only through the `album_artist` string, while each track keeps its
    // own performer `artist_id`. The `artist_key` source therefore finds only the
    // few tracks literally tagged with the VA id, not the hundreds of compilations.
    // When the detail target *is* the VA entity, union a second album source keyed
    // on the VA `album_artist` label so the page shows every compilation. The union
    // feeds the same dedup pipeline, so an album qualifying under both sources is
    // still counted once. `scoped_track` is always defined by `scope_cte_sql`.
    //
    // Track-scoped like the `artist_key` source: a compilation with a few untagged
    // tracks (empty `album_artist`) counts only its VA-tagged tracks in the card's
    // `song_count`, matching how every artist page counts its own tracks. The album
    // still appears, and opening it lists the full track set (album_detail keys on
    // `album_key`), so this stays a card-count nuance rather than a missing album.
    let va_arm = if va_mode {
        format!(
            " UNION ALL \
             SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                    t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                    ck.album_key, s.pr AS pr, {TRACK_DEDUP_KEY} AS track_dedup \
             {va_scoped} AND t.album_id IS NOT NULL AND t.album_id != '' AND {va_pred}",
            va_scoped = scoped_track_join(),
            va_pred = various_artists_like_sql("t.album_artist"),
        )
    } else {
        String::new()
    };
    // Compilation signal (compilation / isCompilation / releaseTypes / a Various
    // Artists credit in the flat columns or raw_json displayArtist). Only used to
    // route to appears-on when the album has *no* album-artist tag — a real
    // album_artist that credits the artist (e.g. their own best-of) keeps the album
    // in the main discography, where the frontend groups it under "Compilation".
    //
    // Scoped like `base` (rejoined through `scoped_track`): an album can exist in a
    // library the user did not select — letting those rows decide the split would
    // move an album out of the discography on evidence from outside the scope.
    //
    // Skipped entirely in `va_mode`: the partition returns every album there, so the
    // per-album EXISTS (up to four JSON probes per track of every compilation in the
    // library) would be parsed and thrown away on the heaviest artist page there is.
    // Every track of the album, whichever physical copy and server it sits on:
    // `physical_albums` (one small row per physical album, already grouped by
    // `album_dedup`) drives, `track` is probed through its `(server_id, album_id)`
    // index. Keyed on `album_dedup` rather than the winning row's `(server_id,
    // album_id)`, so reordering library scopes — which changes which copy wins
    // `rn = 1` but no data — cannot move albums between the two lists.
    //
    // Scope is applied against the two bind-value CTEs directly, NOT by joining
    // `scoped_track` or `scope`. `scoped_track` is a UNION ALL over every track in
    // scope and `CROSS JOIN` pins it as the outer loop, so correlating against it
    // would scan the whole scope once per album instead of one indexed probe; `scope`
    // looks small but derives its whole-server half by aggregating the entire `track`
    // table. `exact_scope`/`whole_scope` are the literal scope rows the caller bound —
    // a handful of values, no table access.
    let album_tracks_from = "FROM physical_albums pa \
           JOIN track ct ON ct.server_id = pa.server_id AND ct.album_id = pa.album_id \
          WHERE ct.deleted = 0 AND pa.album_dedup = p.album_dedup \
            AND (EXISTS (SELECT 1 FROM exact_scope es \
                          WHERE es.server_id = ct.server_id AND es.library_id = ct.library_id) \
              OR EXISTS (SELECT 1 FROM whole_scope ws WHERE ws.server_id = ct.server_id))";
    // `ct`'s scope priority — the best (lowest) rank among the scope rows that admit
    // it. Ordering the whole-album credit by this instead of raw `ct.id` makes the
    // choice agree with the priority winner the album card itself is built from, so a
    // cross-server album whose copies disagree on the album-artist can't be classified
    // by one server's metadata and displayed with another's (finding 5).
    let ct_scope_priority = "(SELECT MIN(pr) FROM ( \
            SELECT es.pr FROM exact_scope es \
              WHERE es.server_id = ct.server_id AND es.library_id = ct.library_id \
            UNION ALL \
            SELECT ws.pr FROM whole_scope ws WHERE ws.server_id = ct.server_id))";
    // The album's own `album_artist` tag — see `AlbumSplitMeta` for why it must come
    // from the whole album rather than the viewed artist's own (often untagged) row.
    // Priority-ordered so it names the same copy the card shows.
    let album_artist_tag = format!(
        "(SELECT TRIM(ct.album_artist) {album_tracks_from} \
            AND TRIM(COALESCE(ct.album_artist, '')) <> '' \
          ORDER BY {ct_scope_priority} ASC, ct.id ASC LIMIT 1)"
    );
    // Compilation signal (compilation / isCompilation / releaseTypes / a Various
    // Artists credit on the track artist or in raw_json displayArtist). Only consulted
    // when the album has *no* album-artist tag — a real album_artist that credits the
    // artist (e.g. their own best-of) keeps the album in the main discography, where
    // the frontend groups it under "Compilation".
    //
    // Computed lazily for exactly that reason: it costs up to four JSON probes per
    // track of the album, and the partition ignores it whenever the tag is present —
    // which is the majority of albums. Skipped entirely in `va_mode`, where the
    // partition keeps every album regardless (the heaviest artist page there is).
    //
    // No album-artist column is passed to the predicate: this branch only runs when
    // no scoped track of the album has a non-empty `album_artist`, so that OR-term
    // could never be true and would cost a `LIKE` per track for nothing.
    // In `va_mode` the partition keeps every album, so neither split input is read —
    // emit constants instead of paying for the per-album probes on the heaviest artist
    // page there is.
    let album_artist_col = if va_mode { "NULL" } else { album_artist_tag.as_str() };
    let comp_col = if va_mode {
        "0".to_string()
    } else {
        format!(
            "CASE WHEN {album_artist_tag} IS NOT NULL THEN 0 ELSE \
               EXISTS (SELECT 1 {album_tracks_from} AND {comp_pred}) END",
            comp_pred = compilation_predicate_sql("ct", Some("ct.artist"), None),
        )
    };
    // Displayed credit name. In `va_mode` the VA union already carries the right
    // album-artist label on its own rows, so keep the representative. Otherwise use
    // the priority-consistent whole-album credit — the same value the split classifies
    // on — so an appears-on card shows the album's headliner, not the viewed artist's
    // guest-track performer (findings 2 & 5). The entity that credit *links* to is not
    // selected here: `overlay_album_artist_links` resolves it per physical album once
    // the rows are known, which stays owner-correct across a cross-server dedup.
    let display_album_artist = if va_mode {
        "p.album_artist".to_string()
    } else {
        album_artist_tag.clone()
    };
    let sql = format!(
        "{cte}, \
         base AS ( \
            SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                   t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                   ck.album_key, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup \
            {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
            {va_arm} \
          ), \
          physical_albums AS ( \
            SELECT server_id, album_id, \
                   CASE WHEN COUNT(*) = COUNT(album_key) AND COUNT(DISTINCT album_key) = 1 \
                        THEN MIN(album_key) \
                        ELSE ('physical:' || LENGTH(server_id) || ':' || server_id || ':' || album_id) END AS album_dedup \
            FROM base GROUP BY server_id, album_id \
          ), \
          physical_tracks AS ( \
            SELECT b.*, physical_albums.album_dedup \
            FROM base b \
            INNER JOIN physical_albums \
              ON physical_albums.server_id = b.server_id AND physical_albums.album_id = b.album_id \
          ), \
          deduped_tracks AS ( \
            SELECT *, ROW_NUMBER() OVER (PARTITION BY album_dedup, track_dedup ORDER BY pr ASC, id ASC) AS trn \
            FROM physical_tracks \
         ), \
         album_stats AS ( \
           SELECT album_dedup, COUNT(*) AS song_count, SUM(duration_sec) AS duration_total \
           FROM deduped_tracks WHERE trn = 1 GROUP BY album_dedup \
         ), \
         album_pick AS ( \
           SELECT b.server_id, b.album_id, b.album, b.artist, b.artist_id, b.album_artist, \
                  b.year, b.genre, b.cover_art_id, b.starred_at, b.synced_at, b.album_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY b.album_dedup ORDER BY b.pr ASC, b.album_id ASC, b.id ASC) AS rn \
            FROM physical_tracks b \
         ) \
         SELECT p.server_id, p.album_id, p.album, p.artist, p.artist_id, \
                {display_album_artist} AS album_artist, \
                st.song_count, st.duration_total, p.year, p.genre, p.cover_art_id, p.starred_at, p.synced_at, \
                (SELECT {release_types_expr} \
                   FROM track tt \
                  WHERE tt.server_id = p.server_id AND tt.album_id = p.album_id AND tt.deleted = 0 \
                    AND {release_types_expr} IS NOT NULL \
                  ORDER BY tt.id ASC \
                  LIMIT 1) AS release_types, \
                {album_artist_col} AS album_album_artist, \
                {comp_col} AS is_compilation \
         FROM album_pick p \
         INNER JOIN album_stats st ON p.album_dedup = st.album_dedup \
         WHERE p.rn = 1 \
         ORDER BY p.album COLLATE NOCASE ASC",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    // The bulk album pipeline keeps album `raw_json` NULL and the standalone album
    // table is unused, so the DTO would otherwise carry no `releaseTypes` and the
    // artist page could no longer group releases (Albums / Singles / EPs / Live /
    // Compilations) — it collapses to one flat list. Two ingest paths store the
    // MusicBrainz RELEASETYPE tag differently: Navidrome-native rows keep it per
    // track under `raw_json.tags.releasetype`, while the OpenSubsonic/S2 crawl copies
    // the album-level array onto each track at top-level `raw_json.releaseTypes`
    // (see `merge_album_open_subsonic_track_raw`). `usable_release_types_expr` picks a
    // validated array (`release_types`, column 13); reuse the shared album mapper and
    // attach it, so there is one album-DTO construction path.
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            // The card's credit name comes from the representative row; which entity
            // that credit links to is resolved from the whole physical album by
            // `overlay_album_artist_links` once the page's rows are known.
            let mut dto = album_row_to_dto(map_album_list_row(r)?);
            // Attach the validated release-types array (column 13). SQL already
            // guarantees a non-empty array of strings, or NULL; the client-side
            // re-check is a cheap invariant guard, not new filtering.
            dto.raw_json = r
                .get::<_, Option<String>>(13)?
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
                .map(|types| {
                    let mut obj = serde_json::Map::new();
                    obj.insert("releaseTypes".to_string(), types);
                    Value::Object(obj)
                })
                .unwrap_or(Value::Null);
            // Split inputs ride along on the same row (columns 14/15) so the caller
            // can route own releases vs. appears-on without a second query.
            Ok((
                dto,
                AlbumSplitMeta {
                    // No second emptiness test here: SQL already decided what counts as
                    // a tag (`TRIM(...) <> ''`), and SQLite's TRIM strips only spaces
                    // while Rust's `str::trim` strips all Unicode whitespace. Re-testing
                    // would let a tab-tagged album be "tagged" for the compilation
                    // short-circuit in SQL and "untagged" for the partition in Rust.
                    album_artist: r.get::<_, Option<String>>(14)?,
                    is_compilation: r.get::<_, bool>(15)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn fetch_scope_deduped_tracks_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
    top_tracks_limit: Option<u32>,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let order_and_limit = if top_tracks_limit.is_some() {
        "ORDER BY play_count DESC NULLS LAST, played_at DESC NULLS LAST, title COLLATE NOCASE ASC LIMIT ?"
    } else {
        "ORDER BY album COLLATE NOCASE ASC, track_number ASC NULLS LAST, title COLLATE NOCASE ASC"
    };
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY {priority} ASC, t.id ASC) AS rn \
           {scoped} AND t.artist_id IS NOT NULL {key_filter} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 {order_and_limit}",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    if let Some(limit) = top_tracks_limit {
        binds.push(SqlValue::Integer(i64::from(limit.clamp(1, 50))));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(LibraryTrackDto::from_row(&row_to_track_row(r)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn fetch_top_tracks_server_id(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Option<String>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let sql = format!(
        "{cte}, \
         server_counts AS ( \
           SELECT t.server_id, COUNT(DISTINCT {TRACK_DEDUP_KEY}) AS track_count, \
                  MIN({priority}) AS best_pr \
           {scoped} AND t.artist_id IS NOT NULL {key_filter} \
           GROUP BY t.server_id \
         ) \
         SELECT server_id FROM server_counts \
         ORDER BY track_count DESC, best_pr ASC, server_id ASC LIMIT 1",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    conn.query_row(&sql, params_from_iter(binds.iter()), |row| row.get(0))
        .optional()
}

fn fetch_top_tracks_fingerprint(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<String> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, _) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let sql = format!(
        "{cte} \
         SELECT t.server_id, t.id, t.library_id, t.title, t.album_id, t.duration_sec \
         {scoped} AND t.artist_id IS NOT NULL {key_filter} \
         ORDER BY t.server_id ASC, t.id ASC, t.library_id ASC",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    let mut hasher = DefaultHasher::new();
    for row in rows {
        row?.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

/// `library_scope_artist_detail` — resolve anchor → `artist_key`, aggregate albums + tracks.
pub fn artist_detail(
    store: &LibraryStore,
    request: &LibraryScopeArtistDetailRequest,
) -> Result<LibraryScopeArtistDetailResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let server_id = request.server_id.trim();
    let artist_id = request.artist_id.trim();
    if server_id.is_empty() || artist_id.is_empty() {
        return Err("server_id and artist_id are required".into());
    }

    store.with_scope_detail_read_conn(|conn| {
        let artist_key = lookup_artist_key(conn, server_id, artist_id)?;
        let mut candidates = fetch_artist_candidates(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
        )?;
        candidates.sort_by_key(|a| {
            scopes
                .iter()
                .position(|p| p.server_id == a.server_id)
                .unwrap_or(usize::MAX) as i64
        });
        // `va_mode` decides from the anchor's canonical name (a name-only query on the
        // hot path — no `raw_json` parse), falling back to the track-derived header.
        let anchor_name = lookup_artist_name(conn, server_id, artist_id)?;
        let mut artist = merge_artist_by_priority(&candidates);
        let va_mode = anchor_name
            .as_deref()
            .map(various_artists_label)
            .unwrap_or_else(|| various_artists_label(&artist.name));
        // Seed the header from the anchor's own `artist` row ONLY on the VA shape:
        // its compilations attach by `album_artist` label, so no track carries the
        // anchor id and the merged header would have an empty id — which the frontend
        // loader treats as "no result" and discards. A non-VA artist with no in-scope
        // tracks must keep that empty header so the loader's network fallback still
        // fires; seeding it would render a populated-but-album-less page instead. The
        // full-row fetch (with `raw_json` parse) is deferred to exactly this branch.
        // Seed the header from the anchor artist row when a VA page has no candidate
        // tracks (side effect: pushes the row and re-merges). The returned flag is no
        // longer read — the album count is recomputed unconditionally below — but the
        // seeding itself must still happen.
        if candidates.is_empty() && va_mode {
            if let Some(row) = lookup_artist_row(conn, server_id, artist_id)? {
                candidates.push(row);
                artist = merge_artist_by_priority(&candidates);
            }
        }
        // The track-derived album set contains both the artist's own releases and
        // every album they only appear on (Various Artists / curated compilations,
        // other artists' albums with a guest track). Split by the canonical album
        // artist so the frontend can render "appears on" separately from the main
        // discography — locally, so it stays correct under multi-server scopes and
        // needs no network search (the old featured-albums path was network-only
        // and disabled for multi-server).
        let all_albums = fetch_albums_for_artist_key(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
            va_mode,
        )?;
        let (own, appears_on): (Vec<_>, Vec<_>) = all_albums.into_iter().partition(|(_, meta)| {
            // The "Various Artists" pseudo-entity has no discography of its own to
            // separate an appears-on set from: every album on that page *is* a
            // compilation it heads. Splitting there would eject exactly the albums
            // the VA union arm gathered — an id-tagged compilation with an empty
            // `album_artist` carries a compilation signal and would be routed away.
            if va_mode {
                return true;
            }
            // Own = the album credits this artist as its album artist. A single-artist
            // compilation the artist owns (their own best-of, tagged album_artist = the
            // artist) therefore stays in the main discography and lands in the
            // frontend's "Compilation" release-type group.
            match meta.album_artist.as_deref() {
                // Tagged album: the tag is authoritative, so compare against it.
                Some(tag) => album_credits_artist(Some(tag), &artist.name),
                // Untagged album (S2 ingest, or simply untagged files): there is no
                // album-artist claim to weigh, and the album is only in this set
                // because the artist's own tracks carry this artist's `artist_id` —
                // the strongest signal available. Do NOT second-guess that with a name
                // comparison: a server's artist row and its track tag routinely differ
                // in spelling ("Die drei ???" vs "Die Drei Fragezeichen"), which would
                // exile an artist's entire catalogue. Only a compilation signal, which
                // is about the album rather than the spelling, routes it to appears-on.
                None => !meta.is_compilation,
            }
        });
        let mut albums: Vec<_> = own.into_iter().map(|(al, _)| al).collect();
        let mut appears_on_albums: Vec<_> = appears_on.into_iter().map(|(al, _)| al).collect();
        // Resolve each card's album-artist link against the whole physical album, for
        // both halves of the split: an appears-on card is exactly the case where the
        // representative row is the viewed artist's guest track, so its credit would
        // otherwise link to that guest instead of the album's headliner.
        overlay_album_artist_links(conn, &mut albums);
        overlay_album_artist_links(conn, &mut appears_on_albums);
        // Keep the header count and the rendered grid in agreement. The hero renders
        // exactly `albums` (the main discography), so the count is `albums.len()` in
        // every case: a single server, a cross-server union of own releases, a
        // label-linked VA page whose stored count is 0, or a split that moved releases
        // into "appears on". The server/merge-reported value describes the unsplit,
        // single-server set and drifts from the rendered grid in every multi-source or
        // split case, so the recompute is unconditional (finding 4).
        artist.album_count = Some(albums.len() as i64);
        let tracks = if request.include_tracks {
            fetch_scope_deduped_tracks_for_artist_key(
                conn,
                scopes,
                artist_key.as_deref(),
                server_id,
                artist_id,
                request.top_tracks_limit,
            )?
        } else {
            Vec::new()
        };
        let (top_tracks_server_id, top_tracks_fingerprint) = if request.top_tracks_limit.is_some() {
            let source_server_id = fetch_top_tracks_server_id(
                conn,
                scopes,
                artist_key.as_deref(),
                server_id,
                artist_id,
            )?;
            let fingerprint = if source_server_id.is_some() {
                Some(fetch_top_tracks_fingerprint(
                    conn,
                    scopes,
                    artist_key.as_deref(),
                    server_id,
                    artist_id,
                )?)
            } else {
                None
            };
            (source_server_id, fingerprint)
        } else {
            (None, None)
        };
        Ok(LibraryScopeArtistDetailResponse {
            artist,
            albums,
            appears_on_albums,
            tracks,
            top_tracks_server_id,
            top_tracks_fingerprint,
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
        store
            .with_conn_mut("test.seed_artists", |conn| {
                for row in rows {
                    let Some(artist_id) = row.artist_id.as_deref() else {
                        continue;
                    };
                    let Some(artist) = row.artist.as_deref() else {
                        continue;
                    };
                    conn.execute(
                        "INSERT INTO artist (server_id, id, name, synced_at) VALUES (?1, ?2, ?3, 1) \
                         ON CONFLICT(server_id, id) DO NOTHING",
                        rusqlite::params![&row.server_id, artist_id, artist],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        rebuild_cluster_keys(store, None).unwrap();
    }

    #[test]
    fn scope_normalization_preserves_empty_library_and_rejects_overlap() {
        let scopes = vec![
            scope_pair("s1", ""),
            scope_pair("s1", ""),
            whole_scope("s2"),
        ];
        assert_eq!(normalize_scope_pairs(&scopes).unwrap(), vec![scope_pair("s1", ""), whole_scope("s2")]);
        assert_eq!(non_empty_scopes(&scopes).unwrap_err(), "duplicate scope pair");

        let overlap = vec![whole_scope("s1"), scope_pair("s1", "lib-a")];
        assert!(non_empty_scopes(&overlap)
            .unwrap_err()
            .contains("cannot mix whole-server and exact-library scopes"));
    }

    #[test]
    fn whole_server_scope_includes_empty_library_rows_without_broad_or_predicate() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "exact", "Exact", Some("Artist"), "Exact Album", "exact-album",
                    Some("artist"), 100, "lib-a", None, None, None,
                ),
                track(
                    "s2", "empty", "Empty", Some("Artist"), "Empty Album", "empty-album",
                    Some("artist"), 101, "", None, None, None,
                ),
                track(
                    "s2", "tagged", "Tagged", Some("Artist"), "Tagged Album", "tagged-album",
                    Some("artist"), 102, "lib-b", None, None, None,
                ),
            ],
        );
        let scopes = vec![scope_pair("s1", "lib-a"), whole_scope("s2")];
        let (cte, binds) = scope_cte_sql(&scopes);
        assert!(cte.contains("exact_scope"));
        assert!(cte.contains("whole_scope"));
        assert!(cte.contains("UNION ALL"));
        assert!(!cte.contains("IS NULL OR"));
        let sql = format!(
            "{cte} SELECT t.id, s.pr FROM scoped_track s \
             INNER JOIN track t ON t.rowid = s.rowid ORDER BY s.pr, t.id"
        );
        let rows = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params_from_iter(binds.iter()), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>();
                rows
            })
            .unwrap();
        assert_eq!(
            rows,
            vec![("exact".into(), 0), ("empty".into(), 1), ("tagged".into(), 1)]
        );

        let exact_empty = list_albums(
            &store,
            &LibraryScopeListRequest {
                scopes: vec![scope_pair("s2", "")],
                sort: None,
                limit: Some(10),
                offset: None,
            },
        )
        .unwrap();
        assert_eq!(exact_empty.len(), 1);
        assert_eq!(exact_empty[0].id, "empty-album");
    }

    #[test]
    fn source_resolver_track_matches_browse_partition_and_pair_priority() {
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
            Some("ar-low"), 104, "", None, None, None,
        );
        low.suffix = Some("mp3".into());
        low.bit_rate = Some(320);
        low.size_bytes = Some(8_000_000);
        let boundary = track(
            "s3", "t-boundary", "Shared", Some("Artist"), "Album", "al-boundary",
            Some("ar-boundary"), 105, "lib-boundary", None, None, None,
        );
        seed_and_rebuild(&store, &[high, low, boundary]);

        let scopes = vec![whole_scope("s2"), scope_pair("s1", "lib-high"), whole_scope("s3")];
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
        assert_eq!(sources[0].library_id, "");
        assert_eq!(sources[0].priority, 0);
        assert_eq!(sources[1].priority, 1);
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
        assert_eq!(browse.len(), 2, "the 105-second boundary is a separate partition");
        assert_eq!(browse[0].id, "t-low");
    }

    #[test]
    fn source_resolver_album_and_artist_use_browse_identity() {
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
        let scopes = vec![whole_scope("s2"), scope_pair("s1", "lib-a")];

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
    }

    #[test]
    fn artist_detail_can_skip_tracks_for_discography_only_callers() {
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
                Some(2024),
                Some("Rock"),
                None,
            )],
        );

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        assert_eq!(response.artist.id, "art1");
        assert_eq!(response.albums.len(), 1);
        assert!(response.tracks.is_empty());

        let with_tracks = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: true,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        assert_eq!(with_tracks.tracks.len(), 1);
        assert_eq!(with_tracks.tracks[0].id, "t1");
    }

    #[test]
    fn artist_detail_albums_carry_release_types_for_grouping() {
        // Regression (#1326): the artist page groups a discography into Albums /
        // Singles / EPs / Live / Compilations from each album's `releaseTypes`. The
        // multi-scope pipeline builds albums from tracks and keeps album `raw_json`
        // NULL, so the release types must come from the tracks' raw JSON (order
        // preserved), or grouping goes flat. Two ingest paths store them differently
        // and both must work: Navidrome-native `raw_json.tags.releasetype` and the
        // OpenSubsonic/S2 top-level `raw_json.releaseTypes`
        // (`merge_album_open_subsonic_track_raw`). Albums with neither stay null.
        let store = LibraryStore::open_in_memory();
        // Native Navidrome shape.
        let mut native = track(
            "s1", "t1", "Song", Some("Artist"), "A Live EP", "alb1",
            Some("art1"), 200, "lib-a", Some(2020), None, None,
        );
        native.raw_json = r#"{"tags":{"releasetype":["Single","Live"]}}"#.into();
        // OpenSubsonic/S2 shape: album-level array copied onto the track top-level.
        let mut s2 = track(
            "s1", "t2", "Song", Some("Artist"), "B Compilation EP", "alb2",
            Some("art1"), 200, "lib-a", Some(2021), None, None,
        );
        s2.raw_json = r#"{"releaseTypes":["EP"]}"#.into();
        // Neither representation → default (null) group.
        let plain = track(
            "s1", "t3", "Song", Some("Artist"), "C Plain Album", "alb3",
            Some("art1"), 200, "lib-a", Some(2022), None, None,
        );
        seed_and_rebuild(&store, &[native, s2, plain]);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        assert_eq!(response.albums.len(), 3);
        let by_id = |id: &str| {
            response
                .albums
                .iter()
                .find(|a| a.id == id)
                .unwrap_or_else(|| panic!("album {id} missing"))
        };
        // Native tag order preserved.
        assert_eq!(by_id("alb1").raw_json["releaseTypes"][0], "Single");
        assert_eq!(by_id("alb1").raw_json["releaseTypes"][1], "Live");
        // S2 top-level array surfaced.
        assert_eq!(by_id("alb2").raw_json["releaseTypes"][0], "EP");
        // No release types anywhere → null raw_json, so grouping falls back cleanly.
        assert!(by_id("alb3").raw_json.is_null());
    }

    #[test]
    fn artist_detail_release_types_reject_unusable_candidates() {
        // Release-type candidates must be validated (non-empty array of strings)
        // before precedence and before the representative-track `LIMIT 1`, or bad
        // server metadata leaves valid albums ungrouped and can crash the artist page.
        let store = LibraryStore::open_in_memory();
        // (1) Empty top-level array must not suppress the valid nested value.
        let mut empty_top = track(
            "s1", "et1", "Song", Some("Artist"), "Empty Top", "alb-empty",
            Some("art1"), 200, "lib-a", Some(2020), None, None,
        );
        empty_top.raw_json = r#"{"releaseTypes":[],"tags":{"releasetype":["EP"]}}"#.into();
        // (2) An unusable earlier track must not hide a valid later track on the same
        // album. `hid1` sorts before `hid2`; only `hid2` carries a usable array.
        let mut hidden_bad = track(
            "s1", "hid1", "First", Some("Artist"), "Hidden", "alb-hidden",
            Some("art1"), 200, "lib-a", Some(2021), None, None,
        );
        hidden_bad.raw_json = r#"{"releaseTypes":[]}"#.into();
        let mut hidden_good = track(
            "s1", "hid2", "Second", Some("Artist"), "Hidden", "alb-hidden",
            Some("art1"), 210, "lib-a", Some(2021), None, None,
        );
        hidden_good.raw_json = r#"{"tags":{"releasetype":["Album","Live"]}}"#.into();
        // (3a) Non-string members with no usable fallback → no release types at all.
        let mut nonstring = track(
            "s1", "ns1", "Song", Some("Artist"), "Non String", "alb-nonstring",
            Some("art1"), 200, "lib-a", Some(2022), None, None,
        );
        nonstring.raw_json = r#"{"releaseTypes":["EP",null]}"#.into();
        // (3b) Non-string top-level → fall back to the valid nested value.
        let mut nonstring_fallback = track(
            "s1", "nsf1", "Song", Some("Artist"), "Non String Fallback", "alb-nsfb",
            Some("art1"), 200, "lib-a", Some(2023), None, None,
        );
        nonstring_fallback.raw_json =
            r#"{"releaseTypes":["Live",1],"tags":{"releasetype":["Album"]}}"#.into();
        seed_and_rebuild(
            &store,
            &[empty_top, hidden_bad, hidden_good, nonstring, nonstring_fallback],
        );

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        let by_id = |id: &str| {
            response
                .albums
                .iter()
                .find(|a| a.id == id)
                .unwrap_or_else(|| panic!("album {id} missing"))
        };
        // Empty top-level did not suppress the nested value.
        assert_eq!(by_id("alb-empty").raw_json["releaseTypes"][0], "EP");
        // The valid later track won over the unusable earlier one, order preserved.
        assert_eq!(by_id("alb-hidden").raw_json["releaseTypes"][0], "Album");
        assert_eq!(by_id("alb-hidden").raw_json["releaseTypes"][1], "Live");
        // Non-string members with no fallback → null (never reaches the frontend).
        assert!(by_id("alb-nonstring").raw_json.is_null());
        // Non-string top-level fell back to the valid nested array.
        assert_eq!(by_id("alb-nsfb").raw_json["releaseTypes"][0], "Album");
    }

    #[test]
    fn artist_detail_release_types_tolerate_malformed_raw_json() {
        // `track.raw_json` is unconstrained text and the library tolerates invalid
        // JSON (from_row → Value::Null). The release-type lookup must not let a
        // malformed row raise `malformed JSON` and abort the whole artist-detail
        // query: the bad row contributes nothing and a later valid track still wins.
        let store = LibraryStore::open_in_memory();
        // Malformed row sorts before the valid one, so an unguarded query would hit
        // it first and error out.
        let mut bad = track(
            "s1", "aa-bad", "Broken", Some("Artist"), "Mixed", "alb-mixed",
            Some("art1"), 200, "lib-a", Some(2020), None, None,
        );
        bad.raw_json = "{not valid json".into();
        let mut good = track(
            "s1", "zz-good", "Fine", Some("Artist"), "Mixed", "alb-mixed",
            Some("art1"), 210, "lib-a", Some(2020), None, None,
        );
        good.raw_json = r#"{"tags":{"releasetype":["EP"]}}"#.into();
        seed_and_rebuild(&store, &[bad, good]);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        let album = response
            .albums
            .iter()
            .find(|a| a.id == "alb-mixed")
            .expect("album missing");
        assert_eq!(album.raw_json["releaseTypes"][0], "EP");
    }

    /// Builds a compilation track: `album_artist` = "Various Artists", the track
    /// credited to a real performer, and `raw_json.albumArtistId` = the VA entity id.
    /// This is the shape that links a compilation to VA only through the label —
    /// every track keeps its own performer `artist_id`.
    #[allow(clippy::too_many_arguments)]
    fn va_comp_track(
        id: &str,
        title: &str,
        performer: &str,
        performer_id: &str,
        album: &str,
        album_id: &str,
        va_id: &str,
    ) -> TrackRow {
        let mut row = track(
            "s1", id, title, Some(performer), album, album_id, Some(performer_id),
            200, "lib-a", Some(2020), None, None,
        );
        row.album_artist = Some("Various Artists".into());
        row.raw_json = format!(r#"{{"albumArtistId":"{va_id}"}}"#);
        row
    }

    #[test]
    fn artist_detail_various_artists_includes_album_artist_compilations() {
        // Bug A: "Various Artists" is not a real performer — its compilations attach
        // through the `album_artist` label while each track keeps its own performer
        // `artist_id`. The `artist_key` source alone finds only tracks literally
        // tagged with the VA id (here one Fat-Wreck-style album), so the page showed
        // "a handful" instead of every compilation. The VA union arm must add the
        // label-linked compilations, and a normal artist must stay unaffected.
        let store = LibraryStore::open_in_memory();
        // Two compilations linked to VA only through `album_artist`.
        let c1a = va_comp_track("c1a", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
        let c1b = va_comp_track("c1b", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
        let c2a = va_comp_track("c2a", "Song C", "Perf Three", "p3", "Comp Two", "comp2", "va");
        // A track literally tagged with the VA performer id but with an *empty*
        // album_artist: creates the "Various Artists" artist row and exercises the
        // `artist_key` arm, which the union must not drop.
        let mut vatag = track(
            "s1", "vatag", "Punk Track", Some("Various Artists"), "Punk Comp", "punk1",
            Some("va"), 200, "lib-a", Some(2019), None, None,
        );
        vatag.album_artist = Some(String::new());
        // A normal solo artist that must NOT absorb the compilations.
        let solo = track(
            "s1", "solo1", "Solo Song", Some("Solo Artist"), "Solo Album", "soloalb",
            Some("solo"), 200, "lib-a", Some(2022), None, None,
        );
        seed_and_rebuild(&store, &[c1a, c1b, c2a, vatag, solo]);

        let va = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "va".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        let mut ids: Vec<&str> = va.albums.iter().map(|a| a.id.as_str()).collect();
        ids.sort_unstable();
        // Label-linked compilations (comp1, comp2) plus the id-tagged album (punk1).
        assert_eq!(ids, vec!["comp1", "comp2", "punk1"]);

        // A normal artist page must not gain compilations from the VA label match.
        let solo_detail = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "solo".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        let solo_ids: Vec<&str> = solo_detail.albums.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(solo_ids, vec!["soloalb"]);
    }

    #[test]
    fn album_detail_various_artists_hero_links_to_album_artist() {
        // Bug B: a compilation's hero shows the album-artist credit ("Various
        // Artists") but linked to a representative track's performer id, because the
        // DTO took `artist_id` from `MAX(t.artist_id)`. The id must follow the same
        // choice as the displayed name — the album-artist entity (`albumArtistId`).
        let store = LibraryStore::open_in_memory();
        let c1a = va_comp_track("c1a", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
        let c1b = va_comp_track("c1b", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
        // Ensure the VA row exists (album-artist entity being linked to).
        let mut vatag = track(
            "s1", "vatag", "Punk Track", Some("Various Artists"), "Punk Comp", "punk1",
            Some("va"), 200, "lib-a", Some(2019), None, None,
        );
        vatag.album_artist = Some(String::new());
        let solo = track(
            "s1", "solo1", "Solo Song", Some("Solo Artist"), "Solo Album", "soloalb",
            Some("solo"), 200, "lib-a", Some(2022), None, None,
        );
        seed_and_rebuild(&store, &[c1a, c1b, vatag, solo]);

        let comp = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "comp1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            comp.album.artist_id.as_deref(),
            Some("va"),
            "compilation hero must link to the VA entity, not a track performer"
        );

        // A solo album (no album-artist id in raw_json) keeps the track artist id.
        let solo_detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "soloalb".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(solo_detail.album.artist_id.as_deref(), Some("solo"));
    }

    #[test]
    fn live_search_albums_links_va_card_to_the_album_artist() {
        // A compilation surfaced in live search must credit "Various Artists" and
        // link `artist_id` to the album-artist entity — recovered from a sibling
        // track even when the best-ranked (representative) track carries no
        // `albumArtistId`. The dedup collapses siblings, so recovery has to run on
        // the per-track scan (window), not after the group.
        let store = LibraryStore::open_in_memory();
        // The best-ranked (representative) track matches the query in *both* title
        // and album, so it deterministically wins the group — yet it lacks the
        // album-artist id. Without cross-sibling recovery the card would render
        // unlinked; the window must lift "va" from the sibling.
        let mut c1 = va_comp_track("c1", "Comp Anthem", "Perf One", "p1", "Comp One", "comp1", "va");
        c1.raw_json = "{}".into();
        // ... its sibling carries the id but matches only via the album title.
        let c2 = va_comp_track("c2", "Bravo", "Perf Two", "p2", "Comp One", "comp1", "va");
        // A solo album keeps its own performer id (no album-artist entity).
        let solo = track(
            "s1", "solo1", "Comp Solo", Some("Solo Artist"), "Solo Album", "soloalb",
            Some("solo"), 200, "lib-a", Some(2022), None, None,
        );
        seed_and_rebuild(&store, &[c1, c2, solo]);

        let albums =
            live_search_albums(&store, &[scope_pair("s1", "lib-a")], "Comp*", 20).unwrap();
        let comp = albums.iter().find(|a| a.id == "comp1").expect("comp missing");
        assert_eq!(comp.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            comp.artist_id.as_deref(),
            Some("va"),
            "VA card must link to the album-artist entity, recovered from a sibling"
        );
        let solo_dto = albums.iter().find(|a| a.id == "soloalb").expect("solo missing");
        assert_eq!(solo_dto.artist_id.as_deref(), Some("solo"));
    }

    /// Inserts the standalone `album` row that a normal S2/`getAlbum` sync writes.
    /// `upsert_album_from_get_album` persists the *legacy* `artistId`, which on a
    /// compilation is a representative performer — the value that must not win over
    /// the resolved album-artist.
    fn seed_album_row(
        store: &LibraryStore,
        server: &str,
        id: &str,
        name: &str,
        artist: &str,
        artist_id: &str,
        raw_json: &str,
    ) {
        store
            .with_conn_mut("test.seed_album_row", |conn| {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, artist, artist_id, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6) \
                     ON CONFLICT(server_id, id) DO UPDATE SET \
                       artist = excluded.artist, artist_id = excluded.artist_id, \
                       raw_json = excluded.raw_json",
                    rusqlite::params![server, id, name, artist, artist_id, raw_json],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn album_detail_album_artist_id_survives_the_album_row_overlay() {
        // Bug B, durable variant: the corrected album-artist id was computed in
        // `fetch_album_candidates` and then overwritten by `overlay_priority_album_row`,
        // which copied `album.artist_id` from the standalone album row. That row holds
        // the legacy performer id (the sync `Album` type maps no `albumArtistId`), so a
        // normally synced compilation relinked its "Various Artists" hero to a guest.
        let store = LibraryStore::open_in_memory();
        let c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
        let c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
        seed_and_rebuild(&store, &[c1, c2]);
        // What a normal getAlbum sync leaves behind: legacy performer credit in the
        // hot columns, the real album-artist only in the raw payload.
        seed_album_row(
            &store, "s1", "comp1", "Comp One", "Perf One", "p1",
            r#"{"artistId":"p1","albumArtist":"Various Artists","albumArtistId":"va"}"#,
        );

        let comp = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "comp1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            comp.album.artist_id.as_deref(),
            Some("va"),
            "the album row's legacy performer id must not overwrite the album-artist"
        );
        assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
    }

    #[test]
    fn album_detail_overlay_unlinks_va_when_the_row_has_no_album_artist_id() {
        // Overlay path, VA-unlink: a compilation with no `albumArtistId` anywhere —
        // not on the tracks, not on the standalone album row — whose row credits
        // "Various Artists" (name) but holds a legacy performer id. The id must
        // resolve to None; pointing the link at the legacy performer under a VA
        // credit is the bug being fixed.
        let store = LibraryStore::open_in_memory();
        let mut c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
        c1.raw_json = String::new();
        let mut c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
        c2.raw_json = String::new();
        seed_and_rebuild(&store, &[c1, c2]);
        seed_album_row(
            &store, "s1", "comp1", "Comp One", "Various Artists", "p1",
            r#"{"artistId":"p1"}"#,
        );

        let comp = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "comp1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            comp.album.artist_id, None,
            "a VA credit with no album-artist id must stay unlinked, not open a guest"
        );
    }

    #[test]
    fn album_detail_overlay_unlinks_va_sourced_only_from_the_album_row() {
        // The VA identity lives *only* on the standalone album row (raw `albumArtist`
        // = "Various Artists", no `albumArtistId`); the tracks carry no album-artist
        // label and their own performer id. The candidate is then a performer, so its
        // id must NOT survive under the album row's VA header — the final id must be
        // re-decided against the resolved name and stay unlinked.
        let store = LibraryStore::open_in_memory();
        let mut t1 = track(
            "s1", "t1", "Song A", Some("Perf One"), "Comp", "comp1",
            Some("p1"), 200, "lib-a", Some(2000), None, None,
        );
        t1.album_artist = None;
        let mut t2 = track(
            "s1", "t2", "Song B", Some("Perf Two"), "Comp", "comp1",
            Some("p2"), 200, "lib-a", Some(2000), None, None,
        );
        t2.album_artist = None;
        seed_and_rebuild(&store, &[t1, t2]);
        seed_album_row(
            &store, "s1", "comp1", "Comp", "Perf One", "p1",
            r#"{"albumArtist":"Various Artists","artistId":"p1"}"#,
        );

        let comp = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "comp1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            comp.album.artist_id, None,
            "a track performer id must not survive under an album-row VA header"
        );
    }

    #[test]
    fn album_detail_overlay_keeps_clean_album_artist_over_feat_tracks() {
        // Overlay path, feat regression guard: the standalone album row holds a clean
        // album-artist name and id, while the tracks carry a "feat." credit. The
        // overlay must keep the clean row name — an earlier precedence let the
        // track-derived candidate win and resurfaced the feat-polluted header.
        let store = LibraryStore::open_in_memory();
        let mut t1 = track(
            "s1", "t1", "Song A", Some("Metallica feat. Guest"), "Album", "alb1",
            Some("m-id"), 200, "lib-a", Some(2000), None, None,
        );
        t1.album_artist = None;
        let mut t2 = track(
            "s1", "t2", "Song B", Some("Metallica"), "Album", "alb1",
            Some("m-id"), 200, "lib-a", Some(2000), None, None,
        );
        t2.album_artist = None;
        seed_and_rebuild(&store, &[t1, t2]);
        seed_album_row(&store, "s1", "alb1", "Album", "Metallica", "m-id", "{}");

        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "alb1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            detail.album.artist.as_deref(),
            Some("Metallica"),
            "the clean album-artist column must not be demoted below a feat. track credit"
        );
        assert_eq!(detail.album.artist_id.as_deref(), Some("m-id"));
    }

    /// Seeds one compilation on two servers with *different* server-local VA ids and
    /// forces them into one cluster, so the dedup has to choose an owner.
    fn seed_cross_server_compilation(store: &LibraryStore) {
        let mut s1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Shared Comp", "comp-a", "va-a");
        s1.library_id = Some("lib-a".into());
        let mut s2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Shared Comp", "comp-b", "va-z");
        s2.server_id = "s2".into();
        s2.library_id = Some("lib-b".into());
        seed_and_rebuild(store, &[s1, s2]);
        store
            .with_conn_mut("test.force_shared_album_key", |conn| {
                conn.execute(
                    "UPDATE cluster.track_cluster_key SET album_key = 'shared-comp' \
                     WHERE track_id IN ('c1', 'c2')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn album_grid_links_the_winning_server_own_va_id_across_servers() {
        // Artist ids are server-local while `album_dedup` merges the same compilation
        // across servers. Recovering the id from the merged group can hand the
        // priority winner (`s1`) the *other* server's lexically larger id (`va-z`),
        // producing a `(server_id, artist_id)` pair no server can resolve.
        let store = LibraryStore::open_in_memory();
        seed_cross_server_compilation(&store);

        let albums = list_albums(
            &store,
            &LibraryScopeListRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
                sort: None,
                limit: Some(50),
                offset: Some(0),
            },
        )
        .unwrap();
        let comp = albums.iter().find(|a| a.name == "Shared Comp").expect("comp missing");
        assert_eq!(comp.server_id, "s1", "the first scope owns the representative");
        assert_eq!(comp.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            comp.artist_id.as_deref(),
            Some("va-a"),
            "the link must be the winning server's own VA id, not the other server's"
        );
    }

    #[test]
    fn artist_detail_va_union_recovers_the_id_from_a_sibling_of_both_arms() {
        // Under `va_mode` a VA-labelled track tagged with the VA id itself qualifies for
        // both the keyed arm and the label arm. Recovery computed per compound-select
        // arm cannot see across them, so a duplicate carrying no `albumArtistId` can win
        // the representative tie and leave the card unlinked.
        let store = LibraryStore::open_in_memory();
        // Lowest track id wins the representative tie: a guest performer's row, carrying
        // no `albumArtistId`. Reached through the label arm only.
        let mut representative =
            va_comp_track("a1", "Song A", "Perf One", "p1", "Comp", "comp1", "va");
        representative.raw_json = "{}".into();
        // Present in *both* arms (tagged with the VA artist id and VA-labelled) and the
        // only row that supplies the album-artist id.
        let mut both_arms = track(
            "s1", "b1", "Song B", Some("Various Artists"), "Comp", "comp1", Some("va"),
            200, "lib-a", Some(2020), None, None,
        );
        both_arms.album_artist = Some("Various Artists".into());
        both_arms.raw_json = r#"{"albumArtistId":"va"}"#.into();
        seed_and_rebuild(&store, &[representative, both_arms]);

        let detail = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "va".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        let comp = detail.albums.iter().find(|a| a.id == "comp1").expect("comp missing");
        assert_eq!(
            comp.artist_id.as_deref(),
            Some("va"),
            "the id must survive the union, whichever duplicate wins the tie"
        );
    }

    #[test]
    fn artist_detail_various_artists_albums_link_to_the_va_entity() {
        // The VA artist page listed album cards whose displayed credit was "Various
        // Artists" while `artist_id` still held a representative track performer, so
        // the card's artist link and the "go to artist" action opened that guest.
        let store = LibraryStore::open_in_memory();
        let c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
        let c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp Two", "comp2", "va");
        // A compilation whose tracks carry no album-artist id at all: linking to the
        // performer under a VA credit would be worse than not linking.
        let mut unlinked = va_comp_track("c3", "Song C", "Perf Three", "p3", "Comp Three", "comp3", "va");
        unlinked.raw_json = String::new();
        seed_and_rebuild(&store, &[c1, c2, unlinked]);
        seed_artist_row(&store, "s1", "va", "Various Artists");

        let va = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "va".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        assert_eq!(va.albums.len(), 3);
        for album in &va.albums {
            assert_eq!(
                album.artist.as_deref(),
                Some("Various Artists"),
                "album {} lost its VA credit",
                album.id
            );
        }
        // Exact per-album expectations: a blanket "va or nothing" assertion would
        // also accept a mapper that returns None for every card.
        let mut linked: Vec<(&str, Option<&str>)> = va
            .albums
            .iter()
            .map(|a| (a.id.as_str(), a.artist_id.as_deref()))
            .collect();
        // The query orders by album *name* ("Comp One", "Comp Three", "Comp Two");
        // sort by id so the expectation reads in album order.
        linked.sort_unstable_by_key(|(id, _)| *id);
        assert_eq!(
            linked,
            vec![
                ("comp1", Some("va")),
                ("comp2", Some("va")),
                // No album-artist id anywhere on this album — stay unlinked rather
                // than opening a guest performer under a Various Artists credit.
                ("comp3", None),
            ],
            "VA cards must open the VA entity, and only the id-less one stays unlinked"
        );
    }

    /// Inserts an artist row directly, for VA entities that have no track tagged
    /// with their id (pure label-linked compilations — the common shape on servers
    /// where every track carries its own performer).
    fn seed_artist_row(store: &LibraryStore, server: &str, id: &str, name: &str) {
        store
            .with_conn_mut("test.seed_artist_row", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES (?1, ?2, ?3, 1) \
                     ON CONFLICT(server_id, id) DO UPDATE SET name = excluded.name",
                    rusqlite::params![server, id, name],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn artist_detail_various_artists_pure_label_compilations() {
        // Bug A, no-id-tagged variant: a VA entity whose compilations link *only*
        // through `album_artist` and no track carries the VA performer id. The
        // `artist_key` source is then empty, so `va_mode` must come from the artist
        // row itself (not the track-derived header) and the label arm alone must
        // surface every compilation via the non-keyed detail path.
        let store = LibraryStore::open_in_memory();
        let c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
        let c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp Two", "comp2", "va");
        seed_and_rebuild(&store, &[c1, c2]);
        // The VA row exists on the server but no track is tagged with its id.
        seed_artist_row(&store, "s1", "va", "Various Artists");

        let va = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "va".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        let mut ids: Vec<&str> = va.albums.iter().map(|a| a.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["comp1", "comp2"]);
        // The albums alone are not enough: the frontend loader discards the whole
        // payload when the artist header has no id (`!response.artist?.id`), and the
        // artist hook does not fall back once the multi-scope branch is taken. So an
        // empty header makes these albums unreachable in the app even though the
        // query found them.
        assert_eq!(
            va.artist.id, "va",
            "header must carry the anchor id, or the frontend drops the response"
        );
        assert_eq!(va.artist.server_id, "s1");
        assert_eq!(va.artist.name, "Various Artists");
        // The seeded header must carry a derived sort key, like every other candidate
        // builder — not None, which would reach the frontend without a `nameSort`.
        assert_eq!(
            va.artist.name_sort.as_deref(),
            Some(sort_key_for_display_name("Various Artists", DEFAULT_IGNORED_ARTICLES).as_str()),
            "seeded VA header must derive its sort key from the name"
        );
        // The stored VA `artist.album_count` is 0 (no track tags its id); the seeded
        // header must report the compilations actually returned, not contradict the grid.
        assert_eq!(
            va.artist.album_count,
            Some(2),
            "seeded VA header count must match the returned album grid"
        );
    }

    #[test]
    fn artist_detail_non_va_track_less_artist_is_not_seeded() {
        // A real (non-VA) artist that has an `artist` row but no track in the current
        // scope must NOT be seeded: the header must stay empty so the frontend loader
        // discards the payload and takes its network fallback. Only the VA label shape
        // is seeded. (Guards against reviving a populated-but-album-less page.)
        let store = LibraryStore::open_in_memory();
        // Some unrelated track so the store isn't empty, but nothing tagged "ra".
        let other = track(
            "s1", "o1", "Song", Some("Other"), "Other Album", "oalb",
            Some("other"), 200, "lib-a", Some(2000), None, None,
        );
        seed_and_rebuild(&store, &[other]);
        seed_artist_row(&store, "s1", "ra", "Real Artist");

        let detail = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "ra".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        assert_eq!(
            detail.artist.id, "",
            "a non-VA track-less artist must keep an empty header for the frontend fallback"
        );
        assert!(detail.albums.is_empty());
    }

    #[test]
    fn artist_detail_various_artists_union_does_not_double_count() {
        // A track that qualifies under *both* arms (tagged with the VA id AND
        // labelled "Various Artists") must be counted once. The union is UNION ALL,
        // so such a track appears twice in `base`; the dedup pipeline
        // (`track_dedup`) must collapse it, or the card `song_count` doubles.
        let store = LibraryStore::open_in_memory();
        let mut both1 = va_comp_track("both1", "Song A", "Various Artists", "va", "Both", "both", "va");
        // Tagged with the VA performer id *and* labelled VA.
        both1.artist = Some("Various Artists".into());
        let mut both2 = va_comp_track("both2", "Song B", "Various Artists", "va", "Both", "both", "va");
        both2.artist = Some("Various Artists".into());
        seed_and_rebuild(&store, &[both1, both2]);

        let va = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "va".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        assert_eq!(va.albums.len(), 1);
        assert_eq!(
            va.albums[0].song_count,
            Some(2),
            "two distinct tracks must not be counted four times by the UNION ALL"
        );
    }

    #[test]
    fn album_detail_album_artist_id_tolerates_malformed_raw_json() {
        // The album-artist id is read with JSON1 (`json_type`/`json_extract`), which
        // raise `malformed JSON` on invalid text. One badly-stored track must not
        // abort the whole album_detail query — the guard makes it contribute no id,
        // and a later valid track still resolves the VA link. (Mirror of the #1329
        // release-types malformed guard for the hero-id path.)
        let store = LibraryStore::open_in_memory();
        let mut bad = va_comp_track("aa-bad", "Broken", "Perf One", "p1", "Comp", "comp1", "va");
        bad.raw_json = "{not valid json".into();
        let good = va_comp_track("zz-good", "Fine", "Perf Two", "p2", "Comp", "comp1", "va");
        seed_and_rebuild(&store, &[bad, good]);

        let comp = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "comp1".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(comp.album.artist_id.as_deref(), Some("va"));
    }

    #[test]
    fn artist_detail_name_uses_canonical_artist_not_feature_track_credit() {
        // Regression: a single guest-feature track in a discography carries a
        // per-track "feat." credit while sharing the artist's `artist_id`. The
        // header name must stay the canonical `artist.name`, not `MAX(t.artist)`
        // which would pick the lexicographically-larger "… feat. …" string and
        // rename the whole artist. Mirrors the browse list (reads `artist.name`).
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                // Plain credit first so the seeded `artist.name` is canonical.
                track(
                    "s1", "t-plain", "A Plain Song", Some("Skyclad"), "Album One",
                    "alb1", Some("skyclad"), 200, "lib-a", None, None, None,
                ),
                track(
                    "s1", "t-feat", "A Guest Song", Some("Skyclad feat. Ten Pole Tudor"),
                    "Album Two", "alb2", Some("skyclad"), 201, "lib-a", None, None, None,
                ),
            ],
        );

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "skyclad".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        assert_eq!(response.artist.name, "Skyclad");
    }

    #[test]
    fn artist_detail_splits_own_releases_from_appears_on() {
        // The track-derived album set mixes the artist's own releases with albums
        // they only appear on. `albums` carries own releases — where the artist is the
        // album artist, *including their own best-of compilations* (which the frontend
        // then groups under "Compilation"); Various Artists / other-artist releases the
        // artist only guests on belong in `appears_on_albums`. The split keys off the
        // album artist, so it is ingest-path agnostic and multi-server aware without
        // any network search.
        let store = LibraryStore::open_in_memory();
        // Own release: the helper defaults `album_artist` to the track artist.
        let own_a = track(
            "s1", "own1", "One", Some("The Band"), "Own Album", "alb-own",
            Some("art1"), 200, "lib-a", Some(2020), None, None,
        );
        let own_b = track(
            "s1", "own2", "Two", Some("The Band"), "Own Album", "alb-own",
            Some("art1"), 210, "lib-a", Some(2020), None, None,
        );
        // The artist's own best-of: a compilation, but album_artist credits the artist,
        // so it stays in the main discography (Option B) rather than appears-on.
        let mut own_comp = track(
            "s1", "ownc1", "Best Cut", Some("The Band"), "Own Best-Of", "alb-owncomp",
            Some("art1"), 205, "lib-a", Some(2022), None, None,
        );
        own_comp.album_artist = Some("The Band".into());
        own_comp.raw_json = r#"{"compilation":true}"#.into();
        // Various Artists compilation with a single track by the artist.
        let mut comp = track(
            "s1", "comp1", "Comp Cut", Some("The Band"), "A Compilation", "alb-comp",
            Some("art1"), 180, "lib-a", Some(2019), None, None,
        );
        comp.album_artist = Some("Various Artists".into());
        // OpenSubsonic/S2 compilation: the flat album_artist is empty and the only
        // compilation signal lives in raw_json — must still count as appears-on.
        let mut s2comp = track(
            "s1", "s2c1", "S2 Comp Cut", Some("The Band"), "An S2 Compilation",
            "alb-s2comp", Some("art1"), 170, "lib-a", Some(2018), None, None,
        );
        s2comp.album_artist = None;
        s2comp.raw_json = r#"{"compilation":true}"#.into();
        // Another artist's album the artist only guests on.
        let mut guest = track(
            "s1", "guest1", "Guest Spot", Some("The Band"), "Someone Else's Album",
            "alb-guest", Some("art1"), 190, "lib-a", Some(2021), None, None,
        );
        guest.album_artist = Some("Another Artist".into());
        seed_and_rebuild(&store, &[own_a, own_b, own_comp, comp, s2comp, guest]);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        let own_ids: Vec<&str> = response.albums.iter().map(|a| a.id.as_str()).collect();
        let appears_ids: Vec<&str> = response
            .appears_on_albums
            .iter()
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(own_ids, ["alb-own", "alb-owncomp"]);
        assert_eq!(appears_ids, ["alb-comp", "alb-s2comp", "alb-guest"]);
    }

    #[test]
    fn artist_detail_appears_on_card_credits_the_headliner_not_the_guest() {
        // The viewed artist guests on an album with an *untagged* row (no
        // `album_artist`); another track on the same album carries the headliner and
        // its `albumArtistId`. The album must land in appears-on, and its card must
        // show and link the headliner — not the viewed artist's guest-track performer,
        // which is the row the album representative is built from (findings 2 & 5).
        let store = LibraryStore::open_in_memory();
        // The viewed artist's guest track: explicitly untagged album-artist.
        let mut guest = track(
            "s1", "g1", "Guest Verse", Some("The Band"), "Someone's Record", "alb-feat",
            Some("art1"), 190, "lib-a", Some(2021), None, None,
        );
        guest.album_artist = None;
        // Another performer's row on the same album carries the album-artist tag and
        // the server's albumArtistId. It is not one of the viewed artist's rows, so it
        // only reaches the query through the whole-album scan.
        let mut head = track(
            "s1", "h1", "Title Track", Some("Headliner"), "Someone's Record", "alb-feat",
            Some("perf2"), 200, "lib-a", Some(2021), None, None,
        );
        head.album_artist = Some("Headliner".into());
        head.raw_json = r#"{"albumArtistId":"head-id"}"#.into();
        // Give the artist one plain own release so the page is not appears-on-only.
        let own = track(
            "s1", "o1", "Own", Some("The Band"), "Own Album", "alb-own",
            Some("art1"), 200, "lib-a", Some(2020), None, None,
        );
        seed_and_rebuild(&store, &[guest, head, own]);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        let feat = response
            .appears_on_albums
            .iter()
            .find(|a| a.id == "alb-feat")
            .expect("guested album is an appears-on entry");
        assert_eq!(feat.artist.as_deref(), Some("Headliner"));
        assert_eq!(feat.artist_id.as_deref(), Some("head-id"));
    }

    #[test]
    fn artist_detail_appears_on_card_recovers_the_id_from_a_sibling_track() {
        // Partial album credit: the representative row *does* carry the album-artist
        // label, but the server only tagged `albumArtistId` on a sibling track. The
        // card must still link to the album-artist entity — the name alone is not a
        // link, and falling back to the guest performer's id would open the wrong
        // artist under a correct-looking credit.
        //
        // Distinct from `..._credits_the_headliner_not_the_guest`, where the
        // representative row is untagged: there the label itself has to be recovered,
        // so a fix that only reads the label would pass it. Here the label is already
        // right and only the id is missing, which is exactly the case a query-local
        // recovery gets wrong and `overlay_album_artist_links` gets right.
        let store = LibraryStore::open_in_memory();
        // The viewed artist's only row on this album: tagged, but no id in raw_json.
        let mut guest = track(
            "s1", "p1", "Guest Spot", Some("The Band"), "Partial Credit", "alb-partial",
            Some("art1"), 190, "lib-a", Some(2022), None, None,
        );
        guest.album_artist = Some("Headliner".into());
        // A sibling the viewed artist has no part in — reachable only through the
        // whole-album read, and the sole carrier of the album-artist id.
        let mut sibling = track(
            "s1", "p2", "Title Track", Some("Headliner"), "Partial Credit", "alb-partial",
            Some("perf2"), 200, "lib-a", Some(2022), None, None,
        );
        sibling.album_artist = Some("Headliner".into());
        sibling.raw_json = r#"{"albumArtistId":"head-id"}"#.into();
        let own = track(
            "s1", "o1", "Own", Some("The Band"), "Own Album", "alb-own",
            Some("art1"), 200, "lib-a", Some(2020), None, None,
        );
        seed_and_rebuild(&store, &[guest, sibling, own]);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                artist_id: "art1".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        let feat = response
            .appears_on_albums
            .iter()
            .find(|a| a.id == "alb-partial")
            .expect("guested album is an appears-on entry");
        assert_eq!(feat.artist.as_deref(), Some("Headliner"));
        assert_eq!(
            feat.artist_id.as_deref(),
            Some("head-id"),
            "the id must come from the sibling row, not the guest performer",
        );
    }

    #[test]
    fn artist_detail_appears_on_credit_follows_scope_priority_across_servers() {
        // The viewed artist guests on the same album on two servers, which disagree on
        // the album-artist. The credit and link must come from the priority winner —
        // the same copy the card representative is built from — not from whichever
        // track happens to have the lowest id (finding 5). Reversing the scope order
        // reverses the winner.
        let seed = || {
            let store = LibraryStore::open_in_memory();
            let mut g1 = track(
                "s1", "g1", "Verse", Some("Guest"), "Split Record", "s1-rec",
                Some("guest-id"), 190, "lib-a", Some(2021), None, None,
            );
            g1.album_artist = None;
            let mut h1 = track(
                "s1", "h1", "Title", Some("Head One"), "Split Record", "s1-rec",
                Some("p1"), 200, "lib-a", Some(2021), None, None,
            );
            h1.album_artist = Some("Head One".into());
            h1.raw_json = r#"{"albumArtistId":"head-1"}"#.into();
            let mut g2 = track(
                "s2", "g2", "Verse", Some("Guest"), "Split Record", "s2-rec",
                Some("guest-id"), 190, "lib-b", Some(2021), None, None,
            );
            g2.album_artist = None;
            let mut h2 = track(
                "s2", "h2", "Title", Some("Head Two"), "Split Record", "s2-rec",
                Some("p2"), 200, "lib-b", Some(2021), None, None,
            );
            h2.album_artist = Some("Head Two".into());
            h2.raw_json = r#"{"albumArtistId":"head-2"}"#.into();
            seed_and_rebuild(&store, &[g1, h1, g2, h2]);
            // Force the two physical copies into one deduped album. Conflicting
            // album-artist tags would otherwise cluster them apart, but the finding is
            // precisely about a *deduped* album whose copies disagree — so pin a shared
            // album key on the viewed artist's rows (the ones that drive `album_dedup`).
            store
                .with_conn_mut("test.force_shared_album_key", |conn| {
                    conn.execute(
                        "UPDATE cluster.track_cluster_key SET album_key = 'shared-rec' \
                         WHERE track_id IN ('g1', 'g2')",
                        [],
                    )?;
                    Ok(())
                })
                .unwrap();
            store
        };

        let appears_credit = |scopes: Vec<LibraryScopePair>, server: &str| {
            let store = seed();
            let response = artist_detail(
                &store,
                &LibraryScopeArtistDetailRequest {
                    scopes,
                    artist_id: "guest-id".into(),
                    server_id: server.into(),
                    include_tracks: false,
                    top_tracks_limit: None,
                },
            )
            .unwrap();
            let a = response
                .appears_on_albums
                .into_iter()
                .find(|a| a.name == "Split Record")
                .expect("guested album present");
            (a.artist, a.artist_id)
        };

        // s1 first → s1's credit wins.
        assert_eq!(
            appears_credit(vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")], "s1"),
            (Some("Head One".to_string()), Some("head-1".to_string())),
        );
        // Reverse the scope order → s2's credit wins.
        assert_eq!(
            appears_credit(vec![scope_pair("s2", "lib-b"), scope_pair("s1", "lib-a")], "s2"),
            (Some("Head Two".to_string()), Some("head-2".to_string())),
        );
    }

    #[test]
    fn artist_detail_album_count_matches_the_rendered_grid() {
        // Own releases on two servers with no appears-on: the header count must be the
        // size of the rendered union, not the priority server's local count (finding 4).
        let store = LibraryStore::open_in_memory();
        let s1 = track(
            "s1", "s1a", "One", Some("Solo"), "Album One", "s1-alb1",
            Some("s1-art"), 200, "lib-a", Some(2020), None, None,
        );
        let s2 = track(
            "s2", "s2a", "Two", Some("Solo"), "Album Two", "s2-alb2",
            Some("s2-art"), 200, "lib-b", Some(2021), None, None,
        );
        seed_and_rebuild(&store, &[s1, s2]);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
                artist_id: "s1-art".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();

        // Two distinct own albums across the two servers, no appears-on.
        assert_eq!(response.albums.len(), 2);
        assert!(response.appears_on_albums.is_empty());
        // The header count reflects the rendered union, not one server's local count.
        assert_eq!(response.artist.album_count, Some(2));
    }

    #[test]
    fn artist_detail_bounds_top_tracks_and_selects_broadest_server() {
        let store = LibraryStore::open_in_memory();
        let mut rows = vec![
            track(
                "s1",
                "s1-low",
                "Local Low",
                Some("Artist"),
                "One",
                "s1-alb",
                Some("s1-art"),
                180,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "s1-mid",
                "Local Mid",
                Some("Artist"),
                "One",
                "s1-alb",
                Some("s1-art"),
                181,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s2",
                "s2-top",
                "Global Top",
                Some("Artist"),
                "Two",
                "s2-alb",
                Some("s2-art"),
                182,
                "lib-b",
                None,
                None,
                None,
            ),
            track(
                "s2",
                "s2-second",
                "Global Second",
                Some("Artist"),
                "Two",
                "s2-alb",
                Some("s2-art"),
                183,
                "lib-b",
                None,
                None,
                None,
            ),
            track(
                "s2",
                "s2-low",
                "Global Low",
                Some("Artist"),
                "Two",
                "s2-alb",
                Some("s2-art"),
                184,
                "lib-b",
                None,
                None,
                None,
            ),
        ];
        for (row, play_count) in rows.iter_mut().zip([5, 10, 100, 50, 1]) {
            row.play_count = Some(play_count);
        }
        seed_and_rebuild(&store, &rows);

        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
                artist_id: "s1-art".into(),
                server_id: "s1".into(),
                include_tracks: true,
                top_tracks_limit: Some(2),
            },
        )
        .unwrap();

        assert_eq!(response.top_tracks_server_id.as_deref(), Some("s2"));
        let fingerprint = response.top_tracks_fingerprint.clone().unwrap();
        assert_eq!(response.tracks.len(), 2);
        assert_eq!(response.tracks[0].id, "s2-top");
        assert_eq!(response.tracks[1].id, "s2-second");

        seed_and_rebuild(
            &store,
            &[track(
                "s2",
                "s2-new",
                "New Track",
                Some("Artist"),
                "Two",
                "s2-alb",
                Some("s2-art"),
                185,
                "lib-b",
                None,
                None,
                None,
            )],
        );
        let updated = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
                artist_id: "s1-art".into(),
                server_id: "s1".into(),
                include_tracks: true,
                top_tracks_limit: Some(2),
            },
        )
        .unwrap();
        assert_ne!(
            updated.top_tracks_fingerprint.as_deref(),
            Some(fingerprint.as_str())
        );
    }

    #[test]
    fn list_artists_collapses_collaboration_track_names_for_one_artist_id() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track(
                    "s1",
                    "t1",
                    "Song 1",
                    Some("Andromida • Daedric"),
                    "Album 1",
                    "album-1",
                    Some("artist-1"),
                    200,
                    "lib-a",
                    None,
                    None,
                    None,
                ),
                track(
                    "s1",
                    "t2",
                    "Song 2",
                    Some("Andromida • Nevertel"),
                    "Album 2",
                    "album-2",
                    Some("artist-1"),
                    220,
                    "lib-a",
                    None,
                    None,
                    None,
                ),
            ])
            .unwrap();
        store
            .with_conn_mut("test.canonical_artist_scope", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES ('s1', 'artist-1', 'Andromida', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        let artists = list_artists(
            &store,
            &LibraryScopeListRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
                sort: Some("name".into()),
                limit: Some(50),
                offset: Some(0),
            },
        )
        .unwrap();

        assert_eq!(artists.iter().filter(|artist| artist.id == "artist-1").count(), 1);
    }

    #[test]
    fn album_merge_preserves_same_server_track_multiplicity_and_priority_winner_flips() {
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
        assert_eq!(albums_a[0].song_count, Some(2));
        assert_eq!(albums_a[0].duration_sec, Some(400));

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
        assert_eq!(albums_b[0].song_count, Some(2));
        assert_eq!(albums_b[0].duration_sec, Some(400));
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
    fn same_server_occurrences_survive_and_cross_server_sources_pair_by_rank() {
        let store = LibraryStore::open_in_memory();
        let mut rows = vec![
            track(
                "s1", "a1", "Tyrion", Some("Narrator"), "Book", "album-a",
                Some("narrator"), 300, "lib-a", None, None, None,
            ),
            track(
                "s1", "a2", "Tyrion", Some("Narrator"), "Book", "album-a",
                Some("narrator"), 300, "lib-a", None, None, None,
            ),
            track(
                "s2", "b1", "Tyrion", Some("Narrator"), "Book", "album-b",
                Some("narrator"), 300, "lib-b", None, None, None,
            ),
            track(
                "s2", "b2", "Tyrion", Some("Narrator"), "Book", "album-b",
                Some("narrator"), 300, "lib-b", None, None, None,
            ),
            track(
                "s3", "c1", "Tyrion", Some("Narrator"), "Book", "album-c",
                Some("narrator"), 300, "lib-c", None, None, None,
            ),
        ];
        for (index, row) in rows.iter_mut().enumerate() {
            row.track_number = Some((index % 2 + 1) as i64);
            row.server_path = Some(format!("chapter-{}.mp3", index % 2 + 1));
        }
        seed_and_rebuild(&store, &rows);
        let scopes = vec![whole_scope("s1"), whole_scope("s2"), whole_scope("s3")];

        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: scopes.clone(),
                album_id: "album-a".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(
            detail.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(),
            vec!["a1", "a2"]
        );

        for (anchor_id, expected_ids) in [
            ("a1", vec!["a1", "b1", "c1"]),
            ("a2", vec!["a2", "b2"]),
        ] {
            let sources = resolve_entity_sources(
                &store,
                &LibraryResolveEntitySourcesRequest {
                    entity_type: LibrarySourceEntityType::Track,
                    anchor_server_id: "s1".into(),
                    anchor_id: anchor_id.into(),
                    scopes: scopes.clone(),
                },
            )
            .unwrap();
            assert_eq!(
                sources.iter().map(|source| source.id.as_str()).collect::<Vec<_>>(),
                expected_ids
            );
        }
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
    fn album_detail_keeps_priority_owner_metadata_coherent() {
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
        assert_eq!(detail.tracks.len(), 2);
    }

    #[test]
    fn album_detail_orders_tracks_disc_then_track() {
        // A multi-disc album must play disc 1 in full before disc 2 — ordered by
        // (disc_number, track_number). Ordering by track_number first interleaves
        // the discs (D1T1, D2T1, D1T2, D2T2), which is what the Play-All queue did.
        // A missing disc number is treated as disc 1 (matching the UI's
        // `discNumber ?? 1`), so an untagged track stays in the disc-1 group and
        // precedes disc 2 rather than sorting after every explicit disc. `id` is the
        // final tie-break, so duplicate disc/track metadata is still deterministic.
        let store = LibraryStore::open_in_memory();
        // Unique title per id, so nothing dedups by title.
        let mk = |id: &str, disc: Option<i64>, trk: i64| {
            let mut t = track(
                "s1", id, id, Some("Artist"), "Double Album", "alb-2disc",
                Some("art1"), 200, "lib-a", Some(2000), None, None,
            );
            t.disc_number = disc;
            t.track_number = Some(trk);
            t
        };
        // Seeded scrambled; ids deliberately don't match the target order.
        // `u-null-t3` has no disc number and must land in the disc-1 group; `b`/`z`
        // share disc 2 / track 2 and must fall back to id order.
        seed_and_rebuild(&store, &[
            mk("z-d2t2", Some(2), 2),
            mk("q-d1t1", Some(1), 1),
            mk("b-d2t2", Some(2), 2),
            mk("u-null-t3", None, 3),
            mk("a-d2t1", Some(2), 1),
            mk("m-d1t2", Some(1), 2),
        ]);

        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a")],
                album_id: "alb-2disc".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();

        let ids: Vec<&str> = detail.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            ["q-d1t1", "m-d1t2", "u-null-t3", "a-d2t1", "b-d2t2", "z-d2t2"]
        );
    }

    #[test]
    fn album_detail_disc_order_tie_break_is_total_across_servers() {
        // The scoped loader merges a cross-server album, so a server-local `id` is
        // not a total tie-break: two surviving tracks from different servers can
        // share disc, track number, and id. `server_id` is the final key, which
        // makes the Play-All order deterministic. The contract is *lexical*
        // `server_id` order, not scope priority — only the dedup inside `ranked`
        // is priority-driven.
        //
        // The fixture deliberately opposes the incidental row order so the
        // assertion cannot pass without that final key: `s2` is seeded first and
        // its tied track sorts before `s1`'s by title/dedup key. Removing
        // `server_id ASC` from the production query must turn this test red.
        let store = LibraryStore::open_in_memory();
        let disc1 = |mut t: TrackRow, trk: i64| {
            t.disc_number = Some(1);
            t.track_number = Some(trk);
            t
        };
        // Matching anchor tracks (same title + duration) de-duplicate and merge the
        // album across the two servers.
        let s1_anchor = disc1(track(
            "s1", "s1-anchor", "Anchor", Some("Band"), "Tie Album", "s1-tie",
            Some("band"), 100, "lib-a", Some(2020), None, None,
        ), 1);
        let s2_anchor = disc1(track(
            "s2", "s2-anchor", "Anchor", Some("Band"), "Tie Album", "s2-tie",
            Some("band"), 100, "lib-b", Some(2020), None, None,
        ), 1);
        // Same id / disc / track on both servers, but distinct title + duration so
        // the two rows do not de-duplicate and both survive the merge — tying on
        // every key except server_id. The titles are chosen so the dedup key of the
        // `s1` row sorts AFTER the `s2` one: any incidental ordering by title or
        // dedup key therefore yields s2 → s1, the reverse of the asserted order.
        let s1_dup = disc1(track(
            "s1", "dup", "Zulu", Some("Band"), "Tie Album", "s1-tie",
            Some("band"), 200, "lib-a", Some(2020), None, None,
        ), 2);
        let s2_dup = disc1(track(
            "s2", "dup", "Alpha", Some("Band"), "Tie Album", "s2-tie",
            Some("band"), 300, "lib-b", Some(2020), None, None,
        ), 2);
        // Seeded s2-first so insertion/rowid order also opposes the assertion.
        seed_and_rebuild(&store, &[s2_anchor, s2_dup, s1_anchor, s1_dup]);

        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
                album_id: "s1-tie".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();

        let seq: Vec<(&str, &str)> = detail
            .tracks
            .iter()
            .map(|t| (t.server_id.as_str(), t.id.as_str()))
            .collect();
        // The anchor merges to the priority server (that part is `pr`-driven inside
        // `ranked`). The tied `dup` rows are then ordered by the final lexical
        // `server_id` key — s1 before s2 — against the fixture's own s2-first bias.
        assert_eq!(seq, [("s1", "s1-anchor"), ("s1", "dup"), ("s2", "dup")]);
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
    fn album_detail_star_reads_priority_owner_album_id() {
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
                album_id: "alb-b".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.album.id, "alb-a");
        assert_eq!(detail.album.starred_at, Some(1111));
    }

    #[test]
    fn album_detail_preserves_priority_owner_raw_json() {
        let store = LibraryStore::open_in_memory();
        seed_and_rebuild(
            &store,
            &[
                track(
                    "s1", "t-a1", "Song", Some("Artist"), "Album", "alb-a",
                    Some("art1"), 200, "lib-a", Some(2001), None, None,
                ),
                track(
                    "s2", "t-b1", "Song", Some("Artist"), "Album", "alb-b",
                    Some("art2"), 200, "lib-b", Some(2002), Some("Jazz"), Some("cov-b"),
                ),
            ],
        );
        store
            .with_conn("test", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, artist, artist_id, year, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'alb-a', 'Album', 'Artist', 'art1', 2001, 1111, 1, \
                             '{\"recordLabel\":\"Primary Records\"}'), \
                            ('s2', 'alb-b', 'Album', 'Artist', 'art2', 2002, 2222, 1, \
                             '{\"recordLabel\":\"Secondary Records\"}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
                album_id: "alb-b".into(),
                server_id: "s2".into(),
            },
        )
        .unwrap();

        assert_eq!(detail.album.server_id, "s1");
        assert_eq!(detail.album.id, "alb-a");
        assert_eq!(detail.album.starred_at, Some(1111));
        assert_eq!(detail.album.raw_json["recordLabel"], "Primary Records");
    }

    #[test]
    fn canonical_artist_album_key_merges_discography_and_preserves_track_owners() {
        let store = LibraryStore::open_in_memory();
        let mut s1_shared = track(
            "s1", "s1-shared", "Shared", Some("Metallica"), "S&M2", "s1-album",
            Some("s1-artist"), 200, "lib-a", Some(2020), None, None,
        );
        s1_shared.album_artist = Some("Metallica & San Francisco Symphony".into());
        let s2_shared = track(
            "s2", "s2-shared", "Shared", Some("Metallica"), "S&M2", "s2-album",
            Some("s2-artist"), 200, "lib-b", Some(2020), None, None,
        );
        let s2_unique = track(
            "s2", "s2-unique", "Unique", Some("Metallica"), "S&M2", "s2-album",
            Some("s2-artist"), 240, "lib-b", Some(2020), None, None,
        );
        seed_and_rebuild(&store, &[s1_shared, s2_shared, s2_unique]);
        store
            .with_conn_mut("test.stale_album_identity", |conn| {
                conn.execute(
                    "UPDATE cluster.track_cluster_key \
                     SET album_key = CASE server_id \
                       WHEN 's1' THEN 'metallicasymphony-old' ELSE 'metallica-old' END",
                    [],
                )?;
                conn.execute(
                    "UPDATE cluster.cluster_meta SET value = 'stale' WHERE key = 'norm_version'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let scopes = vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")];
        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: scopes.clone(),
                album_id: "s1-album".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.album.server_id, "s1");
        assert_eq!(detail.album.id, "s1-album");
        assert_eq!(
            detail
                .tracks
                .iter()
                .map(|track| (track.server_id.as_str(), track.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("s1", "s1-shared"), ("s2", "s2-unique")]
        );

        let artist = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes,
                artist_id: "s1-artist".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        assert_eq!(artist.albums.len(), 1);
        assert_eq!(artist.albums[0].server_id, "s1");
        assert_eq!(artist.albums[0].id, "s1-album");
        assert_eq!(artist.albums[0].song_count, Some(2));

        let reverse = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes: vec![scope_pair("s2", "lib-b"), scope_pair("s1", "lib-a")],
                album_id: "s2-album".into(),
                server_id: "s2".into(),
            },
        )
        .unwrap();
        assert_eq!(reverse.album.server_id, "s2");
        assert_eq!(reverse.album.id, "s2-album");
        assert_eq!(
            reverse
                .tracks
                .iter()
                .map(|track| (track.server_id.as_str(), track.id.as_str()))
                .collect::<Vec<_>>(),
            vec![("s2", "s2-shared"), ("s2", "s2-unique")]
        );
    }

    #[test]
    fn ambiguous_physical_albums_stay_separate_but_open_all_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut rows = vec![
            track(
                "s1", "s1-a", "One", Some("Artist A"), "Split", "s1-album",
                Some("s1-artist-a"), 200, "lib-a", None, None, None,
            ),
            track(
                "s1", "s1-b", "Two", Some("Artist B"), "Split", "s1-album",
                Some("s1-artist-b"), 210, "lib-a", None, None, None,
            ),
            track(
                "s2", "s2-a", "One", Some("Artist A"), "Split", "s2-album",
                Some("s2-artist-a"), 200, "lib-b", None, None, None,
            ),
            track(
                "s2", "s2-c", "Three", Some("Artist C"), "Split", "s2-album",
                Some("s2-artist-c"), 220, "lib-b", None, None, None,
            ),
        ];
        for row in &mut rows {
            row.album_artist = Some("Various Artists".into());
        }
        seed_and_rebuild(&store, &rows);

        let scopes = vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")];
        let artist = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes: scopes.clone(),
                artist_id: "s1-artist-a".into(),
                server_id: "s1".into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        // Both "Split" albums carry a Various Artists credit, so they are albums the
        // artist appears on, not part of the main discography — but they still stay
        // as two separate physical albums (see album_detail below).
        assert!(artist.albums.is_empty());
        assert_eq!(artist.appears_on_albums.len(), 2);

        let detail = album_detail(
            &store,
            &LibraryScopeAlbumDetailRequest {
                scopes,
                album_id: "s1-album".into(),
                server_id: "s1".into(),
            },
        )
        .unwrap();
        assert_eq!(detail.tracks.len(), 2);
        assert!(detail.tracks.iter().all(|track| track.server_id == "s1"));
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

    #[test]
    fn album_credit_lookup_uses_name_fold_index() {
        let store = LibraryStore::open_in_memory();
        let plan: Vec<String> = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    "EXPLAIN QUERY PLAN \
                     SELECT ar.id FROM artist ar \
                     WHERE ar.server_id = 's1' AND ar.name_fold = psysonic_lower_name('Кино')",
                )?;
                let rows = stmt.query_map([], |row| row.get(3))?;
                rows.collect()
            })
            .unwrap();
        assert!(
            plan.iter().any(|detail| detail.contains("idx_artist_name_fold")),
            "expected name-fold index lookup, got: {plan:?}"
        );
    }

    /// #1360: the layer-1 artist browse joins a CTE to `artist` through
    /// `psysonic_lower_name`, which the planner cannot cost. Left to choose, it
    /// drove from `artist` and re-scanned the CTE per row — on a 172k-track
    /// library that query never returned.
    ///
    /// Unlike the index-choice guard in #1359, a plan assertion **does** work
    /// here, and it was checked rather than assumed: with the `CROSS` removed
    /// this same empty database reports `SEARCH ar … / SCAN ac`, the exact bad
    /// order measured on the real library. Nothing about the choice depends on
    /// row counts — a CTE has no statistics, so SQLite applies the same default
    /// estimate whether the table holds three rows or three hundred thousand.
    ///
    /// `EXPLAIN` also prepares the statement, so a dropped or narrowed
    /// `idx_artist_name_fold` fails here too: `INDEXED BY` on an unusable index
    /// is a prepare-time error.
    #[test]
    fn layer1_artist_credit_join_drives_from_the_cte() {
        let store = LibraryStore::open_in_memory();
        let sql = format!(
            "EXPLAIN QUERY PLAN \
             WITH album_scoped(album_id, credit_name) AS (SELECT NULL, NULL) \
             SELECT DISTINCT ar.id FROM album_scoped ac {LAYER1_ARTIST_CREDIT_JOIN_SQL}"
        );
        let plan: Vec<String> = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(rusqlite::params!["s1"], |row| row.get(3))?;
                rows.collect()
            })
            .unwrap();

        let scan_ac = plan.iter().position(|step| step.contains("SCAN ac"));
        let search_ar = plan
            .iter()
            .position(|step| step.contains("SEARCH ar USING INDEX idx_artist_name_fold"));
        assert!(
            scan_ac.is_some() && search_ar.is_some() && scan_ac < search_ar,
            "the CTE must be the outer loop and `artist` the indexed inner lookup, got: {plan:?}"
        );
    }

    fn detail_key_query_plan(key_column: &'static str, key: &str) -> Vec<String> {
        let store = LibraryStore::open_in_memory();
        let scopes = vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")];
        let (scope_cte, mut binds) = scope_cte_sql(&scopes);
        let (cte, scoped, _, _) = keyed_detail_track_source(scope_cte, Some(key_column), "");
        binds.push(SqlValue::Text(key.into()));
        let sql = format!("EXPLAIN QUERY PLAN {cte} SELECT t.id {scoped}");
        store
            .with_scope_detail_read_conn(|conn| {
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params_from_iter(binds.iter()), |row| row.get(3))?;
                rows.collect()
            })
            .unwrap()
    }

    #[test]
    fn album_detail_uses_scope_album_key_index() {
        let plan = detail_key_query_plan("album_key", "album-key");

        assert!(
            plan.iter().any(|detail| detail.contains("idx_ck_scope_album")),
            "expected scope album-key index lookup, got: {plan:?}"
        );
        assert!(
            plan.iter().any(|detail| detail.contains("sqlite_autoindex_track_1")),
            "expected track primary-key lookup, got: {plan:?}"
        );
    }

    #[test]
    fn artist_detail_uses_scope_artist_key_index() {
        let plan = detail_key_query_plan("artist_key", "artist-key");

        assert!(
            plan.iter().any(|detail| detail.contains("idx_ck_scope_artist")),
            "expected scope artist-key index lookup, got: {plan:?}"
        );
        assert!(
            plan.iter().any(|detail| detail.contains("sqlite_autoindex_track_1")),
            "expected track primary-key lookup, got: {plan:?}"
        );
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
    /// `PSYSONIC_LIBRARY_DB=~/.local/share/.../library.sqlite cargo test --workspace perf_probe_real_db -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_probe_real_db() {
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

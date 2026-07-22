//! Merged, priority-deduped reads over an ordered `(server_id, library_id)` scope
//! (multi-library filter WO-4). Joins `track` with the attached `cluster.track_cluster_key`
//! table and keeps the lowest `priority_rank` winner per identity key.

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value;
use std::collections::{hash_map::DefaultHasher, HashMap, HashSet};
use std::hash::{Hash, Hasher};

use crate::album_compilation_filter::pick_album_group_artist;
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::browse_support::{overlay_album_starred_at_rows, read_album_starred_at};
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
                INNER JOIN artist ar ON ar.server_id = ? AND ar.album_count IS NOT NULL \
                  AND ar.name_fold = psysonic_lower_name(ac.credit_name) \
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

pub(crate) fn lookup_album_key(
    conn: &rusqlite::Connection,
    server_id: &str,
    album_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT CASE WHEN COUNT(*) = COUNT(ck.album_key) \
                           AND COUNT(DISTINCT ck.album_key) = 1 \
                     THEN MIN(ck.album_key) END \
         FROM track t \
         INNER JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.server_id = ? AND t.album_id = ? AND t.deleted = 0",
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
    album.artist = artist;
    album.artist_id = artist_id;
    album.song_count = song_count;
    album.duration_sec = duration_sec;
    album.year = year;
    album.genre = genre;
    album.cover_art_id = cover_art_id;
    album.starred_at = starred_at;
    album.synced_at = synced_at;
    album.raw_json = raw_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
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
                   COUNT(*) AS song_count, SUM(t.duration_sec) AS duration_total, MIN({priority}) AS best_pr \
            {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
           GROUP BY t.server_id, t.album_id \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, song_count, duration_total, \
                year, genre, cover_art_id, starred_at, synced_at, best_pr \
         FROM grouped ORDER BY best_pr ASC",
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
         ORDER BY track_number ASC NULLS LAST, disc_number ASC NULLS LAST, title COLLATE NOCASE ASC",
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
/// The whole expression is wrapped in a lazy `CASE WHEN json_valid(...)` guard:
/// `track.raw_json` is unconstrained text and the library tolerates invalid JSON
/// (`LibraryTrackDto::from_row` maps it to `Value::Null`), but the JSON1 functions
/// (`json_type`/`json_array_length`/`json_each`/`json_extract`) raise `malformed JSON`
/// on invalid text — which, inside this per-album correlated lookup, would abort the
/// entire artist-detail query instead of skipping the bad row. The guard makes a
/// malformed row contribute no release types, so a later valid track still wins.
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
    format!(
        "CASE WHEN json_valid({c}) THEN COALESCE({top}, {nested}) END",
        c = json_col,
        top = candidate("$.releaseTypes"),
        nested = candidate("$.tags.releasetype"),
    )
}

fn fetch_albums_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Vec<LibraryAlbumDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let release_types_expr = usable_release_types_expr("tt.raw_json");
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let sql = format!(
        "{cte}, \
         base AS ( \
            SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                   t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                   ck.album_key, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup \
            {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' {key_filter} \
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
         SELECT p.server_id, p.album_id, p.album, p.artist, p.artist_id, p.album_artist, \
                st.song_count, st.duration_total, p.year, p.genre, p.cover_art_id, p.starred_at, p.synced_at, \
                (SELECT {release_types_expr} \
                   FROM track tt \
                  WHERE tt.server_id = p.server_id AND tt.album_id = p.album_id AND tt.deleted = 0 \
                    AND {release_types_expr} IS NOT NULL \
                  ORDER BY tt.id ASC \
                  LIMIT 1) AS release_types \
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
            let mut dto = album_row_to_dto(map_album_list_row(r)?);
            // SQL already guarantees a non-empty array of strings, or NULL; the
            // client-side re-check is a cheap invariant guard, not new filtering.
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
            Ok(dto)
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
        let artist = merge_artist_by_priority(&candidates);
        let albums = fetch_albums_for_artist_key(
            conn,
            scopes,
            artist_key.as_deref(),
            server_id,
            artist_id,
        )?;
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
        assert_eq!(artist.albums.len(), 2);

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

use rusqlite::types::Value as SqlValue;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::album_compilation_filter::pick_album_group_artist;
use crate::browse_support::{overlay_album_artist_links, overlay_album_starred_at_rows};
use crate::dto::{LibraryAlbumDto, LibraryScopePair};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

pub(crate) fn random_window_offset(total: u32, limit: u32) -> u32 {
    let window_count = total.saturating_sub(limit).saturating_add(1);
    if window_count <= 1 {
        return 0;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    (nanos % u128::from(window_count)) as u32
}

/// NULL `album_key` rows never merge — fall back to a per-server album id.
pub(crate) const ALBUM_DEDUP_KEY: &str = "CASE WHEN ck.album_key IS NOT NULL THEN ck.album_key \
    ELSE ('null:' || t.server_id || ':' || COALESCE(NULLIF(t.album_id, ''), t.id)) END";

/// NULL `artist_key` rows never merge.
pub(super) const ARTIST_DEDUP_KEY: &str = "CASE WHEN ck.artist_key IS NOT NULL THEN ck.artist_key \
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
pub(super) const ARTIST_PICK_KEY: &str = "printf('%08d|%s', pr, artist_id)";

pub(super) const TRACK_FTS_BM25_RANK: &str = "bm25(track_fts, 10.0, 3.0, 5.0, 3.0, 0.0)";

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
        if let Some(previous_whole_server) =
            server_modes.insert(server_id.to_string(), whole_server)
        {
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
        if seen.insert((
            normalized_pair.server_id.clone(),
            normalized_pair.library_id.clone(),
        )) {
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

pub(super) fn clamp_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(50).clamp(1, PAGE_LIMIT_MAX)
}

pub(super) fn clamp_offset(offset: Option<u32>) -> u32 {
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

pub(super) fn scoped_track_join_layer1() -> &'static str {
    "FROM scoped_track s \
     CROSS JOIN track t ON t.rowid = s.rowid \
     WHERE t.deleted = 0"
}

pub(super) fn scoped_track_join() -> &'static str {
    // `scoped_track` already compiled exact-library and whole-server scans into
    // separate indexed branches. Rejoin by rowid so downstream SQL keeps one
    // track shape without broad OR predicates.
    "FROM scoped_track s \
     CROSS JOIN track t ON t.rowid = s.rowid \
     LEFT JOIN cluster.track_cluster_key ck ON ck.server_id = t.server_id AND ck.track_id = t.id \
     WHERE t.deleted = 0"
}

pub(super) fn keyed_detail_track_source(
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
        (scope_cte, scoped_track_join(), fallback_filter, "s.pr")
    }
}

pub(super) fn append_extra_where(base: &str, extra: &str) -> String {
    if extra.trim().is_empty() {
        base.to_string()
    } else {
        format!("{base} AND {extra}")
    }
}

pub(super) fn merge_binds(mut scope_binds: Vec<SqlValue>, extra: &[SqlValue]) -> Vec<SqlValue> {
    scope_binds.extend_from_slice(extra);
    scope_binds
}

pub(super) fn plain_track_columns_sql() -> &'static str {
    crate::repos::track_columns()
}

pub(super) fn album_order_sql(sort: Option<&str>) -> String {
    match sort.map(str::trim).filter(|s| !s.is_empty()) {
        Some("year") => {
            "ORDER BY year DESC NULLS LAST, album COLLATE NOCASE ASC, album_id ASC".into()
        }
        Some("artist") => {
            "ORDER BY artist COLLATE NOCASE ASC NULLS LAST, album COLLATE NOCASE ASC, album_id ASC"
                .into()
        }
        _ => "ORDER BY album COLLATE NOCASE ASC, album_id ASC".into(),
    }
}

pub(super) fn artist_order_sql(sort: Option<&str>) -> String {
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

pub(super) fn map_album_list_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumListRow> {
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

pub(crate) fn finish_scope_album_list(
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
pub(super) fn ensure_cluster_keys_for_all_scopes(
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

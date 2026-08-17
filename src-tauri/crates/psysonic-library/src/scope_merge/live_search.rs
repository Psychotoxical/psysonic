use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::common::{
    clamp_limit, ensure_cluster_keys_for_all_scopes, non_empty_scopes, scope_cte_sql,
    ALBUM_DEDUP_KEY, ARTIST_DEDUP_KEY, TRACK_FTS_BM25_RANK,
};
use super::track_browse::{collect_scope_fts_rowids, fetch_deduped_tracks_by_rowids};
use crate::album_compilation_filter::pick_album_group_artist;
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::browse_support::overlay_album_artist_links;
use crate::dto::{
    LibraryAlbumDto, LibraryArtistDto, LibraryScopePair, LibraryScopeSearchRequest, LibraryTrackDto,
};
use crate::search::{fts_query_meets_min_len, fts_track_match_query, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

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
    binds.push(SqlValue::Integer(
        crate::live_search::LIVE_SEARCH_FTS_CANDIDATE_CAP,
    ));
    binds.push(SqlValue::Integer(i64::from(limit)));

    store
        .with_read_conn(|conn| {
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
    binds.push(SqlValue::Integer(
        crate::live_search::LIVE_SEARCH_FTS_CANDIDATE_CAP,
    ));
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

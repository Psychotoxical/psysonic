//! Global chronological album feeds over an ordered multi-server library scope.

use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;

use crate::album_compilation_filter::pick_album_group_artist;
use crate::browse_support::{overlay_album_artist_links, overlay_album_starred_at_rows};
use crate::dto::{
    GenreAlbumCountDto, LibraryAlbumDto, LibraryMainstageAlbumFeed, LibraryMainstageAlbumsRequest,
    LibraryMainstageAlbumsResponse, LibraryScopePair,
};
use crate::scope_merge::{non_empty_scopes, scope_cte_sql, ALBUM_DEDUP_KEY, ALBUM_PICK_KEY};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

const CANDIDATE_MULTIPLIER: u32 = 8;
const CANDIDATE_MARGIN: u32 = 128;
const MAX_CANDIDATE_LIMIT: u32 = 65_536;

fn candidate_limit(offset: u32, fetch_limit: u32) -> u32 {
    offset
        .saturating_add(fetch_limit)
        .saturating_mul(CANDIDATE_MULTIPLIER)
        .saturating_add(CANDIDATE_MARGIN)
}

fn candidate_columns(feed_at: &str, priority: usize) -> String {
    format!(
        "t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
         t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.id, \
         {priority} AS pr, ck.album_key, {ALBUM_DEDUP_KEY} AS album_dedup, \
         {feed_at} AS feed_at"
    )
}

fn new_release_candidates_sql(scopes: &[LibraryScopePair], genre_count: usize) -> String {
    scopes
        .iter()
        .enumerate()
        .map(|(priority, pair)| {
            let columns = candidate_columns("t.server_created_at", priority);
            let library_predicate = if pair.library_id.is_some() {
                " AND t.library_id = ?"
            } else {
                ""
            };
            let genre_predicate = if genre_count == 0 {
                String::new()
            } else {
                let placeholders = (0..genre_count).map(|_| "?").collect::<Vec<_>>().join(", ");
                format!(
                    " AND EXISTS (SELECT 1 FROM track_genre tg \
                     WHERE tg.server_id = t.server_id AND tg.track_id = t.id \
                       AND tg.genre COLLATE NOCASE IN ({placeholders}))"
                )
            };
            format!(
                "SELECT * FROM ( \
                   SELECT {columns} \
                   FROM track t INDEXED BY idx_track_library_created_album \
                   LEFT JOIN cluster.track_cluster_key ck \
                     ON ck.server_id = t.server_id AND ck.track_id = t.id \
                    WHERE t.server_id = ? {library_predicate} \
                     AND t.deleted = 0 AND t.server_created_at IS NOT NULL \
                      AND t.album_id IS NOT NULL AND t.album_id != '' {genre_predicate} \
                   ORDER BY t.server_created_at DESC, t.album_id ASC, t.id ASC \
                   LIMIT ? \
                 )"
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ")
}

fn recently_played_candidates_sql() -> String {
    let columns = candidate_columns("ps.started_at_ms", 0);
    format!(
        "SELECT {columns} \
         FROM play_session ps INDEXED BY idx_play_session_started \
         INNER JOIN track t INDEXED BY sqlite_autoindex_track_1 \
           ON t.server_id = ps.server_id AND t.id = ps.track_id \
         INNER JOIN scope matched_scope \
           ON matched_scope.server_id = t.server_id \
          AND matched_scope.library_id = t.library_id \
         LEFT JOIN cluster.track_cluster_key ck \
           ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
         ORDER BY ps.started_at_ms DESC \
         LIMIT ?"
    )
    .replace("0 AS pr", "matched_scope.pr AS pr")
}

fn build_mainstage_query(
    scopes: &[LibraryScopePair],
    feed: LibraryMainstageAlbumFeed,
    genres: &[String],
    bounded_candidates: u32,
    result_offset: u32,
    result_limit: u32,
) -> (String, Vec<SqlValue>) {
    let (cte, mut binds) = scope_cte_sql(scopes);
    let candidates_sql = match feed {
        LibraryMainstageAlbumFeed::NewReleases => {
            for pair in scopes {
                binds.push(SqlValue::Text(pair.server_id.clone()));
                if let Some(library_id) = &pair.library_id {
                    binds.push(SqlValue::Text(library_id.clone()));
                }
                for genre in genres {
                    binds.push(SqlValue::Text(genre.clone()));
                }
                binds.push(SqlValue::Integer(i64::from(bounded_candidates)));
            }
            new_release_candidates_sql(scopes, genres.len())
        }
        LibraryMainstageAlbumFeed::RecentlyPlayed => {
            binds.push(SqlValue::Integer(i64::from(bounded_candidates)));
            recently_played_candidates_sql()
        }
    };

    let sql = format!(
        "{cte}, \
         candidates AS MATERIALIZED ({candidates_sql}), \
         candidate_groups AS ( \
           SELECT album_dedup, MAX(feed_at) AS feed_at, MAX(album_key) AS album_key \
           FROM candidates GROUP BY album_dedup \
         ), \
         representative_pool AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.id, \
                  s.pr, grouped.album_dedup \
           FROM candidate_groups grouped \
           CROSS JOIN scope s \
           CROSS JOIN cluster.track_cluster_key ck INDEXED BY idx_ck_scope_album \
             ON ck.server_id = s.server_id AND ck.library_id = s.library_id \
            AND ck.album_key = grouped.album_key \
           INNER JOIN track t INDEXED BY sqlite_autoindex_track_1 \
             ON t.server_id = ck.server_id AND t.id = ck.track_id \
           WHERE grouped.album_key IS NOT NULL AND t.deleted = 0 \
             AND t.library_id = s.library_id \
             AND t.album_id IS NOT NULL AND t.album_id != '' \
           UNION ALL \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, id, pr, album_dedup \
           FROM candidates WHERE album_key IS NULL \
         ), \
         representatives AS ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, album_dedup, \
                  MIN({ALBUM_PICK_KEY}) AS _pick \
           FROM representative_pool GROUP BY album_dedup \
         ) \
          SELECT representative.server_id, representative.album_id, representative.album, \
                 representative.artist, representative.artist_id, representative.album_artist, \
                  representative.year, representative.genre, representative.cover_art_id, \
                  representative.starred_at, representative.synced_at, \
                  grouped.feed_at, \
                  (SELECT COUNT(*) FROM candidates) AS candidate_count \
         FROM representatives representative \
         INNER JOIN candidate_groups grouped \
           ON grouped.album_dedup = representative.album_dedup \
         ORDER BY grouped.feed_at DESC, representative.album COLLATE NOCASE ASC, \
                  representative.server_id ASC, representative.album_id ASC \
         LIMIT ? OFFSET ?"
    );
    binds.push(SqlValue::Integer(i64::from(result_limit)));
    binds.push(SqlValue::Integer(i64::from(result_offset)));
    (sql, binds)
}

fn new_release_genre_counts(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
) -> rusqlite::Result<Vec<GenreAlbumCountDto>> {
    let (cte, binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte} \
         SELECT tg.genre, COUNT(DISTINCT t.album_id), COUNT(DISTINCT t.id) \
         FROM scope s CROSS JOIN track t \
           ON t.server_id = s.server_id AND t.library_id = s.library_id \
         INNER JOIN track_genre tg ON tg.server_id = t.server_id AND tg.track_id = t.id \
         WHERE t.deleted = 0 AND t.server_created_at IS NOT NULL \
           AND t.album_id IS NOT NULL AND t.album_id != '' \
         GROUP BY tg.genre COLLATE NOCASE \
         ORDER BY COUNT(DISTINCT t.album_id) DESC, tg.genre COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |row| {
            Ok(GenreAlbumCountDto {
                value: row.get(0)?,
                album_count: row.get::<_, i64>(1)?.max(0) as u32,
                song_count: row.get::<_, i64>(2)?.max(0) as u32,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>();
    rows
}

fn map_mainstage_album(
    r: &rusqlite::Row<'_>,
    include_catalog_created_at: bool,
) -> rusqlite::Result<(LibraryAlbumDto, u32)> {
    // Credit name only — `overlay_album_artist_links` resolves which entity that credit
    // links to once the feed's rows are known, from the whole physical album.
    let track_artist: Option<String> = r.get(3)?;
    let album_artist: Option<String> = r.get(5)?;
    Ok((
        LibraryAlbumDto {
            server_id: r.get(0)?,
            id: r.get(1)?,
            name: r.get(2)?,
            artist: pick_album_group_artist(track_artist, album_artist),
            artist_id: r.get(4)?,
            song_count: None,
            duration_sec: None,
            year: r.get(6)?,
            genre: r.get(7)?,
            cover_art_id: r.get(8)?,
            starred_at: r.get(9)?,
            synced_at: r.get(10)?,
            raw_json: if include_catalog_created_at {
                serde_json::json!({ "createdMs": r.get::<_, i64>(11)? })
            } else {
                serde_json::Value::Null
            },
        },
        r.get(12)?,
    ))
}

pub fn list_mainstage_albums(
    store: &LibraryStore,
    request: &LibraryMainstageAlbumsRequest,
) -> Result<LibraryMainstageAlbumsResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;

    let limit = request.limit.unwrap_or(30).clamp(1, PAGE_LIMIT_MAX);
    let offset = request.offset.unwrap_or(0);
    let fetch_limit = limit.saturating_add(1);
    let requested_results = offset.saturating_add(fetch_limit);
    let initial_candidates = candidate_limit(offset, fetch_limit);

    let (result, timing) = store.with_mainstage_read_conn_timed(|conn| {
        let genre_counts_start = std::time::Instant::now();
        let genre_counts = if request.include_genre_counts
            && request.feed == LibraryMainstageAlbumFeed::NewReleases
        {
            new_release_genre_counts(conn, scopes)?
        } else {
            Vec::new()
        };
        let genre_counts_ms = genre_counts_start.elapsed().as_millis();
        let feed_start = std::time::Instant::now();
        let mut bounded_candidates = initial_candidates;
        loop {
            let (sql, binds) = build_mainstage_query(
                scopes,
                request.feed,
                &request.genres,
                bounded_candidates,
                0,
                requested_results,
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(binds.iter()), |row| {
                    map_mainstage_album(row, request.feed == LibraryMainstageAlbumFeed::NewReleases)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let candidate_count = rows.first().map(|(_, count)| *count).unwrap_or(0);
            let candidate_capacity = match request.feed {
                LibraryMainstageAlbumFeed::NewReleases => {
                    bounded_candidates.saturating_mul(scopes.len() as u32)
                }
                LibraryMainstageAlbumFeed::RecentlyPlayed => bounded_candidates,
            };
            if rows.len() < requested_results as usize
                && candidate_count >= candidate_capacity
                && bounded_candidates < MAX_CANDIDATE_LIMIT
            {
                bounded_candidates = bounded_candidates
                    .saturating_mul(2)
                    .min(MAX_CANDIDATE_LIMIT);
                continue;
            }
            let mut albums = rows
                .into_iter()
                .skip(offset as usize)
                .map(|(album, _)| album)
                .collect::<Vec<_>>();
            let has_more = albums.len() > limit as usize;
            albums.truncate(limit as usize);
            overlay_album_starred_at_rows(conn, &mut albums);
            overlay_album_artist_links(conn, &mut albums);
            let result_count = albums.len();
            return Ok((
                LibraryMainstageAlbumsResponse {
                    albums,
                    has_more,
                    genre_counts,
                },
                genre_counts_ms,
                feed_start.elapsed().as_millis(),
                bounded_candidates,
                result_count,
            ));
        }
    })?;
    let (response, genre_counts_ms, feed_ms, bounded_candidates, result_count) = result;
    if psysonic_core::logging::should_log_debug() {
        // `lockWaitMs` separates "this query is slow" from "this query waited
        // for someone else's". The feeds, their genre counts, the hot-release
        // overlay and the sidebar badge all share this connection, so the two
        // look identical from the frontend — it only ever sees total duration.
        crate::app_deprintln!(
            "[frontend][mainstage-browse] {}",
            serde_json::json!({
                "feed": request.feed,
                "scopeCount": scopes.len(),
                "includeGenreCounts": request.include_genre_counts,
                "genreCountMs": genre_counts_ms,
                "feedMs": feed_ms,
                "lockWaitMs": timing.lock_wait_ms,
                "blockedBy": timing
                    .blocked_by
                    .map(|owner| format!("{}:{}", owner.file, owner.line))
                    .unwrap_or_else(|| "none".to_string()),
                "candidateLimit": bounded_candidates,
                "resultCount": result_count,
            })
        );
    }
    Ok(response)
}

#[cfg(test)]
#[path = "mainstage_browse/tests.rs"]
mod tests;

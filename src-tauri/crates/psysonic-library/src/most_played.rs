//! Local-index ranked albums over the selected server/library scope.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params_from_iter, types::Value as SqlValue};

use crate::dto::{
    LibraryMostPlayedAlbumDto, LibraryMostPlayedArtistDto, LibraryMostPlayedRequest,
    LibraryMostPlayedResponse, LibraryStatisticsScope,
};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

type NormalizedScopes = BTreeMap<String, Option<BTreeSet<String>>>;

fn normalize_scopes(scopes: &[LibraryStatisticsScope]) -> NormalizedScopes {
    let mut normalized = BTreeMap::new();

    for scope in scopes
        .iter()
        .filter(|scope| !scope.server_id.trim().is_empty())
    {
        let library_ids: BTreeSet<String> = scope
            .library_ids
            .iter()
            .filter(|id| !id.is_empty())
            .cloned()
            .collect();
        let selected = normalized
            .entry(scope.server_id.clone())
            .or_insert_with(|| Some(BTreeSet::new()));

        if library_ids.is_empty() {
            *selected = None;
        } else if let Some(selected) = selected {
            selected.extend(library_ids);
        }
    }

    normalized
}

fn scopes_where(scopes: &NormalizedScopes) -> (String, Vec<SqlValue>) {
    let mut clauses = Vec::new();
    let mut params = Vec::new();

    for (server_id, library_ids) in scopes {
        let Some(library_ids) = library_ids else {
            clauses.push("t.server_id = ?".to_string());
            params.push(SqlValue::Text(server_id.clone()));
            continue;
        };

        let placeholders = std::iter::repeat_n("?", library_ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        clauses.push(format!(
            "(t.server_id = ? AND t.library_id IN ({placeholders}))"
        ));
        params.push(SqlValue::Text(server_id.clone()));
        params.extend(library_ids.iter().cloned().map(SqlValue::Text));
    }

    (format!("({})", clauses.join(" OR ")), params)
}

fn album_plays_cte(scope_where: &str) -> String {
    format!(
        "album_plays AS (\
             SELECT t.server_id, COALESCE(t.library_id, '') AS library_id, t.album_id, \
                    NULLIF(MAX(t.album), '') AS track_name, \
                    NULLIF(MAX(t.album_artist), '') AS track_album_artist, \
                    NULLIF(MAX(t.artist), '') AS track_artist, \
                    NULLIF(MAX(t.artist_id), '') AS track_artist_id, \
                    MAX(t.year) AS track_year, \
                    NULLIF(MAX(t.cover_art_id), '') AS track_cover_art_id, \
                    SUM(COALESCE(t.play_count, 0)) AS play_count \
             FROM track t \
             WHERE {scope_where} AND t.deleted = 0 \
               AND t.album_id IS NOT NULL AND t.album_id != '' \
             GROUP BY t.server_id, COALESCE(t.library_id, ''), t.album_id \
             HAVING SUM(COALESCE(t.play_count, 0)) > 0\
         )"
    )
}

fn album_sql(scope_where: &str) -> String {
    format!(
        "WITH {} \
         SELECT ap.server_id, ap.library_id, ap.album_id, \
                COALESCE(NULLIF(p.name, ''), ap.track_name, '') AS name, \
                COALESCE(NULLIF(p.artist, ''), ap.track_album_artist, ap.track_artist, '') AS artist, \
                COALESCE(NULLIF(p.artist_id, ''), ap.track_artist_id) AS artist_id, \
                COALESCE(p.year, ap.track_year) AS year, \
                COALESCE(NULLIF(p.cover_art_id, ''), ap.track_cover_art_id) AS cover_art_id, \
                ap.play_count \
         FROM album_plays ap \
         LEFT JOIN album_browse_projection p \
           ON p.server_id = ap.server_id \
          AND p.library_id = ap.library_id \
          AND p.album_id = ap.album_id \
         ORDER BY ap.play_count DESC, name COLLATE NOCASE ASC, \
                  ap.server_id ASC, ap.library_id ASC, ap.album_id ASC \
         LIMIT ? OFFSET ?",
        album_plays_cte(scope_where)
    )
}

fn artist_sql(scope_where: &str) -> String {
    format!(
        "WITH {}, \
         artist_albums AS ( \
             SELECT ap.server_id, \
                    COALESCE(NULLIF(p.artist_id, ''), ap.track_artist_id, \
                             NULLIF(p.artist, ''), ap.track_album_artist, ap.track_artist) AS id, \
                    COALESCE(NULLIF(p.artist, ''), ap.track_album_artist, ap.track_artist, '') AS name, \
                    COALESCE(NULLIF(p.cover_art_id, ''), ap.track_cover_art_id) AS cover_art_id, \
                    ap.play_count \
             FROM album_plays ap \
             LEFT JOIN album_browse_projection p \
               ON p.server_id = ap.server_id \
               AND p.library_id = ap.library_id \
              AND p.album_id = ap.album_id \
         ), \
         ranked_artists AS ( \
             SELECT server_id, id, \
                    FIRST_VALUE(name) OVER ( \
                        PARTITION BY server_id, id \
                        ORDER BY play_count DESC, name COLLATE NOCASE ASC, \
                                 COALESCE(cover_art_id, '') ASC \
                    ) AS name, \
                    FIRST_VALUE(cover_art_id) OVER ( \
                        PARTITION BY server_id, id \
                        ORDER BY (cover_art_id IS NULL) ASC, play_count DESC, \
                                 cover_art_id ASC \
                    ) AS cover_art_id, \
                    SUM(play_count) OVER (PARTITION BY server_id, id) AS play_count, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY server_id, id \
                        ORDER BY play_count DESC, name COLLATE NOCASE ASC, \
                                 COALESCE(cover_art_id, '') ASC \
                    ) AS artist_row \
             FROM artist_albums \
             WHERE id IS NOT NULL AND id != '' \
         ) \
         SELECT server_id, id, name, cover_art_id, play_count \
         FROM ranked_artists \
         WHERE artist_row = 1 \
         ORDER BY play_count DESC, name COLLATE NOCASE ASC, server_id ASC, id ASC \
         LIMIT 50",
        album_plays_cte(scope_where)
    )
}

/// Aggregate `track.play_count` for the selected scopes without any REST reads.
pub fn query_most_played(
    store: &LibraryStore,
    request: &LibraryMostPlayedRequest,
) -> Result<LibraryMostPlayedResponse, String> {
    let limit = request.limit.unwrap_or(50).clamp(1, PAGE_LIMIT_MAX);
    let offset = request.offset.unwrap_or(0);
    let fetch_limit = limit.saturating_add(1);
    let normalized_scopes = normalize_scopes(&request.scopes);
    if normalized_scopes.is_empty() {
        return Ok(LibraryMostPlayedResponse {
            albums: Vec::new(),
            artists: Vec::new(),
            has_more: false,
        });
    }
    let (scope_where, scope_params) = scopes_where(&normalized_scopes);
    let artist_sql = artist_sql(&scope_where);
    let sql = album_sql(&scope_where);
    let mut album_params = scope_params.clone();
    album_params.push(SqlValue::Integer(i64::from(fetch_limit)));
    album_params.push(SqlValue::Integer(i64::from(offset)));

    store
        .with_scope_detail_read_conn(|conn| {
            let mut artist_stmt = conn.prepare(&artist_sql)?;
            let artists = artist_stmt
                .query_map(params_from_iter(scope_params.iter()), |row| {
                    Ok(LibraryMostPlayedArtistDto {
                        server_id: row.get(0)?,
                        id: row.get(1)?,
                        name: row.get(2)?,
                        cover_art_id: row.get(3)?,
                        play_count: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut stmt = conn.prepare(&sql)?;
            let mut albums = stmt
                .query_map(params_from_iter(album_params.iter()), |row| {
                    Ok(LibraryMostPlayedAlbumDto {
                        server_id: row.get(0)?,
                        library_id: row.get(1)?,
                        id: row.get(2)?,
                        name: row.get(3)?,
                        artist: row.get(4)?,
                        artist_id: row.get(5)?,
                        year: row.get(6)?,
                        cover_art_id: row.get(7)?,
                        play_count: row.get(8)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let has_more = albums.len() > limit as usize;
            albums.truncate(limit as usize);
            Ok(LibraryMostPlayedResponse {
                albums,
                artists,
                has_more,
            })
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "most_played/tests.rs"]
mod tests;

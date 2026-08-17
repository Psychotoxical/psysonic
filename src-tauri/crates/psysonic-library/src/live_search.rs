//! Live Search dropdown (spec §5.9 / P24) — column-scoped FTS with LIMIT inside
//! the FTS subquery (bm25 on ≤N rowids), then a cheap join to `track`.
//! Avoids the SQLite pitfall where `JOIN track … ORDER BY bm25` on an OR
//! MATCH scans/ranks the whole hit set on 100k+ libraries (10–20s queries).

use std::collections::{HashMap, HashSet};

use crate::dto::{
    multi_library_merge_enabled, ordered_library_scope_pairs, LibraryAlbumDto, LibraryArtistDto,
    LibraryLiveSearchResponse, LibraryScopePair, LibraryTrackDto,
};
use crate::scope_merge;
use crate::search::{
    fts_album_prefix_any_token_match_query, fts_artist_prefix_any_token_match_query,
    fts_query_meets_min_len, fts_track_prefix_any_token_match_query, library_scope_in_sql,
    normalized_library_scopes, push_library_scope_binds,
};
use crate::store::LibraryStore;

const TRACK_FTS_BM25_RANK: &str = "bm25(track_fts, 10.0, 3.0, 5.0, 3.0, 0.0)";
/// FTS row candidates before GROUP BY dedupe — avoids one artist filling the whole cap.
pub(crate) const LIVE_SEARCH_FTS_CANDIDATE_CAP: i64 = 150;

struct LiveHit {
    track: LibraryTrackDto,
}

/// `library_live_search` — read connection, scoped FTS rowid picks + join.
#[allow(clippy::too_many_arguments)]
pub fn run_live_search(
    store: &LibraryStore,
    server_id: &str,
    query: &str,
    library_scope: Option<&str>,
    library_scopes: Option<&[LibraryScopePair]>,
    artist_limit: u32,
    album_limit: u32,
    song_limit: u32,
) -> Result<LibraryLiveSearchResponse, String> {
    if !fts_query_meets_min_len(query) {
        return Ok(LibraryLiveSearchResponse {
            artists: Vec::new(),
            albums: Vec::new(),
            tracks: Vec::new(),
            source: "local".to_string(),
        });
    }

    let scope_pairs = ordered_library_scope_pairs(server_id, library_scope, library_scopes)?;
    if multi_library_merge_enabled(&scope_pairs) {
        crate::scope_merge::ensure_cluster_keys_for_scopes(store, &scope_pairs)?;
        return run_live_search_multi_scope(
            store,
            &scope_pairs,
            query,
            artist_limit,
            album_limit,
            song_limit,
        );
    }

    let effective_scope = library_scope
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| scope_pairs.first().and_then(|p| p.library_id.clone()));

    store.with_read_conn(|conn| {
        let scopes = scopes_from_option(effective_scope.as_deref());
        // Songs first — smallest FTS cap; warms the page cache for follow-up queries.
        let songs = query_songs(conn, query, server_id, &scopes, song_limit)?;
        let artists = query_artists(conn, query, server_id, &scopes, artist_limit)?;
        let albums = query_albums(conn, query, server_id, &scopes, album_limit)?;
        Ok(LibraryLiveSearchResponse {
            artists,
            albums,
            tracks: songs,
            source: "local".to_string(),
        })
    })
}

fn run_live_search_multi_scope(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    query: &str,
    artist_limit: u32,
    album_limit: u32,
    song_limit: u32,
) -> Result<LibraryLiveSearchResponse, String> {
    let Some(song_fts) = fts_track_prefix_any_token_match_query(query) else {
        return Ok(LibraryLiveSearchResponse {
            artists: Vec::new(),
            albums: Vec::new(),
            tracks: Vec::new(),
            source: "local".to_string(),
        });
    };
    let songs = scope_merge::live_search_songs(store, scopes, &song_fts, song_limit)?;

    let artists = if let Some(artist_fts) = fts_artist_prefix_any_token_match_query(query) {
        scope_merge::live_search_artists(store, scopes, &artist_fts, artist_limit)?
    } else {
        Vec::new()
    };

    let albums = if let Some(album_fts) = fts_album_prefix_any_token_match_query(query) {
        scope_merge::live_search_albums(store, scopes, &album_fts, album_limit)?
    } else {
        Vec::new()
    };

    Ok(LibraryLiveSearchResponse {
        artists,
        albums,
        tracks: songs,
        source: "local".to_string(),
    })
}

fn scopes_from_option(library_scope: Option<&str>) -> Vec<String> {
    normalized_library_scopes(
        &library_scope
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
    )
}

/// Top FTS rowids for column-scoped MATCH, scoped to `server_id` (multi-server safe).
fn collect_fts_rowids(
    conn: &rusqlite::Connection,
    match_queries: &[String],
    server_id: &str,
    library_scopes: &[String],
    per_query_limit: i64,
    total_limit: usize,
) -> rusqlite::Result<Vec<i64>> {
    let mut scope_sql = String::new();
    if !library_scopes.is_empty() {
        scope_sql = format!(" AND {}", library_scope_in_sql("c", library_scopes.len()));
    }
    let sql = format!(
        "SELECT f.rowid FROM track_fts f \
         WHERE track_fts MATCH ? \
           AND EXISTS (\
             SELECT 1 FROM track c \
             WHERE c.rowid = f.rowid \
               AND c.server_id = ? \
               AND c.deleted = 0{scope_sql}\
           ) \
         ORDER BY {TRACK_FTS_BM25_RANK} LIMIT ?",
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut seen = HashSet::new();
    let mut rowids = Vec::new();
    for mq in match_queries {
        let mut bind: Vec<rusqlite::types::Value> = vec![
            rusqlite::types::Value::Text(mq.clone()),
            rusqlite::types::Value::Text(server_id.to_string()),
        ];
        push_library_scope_binds(&mut bind, library_scopes);
        bind.push(rusqlite::types::Value::Integer(per_query_limit));
        let rows = stmt.query_map(rusqlite::params_from_iter(bind.iter()), |r| r.get(0))?;
        for rowid in rows {
            let rowid = rowid?;
            if seen.insert(rowid) {
                rowids.push(rowid);
                if rowids.len() >= total_limit {
                    return Ok(rowids);
                }
            }
        }
    }
    Ok(rowids)
}

fn append_library_scope(
    sql: &mut String,
    params: &mut Vec<rusqlite::types::Value>,
    library_scopes: &[String],
) {
    if !library_scopes.is_empty() {
        sql.push_str(" AND ");
        sql.push_str(&library_scope_in_sql("t", library_scopes.len()));
        push_library_scope_binds(params, library_scopes);
    }
}

fn scoped_exists_sql(library_scopes: &[String], extra: &str) -> String {
    let mut scope_sql = String::new();
    if !library_scopes.is_empty() {
        scope_sql = format!(" AND {}", library_scope_in_sql("c", library_scopes.len()));
    }
    format!(
        "EXISTS (\
           SELECT 1 FROM track c \
           WHERE c.rowid = f.rowid \
             AND c.server_id = ? \
             AND c.deleted = 0{extra}{scope_sql}\
         )"
    )
}

fn query_artists(
    conn: &rusqlite::Connection,
    query: &str,
    server_id: &str,
    library_scopes: &[String],
    limit: u32,
) -> rusqlite::Result<Vec<LibraryArtistDto>> {
    let Some(artist_fts) = fts_artist_prefix_any_token_match_query(query) else {
        return Ok(Vec::new());
    };
    let exists = scoped_exists_sql(
        library_scopes,
        " AND c.artist_id IS NOT NULL AND c.artist_id != ''",
    );
    let sql = format!(
        "WITH fts_hits AS (\
           SELECT f.rowid, {TRACK_FTS_BM25_RANK} AS rank \
           FROM track_fts f \
           WHERE track_fts MATCH ? \
             AND {exists} \
           ORDER BY rank \
           LIMIT ?\
         ) \
         SELECT t.server_id, t.artist_id, t.artist, t.synced_at, MIN(h.rank) AS best_rank \
         FROM fts_hits h \
         JOIN track t ON t.rowid = h.rowid \
         WHERE t.server_id = ? \
           AND t.deleted = 0 \
           AND t.artist_id IS NOT NULL AND t.artist_id != ''"
    );
    let mut sql = sql;
    let mut params: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(artist_fts),
        rusqlite::types::Value::Text(server_id.to_string()),
    ];
    push_library_scope_binds(&mut params, library_scopes);
    params.push(rusqlite::types::Value::Integer(
        LIVE_SEARCH_FTS_CANDIDATE_CAP,
    ));
    params.push(rusqlite::types::Value::Text(server_id.to_string()));
    append_library_scope(&mut sql, &mut params, library_scopes);
    sql.push_str(" GROUP BY t.artist_id ORDER BY best_rank LIMIT ?");
    params.push(rusqlite::types::Value::Integer(i64::from(limit)));
    let mut stmt = conn.prepare(&sql)?;
    let mut out = Vec::new();
    for row in stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        Ok(LibraryArtistDto {
            server_id: r.get(0)?,
            id: r.get(1)?,
            name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            name_sort: None,
            album_count: None,
            synced_at: r.get(3)?,
            raw_json: serde_json::Value::Null,
        })
    })? {
        out.push(row?);
    }
    Ok(out)
}

fn query_songs(
    conn: &rusqlite::Connection,
    query: &str,
    server_id: &str,
    library_scopes: &[String],
    limit: u32,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let Some(song_fts) = fts_track_prefix_any_token_match_query(query) else {
        return Ok(Vec::new());
    };
    let per_col = i64::from(limit.max(4));
    let rowids = collect_fts_rowids(
        conn,
        &[song_fts],
        server_id,
        library_scopes,
        per_col,
        limit as usize,
    )?;
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    fetch_tracks_by_rowids(conn, &rowids, server_id, library_scopes)
}

fn query_albums(
    conn: &rusqlite::Connection,
    query: &str,
    server_id: &str,
    library_scopes: &[String],
    limit: u32,
) -> rusqlite::Result<Vec<LibraryAlbumDto>> {
    let Some(album_fts) = fts_album_prefix_any_token_match_query(query) else {
        return Ok(Vec::new());
    };
    let exists = scoped_exists_sql(
        library_scopes,
        " AND c.album_id IS NOT NULL AND c.album_id != ''",
    );
    let sql = format!(
        "WITH fts_hits AS (\
           SELECT f.rowid, {TRACK_FTS_BM25_RANK} AS rank \
           FROM track_fts f \
           WHERE track_fts MATCH ? \
             AND {exists} \
           ORDER BY rank \
           LIMIT ?\
         ) \
         SELECT t.server_id, t.album_id, MAX(t.album), MAX(t.artist), MAX(t.album_artist), \
                MAX(t.artist_id), MAX(t.year), MAX(t.genre), MAX(t.cover_art_id), \
                MAX(t.starred_at), MAX(t.synced_at), MIN(h.rank) AS best_rank \
         FROM fts_hits h \
         JOIN track t ON t.rowid = h.rowid \
         WHERE t.server_id = ? \
           AND t.deleted = 0 \
           AND t.album_id IS NOT NULL AND t.album_id != ''"
    );
    let mut sql = sql;
    let mut params: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(album_fts),
        rusqlite::types::Value::Text(server_id.to_string()),
    ];
    push_library_scope_binds(&mut params, library_scopes);
    params.push(rusqlite::types::Value::Integer(
        LIVE_SEARCH_FTS_CANDIDATE_CAP,
    ));
    params.push(rusqlite::types::Value::Text(server_id.to_string()));
    append_library_scope(&mut sql, &mut params, library_scopes);
    sql.push_str(" GROUP BY t.server_id, t.album_id ORDER BY best_rank LIMIT ?");
    params.push(rusqlite::types::Value::Integer(i64::from(limit)));
    let mut stmt = conn.prepare(&sql)?;
    let mut out = Vec::new();
    for row in stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        let track_artist: Option<String> = r.get(3)?;
        let album_artist: Option<String> = r.get(4)?;
        Ok(LibraryAlbumDto {
            server_id: r.get(0)?,
            id: r.get(1)?,
            name: r.get(2)?,
            artist: crate::album_compilation_filter::pick_album_group_artist(
                track_artist,
                album_artist,
            ),
            artist_id: r.get(5)?,
            song_count: None,
            duration_sec: None,
            year: r.get(6)?,
            genre: r.get(7)?,
            cover_art_id: r.get(8)?,
            starred_at: r.get(9)?,
            synced_at: r.get(10)?,
            raw_json: serde_json::Value::Null,
        })
    })? {
        out.push(row?);
    }
    crate::browse_support::overlay_album_artist_links(conn, &mut out);
    Ok(out)
}

fn rowid_placeholders(n: usize) -> String {
    (0..n).map(|_| "?").collect::<Vec<_>>().join(", ")
}

fn fetch_tracks_by_rowids(
    conn: &rusqlite::Connection,
    rowids: &[i64],
    server_id: &str,
    library_scopes: &[String],
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let placeholders = rowid_placeholders(rowids.len());
    let sql = format!(
        "SELECT \
          t.rowid, \
          t.server_id, t.id, t.title, t.artist, t.artist_id, t.album, t.album_id, \
          t.album_artist, t.duration_sec, t.track_number, t.disc_number, t.year, \
          t.genre, t.suffix, t.bit_rate, t.size_bytes, t.cover_art_id, \
          t.starred_at, t.user_rating, t.play_count, t.bpm, t.synced_at \
         FROM track t \
         WHERE t.rowid IN ({placeholders}) \
           AND t.server_id = ? \
           AND t.deleted = 0"
    );
    let mut params: Vec<rusqlite::types::Value> = rowids
        .iter()
        .copied()
        .map(rusqlite::types::Value::Integer)
        .collect();
    params.push(rusqlite::types::Value::Text(server_id.to_string()));
    let mut sql = sql;
    append_library_scope(&mut sql, &mut params, library_scopes);
    let mut stmt = conn.prepare(&sql)?;
    let mut by_rowid: HashMap<i64, LibraryTrackDto> = HashMap::new();
    for row in stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        let rowid: i64 = r.get(0)?;
        let hit = map_live_hit_row(r, 1)?;
        Ok((rowid, hit.track))
    })? {
        let (rowid, track) = row?;
        by_rowid.insert(rowid, track);
    }
    Ok(rowids
        .iter()
        .filter_map(|rid| by_rowid.get(rid).cloned())
        .collect())
}

fn map_live_hit_row(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<LiveHit> {
    Ok(LiveHit {
        track: LibraryTrackDto {
            server_id: row.get(offset)?,
            id: row.get(offset + 1)?,
            content_hash: None,
            title: row.get(offset + 2)?,
            title_sort: None,
            artist: row.get(offset + 3)?,
            artist_id: row.get(offset + 4)?,
            album: row.get(offset + 5)?,
            album_id: row.get(offset + 6)?,
            album_artist: row.get(offset + 7)?,
            duration_sec: row.get(offset + 8)?,
            track_number: row.get(offset + 9)?,
            disc_number: row.get(offset + 10)?,
            year: row.get(offset + 11)?,
            genre: row.get(offset + 12)?,
            suffix: row.get(offset + 13)?,
            bit_rate: row.get(offset + 14)?,
            size_bytes: row.get(offset + 15)?,
            cover_art_id: row.get(offset + 16)?,
            starred_at: row.get(offset + 17)?,
            user_rating: row.get(offset + 18)?,
            play_count: row.get(offset + 19)?,
            bpm: row.get(offset + 20)?,
            bpm_source: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            server_updated_at: None,
            server_created_at: None,
            synced_at: row.get(offset + 21)?,
            enrichment: None,
            raw_json: serde_json::Value::Null,
        },
    })
}

#[cfg(test)]
#[path = "live_search/tests.rs"]
mod tests;

//! Live Search dropdown (spec §5.9 / P24) — column-scoped FTS with LIMIT inside
//! the FTS subquery (bm25 on ≤N rowids), then a cheap join to `track`.
//! Avoids the SQLite pitfall where `JOIN track … ORDER BY bm25` on an OR
//! MATCH scans/ranks the whole hit set on 100k+ libraries (10–20s queries).

use std::collections::{HashMap, HashSet};

use crate::dto::{LibraryAlbumDto, LibraryArtistDto, LibraryLiveSearchResponse, LibraryTrackDto};
use crate::search::{
    fts_album_prefix_any_token_match_query, fts_artist_prefix_any_token_match_query,
    fts_query_meets_min_len, fts_track_prefix_any_token_match_query, library_scope_equals_sql,
};
use crate::store::LibraryStore;

const TRACK_FTS_BM25_RANK: &str = "bm25(track_fts, 10.0, 3.0, 5.0, 3.0, 0.0)";
/// FTS row candidates before GROUP BY dedupe — avoids one artist filling the whole cap.
const LIVE_SEARCH_FTS_CANDIDATE_CAP: i64 = 150;

struct LiveHit {
    track: LibraryTrackDto,
}

/// `library_live_search` — read connection, scoped FTS rowid picks + join.
pub fn run_live_search(
    store: &LibraryStore,
    server_id: &str,
    query: &str,
    library_scope: Option<&str>,
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

    store.with_read_conn(|conn| {
        let scope = trimmed_scope(library_scope);
        // Songs first — smallest FTS cap; warms the page cache for follow-up queries.
        let songs = query_songs(conn, query, server_id, scope.as_deref(), song_limit)?;
        let artists = query_artists(conn, query, server_id, scope.as_deref(), artist_limit)?;
        let albums = query_albums(conn, query, server_id, scope.as_deref(), album_limit)?;
        Ok(LibraryLiveSearchResponse {
            artists,
            albums,
            tracks: songs,
            source: "local".to_string(),
        })
    })
}

/// Top FTS rowids for column-scoped MATCH, scoped to `server_id` (multi-server safe).
fn collect_fts_rowids(
    conn: &rusqlite::Connection,
    match_queries: &[String],
    server_id: &str,
    library_scope: Option<&str>,
    per_query_limit: i64,
    total_limit: usize,
) -> rusqlite::Result<Vec<i64>> {
    let scope = trimmed_scope(library_scope);
    let mut scope_sql = String::new();
    if scope.is_some() {
        scope_sql = format!(" AND {}", library_scope_equals_sql("c"));
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
        if let Some(ref s) = scope {
            bind.push(rusqlite::types::Value::Text(s.clone()));
        }
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

fn trimmed_scope(scope: Option<&str>) -> Option<String> {
    scope
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn append_library_scope(
    sql: &mut String,
    params: &mut Vec<rusqlite::types::Value>,
    library_scope: Option<&str>,
) {
    if let Some(scope) = library_scope.filter(|s| !s.trim().is_empty()) {
        sql.push_str(" AND ");
        sql.push_str(&library_scope_equals_sql("t"));
        params.push(rusqlite::types::Value::Text(scope.to_string()));
    }
}

fn scoped_exists_sql(library_scope: Option<&str>, extra: &str) -> String {
    let mut scope_sql = String::new();
    if library_scope.is_some() {
        scope_sql = format!(" AND {}", library_scope_equals_sql("c"));
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

fn push_scope_bind(params: &mut Vec<rusqlite::types::Value>, library_scope: Option<&str>) {
    if let Some(scope) = library_scope.filter(|s| !s.trim().is_empty()) {
        params.push(rusqlite::types::Value::Text(scope.to_string()));
    }
}

fn query_artists(
    conn: &rusqlite::Connection,
    query: &str,
    server_id: &str,
    library_scope: Option<&str>,
    limit: u32,
) -> rusqlite::Result<Vec<LibraryArtistDto>> {
    let Some(artist_fts) = fts_artist_prefix_any_token_match_query(query) else {
        return Ok(Vec::new());
    };
    let exists = scoped_exists_sql(
        library_scope,
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
    push_scope_bind(&mut params, library_scope);
    params.push(rusqlite::types::Value::Integer(LIVE_SEARCH_FTS_CANDIDATE_CAP));
    params.push(rusqlite::types::Value::Text(server_id.to_string()));
    append_library_scope(&mut sql, &mut params, library_scope);
    sql.push_str(" GROUP BY t.artist_id ORDER BY best_rank LIMIT ?");
    params.push(rusqlite::types::Value::Integer(i64::from(limit)));
    let mut stmt = conn.prepare(&sql)?;
    let mut out = Vec::new();
    for row in stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        Ok(LibraryArtistDto {
            server_id: r.get(0)?,
            id: r.get(1)?,
            name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
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
    library_scope: Option<&str>,
    limit: u32,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let Some(song_fts) = fts_track_prefix_any_token_match_query(query) else {
        return Ok(Vec::new());
    };
    let per_col = i64::from(limit.max(4));
    let rowids = collect_fts_rowids(conn, &[song_fts], server_id, library_scope, per_col, limit as usize)?;
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    fetch_tracks_by_rowids(conn, &rowids, server_id, library_scope)
}

fn query_albums(
    conn: &rusqlite::Connection,
    query: &str,
    server_id: &str,
    library_scope: Option<&str>,
    limit: u32,
) -> rusqlite::Result<Vec<LibraryAlbumDto>> {
    let Some(album_fts) = fts_album_prefix_any_token_match_query(query) else {
        return Ok(Vec::new());
    };
    let exists = scoped_exists_sql(
        library_scope,
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
         SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.year, \
                t.genre, t.cover_art_id, t.starred_at, t.synced_at, MIN(h.rank) AS best_rank \
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
    push_scope_bind(&mut params, library_scope);
    params.push(rusqlite::types::Value::Integer(LIVE_SEARCH_FTS_CANDIDATE_CAP));
    params.push(rusqlite::types::Value::Text(server_id.to_string()));
    append_library_scope(&mut sql, &mut params, library_scope);
    sql.push_str(" GROUP BY t.album_id ORDER BY best_rank LIMIT ?");
    params.push(rusqlite::types::Value::Integer(i64::from(limit)));
    let mut stmt = conn.prepare(&sql)?;
    let mut out = Vec::new();
    for row in stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        Ok(LibraryAlbumDto {
            server_id: r.get(0)?,
            id: r.get(1)?,
            name: r.get(2)?,
            artist: r.get(3)?,
            artist_id: r.get(4)?,
            song_count: None,
            duration_sec: None,
            year: r.get(5)?,
            genre: r.get(6)?,
            cover_art_id: r.get(7)?,
            starred_at: r.get(8)?,
            synced_at: r.get(9)?,
            raw_json: serde_json::Value::Null,
        })
    })? {
        out.push(row?);
    }
    Ok(out)
}

fn rowid_placeholders(n: usize) -> String {
    (0..n).map(|_| "?").collect::<Vec<_>>().join(", ")
}

fn fetch_tracks_by_rowids(
    conn: &rusqlite::Connection,
    rowids: &[i64],
    server_id: &str,
    library_scope: Option<&str>,
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
    append_library_scope(&mut sql, &mut params, library_scope);
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
            server_updated_at: None,
            server_created_at: None,
            synced_at: row.get(offset + 21)?,
            enrichment: None,
            raw_json: serde_json::Value::Null,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use serde_json::json;

    fn track(
        server: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        album_id: &str,
        artist_id: &str,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(artist_id.into()),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: Some(format!("cv_{album_id}")),
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

    #[test]
    fn live_search_prefix_matches_partial_artist_name() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track(
                    "s1",
                    "t1",
                    "Enter Sandman",
                    "Metallica",
                    "Metallica",
                    "al1",
                    "ar_meta",
                ),
                track("s1", "t2", "Other", "Other Artist", "Other Album", "al2", "ar2"),
            ])
            .unwrap();
        let resp = run_live_search(&store, "s1", "metal", None, 5, 5, 10).unwrap();
        assert!(
            resp.artists.iter().any(|a| a.name == "Metallica"),
            "expected Metallica from prefix query metal"
        );
        assert!(resp.tracks.iter().any(|t| t.artist.as_deref() == Some("Metallica")));
    }

    #[test]
    fn live_search_returns_songs_albums_artists_from_scoped_fts() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora Song", "Aurora Quartet", "Aurora Nights", "al1", "ar1"),
                track("s1", "t2", "Other", "Other Artist", "Other Album", "al2", "ar2"),
            ])
            .unwrap();
        let resp = run_live_search(&store, "s1", "aurora", None, 5, 5, 10).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al1");
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].id, "ar1");
        assert!(resp.tracks[0].raw_json.is_null());
    }

    #[test]
    fn live_search_does_not_surface_artist_from_unrelated_track_hit() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track(
                    "s1",
                    "t1",
                    "Battle Hymn",
                    "Arch Enemy",
                    "Manowar Covers Vol 1",
                    "al1",
                    "ar_arch",
                ),
                track(
                    "s1",
                    "t2",
                    "Heart Of Steel",
                    "Manowar",
                    "Fighting the World",
                    "al2",
                    "ar_mano",
                ),
            ])
            .unwrap();
        let resp = run_live_search(&store, "s1", "manowar", None, 5, 5, 10).unwrap();
        assert!(
            resp.artists.iter().any(|a| a.name == "Manowar"),
            "expected Manowar artist"
        );
        assert!(
            !resp.artists.iter().any(|a| a.name == "Arch Enemy"),
            "Arch Enemy must not appear when only the album title mentions Manowar"
        );
        assert!(resp.albums.iter().any(|a| a.name.contains("Manowar")));
    }

    #[test]
    fn live_search_short_query_returns_empty_without_scanning() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track(
                "s1",
                "t1",
                "Аура",
                "Artist",
                "Album",
                "al1",
                "ar1",
            )])
            .unwrap();
        let resp = run_live_search(&store, "s1", "а", None, 5, 5, 10).unwrap();
        assert!(resp.tracks.is_empty());
        assert!(resp.artists.is_empty());
        assert!(resp.albums.is_empty());
    }

    #[test]
    fn live_search_library_scope_narrows_results() {
        let store = LibraryStore::open_in_memory();
        let mut in_lib = track(
            "s1",
            "t1",
            "Scoped Song",
            "Scoped Artist",
            "Scoped Album",
            "al1",
            "ar1",
        );
        in_lib.library_id = Some("lib1".into());
        let mut other = track(
            "s1",
            "t2",
            "Scoped Song",
            "Other Artist",
            "Other Album",
            "al2",
            "ar2",
        );
        other.library_id = Some("lib2".into());
        TrackRepository::new(&store)
            .upsert_batch(&[in_lib, other])
            .unwrap();
        let resp = run_live_search(&store, "s1", "scoped", Some("lib1"), 5, 5, 10).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].name, "Scoped Artist");
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].name, "Scoped Album");
    }

    #[test]
    fn live_search_library_scope_matches_raw_json_when_column_null() {
        let store = LibraryStore::open_in_memory();
        let mut row = track(
            "s1",
            "t1",
            "Scoped Song",
            "Scoped Artist",
            "Scoped Album",
            "al1",
            "ar1",
        );
        row.raw_json = json!({"libraryId": 3}).to_string();
        TrackRepository::new(&store).upsert_batch(&[row]).unwrap();
        let resp = run_live_search(&store, "s1", "scoped", Some("3"), 5, 5, 10).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn live_search_fts_scoped_to_server_not_global_bm25() {
        let store = LibraryStore::open_in_memory();
        let mut batch = Vec::new();
        for i in 0..20 {
            batch.push(track(
                "s_big",
                &format!("t{i}"),
                "Song",
                "Nightblaze",
                "Album",
                &format!("al{i}"),
                "ar_nightblaze",
            ));
        }
        batch.push(track(
            "s_small",
            "t_nw",
            "Ghost Love Score",
            "Nightwish",
            "Once",
            "al_nw",
            "ar_nw",
        ));
        TrackRepository::new(&store)
            .upsert_batch(&batch)
            .unwrap();
        let resp = run_live_search(&store, "s_small", "night", None, 5, 5, 10).unwrap();
        assert!(
            resp.artists.iter().any(|a| a.name == "Nightwish"),
            "expected Nightwish on s_small; global bm25 must not crowd out the active server"
        );
    }

    #[test]
    fn live_search_returns_distinct_artists_not_one_per_many_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut batch = Vec::new();
        for i in 0..12 {
            batch.push(track(
                "s1",
                &format!("t_m{i}"),
                "Song",
                "Metallica",
                "Album",
                &format!("al_m{i}"),
                "ar_meta",
            ));
        }
        for (id, name, artist_id) in [
            ("ar_metal1", "Metallica Tribute", "ar_t1"),
            ("ar_metal2", "Metallium", "ar_t2"),
            ("ar_metal3", "Metalloid", "ar_t3"),
        ] {
            batch.push(track(
                "s1",
                &format!("t_{artist_id}"),
                "One",
                name,
                "Other",
                id,
                artist_id,
            ));
        }
        TrackRepository::new(&store).upsert_batch(&batch).unwrap();
        let resp = run_live_search(&store, "s1", "metall", None, 5, 5, 10).unwrap();
        assert!(
            resp.artists.len() >= 3,
            "expected distinct metall* artists, got {} ({:?})",
            resp.artists.len(),
            resp.artists.iter().map(|a| a.name.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn live_search_equals_query_returns_no_false_positives() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track(
                    "s1",
                    "t1",
                    "Intro",
                    "Smith & Myers",
                    "Volume 1 & 2",
                    "al_vol",
                    "ar1",
                ),
                track("s1", "t2", "Hello", "Adele", "25", "al_25", "ar2"),
                track("s1", "t3", "Track", "Y.O.M.C.", "Single", "al_yo", "ar3"),
            ])
            .unwrap();
        for q in ["1=2", "1=1", "M=c"] {
            let resp = run_live_search(&store, "s1", q, None, 5, 5, 10).unwrap();
            assert!(
                resp.tracks.is_empty() && resp.albums.is_empty() && resp.artists.is_empty(),
                "query {q:?} must not fuzzy-match unrelated library rows"
            );
        }
    }

    #[test]
    fn live_search_censorship_stars_in_title_is_searchable() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track(
                    "s1",
                    "t1",
                    "***Flawless",
                    "Beyoncé",
                    "BEYONCÉ",
                    "al1",
                    "ar1",
                ),
                track("s1", "t2", "Other Song", "Artist", "Album", "al2", "ar2"),
            ])
            .unwrap();
        let resp = run_live_search(&store, "s1", "***Flawless", None, 5, 5, 10).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].title, "***Flawless");
    }

    #[test]
    fn live_search_multiword_album_matches_any_token_not_only_first() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track(
                    "s1",
                    "t1",
                    "Intro",
                    "Artist",
                    "Supreme Ballads",
                    "al_supreme",
                    "ar1",
                ),
                track(
                    "s1",
                    "t2",
                    "Other",
                    "Artist",
                    "Unrelated",
                    "al2",
                    "ar1",
                ),
            ])
            .unwrap();
        let resp = run_live_search(&store, "s1", "love supreme", None, 5, 5, 10).unwrap();
        assert!(
            resp.albums.iter().any(|a| a.name == "Supreme Ballads"),
            "second token supreme must match album title; AND-all-tokens would miss this album"
        );
    }

    /// Manual: `cargo test -p psysonic-library bench_disk_live_search --release -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_disk_live_search() {
        use std::path::PathBuf;
        use std::time::Instant;

        let path: PathBuf = std::env::var("HOME")
            .map(|h| {
                PathBuf::from(h)
                    .join(".local/share/dev.psysonic.player/databases/library/library.sqlite")
            })
            .expect("HOME");
        if !path.exists() {
            eprintln!("skip: no db at {}", path.display());
            return;
        }
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("open db");
        conn.pragma_update(None, "cache_size", -64000).unwrap();

        let server_id = std::env::var("PSYSONIC_BENCH_SERVER_ID").unwrap_or_else(|_| {
            conn.query_row(
                "SELECT server_id FROM track WHERE deleted = 0 LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .expect("server_id")
        });

        for q in ["manowar", "metallica", "arch enemy", "metal", "meta"] {
            let t0 = Instant::now();
            let songs = query_songs(&conn, q, &server_id, None, 10).unwrap();
            let t1 = Instant::now();
            let artists = query_artists(&conn, q, &server_id, None, 5).unwrap();
            let t2 = Instant::now();
            let albums = query_albums(&conn, q, &server_id, None, 5).unwrap();
            let t3 = Instant::now();
            eprintln!(
                "{q:?}: songs={} ({:.1}ms) artists={} ({:.1}ms) albums={} ({:.1}ms) total={:.1}ms",
                songs.len(),
                t1.duration_since(t0).as_secs_f64() * 1000.0,
                artists.len(),
                t2.duration_since(t1).as_secs_f64() * 1000.0,
                albums.len(),
                t3.duration_since(t2).as_secs_f64() * 1000.0,
                t3.duration_since(t0).as_secs_f64() * 1000.0,
            );
        }
    }
}

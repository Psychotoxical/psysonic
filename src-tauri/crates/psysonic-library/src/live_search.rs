//! Live Search dropdown (spec §5.9 / P24) — column-scoped FTS queries with
//! tight LIMITs. Artists/albums match **name columns only** (not every track
//! hit); songs match title/artist/album fields. Avoids false artist rows when
//! the query appears only in a song/album title (e.g. "Manowar" in album name
//! → artist "Arch Enemy") and keeps each FTS pass small on 100k+ libraries.

use std::collections::HashMap;

use rusqlite::params;

use crate::dto::{LibraryAlbumDto, LibraryArtistDto, LibraryLiveSearchResponse, LibraryTrackDto};
use crate::search::{fts_album_match_query, fts_column_query, fts_query_meets_min_len, fts_track_match_query};
use crate::store::LibraryStore;

struct LiveHit {
    track: LibraryTrackDto,
}

/// `library_live_search` — read connection, three scoped FTS SELECTs.
pub fn run_live_search(
    store: &LibraryStore,
    server_id: &str,
    query: &str,
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
    let song_fts =
        fts_track_match_query(query).ok_or_else(|| "empty query".to_string())?;
    let artist_fts = fts_column_query("artist", query)
        .ok_or_else(|| "empty query".to_string())?;
    let album_fts = fts_album_match_query(query)
        .ok_or_else(|| "empty query".to_string())?;

    store.with_read_conn(|conn| {
        let songs = query_songs(conn, &song_fts, server_id, song_limit)?;
        let artists = query_artists(conn, &artist_fts, server_id, artist_limit)?;
        let albums = query_albums(conn, &album_fts, server_id, album_limit)?;
        Ok(LibraryLiveSearchResponse {
            artists,
            albums,
            tracks: songs,
            source: "local".to_string(),
        })
    })
}

fn query_songs(
    conn: &rusqlite::Connection,
    fts: &str,
    server_id: &str,
    limit: u32,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT
          t.server_id, t.id, t.title, t.artist, t.artist_id, t.album, t.album_id,
          t.album_artist, t.duration_sec, t.track_number, t.disc_number, t.year,
          t.genre, t.suffix, t.bit_rate, t.size_bytes, t.cover_art_id,
          t.starred_at, t.user_rating, t.play_count, t.bpm, t.synced_at
        FROM track_fts f
        JOIN track t ON t.rowid = f.rowid
        WHERE track_fts MATCH ?1
          AND t.server_id = ?2
          AND t.deleted = 0
        ORDER BY bm25(track_fts)
        LIMIT ?3
        "#,
    )?;
    let rows: Vec<LiveHit> = stmt
        .query_map(params![fts, server_id, limit], map_live_hit)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(|h| h.track).collect())
}

fn query_artists(
    conn: &rusqlite::Connection,
    fts: &str,
    server_id: &str,
    limit: u32,
) -> rusqlite::Result<Vec<LibraryArtistDto>> {
    let fetch = limit.saturating_mul(3).clamp(limit, 24);
    let mut stmt = conn.prepare(
        r#"
        SELECT t.server_id, t.artist_id, t.artist, t.synced_at
        FROM track_fts f
        JOIN track t ON t.rowid = f.rowid
        WHERE track_fts MATCH ?1
          AND t.server_id = ?2
          AND t.deleted = 0
          AND t.artist_id IS NOT NULL AND t.artist_id != ''
        ORDER BY bm25(track_fts)
        LIMIT ?3
        "#,
    )?;
    let mut seen = HashMap::new();
    for row in stmt.query_map(params![fts, server_id, fetch], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })? {
        let (server_id, artist_id, artist, synced_at) = row?;
        if seen.contains_key(&artist_id) {
            continue;
        }
        seen.insert(
            artist_id.clone(),
            LibraryArtistDto {
                server_id,
                id: artist_id,
                name: artist.unwrap_or_default(),
                album_count: None,
                synced_at,
                raw_json: serde_json::Value::Null,
            },
        );
        if seen.len() >= limit as usize {
            break;
        }
    }
    Ok(seen.into_values().collect())
}

fn query_albums(
    conn: &rusqlite::Connection,
    fts: &str,
    server_id: &str,
    limit: u32,
) -> rusqlite::Result<Vec<LibraryAlbumDto>> {
    let fetch = limit.saturating_mul(3).clamp(limit, 24);
    let mut stmt = conn.prepare(
        r#"
        SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.year,
               t.genre, t.cover_art_id, t.starred_at, t.synced_at
        FROM track_fts f
        JOIN track t ON t.rowid = f.rowid
        WHERE track_fts MATCH ?1
          AND t.server_id = ?2
          AND t.deleted = 0
          AND t.album_id IS NOT NULL AND t.album_id != ''
        ORDER BY bm25(track_fts)
        LIMIT ?3
        "#,
    )?;
    let mut seen = HashMap::new();
    for row in stmt.query_map(params![fts, server_id, fetch], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, i64>(9)?,
        ))
    })? {
        let (
            server_id,
            album_id,
            album,
            artist,
            artist_id,
            year,
            genre,
            cover_art_id,
            starred_at,
            synced_at,
        ) = row?;
        if seen.contains_key(&album_id) {
            continue;
        }
        seen.insert(
            album_id.clone(),
            LibraryAlbumDto {
                server_id,
                id: album_id,
                name: album,
                artist,
                artist_id,
                song_count: None,
                duration_sec: None,
                year,
                genre,
                cover_art_id,
                starred_at,
                synced_at,
                raw_json: serde_json::Value::Null,
            },
        );
        if seen.len() >= limit as usize {
            break;
        }
    }
    Ok(seen.into_values().collect())
}

fn map_live_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiveHit> {
    Ok(LiveHit {
        track: LibraryTrackDto {
            server_id: row.get(0)?,
            id: row.get(1)?,
            content_hash: None,
            title: row.get(2)?,
            title_sort: None,
            artist: row.get(3)?,
            artist_id: row.get(4)?,
            album: row.get(5)?,
            album_id: row.get(6)?,
            album_artist: row.get(7)?,
            duration_sec: row.get(8)?,
            track_number: row.get(9)?,
            disc_number: row.get(10)?,
            year: row.get(11)?,
            genre: row.get(12)?,
            suffix: row.get(13)?,
            bit_rate: row.get(14)?,
            size_bytes: row.get(15)?,
            cover_art_id: row.get(16)?,
            starred_at: row.get(17)?,
            user_rating: row.get(18)?,
            play_count: row.get(19)?,
            bpm: row.get(20)?,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            server_updated_at: None,
            server_created_at: None,
            synced_at: row.get(21)?,
            enrichment: None,
            raw_json: serde_json::Value::Null,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

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
    fn live_search_returns_songs_albums_artists_from_scoped_fts() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora Song", "Aurora Quartet", "Aurora Nights", "al1", "ar1"),
                track("s1", "t2", "Other", "Other Artist", "Other Album", "al2", "ar2"),
            ])
            .unwrap();
        let resp = run_live_search(&store, "s1", "aurora", 5, 5, 10).unwrap();
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
        let resp = run_live_search(&store, "s1", "manowar", 5, 5, 10).unwrap();
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
        let resp = run_live_search(&store, "s1", "а", 5, 5, 10).unwrap();
        assert!(resp.tracks.is_empty());
        assert!(resp.artists.is_empty());
        assert!(resp.albums.is_empty());
    }
}

//! Live Search dropdown (spec §5.9 / P24) — one FTS pass, lean columns,
//! in-memory album/artist dedupe. Avoids the Advanced Search builder's
//! multi-query path (empty album/artist tables + `%LIKE%` scans + full
//! `raw_json` hydration).

use std::collections::HashMap;

use rusqlite::params;

use crate::dto::{LibraryAlbumDto, LibraryArtistDto, LibraryLiveSearchResponse, LibraryTrackDto};
use crate::search::fts_query;
use crate::store::LibraryStore;

const DEDUPE_POOL_MAX: i64 = 48;

struct LiveHit {
    track: LibraryTrackDto,
}

/// `library_live_search` — single read connection, one FTS SELECT.
pub fn run_live_search(
    store: &LibraryStore,
    server_id: &str,
    query: &str,
    artist_limit: u32,
    album_limit: u32,
    song_limit: u32,
) -> Result<LibraryLiveSearchResponse, String> {
    let fts = fts_query(query).ok_or_else(|| "empty query".to_string())?;
    let pool = song_limit.max(album_limit).max(artist_limit) as i64 * 4;
    let pool = pool.clamp(10, DEDUPE_POOL_MAX);

    store.with_read_conn(|conn| {
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
        let hits: Vec<LiveHit> = stmt
            .query_map(params![fts, server_id, pool], map_live_hit)?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut songs: Vec<LibraryTrackDto> = Vec::with_capacity(song_limit as usize);
        let mut albums: HashMap<String, LibraryAlbumDto> = HashMap::new();
        let mut artists: HashMap<String, LibraryArtistDto> = HashMap::new();

        for hit in hits {
            if songs.len() < song_limit as usize {
                songs.push(hit.track.clone());
            }
            if albums.len() < album_limit as usize {
                if let Some(album_id) = hit.track.album_id.as_deref().filter(|s| !s.is_empty()) {
                    albums.entry(album_id.to_string()).or_insert_with(|| {
                        LibraryAlbumDto {
                            server_id: hit.track.server_id.clone(),
                            id: album_id.to_string(),
                            name: hit.track.album.clone(),
                            artist: hit.track.artist.clone(),
                            artist_id: hit.track.artist_id.clone(),
                            song_count: None,
                            duration_sec: None,
                            year: hit.track.year,
                            genre: hit.track.genre.clone(),
                            cover_art_id: hit.track.cover_art_id.clone(),
                            starred_at: hit.track.starred_at,
                            synced_at: hit.track.synced_at,
                            raw_json: serde_json::Value::Null,
                        }
                    });
                }
            }
            if artists.len() < artist_limit as usize {
                if let Some(artist_id) = hit.track.artist_id.as_deref().filter(|s| !s.is_empty()) {
                    artists.entry(artist_id.to_string()).or_insert_with(|| {
                        LibraryArtistDto {
                            server_id: hit.track.server_id.clone(),
                            id: artist_id.to_string(),
                            name: hit.track.artist.clone().unwrap_or_default(),
                            album_count: None,
                            synced_at: hit.track.synced_at,
                            raw_json: serde_json::Value::Null,
                        }
                    });
                }
            }
        }

        Ok(LibraryLiveSearchResponse {
            artists: artists.into_values().collect(),
            albums: albums.into_values().collect(),
            tracks: songs,
            source: "local".to_string(),
        })
    })
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
    fn live_search_returns_songs_albums_artists_from_one_fts_pass() {
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
}

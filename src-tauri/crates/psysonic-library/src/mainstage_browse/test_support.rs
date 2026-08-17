use super::*;
use crate::dto::{LibraryScopePair, PlaySessionInputDto};
use crate::identity::ensure_cluster_keys_built;
use crate::repos::{PlaySessionRepository, TrackRepository, TrackRow};
use rusqlite::params;
use std::time::{Duration, Instant};

fn scope(server_id: &str, library_id: &str) -> LibraryScopePair {
    LibraryScopePair {
        server_id: server_id.into(),
        library_id: Some(library_id.into()),
    }
}

fn whole_scope(server_id: &str) -> LibraryScopePair {
    LibraryScopePair {
        server_id: server_id.into(),
        library_id: None,
    }
}

fn track(
    server_id: &str,
    id: &str,
    album: &str,
    album_id: &str,
    library_id: &str,
    created_at: Option<i64>,
) -> TrackRow {
    TrackRow {
        server_id: server_id.into(),
        id: id.into(),
        title: format!("Track {id}"),
        title_sort: None,
        artist: Some("Artist".into()),
        artist_id: Some(format!("artist-{server_id}")),
        album: album.into(),
        album_id: Some(album_id.into()),
        album_artist: Some("Artist".into()),
        duration_sec: 180,
        track_number: Some(1),
        disc_number: Some(1),
        year: Some(2026),
        genre: None,
        suffix: Some("flac".into()),
        bit_rate: None,
        size_bytes: None,
        cover_art_id: Some(format!("cover-{album_id}")),
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
        server_created_at: created_at,
        deleted: false,
        synced_at: 1,
        raw_json: "{}".into(),
    }
}

fn request(
    scopes: Vec<LibraryScopePair>,
    feed: LibraryMainstageAlbumFeed,
) -> LibraryMainstageAlbumsRequest {
    LibraryMainstageAlbumsRequest {
        scopes,
        feed,
        limit: Some(30),
        offset: None,
        genres: Vec::new(),
        include_genre_counts: true,
    }
}

fn play(store: &LibraryStore, server_id: &str, track_id: &str, started_at_ms: i64) {
    PlaySessionRepository::new(store)
        .insert(&PlaySessionInputDto {
            server_id: server_id.into(),
            track_id: track_id.into(),
            started_at_ms,
            listened_sec: 20.0,
            position_max_sec: 20.0,
            end_reason: "skip".into(),
            duration_sec_hint: None,
        })
        .unwrap();
}

fn insert_artist(store: &LibraryStore, server_id: &str) {
    store
        .with_conn_mut("test.mainstage_artist", |conn| {
            conn.execute(
                "INSERT INTO artist (server_id, id, name, synced_at) VALUES (?1, ?2, 'Artist', 1) \
                     ON CONFLICT(server_id, id) DO NOTHING",
                params![server_id, format!("artist-{server_id}")],
            )?;
            Ok(())
        })
        .unwrap();
}

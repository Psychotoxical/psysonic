use super::*;
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::dto::{
    LibraryResolveEntitySourcesRequest, LibraryScopeAlbumDetailRequest,
    LibraryScopeArtistDetailRequest, LibraryScopeListRequest, LibraryScopePair,
    LibraryScopeSearchRequest, LibrarySourceEntityType,
};
use crate::identity::rebuild_cluster_keys;
use crate::repos::track::{TrackRepository, TrackRow};
use crate::store::LibraryStore;
use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;

#[test]
fn random_window_offset_stays_within_a_full_page_range() {
    assert_eq!(random_window_offset(0, 6), 0);
    assert_eq!(random_window_offset(6, 6), 0);
    assert!(random_window_offset(100, 6) <= 94);
}

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

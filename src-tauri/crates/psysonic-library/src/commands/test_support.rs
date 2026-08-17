use std::sync::Arc;

use crate::repos::TrackRow;
use crate::runtime::LibraryRuntime;
use crate::store::LibraryStore;

pub(crate) fn make_row(server: &str, id: &str, album_id: &str, track_no: i64) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: format!("Track {id}"),
        title_sort: None,
        artist: Some("A".into()),
        artist_id: Some("ar1".into()),
        album: "Album".into(),
        album_id: Some(album_id.into()),
        album_artist: Some("A".into()),
        duration_sec: 240,
        track_number: Some(track_no),
        disc_number: Some(1),
        year: None,
        genre: None,
        suffix: None,
        bit_rate: None,
        size_bytes: None,
        cover_art_id: None,
        starred_at: None,
        user_rating: None,
        play_count: None,
        played_at: None,
        server_path: Some(format!("/path/{id}.flac")),
        library_id: None,
        isrc: None,
        mbid_recording: None,
        bpm: None,
        replay_gain_track_db: None,
        replay_gain_album_db: None,
        replay_gain_peak: None,
        content_hash: Some(format!("hash-{id}")),
        server_updated_at: None,
        server_created_at: None,
        deleted: false,
        synced_at: 1,
        raw_json: "{}".into(),
    }
}

pub(crate) fn runtime(store: Arc<LibraryStore>) -> LibraryRuntime {
    LibraryRuntime::new(store)
}

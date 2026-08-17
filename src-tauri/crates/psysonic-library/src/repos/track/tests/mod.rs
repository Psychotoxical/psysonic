mod ingest;
mod ingest_sparse;
mod library_tagging;
mod reads;
mod remap;
mod resync;

use super::{TrackRepository, TrackRow};
use crate::store::LibraryStore;

fn row(server: &str, id: &str, title: &str) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: title.into(),
        title_sort: None,
        artist: Some("The Artist".into()),
        artist_id: Some("ar1".into()),
        album: "An Album".into(),
        album_id: Some("al1".into()),
        album_artist: Some("The Artist".into()),
        duration_sec: 240,
        track_number: Some(3),
        disc_number: Some(1),
        year: Some(2024),
        genre: Some("Ambient".into()),
        suffix: Some("flac".into()),
        bit_rate: Some(1000),
        size_bytes: Some(32_000_000),
        cover_art_id: Some("cv1".into()),
        starred_at: None,
        user_rating: None,
        play_count: Some(0),
        played_at: None,
        server_path: Some("Artist/Album/03.flac".into()),
        library_id: Some("lib-1".into()),
        isrc: None,
        mbid_recording: None,
        bpm: None,
        replay_gain_track_db: None,
        replay_gain_album_db: None,
        replay_gain_peak: None,
        content_hash: Some("hash-abc".into()),
        server_updated_at: Some(1_700_000_000),
        server_created_at: Some(1_699_000_000),
        deleted: false,
        synced_at: 1_700_000_500,
        raw_json: r#"{"id":"t1"}"#.into(),
    }
}

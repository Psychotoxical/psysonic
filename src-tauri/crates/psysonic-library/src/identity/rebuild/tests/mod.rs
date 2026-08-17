use super::*;
use crate::identity::keys::{build_album_key, build_track_cluster_keys};
use crate::identity::norm::{norm_part, NORM_VERSION};
use crate::repos::track::{TrackRepository, TrackRow};
use crate::store::LibraryStore;

mod album_identity;
mod incremental;
mod maintenance;
mod occurrence_ranks;
mod synchronization;

#[allow(clippy::too_many_arguments)]
fn track_row(
    server: &str,
    id: &str,
    title: &str,
    artist: Option<&str>,
    album: &str,
    album_artist: Option<&str>,
    duration: i64,
    library_id: &str,
) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: title.into(),
        title_sort: None,
        artist: artist.map(str::to_string),
        artist_id: None,
        album: album.into(),
        album_id: None,
        album_artist: album_artist.map(str::to_string),
        duration_sec: duration,
        track_number: None,
        disc_number: None,
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

#[allow(clippy::too_many_arguments)]
fn physical_album_track_row(
    server: &str,
    id: &str,
    title: &str,
    artist: &str,
    artist_id: &str,
    album: &str,
    album_id: &str,
    album_artist: &str,
    library_id: &str,
) -> TrackRow {
    let mut row = track_row(
        server,
        id,
        title,
        Some(artist),
        album,
        Some(album_artist),
        200,
        library_id,
    );
    row.artist_id = Some(artist_id.into());
    row.album_id = Some(album_id.into());
    row
}

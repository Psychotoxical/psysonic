use super::*;

fn track(builder: impl FnOnce(&mut TrackSyncInfo)) -> TrackSyncInfo {
    let mut track = TrackSyncInfo {
        id: "t1".into(),
        url: "http://example/stream".into(),
        suffix: "flac".into(),
        artist: "Artist".into(),
        album_artist: "AlbumArtist".into(),
        album: "Album".into(),
        title: "Title".into(),
        track_number: Some(1),
        duration: Some(180),
        playlist_name: None,
        playlist_index: None,
    };
    builder(&mut track);
    track
}

/// Normalize Windows backslashes so assertions can be written with `/`.
/// `build_track_path` only emits `\` as the OS path separator on Windows;
/// any `\` that appears inside a name component is already replaced with
/// `_` by `sanitize_path_component`.
fn norm(path: String) -> String {
    path.replace('\\', "/")
}

mod download;
mod manifest;
mod paths;
mod rename;

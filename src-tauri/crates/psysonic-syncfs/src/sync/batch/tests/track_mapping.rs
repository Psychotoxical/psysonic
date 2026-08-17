use super::*;

#[test]
fn estimate_track_size_prefers_explicit_size_field() {
    let track = serde_json::json!({ "size": 12_345_u64, "duration": 200_u64 });
    assert_eq!(estimate_track_size_bytes(&track), 12_345);
}

#[test]
fn estimate_track_size_falls_back_to_duration_at_320kbps() {
    // Duration in seconds → bytes at 320 kbps:
    //   bytes = duration * 320_000 / 8 = duration * 40_000
    let track = serde_json::json!({ "duration": 240_u64 });
    assert_eq!(estimate_track_size_bytes(&track), 240 * 40_000);
}

#[test]
fn estimate_track_size_returns_zero_when_neither_size_nor_duration_present() {
    let track = serde_json::json!({ "title": "no metadata at all" });
    assert_eq!(estimate_track_size_bytes(&track), 0);
}

#[test]
fn estimate_track_size_explicit_size_wins_even_when_duration_present() {
    // Explicit size of 1 byte must NOT be replaced by duration-derived 8 MB.
    let track = serde_json::json!({ "size": 1_u64, "duration": 200_u64 });
    assert_eq!(estimate_track_size_bytes(&track), 1);
}

#[test]
fn track_sync_info_from_json_uses_album_artist_when_present() {
    let track = serde_json::json!({
        "suffix": "flac",
        "artist": "Roger Waters",
        "albumArtist": "Pink Floyd",
        "album": "The Wall",
        "title": "Comfortably Numb",
        "track": 7,
        "duration": 380,
    });
    let info = track_sync_info_from_subsonic_json(&track, "abc", None, None);
    assert_eq!(info.id, "abc");
    assert_eq!(info.suffix, "flac");
    assert_eq!(info.artist, "Roger Waters");
    assert_eq!(info.album_artist, "Pink Floyd");
    assert_eq!(info.album, "The Wall");
    assert_eq!(info.title, "Comfortably Numb");
    assert_eq!(info.track_number, Some(7));
    assert_eq!(info.duration, Some(380));
    assert!(info.playlist_name.is_none() && info.playlist_index.is_none());
}

#[test]
fn track_sync_info_falls_back_to_artist_when_album_artist_missing() {
    let track = serde_json::json!({
        "artist": "Some Artist",
        "title": "Solo",
    });
    let info = track_sync_info_from_subsonic_json(&track, "x", None, None);
    assert_eq!(info.album_artist, "Some Artist");
}

#[test]
fn track_sync_info_treats_whitespace_only_album_artist_as_missing() {
    let track = serde_json::json!({
        "artist": "Real Artist",
        "albumArtist": "   ",
        "title": "T",
    });
    let info = track_sync_info_from_subsonic_json(&track, "x", None, None);
    assert_eq!(info.album_artist, "Real Artist");
}

#[test]
fn track_sync_info_uses_mp3_default_suffix_when_missing() {
    let track = serde_json::json!({ "artist": "A", "title": "T" });
    let info = track_sync_info_from_subsonic_json(&track, "x", None, None);
    assert_eq!(info.suffix, "mp3");
}

#[test]
fn track_sync_info_attaches_playlist_context_when_supplied() {
    let track = serde_json::json!({ "artist": "A", "title": "T" });
    let info = track_sync_info_from_subsonic_json(&track, "x", Some("My Mix"), Some(5));
    assert_eq!(info.playlist_name.as_deref(), Some("My Mix"));
    assert_eq!(info.playlist_index, Some(5));
}

#[test]
fn inject_playlist_context_adds_both_keys_when_supplied() {
    let mut track = serde_json::json!({ "id": "t1", "title": "Song" });
    inject_playlist_context(&mut track, Some("Mix"), Some(3));
    assert_eq!(track.get("_playlistName").unwrap(), "Mix");
    assert_eq!(track.get("_playlistIndex").unwrap().as_u64().unwrap(), 3);
    assert_eq!(track.get("id").unwrap(), "t1");
    assert_eq!(track.get("title").unwrap(), "Song");
}

#[test]
fn inject_playlist_context_is_noop_when_both_args_none() {
    let mut track = serde_json::json!({ "id": "t1" });
    inject_playlist_context(&mut track, None, None);
    assert!(track.get("_playlistName").is_none());
    assert!(track.get("_playlistIndex").is_none());
}

#[test]
fn inject_playlist_context_attaches_only_supplied_args() {
    let mut track = serde_json::json!({ "id": "t1" });
    inject_playlist_context(&mut track, Some("Mix"), None);
    assert_eq!(track.get("_playlistName").unwrap(), "Mix");
    assert!(track.get("_playlistIndex").is_none());
}

#[test]
fn inject_playlist_context_skips_non_object_values() {
    // Defensive: if the JSON is somehow a non-object, do not panic.
    let mut track = serde_json::json!("just a string");
    inject_playlist_context(&mut track, Some("Mix"), Some(3));
    assert_eq!(track, serde_json::json!("just a string"));
}

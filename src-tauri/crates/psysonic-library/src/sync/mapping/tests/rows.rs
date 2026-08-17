use super::super::*;
use serde_json::json;

#[test]
fn subsonic_song_maps_hot_columns_and_keeps_raw_json() {
    let raw = json!({
        "id": "tr_1", "title": "Hello", "artist": "World",
        "displayAlbumArtist": "World & Guests", "albumId": "al_1",
        "sortName": "Hello, The", "duration": 240, "track": 3, "year": 2024,
        "created": "2024-01-01T00:00:00Z", "updatedAt": "2024-06-01T00:00:00Z",
        "musicBrainzId": "mb-1",
        "replayGain": { "trackGain": -1.2, "albumGain": -0.8, "trackPeak": 0.91 }
    });
    let song: Song = serde_json::from_value(raw.clone()).unwrap();
    let row = subsonic_song_to_track_row("s1", &song, &raw, 1_000, Some("lib-fb"));
    assert_eq!(row.id, "tr_1");
    assert_eq!(row.album_id.as_deref(), Some("al_1"));
    assert_eq!(row.album_artist.as_deref(), Some("World & Guests"));
    assert_eq!(row.title_sort.as_deref(), Some("Hello, The"));
    assert_eq!(row.duration_sec, 240);
    assert_eq!(row.mbid_recording.as_deref(), Some("mb-1"));
    assert_eq!(row.replay_gain_track_db, Some(-1.2));
    assert_eq!(row.replay_gain_album_db, Some(-0.8));
    assert_eq!(row.replay_gain_peak, Some(0.91));
    assert!(row.server_created_at.unwrap_or(0) > 0);
    assert!(row.server_updated_at.unwrap_or(0) > 0);
    assert_eq!(row.library_id.as_deref(), Some("lib-fb"));
    assert!(row.raw_json.contains("replayGain"));
}

#[test]
fn sparse_typed_fallback_does_not_invent_explicit_nulls() {
    let song: Song = serde_json::from_value(json!({ "id": "tr_1", "title": "Hello" })).unwrap();
    let raw = sparse_song_raw_fallback(&song);
    assert_eq!(raw.get("id"), Some(&json!("tr_1")));
    assert!(raw.get("albumArtist").is_none());
    assert!(raw.get("updatedAt").is_none());
}

#[test]
fn navidrome_song_maps_native_field_shape() {
    let raw = json!({
        "id": "tr_1", "title": "Hello", "sortTitle": "Hello, The",
        "artist": "World", "artistId": "ar_1", "album": "An Album",
        "albumId": "al_1", "albumArtist": "World", "duration": 240,
        "trackNumber": 3, "discNumber": 1, "year": 2024, "genre": "Ambient",
        "suffix": "flac", "bitRate": 1000, "size": 32_000_000_i64,
        "path": "World/An Album/03.flac", "libraryId": "1",
        "isrc": "USRC17607839", "mbzTrackId": "mb-1", "bpm": 128,
        "rgTrackGain": -1.2, "rgAlbumGain": -0.8,
        "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-06-01T00:00:00Z"
    });
    let row = navidrome_song_to_track_row("s1", &raw, 9_999, None).unwrap();
    assert_eq!(row.id, "tr_1");
    assert_eq!(row.title_sort.as_deref(), Some("Hello, The"));
    assert_eq!(row.track_number, Some(3));
    assert_eq!(row.isrc.as_deref(), Some("USRC17607839"));
    assert_eq!(row.mbid_recording.as_deref(), Some("mb-1"));
    assert_eq!(row.replay_gain_track_db, Some(-1.2));
    assert_eq!(row.library_id.as_deref(), Some("1"));
    assert!(row.server_created_at.unwrap_or(0) > 0);
    assert!(row.server_updated_at.unwrap_or(0) > 0);
}

#[test]
fn navidrome_song_maps_numeric_library_id() {
    let raw = json!({ "id": "tr_1", "title": "Hello", "libraryId": 3 });
    let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();
    assert_eq!(row.library_id.as_deref(), Some("3"));
}

#[test]
fn navidrome_song_rounds_decimal_duration_seconds() {
    let raw = json!({ "id": "tr_1", "title": "Hello", "duration": 229.85 });
    let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();
    assert_eq!(row.duration_sec, 230);
}

#[test]
fn navidrome_song_skips_rows_without_id() {
    let row = navidrome_song_to_track_row("s1", &json!({"title": "no id"}), 1, None);
    assert!(row.is_none());
}

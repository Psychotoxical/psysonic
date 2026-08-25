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
fn navidrome_song_normalizes_current_participants_into_structured_artist_refs() {
    let raw = json!({
        "id": "tr_1",
        "title": "Adore You (Extended Mix)",
        "artist": "FOVOS, Someone Else",
        "artistId": "fovos",
        "albumArtist": "FOVOS",
        "displayArtist": "FOVOS, Max Cardona",
        "displayAlbumArtist": "FOVOS, Max Cardona",
        "artists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ],
        "albumArtists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ],
        "participants": {
            "artist": [
                { "id": "fovos", "name": "FOVOS" },
                { "id": "someone-else", "name": "Someone Else" }
            ],
            "albumartist": [
                { "id": "fovos", "name": "FOVOS" }
            ]
        }
    });

    let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();
    let normalized: serde_json::Value = serde_json::from_str(&row.raw_json).unwrap();

    assert_eq!(
        normalized["artists"],
        json!([
            { "id": "fovos", "name": "FOVOS" },
            { "id": "someone-else", "name": "Someone Else" }
        ])
    );
    assert_eq!(
        normalized["albumArtists"],
        json!([{ "id": "fovos", "name": "FOVOS" }])
    );
    assert_eq!(normalized["displayArtist"], json!("FOVOS, Someone Else"));
    assert_eq!(normalized["displayAlbumArtist"], json!("FOVOS"));
}

#[test]
fn navidrome_song_present_participants_clears_missing_roles() {
    let raw = json!({
        "id": "tr_1",
        "title": "Current credits",
        "artist": "FOVOS",
        "albumArtist": "FOVOS",
        "artists": [
            { "id": "old-track", "name": "Old Track Artist" }
        ],
        "albumArtists": [
            { "id": "old-album", "name": "Old Album Artist" }
        ],
        "participants": {
            "artist": [
                { "id": "fovos", "name": "FOVOS" }
            ]
        }
    });

    let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();
    let normalized: serde_json::Value = serde_json::from_str(&row.raw_json).unwrap();

    assert_eq!(
        normalized["artists"],
        json!([{ "id": "fovos", "name": "FOVOS" }])
    );
    assert_eq!(normalized["albumArtists"], json!([]));
}

#[test]
fn navidrome_song_absent_or_null_participants_keeps_compatibility_arrays() {
    let stale_artists = json!([
        { "id": "fovos", "name": "FOVOS" },
        { "id": "max-cardona", "name": "Max Cardona" }
    ]);
    let stale_album_artists = json!([
        { "id": "fovos", "name": "FOVOS" }
    ]);

    let without_participants = json!({
        "id": "tr_absent",
        "title": "Compatibility",
        "artist": "FOVOS, Max Cardona",
        "albumArtist": "FOVOS",
        "artists": stale_artists.clone(),
        "albumArtists": stale_album_artists.clone()
    });
    let null_participants = json!({
        "id": "tr_null",
        "title": "Compatibility",
        "artist": "FOVOS, Max Cardona",
        "albumArtist": "FOVOS",
        "artists": stale_artists.clone(),
        "albumArtists": stale_album_artists.clone(),
        "participants": null
    });

    for raw in [without_participants, null_participants] {
        let row = navidrome_song_to_track_row("s1", &raw, 1, None).unwrap();
        let normalized: serde_json::Value = serde_json::from_str(&row.raw_json).unwrap();
        assert_eq!(normalized["artists"], stale_artists);
        assert_eq!(normalized["albumArtists"], stale_album_artists);
        assert_eq!(normalized["displayArtist"], json!("FOVOS, Max Cardona"));
        assert_eq!(normalized["displayAlbumArtist"], json!("FOVOS"));
    }
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

#[test]
fn navidrome_song_reads_the_play_date_under_its_own_name() {
    // Navidrome calls it `playDate`. Reading `playedAt` — a name it never sends —
    // wrote NULL on every native ingest, and the server's play dates never
    // arrived. Measured on a real library: 1043 rows carry `playDate`, none
    // carry `playedAt`.
    let raw = json!({
        "id": "tr_1", "title": "Hello", "album": "An Album", "duration": 240,
        "playDate": "2026-08-25T20:55:58Z", "playCount": 4,
        "starredAt": "2026-08-25T18:00:00Z", "rating": 5
    });
    let row = navidrome_song_to_track_row("s1", &raw, 9_999, None).unwrap();

    assert!(row.played_at.is_some(), "the play date has to survive the mapper");
    assert_eq!(row.play_count, Some(4));
    assert!(row.starred_at.is_some());
    assert_eq!(row.user_rating, Some(5));
}

#[test]
fn navidrome_song_also_accepts_the_subsonic_spelling_of_the_play_date() {
    // One mapper, either shape — the same row can arrive from the native API or
    // from a Subsonic-flavoured payload, and neither should lose the date.
    let raw = json!({
        "id": "tr_1", "title": "Hello", "album": "An Album", "duration": 240,
        "played": "2026-08-25T20:55:58Z"
    });
    let row = navidrome_song_to_track_row("s1", &raw, 9_999, None).unwrap();

    assert!(row.played_at.is_some());
}

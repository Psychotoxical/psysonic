use super::test_support::test_client;
use serde_json::json;
use wiremock::matchers::{method as wm_method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── PR-2b: raw_json capture for ingest (PR-3 prep) ────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn get_song_with_raw_returns_typed_and_raw_subtree() {
    let server = MockServer::start().await;
    let song = json!({
        "id": "tr_1",
        "title": "Title",
        "artist": "Artist",
        "musicBrainzId": "abc-123",
        "replayGain": { "trackGain": -1.2, "albumGain": -0.8 },
        "contributors": [
            { "role": "producer", "artistId": "ar_9", "name": "Prod" }
        ]
    });
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "song": song.clone() }
        })))
        .mount(&server)
        .await;

    let (typed, raw) = test_client(&server.uri())
        .get_song_with_raw("tr_1")
        .await
        .unwrap();
    assert_eq!(typed.id, "tr_1");
    assert_eq!(typed.title, "Title");
    // Typed struct picks up the new musicBrainzId alias.
    assert_eq!(typed.mbid_recording.as_deref(), Some("abc-123"));

    // Raw value preserves OpenSubsonic extensions the typed struct
    // doesn't mirror — exactly what `track.raw_json` needs.
    assert_eq!(raw.get("replayGain"), song.get("replayGain"));
    assert_eq!(raw.get("contributors"), song.get("contributors"));
}

#[tokio::test(flavor = "multi_thread")]
async fn search3_with_raw_keeps_song_extensions_in_raw_tree() {
    let server = MockServer::start().await;
    let result_body = json!({
        "song": [
            { "id": "tr_1", "title": "One",  "replayGain": { "trackGain": -1.5 } },
            { "id": "tr_2", "title": "Two", "contributors": [{ "role": "producer" }] }
        ]
    });
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": result_body.clone() }
        })))
        .mount(&server)
        .await;

    let (typed, raw) = test_client(&server.uri())
        .search3_with_raw("", 100, 0, None)
        .await
        .unwrap();
    assert_eq!(typed.song.len(), 2);

    // Raw value preserves the typed-struct-incompatible fields.
    let raw_songs = raw
        .get("song")
        .and_then(|v| v.as_array())
        .expect("song array");
    assert_eq!(raw_songs.len(), 2);
    assert_eq!(
        raw_songs[0].get("replayGain"),
        result_body.get("song").unwrap().as_array().unwrap()[0].get("replayGain")
    );
    assert_eq!(
        raw_songs[1].get("contributors"),
        result_body.get("song").unwrap().as_array().unwrap()[1].get("contributors")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn search3_with_raw_empty_envelope_maps_to_empty_search_result() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .mount(&server)
        .await;
    let (typed, raw) = test_client(&server.uri())
        .search3_with_raw("", 50, 0, None)
        .await
        .unwrap();
    assert!(typed.song.is_empty());
    assert!(typed.album.is_empty());
    // Empty `searchResult3: {}` survives as an empty Object in raw,
    // not Null — runner relies on this for the `get("song")` path.
    assert!(raw.is_object());
}

#[tokio::test(flavor = "multi_thread")]
async fn get_album_with_raw_keeps_song_extensions_in_raw_tree() {
    let server = MockServer::start().await;
    let album = json!({
        "id": "al_1",
        "name": "Album",
        "song": [
            { "id": "tr_1", "title": "One", "track": 1, "musicBrainzId": "mb-1" },
            { "id": "tr_2", "title": "Two", "track": 2, "replayGain": { "trackGain": -3.0 } }
        ]
    });
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "album": album.clone() }
        })))
        .mount(&server)
        .await;

    let (typed, raw) = test_client(&server.uri())
        .get_album_with_raw("al_1")
        .await
        .unwrap();
    assert_eq!(typed.song.len(), 2);
    assert_eq!(typed.song[0].mbid_recording.as_deref(), Some("mb-1"));

    // Per-track raw entries survive in `raw.song[i]`.
    let raw_songs = raw
        .get("song")
        .and_then(|v| v.as_array())
        .expect("song array");
    assert_eq!(raw_songs.len(), 2);
    assert_eq!(
        raw_songs[1].get("replayGain"),
        album.get("song").unwrap().as_array().unwrap()[1].get("replayGain")
    );
}

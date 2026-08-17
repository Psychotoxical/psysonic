use super::*;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn parse_returns_err_when_subsonic_response_missing() {
    let json = serde_json::json!({});
    let err = parse_subsonic_songs(&json, "getAlbum.view").unwrap_err();
    assert!(err.contains("No subsonic-response"));
}

#[test]
fn parse_returns_empty_for_unknown_endpoint() {
    let json = serde_json::json!({
        "subsonic-response": { "status": "ok" }
    });
    let songs = parse_subsonic_songs(&json, "getOther.view").unwrap();
    assert!(songs.is_empty());
}

#[test]
fn parse_album_extracts_song_array() {
    let json = serde_json::json!({
        "subsonic-response": {
            "album": {
                "song": [
                    { "id": "1", "title": "First" },
                    { "id": "2", "title": "Second" }
                ]
            }
        }
    });
    let songs = parse_subsonic_songs(&json, "getAlbum.view").unwrap();
    assert_eq!(songs.len(), 2);
    assert_eq!(songs[0].get("id").unwrap(), "1");
}

#[test]
fn parse_album_normalises_single_song_object_to_vec() {
    // Some Subsonic servers return a single song as an object instead of a 1-element array.
    let json = serde_json::json!({
        "subsonic-response": {
            "album": { "song": { "id": "only", "title": "Solo" } }
        }
    });
    let songs = parse_subsonic_songs(&json, "getAlbum.view").unwrap();
    assert_eq!(songs.len(), 1);
    assert_eq!(songs[0].get("id").unwrap(), "only");
}

#[test]
fn parse_playlist_extracts_entry_array() {
    let json = serde_json::json!({
        "subsonic-response": {
            "playlist": {
                "entry": [{ "id": "p1" }, { "id": "p2" }, { "id": "p3" }]
            }
        }
    });
    let songs = parse_subsonic_songs(&json, "getPlaylist.view").unwrap();
    assert_eq!(songs.len(), 3);
}

#[test]
fn parse_returns_empty_when_album_has_no_songs() {
    let json = serde_json::json!({
        "subsonic-response": {
            "album": { "id": "empty-album" }
        }
    });
    let songs = parse_subsonic_songs(&json, "getAlbum.view").unwrap();
    assert!(songs.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_subsonic_songs_roundtrips_album_via_wiremock() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/getAlbum.view"))
        .and(query_param("u", "user"))
        .and(query_param("id", "album-42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "subsonic-response": {
                "album": {
                    "song": [
                        { "id": "t1", "title": "Track 1" },
                        { "id": "t2", "title": "Track 2" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let client =
        crate::file_transfer::subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let auth = fake_auth(server.uri());
    let songs = fetch_subsonic_songs(&client, None, &auth, "getAlbum.view", "album-42")
        .await
        .unwrap();
    assert_eq!(songs.len(), 2);
    assert_eq!(songs[0].get("id").unwrap(), "t1");
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_subsonic_songs_returns_empty_on_404() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/getAlbum.view"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let client =
        crate::file_transfer::subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let auth = fake_auth(server.uri());
    let result = fetch_subsonic_songs(&client, None, &auth, "getAlbum.view", "missing").await;
    // 404 with HTML/empty body fails JSON parsing and propagates an error string.
    assert!(result.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_subsonic_songs_handles_single_song_object_shape() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/getPlaylist.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "subsonic-response": {
                "playlist": {
                    "entry": { "id": "only", "title": "Lonely" }
                }
            }
        })))
        .mount(&server)
        .await;

    let client =
        crate::file_transfer::subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let auth = fake_auth(server.uri());
    let songs = fetch_subsonic_songs(&client, None, &auth, "getPlaylist.view", "p1")
        .await
        .unwrap();
    assert_eq!(
        songs.len(),
        1,
        "single-object response normalised to 1-element vec"
    );
    assert_eq!(songs[0].get("id").unwrap(), "only");
}

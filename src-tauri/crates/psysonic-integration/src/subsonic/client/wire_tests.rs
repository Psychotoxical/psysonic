use super::test_support::{test_client, test_credentials};
use super::*;
use serde_json::json;
use wiremock::matchers::{method as wm_method, path as wm_path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── SubsonicClient wiremock end-to-end ────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn ping_sends_auth_params_and_returns_ok() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .and(query_param("u", "user"))
        .and(query_param("t", "deadbeef"))
        .and(query_param("s", "saltsalt"))
        .and(query_param("v", SUBSONIC_API_VERSION))
        .and(query_param("c", SUBSONIC_CLIENT_ID))
        .and(query_param("f", "json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "version": "1.16.1" }
        })))
        .mount(&server)
        .await;

    test_client(&server.uri())
        .ping()
        .await
        .expect("ping must succeed");
}

#[tokio::test(flavor = "multi_thread")]
async fn ping_sends_custom_gate_header_via_http_context() {
    // Backs the connect-probe fix (#1216): a per-server gate header
    // (Cloudflare Access / Pangolin) must ride on the ping itself. The mock
    // only answers when the header is present, so a passing ping proves the
    // header was sent on the native request (no WebView CORS preflight).
    use psysonic_core::server_http::{CustomHeadersApplyTo, EndpointKind};
    use wiremock::matchers::header;

    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .and(header("CF-Access-Client-Secret", "gate-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "version": "1.16.1" }
        })))
        .mount(&server)
        .await;

    let ctx = ServerHttpContext {
        endpoints: vec![(server.uri(), EndpointKind::Public)],
        headers: vec![("CF-Access-Client-Secret".into(), "gate-secret".into())],
        apply_to: CustomHeadersApplyTo::Public,
        supports_raw_stream: false,
    };
    test_client(&server.uri())
        .with_http_context(ctx)
        .ping()
        .await
        .expect("ping must carry the gate header to the mounted matcher");
}

#[tokio::test(flavor = "multi_thread")]
async fn ping_without_context_misses_gate_matcher() {
    // Same gated mock, but no header context: the request must NOT match, so
    // the probe fails — confirming the header (not something else) is what
    // unlocks the gated endpoint.
    use wiremock::matchers::header;

    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .and(header("CF-Access-Client-Secret", "gate-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok" }
        })))
        .mount(&server)
        .await;

    let err = test_client(&server.uri()).ping().await.unwrap_err();
    assert!(
        matches!(err, SubsonicError::HttpStatus(_)),
        "gated endpoint without the header should not match the mock (got {err:?})"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn send_raw_get_forwards_query_and_gate_header_and_returns_body() {
    // WebView-transport bridge: the frontend passes the full query (auth +
    // endpoint args) and the gate header rides via the http context. The
    // mock only answers when both the caller's `type` param and the gate
    // header are present, and the untouched JSON body is returned verbatim.
    use psysonic_core::server_http::{CustomHeadersApplyTo, EndpointKind};
    use wiremock::matchers::header;

    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("type", "newest"))
        .and(query_param("u", "user"))
        .and(header("CF-Access-Client-Secret", "gate-secret"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;

    let ctx = ServerHttpContext {
        endpoints: vec![(server.uri(), EndpointKind::Public)],
        headers: vec![("CF-Access-Client-Secret".into(), "gate-secret".into())],
        apply_to: CustomHeadersApplyTo::Public,
        supports_raw_stream: false,
    };
    let params = vec![
        ("u".to_string(), "user".to_string()),
        ("type".to_string(), "newest".to_string()),
    ];
    let body = test_client(&server.uri())
        .with_http_context(ctx)
        .send_raw("getAlbumList2.view", &params, false)
        .await
        .expect("gated raw GET must reach the mounted matcher");
    assert!(
        body.contains("albumList2"),
        "raw body returned verbatim: {body}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn send_raw_post_form_sends_params_in_body() {
    // OpenSubsonic `formPost` path for large multi-`id` calls: params ride in
    // the urlencoded body, not the query string.
    use wiremock::matchers::body_string_contains;

    let server = MockServer::start().await;
    Mock::given(wm_method("POST"))
        .and(wm_path("/rest/savePlayQueue.view"))
        .and(body_string_contains("id=track-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok" }
        })))
        .mount(&server)
        .await;

    let params = vec![
        ("u".to_string(), "user".to_string()),
        ("id".to_string(), "track-1".to_string()),
    ];
    let body = test_client(&server.uri())
        .send_raw("savePlayQueue.view", &params, true)
        .await
        .expect("form-post raw request must match the body matcher");
    assert!(body.contains("\"status\": \"ok\"") || body.contains("\"status\":\"ok\""));
}

#[tokio::test(flavor = "multi_thread")]
async fn ping_surfaces_wrong_credentials_as_code_40() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 40, "message": "Wrong username or password" }
            }
        })))
        .mount(&server)
        .await;

    let err = test_client(&server.uri()).ping().await.unwrap_err();
    assert!(matches!(err, SubsonicError::Api { code: 40, .. }));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_song_returns_typed_song() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .and(query_param("id", "tr_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "song": {
                    "id": "tr_1",
                    "title": "Aurora",
                    "artist": "Anna",
                    "albumId": "al_1",
                    "duration": 240,
                    "track": 3
                }
            }
        })))
        .mount(&server)
        .await;

    let song = test_client(&server.uri()).get_song("tr_1").await.unwrap();
    assert_eq!(song.title, "Aurora");
    assert_eq!(song.album_id.as_deref(), Some("al_1"));
    assert_eq!(song.track_number, Some(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_song_maps_error_70_to_not_found() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Song not found" }
            }
        })))
        .mount(&server)
        .await;

    let err = test_client(&server.uri())
        .get_song("missing")
        .await
        .unwrap_err();
    assert!(matches!(err, SubsonicError::NotFound));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_scan_status_parses_typed_struct() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": {
                    "scanning": true,
                    "count": 9001,
                    "folderCount": 12
                }
            }
        })))
        .mount(&server)
        .await;

    let s = test_client(&server.uri()).get_scan_status().await.unwrap();
    assert!(s.scanning);
    assert_eq!(s.count, Some(9001));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_indexes_forwards_optional_if_modified_since() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getIndexes.view"))
        .and(query_param("ifModifiedSince", "1716840000000"))
        .and(query_param("musicFolderId", "lib-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "indexes": {
                    "lastModified": 1716840000000_i64,
                    "ignoredArticles": "The",
                    "index": []
                }
            }
        })))
        .mount(&server)
        .await;

    let ix = test_client(&server.uri())
        .get_indexes(Some("lib-1"), Some(1_716_840_000_000))
        .await
        .unwrap();
    assert_eq!(ix.last_modified_ms, Some(1_716_840_000_000));
    assert!(ix.index.is_empty(), "empty body when nothing changed");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_artists_omits_music_folder_when_none() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": 1716840000000_i64,
                    "ignoredArticles": "",
                    "index": [
                        { "name": "A", "artist": [
                            { "id": "ar_1", "name": "Anna" }
                        ]}
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let ix = test_client(&server.uri()).get_artists(None).await.unwrap();
    assert_eq!(ix.index.len(), 1);
    assert_eq!(ix.index[0].artist[0].name, "Anna");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_album_list2_unwraps_album_array() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("type", "alphabeticalByName"))
        .and(query_param("size", "500"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": {
                    "album": [
                        { "id": "al_1", "name": "First" },
                        { "id": "al_2", "name": "Second" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let albums = test_client(&server.uri())
        .get_album_list2("alphabeticalByName", 500, 0, None)
        .await
        .unwrap();
    assert_eq!(albums.len(), 2);
    assert_eq!(albums[1].id, "al_2");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_music_folders_handles_array_and_numeric_ids() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": {
                    "musicFolder": [
                        { "id": 1, "name": "Music Library" },
                        { "id": "2", "name": "Podcasts" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let folders = test_client(&server.uri())
        .get_music_folders()
        .await
        .unwrap();
    assert_eq!(folders.len(), 2);
    assert_eq!(folders[0].id, "1");
    assert_eq!(folders[0].name, "Music Library");
    assert_eq!(folders[1].id, "2");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_music_folders_handles_single_object() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": {
                    "musicFolder": { "id": 3, "name": "Only" }
                }
            }
        })))
        .mount(&server)
        .await;

    let folders = test_client(&server.uri())
        .get_music_folders()
        .await
        .unwrap();
    assert_eq!(folders.len(), 1);
    assert_eq!(folders[0].id, "3");
    assert_eq!(folders[0].name, "Only");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_album_includes_song_list() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", "al_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": {
                    "id": "al_1",
                    "name": "Test Album",
                    "songCount": 2,
                    "song": [
                        { "id": "tr_1", "title": "One",  "track": 1 },
                        { "id": "tr_2", "title": "Two",  "track": 2 }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let album = test_client(&server.uri()).get_album("al_1").await.unwrap();
    assert_eq!(album.song.len(), 2);
    assert_eq!(album.song[0].title, "One");
}

#[tokio::test(flavor = "multi_thread")]
async fn search3_handles_empty_query_navidrome_quirk() {
    // Spec §2.4: Navidrome accepts empty query → returns all songs paged.
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("query", ""))
        .and(query_param("songCount", "100"))
        .and(query_param("songOffset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "searchResult3": {
                    "song": [
                        { "id": "tr_1", "title": "One" },
                        { "id": "tr_2", "title": "Two" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let sr = test_client(&server.uri())
        .search3("", 100, 0, None)
        .await
        .unwrap();
    assert_eq!(sr.song.len(), 2);
    assert!(sr.artist.is_empty());
    assert!(sr.album.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn base_url_trailing_slash_does_not_double_up() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok" }
        })))
        .mount(&server)
        .await;

    // Append a trailing slash + additional slashes — the constructor
    // strips them so the request path stays `/rest/ping.view`, not
    // `//rest/ping.view`.
    let url = format!("{}///", server.uri());
    SubsonicClient::with_static_credentials(url, test_credentials(), reqwest::Client::new())
        .ping()
        .await
        .expect("ping with trailing slashes must reach the same endpoint");
}

#[tokio::test(flavor = "multi_thread")]
async fn http_500_returns_http_status_error_without_decode() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let err = test_client(&server.uri()).ping().await.unwrap_err();
    match err {
        SubsonicError::HttpStatus(s) => assert_eq!(s.as_u16(), 500),
        other => panic!("expected HttpStatus, got {other:?}"),
    }
}

use super::test_support::test_client;
use super::*;
use serde_json::json;
use wiremock::matchers::{method as wm_method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── server_info / parse_server_info ────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn server_info_extracts_navidrome_envelope_metadata() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "version": "1.16.1",
                "type": "navidrome",
                "serverVersion": "0.55.2",
                "openSubsonic": true
            }
        })))
        .mount(&server)
        .await;

    let info = test_client(&server.uri()).server_info().await.unwrap();
    assert_eq!(info.server_type.as_deref(), Some("navidrome"));
    assert_eq!(info.server_version.as_deref(), Some("0.55.2"));
    assert_eq!(info.api_version.as_deref(), Some("1.16.1"));
    assert!(info.open_subsonic);
}

#[tokio::test(flavor = "multi_thread")]
async fn server_info_falls_back_to_defaults_for_minimal_envelope() {
    // Older Subsonic servers may omit type / serverVersion / openSubsonic.
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "version": "1.16.1" }
        })))
        .mount(&server)
        .await;

    let info = test_client(&server.uri()).server_info().await.unwrap();
    assert!(info.server_type.is_none());
    assert!(info.server_version.is_none());
    assert!(!info.open_subsonic);
    assert_eq!(info.api_version.as_deref(), Some("1.16.1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn server_info_surfaces_wrong_credentials_as_code_40() {
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

    let err = test_client(&server.uri()).server_info().await.unwrap_err();
    assert!(matches!(err, SubsonicError::Api { code: 40, .. }));
}

#[tokio::test(flavor = "multi_thread")]
async fn get_song_with_raw_maps_error_70_to_not_found_like_get_song() {
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
        .get_song_with_raw("missing")
        .await
        .unwrap_err();
    assert!(matches!(err, SubsonicError::NotFound));
}

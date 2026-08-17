use super::*;
use wiremock::matchers::{method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── audioscrobbler_request ────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn audioscrobbler_request_uses_custom_base_url() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(wm_path("/2.0/"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            r#"{"similarartists":{"artist":[{"name":"Boards of Canada"}]}}"#,
            "application/json",
        ))
        .mount(&server)
        .await;

    let base = format!("{}/2.0/", server.uri());
    let json = audioscrobbler_request(
        base,
        vec![
            ["method".into(), "artist.getSimilar".into()],
            ["artist".into(), "Aphex Twin".into()],
        ],
        false,
        true,
        "key".into(),
        "secret".into(),
    )
    .await
    .expect("request should succeed");

    assert_eq!(
        json["similarartists"]["artist"][0]["name"].as_str(),
        Some("Boards of Canada")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn audioscrobbler_request_surfaces_api_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(wm_path("/2.0/"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            r#"{"error":9,"message":"Invalid session key"}"#,
            "application/json",
        ))
        .mount(&server)
        .await;

    let base = format!("{}/2.0/", server.uri());
    let err = audioscrobbler_request(
        base,
        vec![["method".into(), "track.scrobble".into()]],
        true,
        false,
        "key".into(),
        "secret".into(),
    )
    .await
    .expect_err("api error should map to Err");

    assert!(err.contains("Audioscrobbler 9"), "unexpected error: {err}");
}

use super::*;
use wiremock::matchers::{method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── parse_pls_stream_url ──────────────────────────────────────────────────

#[test]
fn parse_pls_returns_first_file_entry() {
    let pls = "[playlist]\nNumberOfEntries=2\nFile1=https://stream.example/audio\nTitle1=Foo\n";
    assert_eq!(
        parse_pls_stream_url(pls),
        Some("https://stream.example/audio".to_string())
    );
}

#[test]
fn parse_pls_is_case_insensitive_on_key() {
    let pls = "[playlist]\nfile1=http://stream.example/x\n";
    assert_eq!(
        parse_pls_stream_url(pls),
        Some("http://stream.example/x".to_string())
    );
}

#[test]
fn parse_pls_returns_none_for_non_http_url() {
    let pls = "File1=ftp://example/audio\n";
    assert!(parse_pls_stream_url(pls).is_none());
}

#[test]
fn parse_pls_returns_none_when_no_file_entry() {
    let pls = "[playlist]\nNumberOfEntries=0\n";
    assert!(parse_pls_stream_url(pls).is_none());
}

#[test]
fn parse_pls_skips_leading_whitespace_on_lines() {
    let pls = "  File1=https://stream/audio\n";
    assert_eq!(
        parse_pls_stream_url(pls),
        Some("https://stream/audio".to_string())
    );
}

// ── parse_m3u_stream_url ──────────────────────────────────────────────────

#[test]
fn parse_m3u_skips_extm3u_header_and_extinf_comments() {
    let m3u = "#EXTM3U\n#EXTINF:-1,Stream\nhttps://stream.example/audio\n";
    assert_eq!(
        parse_m3u_stream_url(m3u),
        Some("https://stream.example/audio".to_string())
    );
}

#[test]
fn parse_m3u_returns_first_url_in_order() {
    let m3u = "#EXTM3U\nhttps://first.example/a\nhttps://second.example/b\n";
    assert_eq!(
        parse_m3u_stream_url(m3u),
        Some("https://first.example/a".to_string())
    );
}

#[test]
fn parse_m3u_returns_none_when_no_url() {
    let m3u = "#EXTM3U\n#EXTINF:-1,Just a comment\n";
    assert!(parse_m3u_stream_url(m3u).is_none());
}

#[test]
fn parse_m3u_returns_none_for_relative_paths() {
    let m3u = "track.mp3\n";
    assert!(parse_m3u_stream_url(m3u).is_none());
}

// ── resolve_playlist_url ──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn resolve_returns_none_for_non_playlist_url() {
    let client = reqwest::Client::new();
    // Direct stream URLs (without .pls/.m3u/.m3u8 extension) are returned as None.
    assert!(
        resolve_playlist_url(&client, "https://stream.example/audio")
            .await
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resolve_returns_none_for_non_playlist_url_with_query() {
    let client = reqwest::Client::new();
    assert!(
        resolve_playlist_url(&client, "https://stream.example/audio?foo=bar")
            .await
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resolve_extracts_first_stream_from_pls() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(wm_path("/station.pls"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("[playlist]\nFile1=https://stream.example/x\n"),
        )
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let url = format!("{}/station.pls", server.uri());
    assert_eq!(
        resolve_playlist_url(&client, &url).await,
        Some("https://stream.example/x".to_string())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resolve_extracts_first_stream_from_m3u8() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(wm_path("/station.m3u8"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string("#EXTM3U\n#EXTINF:-1,Stream\nhttps://stream.example/y\n"),
        )
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let url = format!("{}/station.m3u8", server.uri());
    assert_eq!(
        resolve_playlist_url(&client, &url).await,
        Some("https://stream.example/y".to_string())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resolve_dispatches_pls_when_content_type_says_so_even_with_other_extension() {
    // Some servers return .m3u extension but with audio/x-scpls Content-Type;
    // resolve_playlist_url honors the Content-Type for the parser choice.
    // set_body_raw lets us pin the Content-Type header — set_body_string
    // would force text/plain regardless of insert_header order.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(wm_path("/weird.m3u"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(
            "[playlist]\nFile1=https://pls.example/audio\n",
            "audio/x-scpls",
        ))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let url = format!("{}/weird.m3u", server.uri());
    assert_eq!(
        resolve_playlist_url(&client, &url).await,
        Some("https://pls.example/audio".to_string())
    );
}

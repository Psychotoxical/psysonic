use super::*;
use crate::file_transfer::subsonic_http_client;
use wiremock::matchers::{method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test(flavor = "multi_thread")]
async fn sync_download_writes_track_file_for_200_response() {
    let server = MockServer::start().await;
    let body = b"flac body".to_vec();
    Mock::given(method("GET"))
        .and(wm_path("/track"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("Album").join("01 - track.flac");
    let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let url = format!("{}/track", server.uri());
    let downloaded = sync_download_one_track(&dest, "flac", &url, &client, None, None)
        .await
        .unwrap();
    assert!(downloaded, "fresh download must report Ok(true)");
    assert_eq!(std::fs::read(&dest).unwrap(), body);
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_download_returns_false_when_file_already_exists() {
    let server = MockServer::start().await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("track.mp3");
    std::fs::write(&dest, b"already there").unwrap();

    let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let url = format!("{}/should-not-be-hit", server.uri());
    let downloaded = sync_download_one_track(&dest, "mp3", &url, &client, None, None)
        .await
        .unwrap();
    assert!(!downloaded, "pre-existing file must be reported as skipped");
    assert_eq!(std::fs::read(&dest).unwrap(), b"already there");
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_download_returns_err_for_non_success_status() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(wm_path("/missing"))
        .respond_with(ResponseTemplate::new(403))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("track.opus");
    let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let url = format!("{}/missing", server.uri());
    let err = sync_download_one_track(&dest, "opus", &url, &client, None, None)
        .await
        .unwrap_err();
    assert!(err.contains("HTTP 403"));
    assert!(!dest.exists(), "no track file must be created on error");
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_download_creates_missing_parent_directories() {
    let server = MockServer::start().await;
    let body = b"x".to_vec();
    Mock::given(method("GET"))
        .and(wm_path("/t"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("a").join("b").join("c").join("track.mp3");
    assert!(!dest.parent().unwrap().exists());
    let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
    let url = format!("{}/t", server.uri());
    sync_download_one_track(&dest, "mp3", &url, &client, None, None)
        .await
        .unwrap();
    assert!(dest.exists());
}

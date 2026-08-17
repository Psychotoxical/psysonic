use std::sync::Arc;

use crate::analysis_cache;

use super::super::super::enqueue::resolve_backfill_server_id;
use super::super::super::http_backfill::*;
use super::support::*;

#[tokio::test]
async fn non_navidrome_backfill_uses_standard_original_download() {
    use tauri::Manager;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let original = vec![0x33; 12 * 1024];
    Mock::given(method("GET"))
        .and(path("/rest/download.view"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), false)));
    app.handle()
        .manage(analysis_cache::AnalysisCache::open_in_memory());
    let stream_url = format!(
        "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
        server.uri()
    );

    let download = analysis_backfill_download(
        app.handle(),
        "canonical-server",
        "t1",
        &stream_url,
        ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
    )
    .await
    .unwrap();

    assert_eq!(download.bytes, original);
    let trusted = download.trusted_revision.unwrap();
    assert_eq!(
        trusted.md5_16kb,
        analysis_cache::md5_first_16kb(&download.bytes)
    );
    assert!(!trusted.analysis_bytes_transcoded);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url.path(), "/rest/download.view");

    let oversized = analysis_backfill_download(
        app.handle(),
        "canonical-server",
        "oversized-original",
        &stream_url,
        8 * 1024,
    )
    .await;
    assert_eq!(
        oversized.unwrap_err(),
        AnalysisBackfillJobError::Terminal(
            "original download exceeds analysis cap of 8192 bytes".to_string()
        )
    );
    let cache = app.handle().state::<analysis_cache::AnalysisCache>();
    assert_eq!(
        cache
            .get_latest_status_for_track("canonical-server", "oversized-original")
            .unwrap()
            .map(|(status, _)| status),
        Some("failed".to_string())
    );
}

#[tokio::test]
async fn permanent_original_download_http_failure_is_terminal() {
    use tauri::Manager;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/download.view"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), false)));
    let stream_url = format!("{}/rest/stream.view?id=missing", server.uri());

    assert_eq!(
        analysis_backfill_download(
            app.handle(),
            "canonical-server",
            "missing",
            &stream_url,
            ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
        )
        .await
        .unwrap_err(),
        AnalysisBackfillJobError::Terminal("original download unavailable: HTTP 404".to_string())
    );
}

#[tokio::test]
async fn missing_source_is_recorded_without_original_download_fallback() {
    use tauri::Manager;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let response = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /music/missing.flac: no such file or directory"}}}"#.to_vec();
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(response))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), true)));
    app.handle()
        .manage(analysis_cache::AnalysisCache::open_in_memory());
    let stream_url = format!("{}/rest/stream.view?id=missing&format=mp3", server.uri());

    let result = analysis_backfill_download(
        app.handle(),
        "canonical-server",
        "missing",
        &stream_url,
        ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
    )
    .await;

    let Err(AnalysisBackfillJobError::Terminal(message)) = result else {
        panic!("missing source should be a recoverable terminal backfill failure");
    };
    assert!(message.contains("Subsonic code 0"));
    assert!(message.contains("reason=no_such_file_or_directory"));
    assert!(!message.contains("/music/"));
    let cache = app.handle().state::<analysis_cache::AnalysisCache>();
    let failed = cache.list_failed_tracks("canonical-server", None).unwrap();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].track_id, "missing");
    assert_eq!(failed[0].md5_16kb, ANALYSIS_SOURCE_UNAVAILABLE_REVISION);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url.path(), "/rest/stream.view");
}

#[test]
fn explicit_backfill_server_hint_beats_url_transport_scope() {
    assert_eq!(
        resolve_backfill_server_id(
            "https://lan.example:4533/nav/rest/stream.view?id=t1",
            Some("canonical.example/nav"),
        ),
        "canonical.example/nav"
    );
    assert_eq!(
        resolve_backfill_server_id("https://lan.example:4533/nav/rest/stream.view?id=t1", None,),
        "lan.example:4533/nav"
    );
}

use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use crate::analysis_cache;

use super::super::super::http_backfill::*;
use super::support::*;

#[tokio::test]
async fn backfill_probes_original_then_downloads_bounded_transcode() {
    use tauri::Manager;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer};

    let server = MockServer::start().await;
    let mut original = vec![0x66; 24 * 1024];
    original[..4].copy_from_slice(b"fLaC");
    let transcode = vec![0x55; 12 * 1024];
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(RawOriginalResponder {
            body: original.clone(),
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "mp3"))
        .and(query_param("maxBitRate", "64"))
        .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(transcode.clone()))
        .mount(&server)
        .await;

    let registry = analysis_registry(&server.uri(), true);
    let app = tauri::test::mock_app();
    app.handle().manage(Arc::new(registry));
    app.handle()
        .manage(analysis_cache::AnalysisCache::open_in_memory());
    let stream_url = format!(
        "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
        server.uri()
    );
    assert_eq!(
        analysis_stream_format_hint(&stream_url).as_deref(),
        Some("mp3")
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

    assert_eq!(download.bytes, transcode);
    let trusted = download.trusted_revision.unwrap();
    assert_eq!(trusted.md5_16kb, analysis_cache::md5_first_16kb(&original));
    assert!(trusted.analysis_bytes_transcoded);
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 3, "raw probe before and after transcode");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request
                .url
                .query_pairs()
                .any(|(key, value)| { key == "format" && value == "raw" }))
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request
                .url
                .query_pairs()
                .any(|(key, value)| { key == "format" && value == "mp3" }))
            .count(),
        1
    );
    assert!(requests.iter().all(|request| !request
        .url
        .query_pairs()
        .any(|(key, _)| key == "estimateContentLength")));

    let oversized = analysis_backfill_download(
        app.handle(),
        "canonical-server",
        "oversized-transcode",
        &stream_url,
        8 * 1024,
    )
    .await;
    assert_eq!(
        oversized.unwrap_err(),
        AnalysisBackfillJobError::Terminal(
            "analysis transcode exceeds cap of 8192 bytes".to_string()
        )
    );
    let cache = app.handle().state::<analysis_cache::AnalysisCache>();
    assert_eq!(
        cache
            .get_latest_status_for_track("canonical-server", "oversized-transcode")
            .unwrap()
            .map(|(status, _)| status),
        Some("failed".to_string())
    );
}

#[tokio::test]
async fn backfill_falls_back_to_original_download_when_transcode_fails() {
    use tauri::Manager;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let mut original = vec![0x44; 24 * 1024];
    original[..4].copy_from_slice(b"fLaC");
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(RawOriginalResponder {
            body: original.clone(),
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "mp3"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/download.view"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), true)));
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
    assert_eq!(download.format_hint, None);
    let trusted = download.trusted_revision.unwrap();
    assert!(!trusted.analysis_bytes_transcoded);
    assert_eq!(
        trusted.md5_16kb,
        analysis_cache::md5_first_16kb(&download.bytes)
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[tokio::test]
async fn successful_raw_revalidation_wins_over_transcode_source_error() {
    use tauri::Manager;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let mut original = vec![0x45; 24 * 1024];
    original[..4].copy_from_slice(b"fLaC");
    let source_error = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /private/music.flac: no such file or directory"}}}"#.to_vec();
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(RawOriginalResponder {
            body: original.clone(),
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "mp3"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(source_error))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/download.view"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), true)));
    app.handle()
        .manage(analysis_cache::AnalysisCache::open_in_memory());
    let stream_url = format!(
        "{}/rest/stream.view?id=transcode-error&format=mp3",
        server.uri()
    );

    let download = analysis_backfill_download(
        app.handle(),
        "canonical-server",
        "transcode-source-error",
        &stream_url,
        ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
    )
    .await
    .unwrap();

    assert_eq!(download.bytes, original);
    let cache = app.handle().state::<analysis_cache::AnalysisCache>();
    assert_eq!(
        cache
            .get_latest_status_for_track("canonical-server", "transcode-source-error")
            .unwrap(),
        None
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[tokio::test]
async fn backfill_discards_transcode_when_original_changes_during_fetch() {
    use tauri::Manager;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let mut original_a = vec![0x41; 24 * 1024];
    original_a[..4].copy_from_slice(b"fLaC");
    let mut original_b = vec![0x42; 24 * 1024];
    original_b[..4].copy_from_slice(b"fLaC");
    let raw_requests = Arc::new(AtomicUsize::new(0));
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(ChangingRawOriginalResponder {
            first: original_a,
            later: original_b.clone(),
            requests: raw_requests,
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "mp3"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0x55; 12 * 1024]))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/download.view"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original_b.clone()))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), true)));
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

    assert_eq!(download.bytes, original_b);
    let trusted = download.trusted_revision.unwrap();
    assert!(!trusted.analysis_bytes_transcoded);
    assert_eq!(
        trusted.md5_16kb,
        analysis_cache::md5_first_16kb(&download.bytes)
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[tokio::test]
async fn oversized_download_does_not_fail_a_stale_raw_fingerprint() {
    use tauri::Manager;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let mut probed_original = vec![0x41; 24 * 1024];
    probed_original[..4].copy_from_slice(b"fLaC");
    let mut downloaded_original = vec![0x42; 24 * 1024];
    downloaded_original[..4].copy_from_slice(b"fLaC");
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(RawOriginalResponder {
            body: probed_original,
        })
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "mp3"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/download.view"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(downloaded_original))
        .mount(&server)
        .await;

    let app = tauri::test::mock_app();
    app.handle()
        .manage(Arc::new(analysis_registry(&server.uri(), true)));
    app.handle()
        .manage(analysis_cache::AnalysisCache::open_in_memory());
    let stream_url = format!(
        "{}/rest/stream.view?id=t1&format=mp3&maxBitRate=64",
        server.uri()
    );

    let result = analysis_backfill_download(
        app.handle(),
        "canonical-server",
        "t1",
        &stream_url,
        8 * 1024,
    )
    .await;

    assert_eq!(
        result.unwrap_err(),
        AnalysisBackfillJobError::Retryable(
            "oversized original download does not match raw-probed identity".to_string()
        )
    );
    let cache = app.handle().state::<analysis_cache::AnalysisCache>();
    assert_eq!(
        cache
            .get_latest_status_for_track("canonical-server", "t1")
            .unwrap(),
        None
    );
}

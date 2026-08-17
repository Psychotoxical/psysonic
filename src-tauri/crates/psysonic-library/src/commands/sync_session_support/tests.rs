use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::commands::test_support::runtime;
use crate::store::LibraryStore;

#[test]
fn normalize_base_url_adds_scheme_and_strips_trailing_slash() {
    assert_eq!(
        normalize_base_url("nas.example.com"),
        "http://nas.example.com"
    );
    assert_eq!(
        normalize_base_url("nas.example.com/"),
        "http://nas.example.com"
    );
    assert_eq!(
        normalize_base_url("192.168.1.5:4533"),
        "http://192.168.1.5:4533"
    );
}

#[test]
fn normalize_base_url_preserves_existing_scheme() {
    assert_eq!(
        normalize_base_url("https://nas.example.com"),
        "https://nas.example.com"
    );
    assert_eq!(
        normalize_base_url("https://nas.example.com/"),
        "https://nas.example.com"
    );
    assert_eq!(
        normalize_base_url("http://localhost:4533/"),
        "http://localhost:4533"
    );
}

#[test]
fn normalize_base_url_trims_whitespace() {
    assert_eq!(
        normalize_base_url("  nas.example.com  "),
        "http://nas.example.com"
    );
}

#[test]
fn scoped_verify_routes_through_scope_safe_full_resync() {
    assert_eq!(
        resolve_sync_job_kind("delta", "music-folder", true).unwrap(),
        "initial_sync"
    );
    assert_eq!(
        resolve_sync_job_kind("delta", "", true).unwrap(),
        "delta_sync"
    );
    assert_eq!(
        resolve_sync_job_kind("delta", "music-folder", false).unwrap(),
        "delta_sync"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_bind_probe_preserves_previous_session_and_is_bounded() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/auth/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "token": "new-token",
            "userId": "u1"
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(1)))
        .mount(&server)
        .await;

    let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
    let previous = SyncSession {
        server_id: "s1".into(),
        base_url: "https://old.example.com".into(),
        username: "old-user".into(),
        password: "old-password".into(),
        navidrome_token: Some("old-token".into()),
        library_scope: Some("old-scope".into()),
    };
    runtime.set_session(previous.clone()).unwrap();

    let error = tokio::time::timeout(
        Duration::from_millis(250),
        bind_sync_session_inner(
            &runtime,
            &ServerHttpRegistry::new(),
            BindSessionRequest {
                server_id: "s1".into(),
                base_url: server.uri(),
                username: "new-user".into(),
                password: "new-password".into(),
                library_scope: Some("new-scope".into()),
            },
            BindSessionTimeouts {
                token: Duration::from_millis(100),
                probe: Duration::from_millis(20),
            },
        ),
    )
    .await
    .expect("bind exceeded its configured network bound")
    .unwrap_err();
    assert!(error.contains("timed out"));
    assert_eq!(runtime.get_session("s1"), Some(previous));
}

#[test]
fn sync_outcome_treats_cancellation_as_silent_success() {
    // Cancellation (user cancel, or a newer sync_start superseding this
    // job) must not surface as a failure on the sync-idle event.
    assert!(sync_outcome_to_result::<()>(Ok(())).is_ok());
    assert!(sync_outcome_to_result::<()>(Err(SyncError::Cancelled)).is_ok());
    let err = sync_outcome_to_result::<()>(Err(SyncError::Transport("boom".into())));
    assert_eq!(err, Err("sync transport: boom".to_string()));
}

#[tokio::test]
async fn clear_session_cancels_and_drains_target_before_removing_it() {
    let runtime = Arc::new(runtime(Arc::new(LibraryStore::open_in_memory())));
    for server_id in ["s1", "s2"] {
        runtime
            .set_session(SyncSession {
                server_id: server_id.to_string(),
                base_url: format!("https://{server_id}.example.com"),
                username: "user".into(),
                password: "password".into(),
                navidrome_token: None,
                library_scope: None,
            })
            .unwrap();
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(tokio::sync::Notify::new());
    runtime
        .install_current_job(CurrentJob {
            job_id: "target-job".into(),
            server_id: "s1".into(),
            kind: "delta_sync".into(),
            cancel: Arc::clone(&cancel),
            abort_handle: None,
            done: Arc::clone(&done),
        })
        .unwrap();

    let runtime_for_job = Arc::clone(&runtime);
    let cancel_for_job = Arc::clone(&cancel);
    let done_for_job = Arc::clone(&done);
    let job = tokio::spawn(async move {
        while !cancel_for_job.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        runtime_for_job.complete_current_job("target-job", &done_for_job);
    });

    clear_sync_session(&runtime, "s1").await.unwrap();
    job.await.unwrap();
    assert!(cancel.load(Ordering::SeqCst));
    assert!(runtime.get_session("s1").is_none());
    assert!(runtime.get_session("s2").is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn navidrome_token_with_retry_returns_token_on_success() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/auth/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "token": "nd-tok", "userId": "u1"
        })))
        .mount(&server)
        .await;
    let tok = navidrome_token_with_retry(None, &server.uri(), "user", "pw").await;
    assert_eq!(tok.as_deref(), Some("nd-tok"));
}

#[tokio::test(flavor = "multi_thread")]
async fn navidrome_token_with_retry_returns_none_after_exhausting_attempts() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};
    let server = MockServer::start().await;
    // No `token` field → navidrome_token errors on every attempt; after
    // the retries are exhausted the helper yields None (caller then falls
    // back to a cached bearer / Subsonic-only).
    Mock::given(method("POST"))
        .and(path("/auth/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&server)
        .await;
    let tok = navidrome_token_with_retry(None, &server.uri(), "user", "pw").await;
    assert!(tok.is_none());
}

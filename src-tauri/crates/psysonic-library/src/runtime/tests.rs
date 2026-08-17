use super::*;

fn sample_session(server_id: &str) -> SyncSession {
    SyncSession {
        server_id: server_id.into(),
        base_url: "https://nas.example.com".into(),
        username: "u".into(),
        password: "p".into(),
        navidrome_token: None,
        library_scope: None,
    }
}

fn sample_job(server_id: &str, kind: &str) -> CurrentJob {
    CurrentJob {
        job_id: format!("{server_id}-{kind}"),
        server_id: server_id.into(),
        kind: kind.into(),
        cancel: Arc::new(AtomicBool::new(false)),
        abort_handle: None,
        done: Arc::new(Notify::new()),
    }
}

#[test]
fn new_runtime_has_empty_sessions_and_idle_hint() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let rt = LibraryRuntime::new(store);
    assert!(rt.snapshot_sessions().is_empty());
    assert_eq!(rt.current_playback_hint(), PlaybackHint::Idle);
    assert!(!rt
        .scheduler_cancel
        .load(std::sync::atomic::Ordering::SeqCst));
}

#[test]
fn set_and_get_session_roundtrip() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let rt = LibraryRuntime::new(store);
    rt.set_session(sample_session("s1")).unwrap();
    let got = rt.get_session("s1").unwrap();
    assert_eq!(got.base_url, "https://nas.example.com");
    assert_eq!(got.username, "u");
}

#[test]
fn clear_session_removes_one_server_only() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let rt = LibraryRuntime::new(store);
    rt.set_session(sample_session("s1")).unwrap();
    rt.set_session(sample_session("s2")).unwrap();
    rt.clear_session("s1");
    assert!(rt.get_session("s1").is_none());
    assert!(rt.get_session("s2").is_some());
}

#[test]
fn snapshot_returns_clones_so_lock_drops_after_call() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let rt = LibraryRuntime::new(store);
    rt.set_session(sample_session("s1")).unwrap();
    let snap = rt.snapshot_sessions();
    // Should be free to mutate after the snapshot.
    rt.set_session(sample_session("s2")).unwrap();
    assert_eq!(snap.len(), 1);
    assert_eq!(rt.snapshot_sessions().len(), 2);
}

#[test]
fn playback_hint_default_is_idle_and_setter_updates() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let rt = LibraryRuntime::new(store);
    assert_eq!(rt.current_playback_hint(), PlaybackHint::Idle);
    rt.set_playback_hint(PlaybackHint::Playing);
    assert_eq!(rt.current_playback_hint(), PlaybackHint::Playing);
    rt.set_playback_hint(PlaybackHint::PrefetchActive);
    assert_eq!(rt.current_playback_hint(), PlaybackHint::PrefetchActive);
}

#[tokio::test]
async fn job_done_notify_one_survives_early_signal_before_await() {
    let done = Arc::new(Notify::new());
    done.notify_one();
    tokio::time::timeout(std::time::Duration::from_millis(50), done.notified())
        .await
        .expect("notify_one must store a permit for a later waiter");
}

#[tokio::test]
async fn job_done_notify_waiters_loses_early_signal_before_await() {
    let done = Arc::new(Notify::new());
    done.notify_waiters();
    let waited = tokio::time::timeout(std::time::Duration::from_millis(20), done.notified())
        .await
        .is_ok();
    assert!(
        !waited,
        "notify_waiters must not store a permit — resync drain uses notify_one instead"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_and_drain_replaces_any_foreground_job() {
    let runtime = Arc::new(LibraryRuntime::new(
        Arc::new(LibraryStore::open_in_memory()),
    ));
    let job = sample_job("old-server", "delta_sync");
    let cancel = Arc::clone(&job.cancel);
    let done = Arc::clone(&job.done);
    let job_id = job.job_id.clone();
    runtime.install_current_job(job).unwrap();

    let runtime_for_job = Arc::clone(&runtime);
    let task = tokio::spawn(async move {
        while !cancel.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        runtime_for_job.complete_current_job(&job_id, &done);
    });

    let barrier = tokio::time::timeout(
        Duration::from_secs(1),
        runtime.cancel_and_drain_sync(None, None),
    )
    .await
    .expect("drain timed out")
    .expect("drain failed");
    assert!(runtime.current_job().is_none());
    drop(barrier);
    task.await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_and_drain_aborts_never_responding_runner_within_bound() {
    let runtime = Arc::new(LibraryRuntime::new(
        Arc::new(LibraryStore::open_in_memory()),
    ));
    let job = sample_job("s1", "delta_sync");
    let cancel = Arc::clone(&job.cancel);
    let done = Arc::clone(&job.done);
    let job_id = job.job_id.clone();
    runtime.install_current_job(job).unwrap();

    let runner = tokio::spawn(std::future::pending::<()>());
    runtime
        .attach_current_job_abort_handle(&job_id, runner.abort_handle())
        .unwrap();
    let runtime_for_completion = Arc::clone(&runtime);
    let completion = tokio::spawn(async move {
        let _ = runner.await;
        runtime_for_completion.complete_current_job(&job_id, &done);
    });

    let barrier = tokio::time::timeout(
        Duration::from_millis(250),
        runtime.cancel_and_drain_sync_with_timeouts(
            None,
            None,
            Duration::from_millis(10),
            Duration::from_millis(100),
        ),
    )
    .await
    .expect("bounded drain hung")
    .expect("abortable runner did not drain");
    assert!(cancel.load(Ordering::SeqCst));
    assert!(runtime.current_job().is_none());
    drop(barrier);
    completion.await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_and_drain_fails_bounded_when_synthetic_job_cannot_abort() {
    let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
    let job = sample_job("s1", "delta_sync");
    let cancel = Arc::clone(&job.cancel);
    runtime.install_current_job(job).unwrap();

    let result = tokio::time::timeout(
        Duration::from_millis(250),
        runtime.cancel_and_drain_sync_with_timeouts(
            None,
            None,
            Duration::from_millis(10),
            Duration::from_millis(20),
        ),
    )
    .await
    .expect("bounded drain hung");
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("non-abortable synthetic job unexpectedly drained"),
    };
    assert!(error.contains("did not stop"));
    assert!(cancel.load(Ordering::SeqCst));
    assert!(runtime.current_job().is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn exclusive_barrier_waits_for_scheduler_activity() {
    let runtime = Arc::new(LibraryRuntime::new(
        Arc::new(LibraryStore::open_in_memory()),
    ));
    let scheduler = runtime.sync_activity_guard().await;
    let acquired = Arc::new(AtomicBool::new(false));
    let acquired_for_task = Arc::clone(&acquired);
    let runtime_for_task = Arc::clone(&runtime);
    let task = tokio::spawn(async move {
        let barrier = runtime_for_task
            .cancel_and_drain_sync(None, None)
            .await
            .unwrap();
        acquired_for_task.store(true, Ordering::SeqCst);
        barrier
    });

    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(!acquired.load(Ordering::SeqCst));
    drop(scheduler);

    let barrier = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .expect("barrier stayed blocked")
        .unwrap();
    assert!(acquired.load(Ordering::SeqCst));
    drop(barrier);
}

#[tokio::test(flavor = "multi_thread")]
async fn stale_job_selector_does_not_cancel_replacement() {
    let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
    let job = sample_job("s1", "delta_sync");
    let cancel = Arc::clone(&job.cancel);
    let done = Arc::clone(&job.done);
    let job_id = job.job_id.clone();
    runtime.install_current_job(job).unwrap();

    let barrier = runtime
        .cancel_and_drain_sync(Some("already-finished"), None)
        .await
        .unwrap();
    assert!(!cancel.load(Ordering::SeqCst));
    assert_eq!(runtime.current_job().unwrap().job_id, job_id);
    drop(barrier);

    runtime.complete_current_job(&job_id, &done);
}

#[tokio::test(flavor = "multi_thread")]
async fn database_swap_drains_http_waiting_job_before_switching_files() {
    use std::time::{SystemTime, UNIX_EPOCH};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/in-flight"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(200))
                .set_body_string("ok"),
        )
        .mount(&server)
        .await;

    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "psysonic-library-drain-swap-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let active_path = root.join("library.sqlite");
    let import_path = root.join("library-import.sqlite");

    let store = Arc::new(LibraryStore::open_path_for_test(&active_path).unwrap());
    store
        .with_conn("test.seed-active", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                     VALUES ('s1', 'before', 'Before', '', 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    {
        let imported = LibraryStore::open_path_for_test(&import_path).unwrap();
        imported
            .with_conn("test.seed-import", |conn| {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                         VALUES ('s1', 'imported', 'Imported', '', 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        imported
            .checkpoint_wal("test.seed-import.checkpoint")
            .unwrap();
    }

    let runtime = Arc::new(LibraryRuntime::new(store));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(Notify::new());
    let job_id = "http-writer".to_string();
    runtime
        .install_current_job(CurrentJob {
            job_id: job_id.clone(),
            server_id: "s1".into(),
            kind: "initial_sync".into(),
            cancel: Arc::clone(&cancel),
            abort_handle: None,
            done: Arc::clone(&done),
        })
        .unwrap();

    let runtime_for_job = Arc::clone(&runtime);
    let request_url = format!("{}/in-flight", server.uri());
    let writer = tokio::spawn(async move {
        reqwest::get(request_url)
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        runtime_for_job
            .store
            .with_conn("test.late-write", |conn| {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                         VALUES ('s1', 'late', 'Late', '', 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        runtime_for_job.complete_current_job(&job_id, &done);
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if server
                .received_requests()
                .await
                .expect("requests captured")
                .is_empty()
            {
                tokio::task::yield_now().await;
            } else {
                break;
            }
        }
    })
    .await
    .expect("HTTP request did not start");

    let barrier = runtime.cancel_and_drain_sync(None, None).await.unwrap();
    assert!(cancel.load(Ordering::SeqCst));
    runtime
        .store
        .swap_database_file(&active_path, &import_path)
        .unwrap()
        .expect("active database backup");
    drop(barrier);
    writer.await.unwrap();

    let ids = runtime
        .store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare("SELECT id FROM track ORDER BY id")?;
            let ids = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
        .unwrap();
    assert_eq!(ids, vec!["imported"]);

    drop(runtime);
    std::fs::remove_dir_all(root).unwrap();
}

// ── is_due ────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn is_due_returns_true_when_no_schedule_yet() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let sched = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    assert!(sched.is_due(0).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn is_due_false_when_next_poll_in_future() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_next_poll_at("s1", "", 5_000_000).unwrap();

    let subsonic = test_subsonic(&server.uri());
    let sched = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    assert!(!sched.is_due(1_000_000).unwrap());
    assert!(sched.is_due(5_000_001).unwrap());
}

// ── tick skips when not due ──────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn tick_skips_while_initial_sync_phase_active() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_sync_phase("s1", "", "initial_sync").unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(0)
    .await
    .unwrap();

    assert!(report.skipped_sync_pass_active);
    assert!(report.delta.is_none());
    assert_eq!(report.next_poll_at_ms, 30_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn tick_skips_when_foreground_sync_job_active() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .with_foreground_sync_job_active(true)
    .tick(0)
    .await
    .unwrap();

    assert!(report.skipped_sync_pass_active);
    assert!(report.delta.is_none());
    assert_eq!(report.next_poll_at_ms, 30_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn tick_skips_while_global_bulk_ingest_is_active() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    store.set_bulk_ingest_active(true);

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(0)
    .await
    .unwrap();

    assert!(report.skipped_sync_pass_active);
    assert!(report.delta.is_none());
    assert_eq!(report.next_poll_at_ms, 30_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn tick_skips_when_not_due_and_reports_next_poll() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state
        .set_next_poll_at("s1", "", 1_000_000_000)
        .unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(500)
    .await
    .unwrap();

    assert!(report.skipped_not_due);
    assert!(report.delta.is_none());
    assert!(report.next_poll_at_ms > 500);
}

#[tokio::test(flavor = "multi_thread")]
async fn skipped_tick_preserves_previous_scheduler_error() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    store
        .with_conn("test.seed_skipped_scheduler_error", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, last_error, next_poll_at) \
                     VALUES ('s1', '', 'old failure', 1000000)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(500)
    .await
    .unwrap();
    assert!(report.skipped_not_due);

    let last_error: Option<String> = store
        .with_conn("test.skipped_scheduler_error", |conn| {
            conn.query_row(
                "SELECT last_error FROM sync_state WHERE server_id = 's1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(last_error.as_deref(), Some("old failure"));
}

// ── tick pauses when PrefetchActive ──────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn tick_pauses_when_playback_hint_is_prefetch_active() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_playback_hint(PlaybackHint::PrefetchActive)
    .with_sleep_disabled()
    .tick(0)
    .await
    .unwrap();

    assert!(report.skipped_bulk_paused);
    assert!(report.delta.is_none());
    // Re-scheduled soon (≤ 60s after now) so we catch the
    // prefetch finishing.
    assert!(report.next_poll_at_ms > 0);
    assert!(report.next_poll_at_ms <= 60_000);
}

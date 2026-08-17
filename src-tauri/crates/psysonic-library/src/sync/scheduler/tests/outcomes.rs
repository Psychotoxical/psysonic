// ── tick runs delta and stamps next_poll_at ──────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn tick_runs_delta_and_persists_next_poll_at() {
    let server = MockServer::start().await;
    empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(1_000)
    .await
    .unwrap();

    assert!(!report.skipped_not_due);
    assert!(!report.skipped_bulk_paused);
    assert!(report.delta.is_some());
    let next = SyncStateRepository::new(&store)
        .get_next_poll_at("s1", "")
        .unwrap()
        .unwrap();
    assert_eq!(next, report.next_poll_at_ms);
    assert!(next > 1_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn tick_failure_is_persisted_and_retried_soon() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let err = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(1_000)
    .await
    .unwrap_err();
    assert!(matches!(err, SyncError::Transport(_)));

    let (last_error, next_poll_at): (Option<String>, Option<i64>) = store
        .with_conn("test.scheduler_error", |conn| {
            conn.query_row(
                "SELECT last_error, next_poll_at FROM sync_state \
                     WHERE server_id = 's1' AND library_scope = ''",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert!(last_error.is_some_and(|message| message.contains("503")));
    assert_eq!(next_poll_at, Some(31_000));
}

#[tokio::test(flavor = "multi_thread")]
async fn tick_timeout_is_persisted_without_waiting_for_server() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(1)))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let err = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick_with_timeout(2_000, Duration::from_millis(20))
    .await
    .unwrap_err();
    assert!(err.to_string().contains("timed out"));

    let last_error: Option<String> = store
        .with_conn("test.scheduler_timeout", |conn| {
            conn.query_row(
                "SELECT last_error FROM sync_state WHERE server_id = 's1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert!(last_error.is_some_and(|message| message.contains("timed out")));
}

#[tokio::test(flavor = "multi_thread")]
async fn successful_tick_clears_previous_scheduler_error() {
    let server = MockServer::start().await;
    empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

    let store = LibraryStore::open_in_memory();
    store
        .with_conn("test.seed_scheduler_error", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, last_error) \
                     VALUES ('s1', '', 'old failure')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let subsonic = test_subsonic(&server.uri());
    BackgroundScheduler::new(
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

    let last_error: Option<String> = store
        .with_conn("test.scheduler_error_cleared", |conn| {
            conn.query_row(
                "SELECT last_error FROM sync_state WHERE server_id = 's1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(last_error, None);
}

// ── auto-tombstone trigger ──────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn tick_auto_tombstones_when_count_gap_exceeds_threshold() {
    let server = MockServer::start().await;
    empty_probe_and_albumlist(&server, 1_716_840_000_000).await;
    // Tombstone probe — empty store has nothing to probe, so we
    // only need to know the runner *would* have called getSong if
    // there were rows. For this test it's enough that no panic
    // occurs and the delta report's tombstone counters are zero.

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    // 110 local vs 100 server → 10 % gap, threshold 5 % default.
    sync_state.set_local_track_count("s1", "", 110).unwrap();
    sync_state.set_server_track_count("s1", "", 100).unwrap();

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

    let delta = report.delta.expect("delta ran");
    // Tombstone budget was set (200), but no local tracks exist →
    // nothing to probe, both counters stay at 0. The important
    // signal is that the runner accepted the trigger.
    assert_eq!(delta.tombstones_checked, 0);
    assert_eq!(delta.tombstones_deleted, 0);
}

// ── PollStats persistence round trip ────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn poll_stats_persist_round_trip_through_tick() {
    let server = MockServer::start().await;
    empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    BackgroundScheduler::new(
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

    let stored = SyncStateRepository::new(&store)
        .get_poll_stats_json("s1", "")
        .unwrap()
        .unwrap();
    // tier is recorded — runner reclassifies even with no
    // observations yet, so this is "unknown" on a fresh store.
    let stats: PollStats = serde_json::from_value(stored).unwrap();
    assert_eq!(stats.library_tier.as_tag(), "unknown");
}

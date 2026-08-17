use super::support::*;

// ── Per-batch progress is emitted during ingest ───────────────────

#[tokio::test(flavor = "multi_thread")]
async fn initial_sync_emits_per_batch_progress() {
    use crate::sync::progress::ChannelProgress;
    use std::time::Duration;

    let server = MockServer::start().await;
    mount_search3_pages(&server, /*total*/ 7, /*batch*/ 4).await;
    mount_minimal_artists(&server).await;

    // ZERO interval so the throttle never drops a batch event in the test.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let progress: Arc<dyn Progress + Send + Sync> =
        Arc::new(ChannelProgress::with_interval(tx, Duration::ZERO));

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_batch_size(4)
    .with_sleep_disabled()
    .with_progress(progress)
    .run()
    .await
    .unwrap();

    // Collect the per-batch ingest totals the runner emitted.
    let mut totals = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        if let ProgressEvent::IngestPage { ingested_total, .. } = ev {
            totals.push(ingested_total);
        }
    }
    assert!(
        !totals.is_empty(),
        "initial sync must emit per-batch IngestPage progress"
    );
    assert_eq!(
        *totals.last().unwrap(),
        7,
        "final progress total must reach the full count"
    );
    assert!(
        totals.windows(2).all(|w| w[0] <= w[1]),
        "ingest totals must be non-decreasing"
    );
}

// ── S1 mid-cursor resume ──────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn s1_resumes_from_persisted_cursor_after_kill() {
    let server = MockServer::start().await;
    mount_search3_pages(&server, /*total*/ 10, /*batch*/ 4).await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);

    // Seed the cursor as if a prior run completed page 0 (offset=4)
    // but was killed before page 1 landed.
    sync_state.ensure("s1", "").unwrap();
    let mid_cursor = json!({
        "strategy": "s1",
        "phase": "ingest",
        "library_scope": null,
        "ingested_count": 4,
        "strategy_state": { "kind": "linear_offset", "offset": 4 }
    });
    sync_state
        .set_initial_sync_cursor("s1", "", &mid_cursor)
        .unwrap();

    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_batch_size(4)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    // Resumed at offset 4 — only 6 more rows ingested.
    assert_eq!(report.ingested_count, 4 + 6);
    // …but the store ends up with all 10.
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    // 6 — only the pages run by *this* invocation are persisted to
    // `track` here because the cursor said offset=4 but the prior
    // run never actually wrote rows in this fixture. The assertion
    // documents the resume semantics: cursor controls request
    // offset, not row count.
    assert_eq!(count, 6);
}

// ── Stale / unreadable cursor self-heals instead of bricking ──────

#[test]
fn cursor_with_progress_resumes_and_ignores_reselected_strategy() {
    // R7-15 Q3: a cursor that already made progress must resume under its
    // own strategy even when a re-probe would now pick a different one
    // (here: flags advertise N1 again, but the in-flight cursor is S1).
    // Freezing the strategy is what stops the flapping-induced restart
    // from offset 0 that kept large syncs from ever completing.
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state
        .set_initial_sync_cursor(
            "s1",
            "",
            &json!({
                "strategy": "s1",
                "phase": "ingest",
                "ingested_count": 42,
                "strategy_state": { "kind": "linear_offset", "offset": 2000 }
            }),
        )
        .unwrap();

    let subsonic = test_subsonic("http://127.0.0.1:1");
    let runner = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
    assert_eq!(
        cursor.strategy, "s1",
        "in-flight strategy must be frozen on resume"
    );
    assert_eq!(cursor.ingested_count, 42, "resume must preserve progress");
}

#[test]
fn fresh_cursor_without_progress_adopts_reselected_strategy() {
    // No progress yet (offset 0): adopting the freshly-selected strategy
    // is free, so a cursor written under a now-unavailable strategy is
    // re-selected (not a hard error, not a needless resume).
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state
        .set_initial_sync_cursor(
            "s1",
            "",
            &json!({
                "strategy": "n1",
                "phase": "ingest",
                "ingested_count": 0,
                "strategy_state": { "kind": "linear_offset", "offset": 0 }
            }),
        )
        .unwrap();

    let subsonic = test_subsonic("http://127.0.0.1:1");
    let runner = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
    assert_eq!(
        cursor.strategy, "s1",
        "no-progress cursor adopts the selected strategy"
    );
    assert_eq!(cursor.ingested_count, 0);
}

#[test]
fn n1_cursor_with_progress_reselects_when_flagged_unreliable() {
    // A cursor still on N1 after the server was learned `n1_bulk_unreliable`
    // is known-broken: the freeze does not apply, so it re-selects onto the
    // non-N1 strategy rather than resuming a wall-bound N1 loop. (The
    // mid-run N1→S1 fallback normally rewrites such a cursor in place,
    // preserving progress; this is the defensive fallback.)
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_n1_bulk_unreliable("s1", "", true).unwrap();
    sync_state
        .set_initial_sync_cursor(
            "s1",
            "",
            &json!({
                "strategy": "n1",
                "phase": "ingest",
                "ingested_count": 42,
                "strategy_state": { "kind": "linear_offset", "offset": 500 }
            }),
        )
        .unwrap();

    let subsonic = test_subsonic("http://127.0.0.1:1");
    let runner = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
    assert_eq!(
        cursor.strategy, "s1",
        "known-broken N1 cursor must re-select to S1"
    );
    assert_eq!(cursor.ingested_count, 0);
}

#[test]
fn legacy_scoped_n1_cursor_with_progress_restarts_scope_safe() {
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "lib-a").unwrap();
    sync_state
        .set_initial_sync_cursor(
            "s1",
            "lib-a",
            &json!({
                "strategy": "n1",
                "phase": "ingest",
                "library_scope": "lib-a",
                "ingested_count": 42,
                "strategy_state": { "kind": "linear_offset", "offset": 500 }
            }),
        )
        .unwrap();

    let subsonic = test_subsonic("http://127.0.0.1:1");
    let runner = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "lib-a",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
    assert_eq!(cursor.strategy, "s1");
    assert_eq!(cursor.ingested_count, 0);
    assert_eq!(cursor.library_scope.as_deref(), Some("lib-a"));
}

#[test]
fn unreadable_cursor_is_reset_not_errored() {
    // A corrupt cursor (missing the required `strategy` field) must
    // also self-heal to a fresh cursor rather than error out.
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state
        .set_initial_sync_cursor("s1", "", &json!({ "phase": "ingest", "ingested_count": 9 }))
        .unwrap();

    let subsonic = test_subsonic("http://127.0.0.1:1");
    let runner = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    );
    let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
    assert_eq!(cursor.strategy, "s1");
}
// ── Cancellation token aborts mid-run ─────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_flag_returns_cancelled_error() {
    let server = MockServer::start().await;
    mount_search3_pages(&server, /*total*/ 100, /*batch*/ 4).await;
    let cancel = Arc::new(AtomicBool::new(true)); // already tripped
    let store = LibraryStore::open_in_memory();

    let err = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_batch_size(4)
    .with_cancellation(cancel)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap_err();
    assert!(matches!(err, SyncError::Cancelled));
}

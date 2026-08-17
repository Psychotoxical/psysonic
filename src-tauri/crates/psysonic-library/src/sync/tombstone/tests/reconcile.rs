// ── reconcile_chunk marks deleted on code 70 ─────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn reconcile_chunk_marks_deleted_for_code_70() {
    let server = MockServer::start().await;
    // tr_a → still present, tr_b → 404 via code 70.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .and(query_param("id", "tr_a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "song": { "id": "tr_a", "title": "Still here" }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .and(query_param("id", "tr_b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Song not found" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    seed_track(&store, "tr_a", 1);
    seed_track(&store, "tr_b", 2);

    let subsonic = test_subsonic(&server.uri());
    let report = TombstoneReconciler::new(&store, &subsonic, "s1")
        .with_sleep_disabled()
        .reconcile_chunk(10)
        .await
        .unwrap();

    assert_eq!(report.checked, 2);
    assert_eq!(report.deleted, 1);

    // tr_b is marked deleted; tr_a stays live but its synced_at is
    // refreshed (so it doesn't get re-picked immediately).
    let (a_deleted, b_deleted): (i64, i64) = store
        .with_conn("misc", |c| {
            let a: i64 = c.query_row("SELECT deleted FROM track WHERE id='tr_a'", [], |r| {
                r.get(0)
            })?;
            let b: i64 = c.query_row("SELECT deleted FROM track WHERE id='tr_b'", [], |r| {
                r.get(0)
            })?;
            Ok((a, b))
        })
        .unwrap();
    assert_eq!(a_deleted, 0);
    assert_eq!(b_deleted, 1);
}

// ── reconcile_chunk respects budget and ordering ─────────────────

#[tokio::test(flavor = "multi_thread")]
async fn reconcile_chunk_processes_oldest_first_up_to_budget() {
    let server = MockServer::start().await;
    // Any id → ok envelope.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "song": { "id": "any", "title": "t" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    // Seed three tracks with distinct synced_at values; oldest first.
    seed_track(&store, "tr_oldest", 100);
    seed_track(&store, "tr_middle", 200);
    seed_track(&store, "tr_newest", 300);

    let subsonic = test_subsonic(&server.uri());
    let report = TombstoneReconciler::new(&store, &subsonic, "s1")
        .with_sleep_disabled()
        .reconcile_chunk(2)
        .await
        .unwrap();
    assert_eq!(report.checked, 2);

    // After the chunk: the two checked rows have a refreshed
    // synced_at; the un-checked tr_newest still sits at 300.
    let untouched: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT synced_at FROM track WHERE id='tr_newest'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        untouched, 300,
        "tr_newest must not be probed within budget=2"
    );
}

// ── reconcile_chunk: empty store ───────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn reconcile_chunk_returns_zero_counts_on_empty_store() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let report = TombstoneReconciler::new(&store, &subsonic, "s1")
        .with_sleep_disabled()
        .reconcile_chunk(50)
        .await
        .unwrap();
    assert_eq!(report.checked, 0);
    assert_eq!(report.deleted, 0);
}

// ── reconcile_chunk: cancellation ─────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn reconcile_chunk_returns_cancelled_when_flag_tripped() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "tr_x", 1);

    let flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let subsonic = test_subsonic(&server.uri());
    let err = TombstoneReconciler::new(&store, &subsonic, "s1")
        .with_cancellation(flag)
        .with_sleep_disabled()
        .reconcile_chunk(10)
        .await
        .unwrap_err();
    assert!(matches!(err, SyncError::Cancelled));
}

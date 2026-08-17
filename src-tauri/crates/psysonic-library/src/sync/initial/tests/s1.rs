use super::support::*;

// ── S1 happy path ──────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn s1_ingest_drains_pages_and_persists_done_phase() {
    let server = MockServer::start().await;
    mount_search3_pages(&server, /*total*/ 7, /*batch*/ 4).await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let runner = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_batch_size(4)
    .with_sleep_disabled();

    let report = runner.run().await.unwrap();
    assert_eq!(report.ingested_count, 7);
    assert_eq!(report.remapped_count, 0);
    assert_eq!(report.strategy.as_deref(), Some("s1"));

    // sync_phase ended in "ready" and cursor cleared.
    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(
        sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("ready")
    );
    let cur = sync_state.get_initial_sync_cursor("s1", "").unwrap();
    assert_eq!(cur, Some(json!({})));

    // Tracks landed in the store.
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(count, 7);
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_continues_when_the_server_clamps_song_count() {
    let server = MockServer::start().await;
    for (offset, ids) in [
        (0, vec!["tr_0", "tr_1"]),
        (2, vec!["tr_2", "tr_3"]),
        (4, vec!["tr_4"]),
    ] {
        let songs: Vec<_> = ids
            .into_iter()
            .map(|id| json!({ "id": id, "title": id, "duration": 100 }))
            .collect();
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", offset.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": { "song": songs }
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
    }
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("songOffset", "5"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .expect(1)
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_batch_size(5)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(report.ingested_count, 5);
    let live: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM track WHERE deleted = 0", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(live, 5);
}
// ── Backoff retries on 503 then succeeds ──────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn s1_retries_after_transient_503_then_succeeds() {
    let server = MockServer::start().await;
    // First request — 503. Wiremock `up_to_n_times` makes this
    // simple: 1 mock that only answers once with 503, then a
    // catch-all that returns the empty success envelope.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("songOffset", "0"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_batch_size(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();
    assert_eq!(report.ingested_count, 0, "all retries land before a song");
}
// ── S1 raw_json carries OpenSubsonic extensions verbatim ──────────

#[tokio::test(flavor = "multi_thread")]
async fn s1_ingest_preserves_open_subsonic_fields_in_track_raw_json() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("songOffset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "searchResult3": {
                    "song": [
                        {
                            "id": "tr_1",
                            "title": "With Extensions",
                            "duration": 240,
                            "replayGain": { "trackGain": -1.2, "albumGain": -0.8 },
                            "contributors": [
                                { "role": "producer", "artistId": "ar_9", "name": "Prod" }
                            ]
                        }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_batch_size(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    // raw_json column must contain the OpenSubsonic-only fields,
    // not just the typed projection — ADR-7 fidelity.
    let raw: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT raw_json FROM track WHERE server_id='s1' AND id='tr_1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(
        parsed.get("replayGain").is_some(),
        "raw json keeps replayGain"
    );
    assert!(
        parsed.get("contributors").is_some(),
        "raw json keeps contributors"
    );

    // Typed projection also picked up replayGain via the mapping
    // helper — both paths agree on the hot column.
    let (rg_t, rg_a): (Option<f64>, Option<f64>) = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT replay_gain_track_db, replay_gain_album_db \
                 FROM track WHERE server_id='s1' AND id='tr_1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(rg_t, Some(-1.2));
    assert_eq!(rg_a, Some(-0.8));
}

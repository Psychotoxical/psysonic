use super::support::*;

// ── N1 happy path via wiremock ────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn n1_ingest_paginates_navidrome_native_endpoint() {
    let server = MockServer::start().await;
    // Two pages of 2 songs each, then empty.
    for page in 0u32..=2 {
        let start = page * 2;
        let songs = if page < 2 {
            vec![
                json!({"id": format!("tr_{start}"), "title": format!("t{start}"), "duration": 100}),
                json!({"id": format!("tr_{}", start + 1), "title": format!("t{}", start + 1), "duration": 100}),
            ]
        } else {
            vec![]
        };
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .and(query_param("_start", start.to_string()))
            .and(header("X-ND-Authorization", "Bearer nd-tok"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::Value::Array(songs)))
            .mount(&server)
            .await;
    }
    // Minimal Subsonic ping path for artist/watermark phases.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": { "lastModified": 0, "ignoredArticles": "", "index": [] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "scanStatus": { "scanning": false } }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_navidrome_credentials(nav)
    .with_batch_size(2)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();
    assert_eq!(report.ingested_count, 4);
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(count, 4);

    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(sync_state.get_local_track_count("s1", "").unwrap(), Some(4));
    assert_eq!(
        sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("ready")
    );
    let full_sync: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT last_full_sync_at FROM sync_state WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(full_sync.is_some());
}

// ── N1 → S1 deep-offset fallback (R7-15 Q5) ───────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn n1_deep_offset_500_falls_back_to_s1_and_flags_server() {
    let server = MockServer::start().await;
    // N1 serves the first page, then 500s at the (test-lowered) wall.
    // Ids match the S1 fixture format so the re-ingest upserts rather
    // than duplicating the rows N1 already wrote.
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .and(query_param("_start", "0"))
        .and(header("X-ND-Authorization", "Bearer nd-tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            {"id": "tr_0000", "title": "t0", "duration": 100},
            {"id": "tr_0001", "title": "t1", "duration": 100}
        ])))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .and(query_param("_start", "2"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    // S1 restarts from offset 0 and ingests all 5 songs.
    mount_search3_pages(&server, /*total*/ 5, /*batch*/ 2).await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": false, "count": 5 }
            }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[test_track_row("stale", "Stale")])
        .unwrap();
    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(
            CapabilityFlags::NAVIDROME_NATIVE_BULK
                | CapabilityFlags::SUBSONIC_SEARCH3_BULK
                | CapabilityFlags::SCAN_STATUS_AVAILABLE,
        ),
    )
    .with_navidrome_credentials(nav)
    .with_batch_size(2)
    .with_n1_deep_offset_safe(2)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(
        report.strategy.as_deref(),
        Some("s1"),
        "run must finish on S1"
    );
    // 5 distinct songs — N1's two rows were re-upserted, not duplicated.
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track WHERE deleted = 0", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(count, 5);
    let stale_deleted: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT deleted FROM track WHERE id = 'stale'", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(
        stale_deleted, 1,
        "fallback must preserve the resync generation"
    );
    // Server learned the flag so future syncs skip N1.
    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(
        sync_state.get_n1_bulk_unreliable("s1", "").unwrap(),
        Some(true)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn n1_shallow_500_propagates_without_fallback() {
    // A 500 below the wall line is a real error, not the deep-offset
    // trigger: it propagates and must NOT silently flag the server.
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let err = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK),
    )
    .with_navidrome_credentials(nav)
    .with_batch_size(2)
    .with_n1_deep_offset_safe(1000)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap_err();
    assert!(matches!(err, SyncError::Navidrome(ref m) if m.contains("500")));
    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(
        sync_state.get_n1_bulk_unreliable("s1", "").unwrap(),
        Some(false)
    );
}

use super::support::*;

#[tokio::test(flavor = "multi_thread")]
async fn full_resync_sweeps_orphans_not_seen_in_ingest() {
    let server = MockServer::start().await;
    mount_search3_pages(&server, /*total*/ 3, /*batch*/ 10).await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": false, "count": 3, "lastScan": "2024-06-01T12:00:00Z" }
            }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_last_full_sync_at("s1", "", 1).unwrap();

    store
        .with_conn_mut("misc", |c| {
            for id in ["tr_stale_a", "tr_stale_b"] {
                c.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, resync_gen) \
                     VALUES ('s1', ?1, 'stale', 'Al', 1, 0, 1, '{}', 1)",
                    rusqlite::params![id],
                )?;
            }
            Ok(())
        })
        .unwrap();

    let subsonic = test_subsonic(&server.uri());
    InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    let live: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = 's1' AND deleted = 0",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(live, 3);

    let stale_deleted: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM track WHERE id IN ('tr_stale_a', 'tr_stale_b') AND deleted = 1",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(stale_deleted, 2);
}

/// IS-5 persists the count from the scan-status response it already
/// fetches. Without it the sweep guard compares against whatever the
/// bind-time probe left behind, which can predate a deliberate deletion.
#[tokio::test(flavor = "multi_thread")]
async fn the_watermark_pass_persists_the_server_track_count() {
    let server = MockServer::start().await;
    // Mounted before the shared fixture, whose scan status carries no
    // count — the first matching mock answers.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": false, "count": 3, "lastScan": "2024-06-01T12:00:00Z" }
            }
        })))
        .mount(&server)
        .await;
    mount_search3_pages(&server, /*total*/ 3, /*batch*/ 10).await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_server_track_count("s1", "", 999).unwrap();

    let subsonic = test_subsonic(&server.uri());
    InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(
        sync_state.get_server_track_count("s1", "").unwrap(),
        Some(3),
        "the count from this run's scan status replaces the stale one"
    );
}

/// Any count observed during a scan is a moving partial result. Even a
/// positive value must not replace the last stable count or authorize IS-7.
#[tokio::test(flavor = "multi_thread")]
async fn an_active_scan_count_does_not_clobber_a_known_one() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": true, "count": 100, "lastScan": "2024-06-01T12:00:00Z" }
            }
        })))
        .mount(&server)
        .await;
    mount_search3_pages(&server, /*total*/ 3, /*batch*/ 10).await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_server_track_count("s1", "", 999).unwrap();

    let subsonic = test_subsonic(&server.uri());
    InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(
        sync_state.get_server_track_count("s1", "").unwrap(),
        Some(999)
    );
}

/// The other half of IS-7: when the ingest visibly failed to cover the
/// catalogue, the leftovers are not orphans — they are the rows the run
/// lost. Sweeping them is a mass deletion of live music.
#[tokio::test(flavor = "multi_thread")]
async fn a_resync_that_fell_short_does_not_sweep() {
    let server = MockServer::start().await;
    mount_search3_pages(&server, /*total*/ 3, /*batch*/ 10).await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": false, "count": 1000, "lastScan": "2024-06-01T12:00:00Z" }
            }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_last_full_sync_at("s1", "", 1).unwrap();
    // The server holds far more than this run will ingest.
    sync_state.set_server_track_count("s1", "", 1_000).unwrap();

    store
        .with_conn_mut("misc", |c| {
            for id in ["tr_stale_a", "tr_stale_b"] {
                c.execute(
                    "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, resync_gen) \
                     VALUES ('s1', ?1, 'stale', 'Al', 1, 0, 1, '{}', 1)",
                    rusqlite::params![id],
                )?;
            }
            Ok(())
        })
        .unwrap();

    let subsonic = test_subsonic(&server.uri());
    InitialSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    let stale_alive: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM track WHERE id IN ('tr_stale_a', 'tr_stale_b') AND deleted = 0",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        stale_alive, 2,
        "a short ingest must not turn its own shortfall into tombstones"
    );
    let stats: PollStats =
        serde_json::from_value(sync_state.get_poll_stats_json("s1", "").unwrap().unwrap()).unwrap();
    assert_eq!(
        stats.last_resync_sweep_skip.map(|skip| skip.reason),
        Some(ResyncSweepSkipReason::IncompleteIngest)
    );
}

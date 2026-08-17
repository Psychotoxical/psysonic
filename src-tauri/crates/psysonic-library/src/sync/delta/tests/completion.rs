// ── DS-9 watermarks land + last_delta_sync_at stamped ────────────

#[tokio::test(flavor = "multi_thread")]
async fn ds9_writes_watermarks_and_last_delta_timestamp() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": 1_716_840_000_000_i64,
                    "ignoredArticles": "",
                    "index": []
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [] }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    DeltaSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(
        sync_state.get_artists_last_modified_ms("s1", "").unwrap(),
        Some(1_716_840_000_000)
    );
    let (last_delta,): (Option<i64>,) = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT last_delta_sync_at FROM sync_state WHERE server_id='s1'",
                [],
                |r| Ok((r.get(0)?,)),
            )
        })
        .unwrap();
    assert!(last_delta.unwrap_or(0) > 0);
}

// ── DS-8: tombstone wire runs after DS-4 ─────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn ds8_runs_tombstone_chunk_when_budget_set() {
    let server = MockServer::start().await;
    // Watermark change → DS-4 ingest path runs.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": 1_716_840_000_000_i64,
                    "ignoredArticles": "",
                    "index": []
                }
            }
        })))
        .mount(&server)
        .await;
    // S2-delta: empty album list → no ingest, but DS-8 still runs.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [] }
            }
        })))
        .mount(&server)
        .await;
    // getSong probe — first id returns ok, second returns code 70.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .and(query_param("id", "tr_alive"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "song": { "id": "tr_alive", "title": "Alive" }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .and(query_param("id", "tr_gone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Song not found" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    seed_track(&store, "tr_alive", "al_x", 1_000);
    seed_track(&store, "tr_gone", "al_x", 1_000);

    let subsonic = test_subsonic(&server.uri());
    let report = DeltaSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_tombstone_budget(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(report.tombstones_checked, 2);
    assert_eq!(report.tombstones_deleted, 1);

    // tr_gone is now soft-deleted.
    let gone_deleted: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT deleted FROM track WHERE id='tr_gone'", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(gone_deleted, 1);

    // The threshold that gates this very pass reads `local_track_count`,
    // and retiring rows is not a "change" the scheduler re-stamps for. Left
    // alone, the one operation that alters the live count most would leave
    // the gate reading a number from before it ran.
    let stored = SyncStateRepository::new(&store)
        .get_local_track_count("s1", "")
        .unwrap();
    assert_eq!(
        stored,
        Some(1),
        "the count must follow the rows the pass retired"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn verify_bypasses_watermark_and_checks_every_live_row() {
    let server = MockServer::start().await;
    // No getArtists mock is mounted: touching the delta watermark path
    // would fail this test. Every getSong probe succeeds.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getSong.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "song": { "id": "present", "title": "Present" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    for i in 0..205 {
        seed_track(&store, &format!("tr-{i:03}"), "album", 1_000);
    }
    let report = DeltaSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_full_tombstone_pass()
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(report.tombstones_checked, 205);
    assert_eq!(report.tombstones_deleted, 0);
    assert!(!report.up_to_date);
}

fn parse_test_iso(s: &str) -> i64 {
    // Tiny helper for the seed track watermark — full date only,
    // midnight UTC, ms epoch.
    let mut parts = s.split('-');
    let y: i64 = parts.next().unwrap().parse().unwrap();
    let m: i64 = parts.next().unwrap().parse().unwrap();
    let d: i64 = parts.next().unwrap().parse().unwrap();
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mm = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400_000
}

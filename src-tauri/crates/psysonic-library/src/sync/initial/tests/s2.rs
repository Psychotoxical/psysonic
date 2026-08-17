use super::support::*;

// ── S1 → S2 persistent-failure fallback (R7-15 Q8) ────────────────

#[tokio::test(flavor = "multi_thread")]
async fn s1_persistent_failure_falls_back_to_s2() {
    let server = MockServer::start().await;
    // S1 (search3) fails on every attempt → persistent after retries.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    // S2 album crawl works: one album page, then empty.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [{ "id": "al_1", "name": "First" }] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", "al_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": {
                    "id": "al_1",
                    "name": "First",
                    "song": [{ "id": "tr_a", "title": "song", "duration": 240 }]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": false, "count": 1 }
            }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let mut stale = test_track_row("stale", "Stale");
    stale.album = "Old".into();
    TrackRepository::new(&store).upsert_batch(&[stale]).unwrap();
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_batch_size(1)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(
        report.strategy.as_deref(),
        Some("s2"),
        "run must finish on S2"
    );
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track WHERE deleted = 0", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(count, 1, "the S2 album crawl ingested the track");
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
}

// ── S3 explicitly unsupported in v1 ───────────────────────────────

#[test]
fn s3_cursor_self_heals_to_selected_strategy() {
    // S3 is never auto-selected, so a persisted s3 cursor (legacy /
    // corrupt) can never match the chosen strategy — it must reset to
    // the selected strategy rather than error.
    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state
        .set_initial_sync_cursor(
            "s1",
            "",
            &json!({
                "strategy": "s3",
                "phase": "ingest",
                "ingested_count": 0,
                "strategy_state": { "kind": "empty" }
            }),
        )
        .unwrap();

    let subsonic = test_subsonic("http://127.0.0.1:1");
    // Default flags ⇒ selector resolves to s2.
    let runner = InitialSyncRunner::new(&store, &subsonic, "s1", "", flags(0));
    let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
    assert_eq!(cursor.strategy, "s2");
}
// ── S2 happy path: getAlbumList2 → getAlbum-per-id loop ───────────

#[tokio::test(flavor = "multi_thread")]
async fn s2_ingest_walks_albums_and_persists_songs() {
    let server = MockServer::start().await;
    // First album-list page: 2 albums, second page: 0 (loop ends).
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": {
                    "album": [
                        { "id": "al_1", "name": "First" },
                        { "id": "al_2", "name": "Second" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [] }
            }
        })))
        .mount(&server)
        .await;
    // Per-album song lists.
    for (album_id, song_id) in [("al_1", "tr_a"), ("al_2", "tr_b")] {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", album_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": {
                        "id": album_id,
                        "name": album_id,
                        "song": [
                            { "id": song_id, "title": "song", "duration": 240 }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
    }
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic(&server.uri());
    let report = InitialSyncRunner::new(
        &store,
        &subsonic,
        "s2",
        "",
        // Force selector to fall through to S2: clear N1 + S1 bits.
        flags(0),
    )
    .with_batch_size(2)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(report.strategy.as_deref(), Some("s2"));
    assert_eq!(report.ingested_count, 2);

    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(count, 2);
}

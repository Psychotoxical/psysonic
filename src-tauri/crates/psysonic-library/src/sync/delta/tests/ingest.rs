// ── DS-4 N1-delta crosses watermark and stops ────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn n1_delta_stops_at_local_watermark() {
    let server = MockServer::start().await;
    // getArtists path: claim new lastModified to trigger DS-4.
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
    // /api/song _sort=updated_at _order=DESC: 3 fresh, then 2 stale
    // (server_updated_at < watermark).
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .and(query_param("_start", "0"))
        .and(query_param("_sort", "updated_at"))
        .and(query_param("_order", "DESC"))
        .and(header("X-ND-Authorization", "Bearer nd-tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([
            { "id": "tr_n3", "title": "new3", "updatedAt": "2024-06-03T00:00:00Z" },
            { "id": "tr_n2", "title": "new2", "updatedAt": "2024-06-02T00:00:00Z" },
            { "id": "tr_n1", "title": "new1", "updatedAt": "2024-06-01T00:00:00Z" },
            { "id": "tr_old1", "title": "old", "updatedAt": "2024-01-01T00:00:00Z" },
            { "id": "tr_old2", "title": "old", "updatedAt": "2024-01-01T00:00:00Z" }
        ])))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    // Seed a track with server_updated_at = 2024-05-01 — fresh3..1
    // are newer (above watermark); old1/old2 are older (below).
    seed_track(&store, "tr_old_seed", "al_x", parse_test_iso("2024-05-01"));

    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let subsonic = test_subsonic(&server.uri());
    let report = DeltaSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK),
    )
    .with_navidrome_credentials(nav)
    .with_batch_size(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert_eq!(report.changed_count, 3, "only the 3 fresh rows upserted");
    assert_eq!(report.strategy.as_deref(), Some("n1"));
}

// ── DS-4 S2-delta rechecks returned known album ids ──────────────

#[tokio::test(flavor = "multi_thread")]
async fn s2_delta_rechecks_known_album_ids_before_advancing_watermark() {
    let server = MockServer::start().await;
    // Watermark change: getArtists lastModified differs from stored
    // (null) → falls through to DS-4.
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
    // getAlbumList2 type=newest page 0: two albums, one we already
    // have locally and one fresh.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("type", "newest"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": {
                    "album": [
                        { "id": "al_known", "name": "Known" },
                        { "id": "al_fresh", "name": "Fresh" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;
    // Empty pages after the first one for both types.
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
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", "al_known"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": {
                    "id": "al_known",
                    "name": "Known",
                    "song": [
                        { "id": "tr_existing", "title": "Known changed", "duration": 240 }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", "al_fresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": {
                    "id": "al_fresh",
                    "name": "Fresh",
                    "song": [
                        { "id": "tr_new", "title": "Just landed", "duration": 240 }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    seed_track(&store, "tr_existing", "al_known", 1_000);

    let subsonic = test_subsonic(&server.uri());
    let report = DeltaSyncRunner::new(
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

    assert_eq!(report.strategy.as_deref(), Some("s2"));
    assert_eq!(
        report.changed_count, 2,
        "known and fresh albums are inspected"
    );
    // The seed plus the new track land in the store.
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(count, 2);
    let title: String = store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT title FROM track WHERE id = 'tr_existing'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(title, "Known changed");
}

#[test]
fn scoped_delta_never_selects_server_wide_n1() {
    let store = LibraryStore::open_in_memory();
    let subsonic = test_subsonic("http://127.0.0.1:1");
    let runner = DeltaSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "lib-1",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK),
    );
    assert_eq!(runner.delta_strategy(), IngestStrategy::S2);
}

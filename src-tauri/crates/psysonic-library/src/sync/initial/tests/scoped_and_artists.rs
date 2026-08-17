use super::support::*;

#[tokio::test(flavor = "multi_thread")]
async fn scoped_s1_resync_preserves_other_library_on_same_server() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("musicFolderId", "lib-a"))
        .and(query_param("songOffset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "searchResult3": {
                    "song": [{ "id": "a-new", "title": "A new", "duration": 100 }]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("musicFolderId", "lib-a"))
        .and(query_param("songOffset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    seed_two_library_resync(&store, "lib-a");
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "lib-a",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_batch_size(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();
    assert_eq!(report.strategy.as_deref(), Some("s1"));
    assert_scoped_resync_kept_unconfirmed_rows(&store, "a-new");
}

#[tokio::test(flavor = "multi_thread")]
async fn scoped_s2_resync_preserves_other_library_on_same_server() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "lib-a"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [{ "id": "album-new", "name": "New" }] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "lib-a"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", "album-new"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": {
                    "id": "album-new",
                    "name": "New",
                    "song": [{ "id": "a-new", "title": "A new", "duration": 100 }]
                }
            }
        })))
        .mount(&server)
        .await;
    mount_minimal_artists(&server).await;

    let store = LibraryStore::open_in_memory();
    seed_two_library_resync(&store, "lib-a");
    let report = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "lib-a",
        flags(CapabilityFlags::NAVIDROME_NATIVE_BULK),
    )
    .with_batch_size(10)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();
    assert_eq!(report.strategy.as_deref(), Some("s2"));
    assert_scoped_resync_kept_unconfirmed_rows(&store, "a-new");
}

#[tokio::test(flavor = "multi_thread")]
async fn full_resync_prunes_artist_orphaned_by_rename() {
    let server = MockServer::start().await;
    // Ingest one song credited to the *new* artist id (post-rename).
    for page in 0u32..=1 {
        let body = if page == 0 {
            json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": {
                        "song": [{
                            "id": "tr_1",
                            "title": "Song",
                            "duration": 200_i64,
                            "artistId": "ar_new",
                            "artist": "New Name"
                        }]
                    }
                }
            })
        } else {
            json!({ "subsonic-response": { "status": "ok", "searchResult3": {} } })
        };
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", if page == 0 { "0" } else { "1" }))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
    }
    // getArtists returns only the new artist (the old name is gone server-side).
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": 1_716_840_000_000_i64,
                    "ignoredArticles": "",
                    "index": [{
                        "name": "N",
                        "artist": [{ "id": "ar_new", "name": "New Name", "albumCount": 1 }]
                    }]
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
                "scanStatus": { "scanning": false, "count": 1, "lastScan": "2024-06-01T12:00:00Z" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    // Prior full sync → this run is a resync (arms the orphan sweep).
    sync_state.set_last_full_sync_at("s1", "", 1).unwrap();
    // Pre-existing ghost: old artist row + its (now stale) track.
    store
        .with_conn_mut("seed", |c| {
            c.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                 VALUES ('s1', 'ar_old', 'Old Name', 'old name', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO track (server_id, id, title, artist_id, album, duration_sec, \
                   deleted, synced_at, raw_json, resync_gen) \
                 VALUES ('s1', 'tr_old', 'Old', 'ar_old', 'Al', 1, 0, 1, '{}', 0)",
                [],
            )?;
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

    // Stale track soft-deleted, ghost artist pruned, new artist kept.
    let old_track_deleted: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT deleted FROM track WHERE id = 'tr_old'", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(old_track_deleted, 1);

    let artist_ids: Vec<String> = store
        .with_read_conn(|c| {
            let mut stmt = c.prepare("SELECT id FROM artist WHERE server_id = 's1' ORDER BY id")?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(artist_ids, vec!["ar_new"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn full_resync_empty_get_artists_keeps_album_artist_rows() {
    // B1 guard: an empty/partial `getArtists` (transient 200-empty) must not
    // prune album-artist-only rows just because track ingest + backfill
    // advanced the freshest `synced_at`.
    let server = MockServer::start().await;
    for page in 0u32..=1 {
        let body = if page == 0 {
            json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": {
                        "song": [{
                            "id": "tr_1",
                            "title": "Song",
                            "duration": 200_i64,
                            "artistId": "ar_track",
                            "artist": "Track Artist"
                        }]
                    }
                }
            })
        } else {
            json!({ "subsonic-response": { "status": "ok", "searchResult3": {} } })
        };
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", if page == 0 { "0" } else { "1" }))
            .respond_with(ResponseTemplate::new(200).set_body_json(body))
            .mount(&server)
            .await;
    }
    // getArtists returns Ok but with an EMPTY index (no confirmation).
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": { "ignoredArticles": "", "index": [] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": false, "count": 1, "lastScan": "2024-06-01T12:00:00Z" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_last_full_sync_at("s1", "", 1).unwrap();
    // Album-artist-only row (compilation credit): stale stamp, no crediting
    // track. A confirmed pass would re-stamp it; an empty pass must leave it.
    store
        .with_conn_mut("seed", |c| {
            c.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                 VALUES ('s1', 'ar_va', 'Various', 'various', 1)",
                [],
            )
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

    let has_va: i64 = store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM artist WHERE server_id = 's1' AND id = 'ar_va'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        has_va, 1,
        "empty getArtists must not prune album-artist rows"
    );
}

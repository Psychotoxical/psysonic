#[tokio::test(flavor = "multi_thread")]
async fn full_pass_checks_more_than_one_budget_and_stays_in_scope() {
    let server = MockServer::start().await;
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
    let mut rows = Vec::new();
    for i in 0..205 {
        let mut row = TrackRow {
            server_id: "s1".into(),
            id: format!("a-{i:03}"),
            title: format!("A {i}"),
            title_sort: None,
            artist: None,
            artist_id: None,
            album: String::new(),
            album_id: None,
            album_artist: None,
            duration_sec: 0,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: Some("lib-a".into()),
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        };
        rows.push(row.clone());
        if i < 5 {
            row.id = format!("z-{i:03}");
            row.library_id = Some("lib-b".into());
            rows.push(row);
        }
    }
    TrackRepository::new(&store).upsert_batch(&rows).unwrap();

    let report = TombstoneReconciler::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_library_scope("lib-a")
        .with_sleep_disabled()
        .reconcile_full_pass(200)
        .await
        .unwrap();
    assert_eq!(report.checked, 205);
    assert_eq!(report.deleted, 0);

    let untouched: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM track \
                     WHERE library_id = 'lib-b' AND synced_at = 1 AND deleted = 0",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(untouched, 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn tombstone_deletion_refreshes_projection_and_identity() {
    let server = MockServer::start().await;
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
    seed_scoped_track(&store, "tr_gone", 1, Some("lib-a"), Some("album-a"));
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    TombstoneReconciler::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_library_scope("lib-a")
        .with_sleep_disabled()
        .reconcile_chunk(10)
        .await
        .unwrap();
    crate::identity::ensure_cluster_keys_built(&store, "s1").unwrap();

    let (projection, identity): (i64, i64) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*) FROM album_browse_projection \
                         WHERE server_id = 's1' AND library_id = 'lib-a'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key \
                         WHERE server_id = 's1' AND track_id = 'tr_gone'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(projection, 0);
    assert_eq!(identity, 0);
}

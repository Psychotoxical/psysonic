#[tokio::test(flavor = "multi_thread")]
async fn an_album_the_index_never_got_is_fetched() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);
    mount_album_list(
        &server,
        vec![album_summary("al-1", 1, 100), album_summary("al-2", 2, 200)],
    )
    .await;
    mount_album_present(&server, "al-2", &["t-2a", "t-2b"]).await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(report.gaps_filled, 1);
    assert_eq!(
        live_rows(&store, "al-2"),
        2,
        "the delta cannot reach below its watermark; the census can"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_clamped_page_size_does_not_truncate_the_census() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);

    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [
                    album_summary("al-1", 1, 100),
                    album_summary("al-2", 1, 100)
                ] }
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
                "albumList2": { "album": [album_summary("al-3", 1, 100)] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "3"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;
    mount_album_present(&server, "al-2", &["t-2"]).await;
    mount_album_present(&server, "al-3", &["t-3"]).await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(report.server_albums, 3);
    assert_eq!(report.gaps_filled, 2);
    assert_eq!(live_rows(&store, "al-2"), 1);
    assert_eq!(live_rows(&store, "al-3"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_gap_fill_keeps_raw_album_and_song_extensions() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);
    store
        .with_conn_mut("test.seed_retired_gap", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, title_sort, album, album_id, \
                       duration_sec, server_updated_at, deleted, synced_at, raw_json) \
                     VALUES ('s1', 't-2', 'Old title', 'Old title, The', 'Extended', 'al-2', \
                       100, 1700000000000, 1, 1, ?1)",
                rusqlite::params![json!({
                    "id": "t-2",
                    "title": "Old title",
                    "sortTitle": "Old title, The",
                    "updatedAt": "2023-11-14T22:13:20Z"
                })
                .to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    mount_album_list(
        &server,
        vec![album_summary("al-1", 1, 100), album_summary("al-2", 1, 100)],
    )
    .await;
    Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", "al-2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": {
                        "id": "al-2",
                        "name": "Extended",
                        "starred": "2026-07-30T12:00:00Z",
                        "releaseTypes": ["Album"],
                        "song": [{
                            "id": "t-2",
                            "title": "Extended Track",
                            "sortName": "Extended Track, The",
                            "album": "Extended",
                            "albumId": "al-2",
                            "duration": 100,
                            "replayGain": { "trackGain": -7.25 },
                            "contributors": [{ "role": "producer", "artist": { "id": "p1", "name": "Producer" } }],
                            "tags": { "mood": ["Calm"] }
                        }]
                    }
                }
            })))
            .mount(&server)
            .await;

    AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    let (track_raw, album_raw, album_starred, title_sort, server_updated_at): (
        String,
        String,
        Option<i64>,
        Option<String>,
        Option<i64>,
    ) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT raw_json FROM track WHERE id = 't-2'", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT raw_json FROM album WHERE id = 'al-2'", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT starred_at FROM album WHERE id = 'al-2'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row("SELECT title_sort FROM track WHERE id = 't-2'", [], |row| {
                    row.get(0)
                })?,
                conn.query_row(
                    "SELECT server_updated_at FROM track WHERE id = 't-2'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    let track_raw: Value = serde_json::from_str(&track_raw).unwrap();
    let album_raw: Value = serde_json::from_str(&album_raw).unwrap();
    assert_eq!(track_raw["replayGain"]["trackGain"], json!(-7.25));
    assert_eq!(track_raw["tags"]["mood"], json!(["Calm"]));
    assert!(track_raw.get("contributors").is_some());
    assert_eq!(album_raw["releaseTypes"], json!(["Album"]));
    assert!(album_starred.is_some());
    assert_eq!(title_sort.as_deref(), Some("Extended Track, The"));
    assert_eq!(server_updated_at, Some(1_700_000_000_000));
}

#[test]
fn local_inventory_aggregates_an_album_across_libraries() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_projection", |conn| {
            conn.execute(
                "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES ('s1', 'lib-a', 'al-1', 'Split', 4, 800, 1, 't1'), \
                            ('s1', 'lib-b', 'al-1', 'Split', 6, 1200, 1, 't2'), \
                            ('s1', 'lib-a', 'al-2', 'Other', 3, 600, 1, 't3'), \
                            ('s2', 'lib-a', 'al-9', 'Elsewhere', 9, 900, 1, 't9')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let mut inventory = local_album_inventory(&store, "s1").unwrap();
    inventory.sort_by(|a, b| a.album_id.cmp(&b.album_id));

    assert_eq!(
        inventory,
        vec![entry("al-1", 10, 2000), entry("al-2", 3, 600)],
        "an album in two libraries counts once, with its songs summed"
    );
}

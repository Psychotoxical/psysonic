use super::*;
use crate::repos::{TrackRepository, TrackRow};
use crate::store::LibraryStore;
use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
use serde_json::{json, Value};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn track_row(server: &str, id: &str, album_id: &str) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: id.into(),
        title_sort: None,
        artist: Some("A".into()),
        artist_id: Some("ar1".into()),
        album: "Al".into(),
        album_id: Some(album_id.into()),
        album_artist: Some("A".into()),
        duration_sec: 100,
        track_number: Some(1),
        disc_number: Some(1),
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
        library_id: None,
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
    }
}

fn test_client(base: &str) -> SubsonicClient {
    SubsonicClient::with_static_credentials(
        base.to_string(),
        SubsonicCredentials {
            username: "u".into(),
            token: "t".into(),
            salt: "s".into(),
        },
        reqwest::Client::new(),
    )
}

async fn mount_bounded_full_album_pages(server: &MockServer) {
    for page_index in 0..MAX_ALBUM_LIST_REQUESTS_PER_PASS {
        let offset = page_index * ALBUM_PAGE_SIZE;
        let albums = (0..ALBUM_PAGE_SIZE)
            .map(|index| json!({ "id": format!("album-{}", offset + index), "name": "A" }))
            .collect::<Vec<_>>();
        Mock::given(method("GET"))
            .and(path("/rest/getAlbumList2.view"))
            .and(query_param("musicFolderId", "1"))
            .and(query_param("offset", offset.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": albums }
                }
            })))
            .expect(1)
            .mount(server)
            .await;
    }
}

#[test]
fn folders_hash_is_order_independent() {
    let a = vec![
        MusicFolder {
            id: "2".into(),
            name: "B".into(),
        },
        MusicFolder {
            id: "1".into(),
            name: "A".into(),
        },
    ];
    let b = vec![
        MusicFolder {
            id: "1".into(),
            name: "A".into(),
        },
        MusicFolder {
            id: "2".into(),
            name: "B".into(),
        },
    ];
    assert_eq!(folders_hash(&a), folders_hash(&b));
    assert_eq!(folders_hash(&a), "1:A|2:B");
}

#[test]
fn should_run_tagging_pass_gates_no_progress() {
    let prior = TagStateRow {
        folders_hash: "2|1:Main".into(),
        last_untagged_count: 5,
    };
    let completed = TagStateRow {
        folders_hash: "2|1:Main".into(),
        last_untagged_count: 0,
    };
    let legacy = TagStateRow {
        folders_hash: "1:Main".into(),
        last_untagged_count: 0,
    };
    assert!(should_run_tagging_pass(0, None, false, "2|1:Main", true));
    assert!(!should_run_tagging_pass(
        0,
        Some(&completed),
        false,
        "2|1:Main",
        false
    ));
    assert!(should_run_tagging_pass(
        0,
        Some(&legacy),
        false,
        "2|1:Main",
        false
    ));
    assert!(should_run_tagging_pass(
        5,
        Some(&prior),
        false,
        "2|1:Main",
        true
    ));
    assert!(should_run_tagging_pass(
        5,
        Some(&prior),
        true,
        "2|1:Main",
        false
    ));
    assert!(should_run_tagging_pass(
        4,
        Some(&prior),
        false,
        "2|1:Main",
        false
    ));
    assert!(should_run_tagging_pass(
        5,
        Some(&prior),
        false,
        "2|1:Other",
        false
    ));
}

#[tokio::test(flavor = "multi_thread")]
async fn tag_library_membership_tags_by_album_and_respects_prior_tags() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": {
                    "musicFolder": [
                        { "id": 1, "name": "Main" },
                        { "id": 2, "name": "Other" }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [{ "id": "alb-a", "name": "A" }] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "2"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [{ "id": "alb-b", "name": "B" }] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "2"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let mut already = track_row("srv", "t0", "alb-a");
    already.library_id = Some("9".into());
    TrackRepository::new(&store)
        .upsert_batch(&[
            track_row("srv", "t1", "alb-a"),
            track_row("srv", "t2", "alb-b"),
            already,
        ])
        .unwrap();

    let report = tag_library_membership(
        &store,
        &test_client(&server.uri()),
        "srv",
        None,
        Arc::new(super::super::progress::NoopProgress),
        false,
    )
    .await
    .unwrap();

    assert!(!report.skipped);
    assert_eq!(report.folders_processed, 2);
    assert_eq!(report.tracks_tagged, 2);
    assert_eq!(report.untagged_remaining, 0);
    assert!(report.completed);

    let read_library = |id: &str| -> String {
        store
            .with_read_conn(|conn| {
                conn.query_row("SELECT library_id FROM track WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
            })
            .unwrap()
    };
    assert_eq!(read_library("t1"), "1");
    assert_eq!(read_library("t2"), "2");
    assert_eq!(read_library("t0"), "9");
}

#[tokio::test(flavor = "multi_thread")]
async fn empty_folder_list_persists_completion_and_skips_the_next_tick() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": [] }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let store = LibraryStore::open_in_memory();
    let client = test_client(&server.uri());
    let progress = Arc::new(super::super::progress::NoopProgress);

    let first = tag_library_membership(
        &store,
        &client,
        "srv",
        None,
        progress.clone(),
        false,
    )
    .await
    .unwrap();
    assert!(first.skipped);
    assert_eq!(
        read_tag_state(&store, "srv")
            .unwrap()
            .unwrap()
            .folders_hash,
        "2|"
    );

    let second = tag_library_membership(&store, &client, "srv", None, progress, true)
        .await
        .unwrap();
    assert!(second.skipped);
}

#[tokio::test(flavor = "multi_thread")]
async fn initial_tag_pass_enriches_search3_tracks_with_album_versions() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": {
                    "album": [
                        { "id": "standard", "name": "Album", "version": "Standard" },
                        {
                            "id": "deluxe",
                            "name": "Album",
                            "tags": { "albumversion": ["Deluxe Edition"] }
                        }
                    ]
                }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let mut standard = track_row("srv", "standard-track", "standard");
    standard.album = "Album".into();
    standard.album_artist = Some("Artist".into());
    standard.artist = Some("Artist".into());
    standard.library_id = Some("1".into());
    let mut deluxe = track_row("srv", "deluxe-track", "deluxe");
    deluxe.album = "Album".into();
    deluxe.album_artist = Some("Artist".into());
    deluxe.artist = Some("Artist".into());
    deluxe.library_id = Some("1".into());
    TrackRepository::new(&store)
        .upsert_batch(&[standard, deluxe])
        .unwrap();

    let report = tag_library_membership(
        &store,
        &test_client(&server.uri()),
        "srv",
        None,
        Arc::new(super::super::progress::NoopProgress),
        false,
    )
    .await
    .unwrap();
    assert!(!report.skipped);
    assert_eq!(report.tracks_tagged, 0);
    crate::identity::ensure_cluster_keys_built(&store, "srv").unwrap();

    let (standard_key, deluxe_key): (String, String) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT album_key FROM cluster.track_cluster_key \
                     WHERE server_id = 'srv' AND track_id = 'standard-track'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT album_key FROM cluster.track_cluster_key \
                     WHERE server_id = 'srv' AND track_id = 'deluxe-track'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_ne!(standard_key, deluxe_key);
}

#[tokio::test(flavor = "multi_thread")]
async fn pending_version_refresh_retries_after_a_completed_tag_pass() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": {
                    "album": [{ "id": "album-1", "name": "Album", "version": "Fresh" }]
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let mut track = track_row("srv", "tagged", "album-1");
    track.library_id = Some("1".into());
    track.raw_json = json!({ "albumVersion": "Stale" }).to_string();
    TrackRepository::new(&store).upsert_batch(&[track]).unwrap();
    write_tag_completion(&store, "srv", "2|1:Main", 0).unwrap();
    let mut sparse = track_row("srv", "tagged", "album-1");
    sparse.library_id = Some("1".into());
    sparse.raw_json = json!({ "id": "tagged", "title": "Track" }).to_string();
    TrackRepository::new(&store)
        .upsert_sparse_batch_initial_ingest_timed(&[sparse], None)
        .unwrap();
    assert_eq!(
        read_tag_state(&store, "srv")
            .unwrap()
            .unwrap()
            .folders_hash,
        ALBUM_LIST_DIRTY_STATE
    );

    let report = tag_library_membership(
        &store,
        &test_client(&server.uri()),
        "srv",
        None,
        Arc::new(super::super::progress::NoopProgress),
        true,
    )
    .await
    .unwrap();

    assert!(!report.skipped);
    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 'srv' AND id = 'tagged'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["albumVersion"],
        json!("Fresh")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tag_library_membership_skips_when_no_progress_possible() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track_row("srv", "orphan", "no-album")])
        .unwrap();
    write_tag_completion(&store, "srv", "2|1:Main", 1).unwrap();

    let report = tag_library_membership(
        &store,
        &test_client(&server.uri()),
        "srv",
        None,
        Arc::new(super::super::progress::NoopProgress),
        true,
    )
    .await
    .unwrap();

    assert!(report.skipped);
    assert_eq!(report.albums_processed, 0);
    assert_eq!(report.tracks_tagged, 0);
    assert_eq!(report.untagged_remaining, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn tag_library_membership_resumes_from_persisted_page_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .expect(3)
        .mount(&server)
        .await;

    mount_bounded_full_album_pages(&server).await;
    let resume_offset = MAX_ALBUM_LIST_REQUESTS_PER_PASS * ALBUM_PAGE_SIZE;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", resume_offset.to_string()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [{ "id": "last-album", "name": "Last" }] }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", (resume_offset + 1).to_string()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track_row("srv", "orphan", "no-album")])
        .unwrap();
    let client = test_client(&server.uri());
    let progress = Arc::new(super::super::progress::NoopProgress);

    let first = tag_library_membership(
        &store,
        &client,
        "srv",
        None,
        progress.clone(),
        false,
    )
    .await
    .unwrap();
    assert!(!first.completed);
    assert_eq!(first.albums_processed, resume_offset);
    let persisted_offset: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT next_album_offset FROM library_tag_cursor WHERE server_id = 'srv'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(persisted_offset, i64::from(resume_offset));

    let second = tag_library_membership(
        &store,
        &client,
        "srv",
        None,
        progress.clone(),
        false,
    )
    .await
    .unwrap();
    assert!(second.completed);
    assert_eq!(second.albums_processed, 1);
    let cursor_count: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM library_tag_cursor", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(cursor_count, 0);

    let third = tag_library_membership(&store, &client, "srv", None, progress, true)
        .await
        .unwrap();
    assert!(third.skipped);
}

#[tokio::test(flavor = "multi_thread")]
async fn tag_library_membership_finishes_metadata_cursor_when_tracks_are_tagged() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .expect(2)
        .mount(&server)
        .await;
    mount_bounded_full_album_pages(&server).await;
    let resume_offset = MAX_ALBUM_LIST_REQUESTS_PER_PASS * ALBUM_PAGE_SIZE;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", resume_offset.to_string()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track_row("srv", "tagged-on-first-page", "album-0")])
        .unwrap();
    let client = test_client(&server.uri());
    let progress = Arc::new(super::super::progress::NoopProgress);

    let first = tag_library_membership(
        &store,
        &client,
        "srv",
        None,
        progress.clone(),
        false,
    )
    .await
    .unwrap();
    assert!(!first.completed);
    assert_eq!(first.tracks_tagged, 1);
    assert_eq!(first.untagged_remaining, 0);
    assert!(read_tag_cursor(&store, "srv").unwrap().is_some());

    let second = tag_library_membership(&store, &client, "srv", None, progress, true)
        .await
        .unwrap();
    assert!(!second.skipped);
    assert!(second.completed);
    assert_eq!(second.untagged_remaining, 0);
    assert!(read_tag_cursor(&store, "srv").unwrap().is_none());

    let completion = read_tag_state(&store, "srv").unwrap().unwrap();
    assert_eq!(completion.folders_hash, "2|1:Main");
    assert_eq!(completion.last_untagged_count, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn dirty_active_cursor_finishes_then_restarts_from_the_first_page() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    write_tag_cursor(&store, "srv", "2|1:Main", "1", 1).unwrap();
    store
        .with_conn_mut("test.mark_album_list_dirty", |conn| {
            conn.execute(
                "INSERT INTO library_tag_state \
                 (server_id, folders_hash, last_untagged_count, completed_at) \
                 VALUES ('srv', 'dirty', 0, 0)",
                [],
            )
        })
        .unwrap();

    let report = tag_library_membership(
        &store,
        &test_client(&server.uri()),
        "srv",
        None,
        Arc::new(super::super::progress::NoopProgress),
        true,
    )
    .await
    .unwrap();

    assert!(!report.completed);
    let cursor = read_tag_cursor(&store, "srv").unwrap().unwrap();
    assert_eq!(cursor.next_album_offset, 0);
    assert_eq!(cursor.next_folder_id, "1");
    assert!(read_tag_state(&store, "srv").unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn tag_library_membership_restarts_a_legacy_cursor_from_the_first_page() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/getMusicFolders.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "musicFolders": { "musicFolder": { "id": 1, "name": "Main" } }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": {
                    "album": [{ "id": "album-1", "name": "Album", "version": "Deluxe" }]
                }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/getAlbumList2.view"))
        .and(query_param("musicFolderId", "1"))
        .and(query_param("offset", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let mut track = track_row("srv", "tagged", "album-1");
    track.library_id = Some("1".into());
    TrackRepository::new(&store).upsert_batch(&[track]).unwrap();
    write_tag_completion(&store, "srv", "1:Main", 0).unwrap();
    write_tag_cursor(&store, "srv", "1:Old", "1", 500).unwrap();

    let report = tag_library_membership(
        &store,
        &test_client(&server.uri()),
        "srv",
        None,
        Arc::new(super::super::progress::NoopProgress),
        true,
    )
    .await
    .unwrap();

    assert!(!report.skipped);
    assert!(report.completed);
    assert!(read_tag_cursor(&store, "srv").unwrap().is_none());
    assert_eq!(
        read_tag_state(&store, "srv")
            .unwrap()
            .unwrap()
            .folders_hash,
        "2|1:Main"
    );
    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 'srv' AND id = 'tagged'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["albumVersion"],
        json!("Deluxe")
    );
}

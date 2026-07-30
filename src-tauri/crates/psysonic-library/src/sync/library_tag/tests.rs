use super::*;
use crate::repos::{TrackRepository, TrackRow};
use crate::store::LibraryStore;
use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
use serde_json::json;
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
        folders_hash: "1:Main".into(),
        last_untagged_count: 5,
    };
    assert!(!should_run_tagging_pass(0, None, false, "1:Main"));
    assert!(!should_run_tagging_pass(5, Some(&prior), false, "1:Main"));
    assert!(should_run_tagging_pass(5, Some(&prior), true, "1:Main"));
    assert!(should_run_tagging_pass(4, Some(&prior), false, "1:Main"));
    assert!(should_run_tagging_pass(5, Some(&prior), false, "1:Other"));
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
    write_tag_completion(&store, "srv", "1:Main", 1).unwrap();

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

    let third = tag_library_membership(&store, &client, "srv", None, progress, false)
        .await
        .unwrap();
    assert!(third.skipped);
}

#[tokio::test(flavor = "multi_thread")]
async fn tag_library_membership_finalizes_cursor_when_no_untagged_tracks_remain() {
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
    mount_bounded_full_album_pages(&server).await;

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
    assert!(second.skipped);
    assert!(second.completed);
    assert_eq!(second.untagged_remaining, 0);
    assert!(read_tag_cursor(&store, "srv").unwrap().is_none());

    let completion = read_tag_state(&store, "srv").unwrap().unwrap();
    assert_eq!(completion.folders_hash, "1:Main");
    assert_eq!(completion.last_untagged_count, 0);
}

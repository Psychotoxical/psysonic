use super::*;

fn entry(id: &str, songs: i64, duration: i64) -> AlbumInventoryEntry {
    AlbumInventoryEntry {
        album_id: id.into(),
        song_count: Some(songs),
        duration_sec: Some(duration),
    }
}

/// An album the server lists without saying how big it is.
fn shapeless_entry(id: &str) -> AlbumInventoryEntry {
    AlbumInventoryEntry {
        album_id: id.into(),
        song_count: None,
        duration_sec: None,
    }
}

#[test]
fn identical_inventories_produce_nothing() {
    let side = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];
    assert!(diff_inventories(&side, &side).is_empty());
}

#[test]
fn duplicate_server_entries_do_not_duplicate_gap_work() {
    let server = vec![entry("al-1", 10, 2000), entry("al-1", 10, 2000)];

    let diff = diff_inventories(&[], &server);

    assert_eq!(diff.missing_locally, vec!["al-1"]);
}

#[test]
fn an_album_only_the_server_has_is_a_gap() {
    let local = vec![entry("al-1", 10, 2000)];
    let server = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];

    let diff = diff_inventories(&local, &server);
    assert_eq!(diff.missing_locally, vec!["al-2"]);
    assert!(diff.absent_on_server.is_empty());
}

#[test]
fn an_album_only_the_index_has_is_a_removal_candidate() {
    let local = vec![entry("al-1", 10, 2000), entry("al-gone", 7, 1400)];
    let server = vec![entry("al-1", 10, 2000)];

    let diff = diff_inventories(&local, &server);
    assert_eq!(diff.absent_on_server, vec!["al-gone"]);
    assert!(diff.missing_locally.is_empty());
}

#[test]
fn an_album_both_sides_have_is_left_alone_whatever_its_shape() {
    // The census compares presence, not contents. It does not retire
    // individual tracks, so a disagreement about an album's size is one it
    // could never settle: it would re-read the album and fire a refresh on
    // every run, forever. Album contents belong to the paths that confirm
    // per track.
    let local = vec![entry("al-1", 10, 2000)];
    let server = vec![entry("al-1", 11, 2200)];
    assert!(diff_inventories(&local, &server).is_empty());
}

#[test]
fn a_server_that_reports_no_sizes_still_gets_a_presence_check() {
    let local = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];
    let server = vec![shapeless_entry("al-1"), shapeless_entry("al-3")];

    let diff = diff_inventories(&local, &server);
    assert_eq!(diff.missing_locally, vec!["al-3"]);
    assert_eq!(diff.absent_on_server, vec!["al-2"]);
}

#[test]
fn the_cap_refuses_a_run_that_would_gut_the_library() {
    // 3000 of 12,746 albums is not a user deleting music between two
    // passes; it is an enumeration that went wrong.
    assert!(!removal_is_within_cap(
        3_000,
        12_746,
        CENSUS_REMOVAL_CAP_PERCENT
    ));
}

#[test]
fn the_cap_lets_an_ordinary_cleanup_through() {
    assert!(removal_is_within_cap(
        30,
        12_746,
        CENSUS_REMOVAL_CAP_PERCENT
    ));
    assert!(removal_is_within_cap(0, 0, CENSUS_REMOVAL_CAP_PERCENT));
}

#[test]
fn the_cap_does_not_block_ordinary_small_library_deletions() {
    assert!(removal_is_within_cap(1, 4, CENSUS_REMOVAL_CAP_PERCENT));
    assert!(removal_is_within_cap(4, 4, CENSUS_REMOVAL_CAP_PERCENT));
}

#[test]
fn nothing_local_means_nothing_to_remove() {
    assert!(!removal_is_within_cap(5, 0, CENSUS_REMOVAL_CAP_PERCENT));
}

// ── runner behaviour ─────────────────────────────────────────────────
//
// These drive the real HTTP paths through wiremock. The interesting cases
// are the ones where the server's answer is incomplete or wrong, because
// that is where a census can destroy a library.

use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
use serde_json::json;
use wiremock::matchers::{method as wm_method, path as wm_path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn test_subsonic(uri: &str) -> SubsonicClient {
    SubsonicClient::with_static_credentials(
        uri,
        SubsonicCredentials::with_static("user", "tok", "salt"),
        reqwest::Client::new(),
    )
}

/// A server whose catalogue is in. The census refuses to run on anything
/// else, so every runner test needs it.
fn mark_ready(store: &LibraryStore) {
    let sync_state = crate::repos::SyncStateRepository::new(store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_sync_phase("s1", "", "ready").unwrap();
}

/// One album in the index: its live tracks plus the projection row the
/// census reads.
fn seed_album(store: &LibraryStore, album_id: &str, song_ids: &[&str], duration: i64) {
    store
        .with_conn_mut("test.seed_album", |conn| {
            for id in song_ids {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, album_id, duration_sec, \
                         deleted, synced_at, raw_json) \
                         VALUES ('s1', ?1, 'Title', 'Album', ?2, ?3, 0, 1, '{}')",
                    rusqlite::params![id, album_id, duration / song_ids.len().max(1) as i64],
                )?;
            }
            conn.execute(
                "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES ('s1', '', ?1, 'Album', ?2, ?3, 1, ?4)",
                rusqlite::params![
                    album_id,
                    song_ids.len() as i64,
                    duration,
                    song_ids.first().copied().unwrap_or("t0")
                ],
            )?;
            Ok(())
        })
        .unwrap();
}

fn album_summary(id: &str, songs: i64, duration: i64) -> serde_json::Value {
    json!({ "id": id, "name": "Album", "songCount": songs, "duration": duration })
}

async fn mount_album_list(server: &MockServer, albums: Vec<serde_json::Value>) {
    let next_offset = albums.len();
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": albums } }
        })))
        .mount(server)
        .await;
    if next_offset > 0 {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", next_offset.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
            })))
            .mount(server)
            .await;
    }
}

async fn mount_album_gone(server: &MockServer, album_id: &str) {
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", album_id))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Album not found" }
            }
        })))
        .mount(server)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_budget_returns_an_exact_no_change_report() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .with_deadline(Instant::now())
        .run()
        .await
        .unwrap();

    assert!(report.budget_exhausted);
    assert!(report.enumeration_incomplete);
    assert_eq!(report.deferred, 0);
    assert!(!report.changed_index());
    assert_eq!(live_rows(&store, "al-1"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_in_flight_enumeration_request_cannot_outlive_the_budget() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_secs(5))
                .set_body_json(json!({
                    "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
                })),
        )
        .expect(1)
        .mount(&server)
        .await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);

    let report = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .with_deadline(Instant::now() + std::time::Duration::from_millis(500))
            .run(),
    )
    .await
    .expect("the census must enforce its own deadline")
    .unwrap();

    assert!(report.budget_exhausted);
    assert!(report.enumeration_incomplete);
    assert_eq!(
        report.deferred, 0,
        "the runner does not know a resumable backlog yet"
    );
    assert_eq!(live_rows(&store, "al-1"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_in_flight_gap_probe_returns_an_exact_deferred_report() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);
    mount_album_list(
        &server,
        vec![album_summary("al-1", 1, 100), album_summary("al-2", 1, 100)],
    )
    .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(query_param("id", "al-2"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_secs(5))
                .set_body_json(json!({
                    "subsonic-response": {
                        "status": "ok",
                        "album": { "id": "al-2", "name": "Album", "song": [] }
                    }
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let report = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
            .with_sleep_disabled()
            .with_deadline(Instant::now() + std::time::Duration::from_secs(1))
            .run(),
    )
    .await
    .expect("the gap probe must not outlive the census deadline")
    .unwrap();

    assert!(report.budget_exhausted);
    assert!(!report.enumeration_incomplete);
    assert_eq!(report.server_albums, 2);
    assert_eq!(report.deferred, 1);
    assert!(!report.changed_index());
    assert_eq!(live_rows(&store, "al-2"), 0);
}

async fn mount_album_present(server: &MockServer, album_id: &str, song_ids: &[&str]) {
    let songs: Vec<_> = song_ids
            .iter()
            .map(|id| json!({ "id": id, "title": "Title", "album": "Album", "albumId": album_id, "duration": 100 }))
            .collect();
    Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", album_id))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": { "id": album_id, "name": "Album", "songCount": song_ids.len(), "song": songs }
                }
            })))
            .mount(server)
            .await;
}

fn live_rows(store: &LibraryStore, album_id: &str) -> i64 {
    store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM track WHERE album_id = ?1 AND deleted = 0",
                rusqlite::params![album_id],
                |r| r.get(0),
            )
        })
        .unwrap()
}

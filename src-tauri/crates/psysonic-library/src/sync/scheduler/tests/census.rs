use super::*;
use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
use serde_json::json;
use wiremock::matchers::{method as wm_method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn test_subsonic(uri: &str) -> SubsonicClient {
    SubsonicClient::with_static_credentials(
        uri,
        SubsonicCredentials::with_static("user", "tok", "salt"),
        reqwest::Client::new(),
    )
}

fn flags(bits: u32) -> CapabilityFlags {
    CapabilityFlags::new(bits)
}

async fn empty_probe_and_albumlist(server: &MockServer, last_modified: i64) {
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": last_modified,
                    "ignoredArticles": "",
                    "index": []
                }
            }
        })))
        .mount(server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "albumList2": { "album": [] }
            }
        })))
        .mount(server)
        .await;
}

// ── census ────────────────────────────────────────────────────────

/// One album in the index, with the projection row the census reads.
fn seed_album(store: &LibraryStore, server_id: &str, album_id: &str, track_id: &str) {
    store
        .with_conn_mut("test.seed_album", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, album_id, duration_sec, \
                     deleted, synced_at, raw_json) \
                     VALUES (?1, ?2, 'Title', 'Album', ?3, 100, 0, 1, '{}')",
                rusqlite::params![server_id, track_id, album_id],
            )?;
            conn.execute(
                "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES (?1, '', ?2, 'Album', 1, 100, 1, ?3)",
                rusqlite::params![server_id, album_id, track_id],
            )?;
            Ok(())
        })
        .unwrap();
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

#[tokio::test(flavor = "multi_thread")]
async fn a_tick_censuses_and_schedules_the_next_one() {
    let server = MockServer::start().await;
    // Only the artists probe from the shared helper — its album-list mock
    // answers every `getAlbumList2` with an empty page and would shadow the
    // enumeration this test is about.
    Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": { "lastModified": 1_716_840_000_000_i64, "ignoredArticles": "", "index": [] }
                }
            })))
            .mount(&server)
            .await;
    // The enumeration lists ten of the eleven albums the index holds, and
    // the missing one answers "gone" when asked directly.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(wiremock::matchers::query_param("id", "al-gone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Album not found" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    for index in 0..10 {
        seed_album(&store, "s1", &format!("al-{index}"), &format!("t-{index}"));
    }
    seed_album(&store, "s1", "al-gone", "t-gone");
    let listed: Vec<_> = (0..10)
            .map(|i| json!({ "id": format!("al-{i}"), "name": "Album", "songCount": 1, "duration": 100 }))
            .collect();
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(wiremock::matchers::query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": listed } }
        })))
        .mount(&server)
        .await;
    // The delta crawls the same list, so every other album id needs a valid
    // answer. Mounted after the `al-gone` mock, which therefore keeps
    // winning for that one id.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": { "id": "al-other", "name": "Album", "songCount": 0, "song": [] }
            }
        })))
        .mount(&server)
        .await;
    // Everything after the first page — and whatever else asks for an album
    // list this tick — gets an empty one. Mounted second on purpose: the
    // first matching mock answers.
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;

    let subsonic = test_subsonic(&server.uri());
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    // The census only runs for a server whose catalogue is in.
    sync_state.set_sync_phase("s1", "", "ready").unwrap();

    BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(1_000_000)
    .await
    .unwrap();

    assert_eq!(live_rows(&store, "al-gone"), 0, "the census removed it");
    assert_eq!(live_rows(&store, "al-0"), 1, "the rest is untouched");
    // Retiring an album moves the live count more than any delta does, and
    // that count is one of the two inputs to the auto-tombstone threshold.
    // Left unstamped, the next tick reads a surplus that no longer exists
    // and burns a full mismatch pass chasing it.
    assert_eq!(
        sync_state.get_local_track_count("s1", "").unwrap(),
        Some(10),
        "the census must leave the live count matching what it retired"
    );

    let stats = sync_state
        .get_poll_stats_json("s1", "")
        .unwrap()
        .map(|value| serde_json::from_value::<PollStats>(value).unwrap_or_default())
        .unwrap_or_default();
    assert_eq!(
        stats.next_census_at_ms,
        Some(1_000_000 + CENSUS_INTERVAL_MS),
        "a clean run waits a full interval"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_active_server_scan_skips_tagging_and_census() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": true, "count": 10 }
            }
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .expect(0)
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    seed_album(&store, "s1", "al-local", "t-local");
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_sync_phase("s1", "", "ready").unwrap();
    sync_state.set_library_tier("s1", "", "huge").unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_sleep_disabled()
    .tick(1_000_000)
    .await
    .unwrap();

    assert!(report
        .delta
        .as_ref()
        .is_some_and(|delta| delta.deferred_scanning));
    assert!(!report.census_changed_index);
    assert_eq!(live_rows(&store, "al-local"), 1);
    assert_eq!(report.next_poll_at_ms, 1_030_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scoped_scheduler_never_censuses() {
    // Deliberately the same fixture as the test above, minus the scope: the
    // enumeration answers, the server-wide row is `ready`, `al-gone` reports
    // itself gone. Everything the census needs is in place, so the *only*
    // thing that can hold it back is the scope guard — remove that guard and
    // this test fails. An earlier version seeded neither the ready phase nor
    // a non-empty album list, which meant it passed for two unrelated
    // reasons and could not have caught the guard's removal.
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": { "lastModified": 1_716_840_000_000_i64, "ignoredArticles": "", "index": [] }
                }
            })))
            .mount(&server)
            .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .and(wiremock::matchers::query_param("id", "al-gone"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Album not found" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    for index in 0..10 {
        seed_album(&store, "s1", &format!("al-{index}"), &format!("t-{index}"));
    }
    seed_album(&store, "s1", "al-gone", "t-gone");
    let listed: Vec<_> = (0..10)
        .map(|index| json!({ "id": format!("al-{index}"), "name": "Album", "songCount": 1 }))
        .collect();
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .and(wiremock::matchers::query_param("offset", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": listed } }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbum.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "album": { "id": "al-other", "name": "Album", "songCount": 0, "song": [] }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getAlbumList2.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
        })))
        .mount(&server)
        .await;

    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "lib-a").unwrap();
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_sync_phase("s1", "", "ready").unwrap();

    let subsonic = test_subsonic(&server.uri());
    BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "lib-a",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(1_000_000)
    .await
    .unwrap();

    // `getAlbumList2` is server-wide, so a scoped run would read every
    // other library's albums as gaps and this library's as absent.
    assert_eq!(live_rows(&store, "al-gone"), 1);
}

/// The schedule is reserved before the run starts, so the readiness gate has
/// to sit next to the reservation and not only inside the run. Otherwise a
/// tick taken while the catalogue is still coming in books the next slot for
/// a pass that immediately bails, and the first census that could actually
/// close the ingest's gaps is a whole interval late.
#[tokio::test(flavor = "multi_thread")]
async fn a_tick_before_the_catalogue_is_in_does_not_burn_the_census_slot() {
    let server = MockServer::start().await;
    empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    // Not `initial_sync` — that would short-circuit the whole tick as a
    // sync pass in flight. `idle` is the phase a server sits in before its
    // first successful sync, and the census must not count it as ready.
    sync_state.set_sync_phase("s1", "", "idle").unwrap();

    let subsonic = test_subsonic(&server.uri());
    BackgroundScheduler::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .tick(1_000_000)
    .await
    .unwrap();

    let stats = sync_state
        .get_poll_stats_json("s1", "")
        .unwrap()
        .map(|value| serde_json::from_value::<PollStats>(value).unwrap_or_default())
        .unwrap_or_default();
    assert_eq!(
        stats.next_census_at_ms, None,
        "the slot stays unclaimed, so the first census runs as soon as the index is ready"
    );
}

#[test]
fn only_a_census_that_made_progress_gets_the_early_retry() {
    let enumeration_timeout = CensusReport {
        budget_exhausted: true,
        enumeration_incomplete: true,
        ..CensusReport::default()
    };
    assert!(!census_needs_early_retry(&enumeration_timeout));

    let probe_timeout = CensusReport {
        budget_exhausted: true,
        deferred: 1,
        ..CensusReport::default()
    };
    assert!(!census_needs_early_retry(&probe_timeout));

    let partial_progress = CensusReport {
        gaps_filled: 1,
        budget_exhausted: true,
        deferred: 1,
        ..CensusReport::default()
    };
    assert!(census_needs_early_retry(&partial_progress));
}

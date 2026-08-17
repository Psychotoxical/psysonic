use super::*;
use crate::repos::TrackRow;
use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
use serde_json::json;
use wiremock::matchers::{header, method as wm_method, path as wm_path, query_param};
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

fn seed_track(store: &LibraryStore, id: &str, album_id: &str, server_updated_at: i64) {
    TrackRepository::new(store)
        .upsert_batch(&[TrackRow {
            server_id: "s1".into(),
            id: id.into(),
            title: "seed".into(),
            title_sort: None,
            artist: None,
            artist_id: None,
            album: "A".into(),
            album_id: Some(album_id.into()),
            album_artist: None,
            duration_sec: 240,
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
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: Some(server_updated_at),
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }])
        .unwrap();
}

// ── DS-2: getArtists watermark match → short-circuit ─────────────

#[tokio::test(flavor = "multi_thread")]
async fn ds2_short_circuits_when_artists_watermark_matches() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getArtists.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "artists": {
                    "lastModified": 1_700_000_000_000_i64,
                    "ignoredArticles": "",
                    "index": []
                }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state
        .set_artists_last_modified_ms("s1", "", 1_700_000_000_000)
        .unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = DeltaSyncRunner::new(
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

    assert!(report.up_to_date);
    assert_eq!(report.changed_count, 0);
    assert!(!report.deferred_scanning);
}

// ── DS-3: huge-tier scan in progress → defer ─────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn ds3_defers_when_getscanstatus_is_scanning() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "scanStatus": { "scanning": true, "count": 10000 }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_library_tier("s1", "", "huge").unwrap();

    let subsonic = test_subsonic(&server.uri());
    let report = DeltaSyncRunner::new(
        &store,
        &subsonic,
        "s1",
        "",
        flags(CapabilityFlags::SCAN_STATUS_AVAILABLE),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap();

    assert!(report.deferred_scanning);
    assert!(!report.up_to_date);
    assert_eq!(report.changed_count, 0);
}

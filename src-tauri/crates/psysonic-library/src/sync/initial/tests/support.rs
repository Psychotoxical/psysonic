pub(super) use std::sync::atomic::AtomicBool;
pub(super) use std::sync::Arc;

pub(super) use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
pub(super) use serde_json::json;
pub(super) use wiremock::matchers::{header, method as wm_method, path as wm_path, query_param};
pub(super) use wiremock::{Mock, MockServer, ResponseTemplate};

pub(super) use super::super::bulk_ingest::{BulkIngestGuard, BulkIngestPragmas};
pub(super) use super::super::InitialSyncRunner;
pub(super) use crate::repos::{SyncStateRepository, TrackRepository, TrackRow};
pub(super) use crate::store::LibraryStore;
pub(super) use crate::sync::capability::{CapabilityFlags, NavidromeProbeCredentials};
pub(super) use crate::sync::cursor::{CursorPhase, InitialSyncCursor};
pub(super) use crate::sync::error::SyncError;
pub(super) use crate::sync::poll_stats::{PollStats, ResyncSweepSkipReason};
pub(super) use crate::sync::progress::{Progress, ProgressEvent};

pub(super) fn flags(bits: u32) -> CapabilityFlags {
    CapabilityFlags::new(bits)
}

pub(super) fn test_subsonic(uri: &str) -> SubsonicClient {
    SubsonicClient::with_static_credentials(
        uri,
        SubsonicCredentials::with_static("user", "tok", "salt"),
        reqwest::Client::new(),
    )
}

pub(super) fn test_track_row(id: &str, title: &str) -> TrackRow {
    TrackRow {
        server_id: "s1".into(),
        id: id.into(),
        title: title.into(),
        title_sort: None,
        artist: None,
        artist_id: None,
        album: "Album".into(),
        album_id: None,
        album_artist: None,
        duration_sec: 1,
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
        server_updated_at: None,
        server_created_at: None,
        deleted: false,
        synced_at: 1,
        raw_json: "{}".into(),
    }
}

pub(super) async fn mount_search3_pages(server: &MockServer, total: u32, batch: u32) {
    let mut offset = 0;
    while offset < total {
        let received = (total - offset).min(batch);
        let songs: Vec<_> = (0..received)
            .map(|i| {
                json!({
                    "id": format!("tr_{:04}", offset + i),
                    "title": format!("Title {}", offset + i),
                    "duration": 200_i64 + (offset + i) as i64,
                })
            })
            .collect();
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", offset.to_string()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": { "song": songs }
                }
            })))
            .mount(server)
            .await;
        offset += received;
    }
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .and(query_param("songOffset", total.to_string()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .mount(server)
        .await;
}

pub(super) async fn mount_minimal_artists(server: &MockServer) {
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
        .mount(server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                // No `count`: these fixtures are about ingest and sweep
                // mechanics, not catalogue size, and a count that disagrees
                // with the search3 pages is not a server state worth
                // asserting against — IS-7 now refuses to sweep on exactly
                // that mismatch. Tests that care set the count explicitly.
                "scanStatus": {
                    "scanning": false,
                    "lastScan": "2024-06-01T12:00:00Z"
                }
            }
        })))
        .mount(server)
        .await;
}

pub(super) fn seed_two_library_resync(store: &LibraryStore, scope: &str) {
    let sync_state = SyncStateRepository::new(store);
    sync_state.ensure("s1", scope).unwrap();
    sync_state.set_last_full_sync_at("s1", scope, 1).unwrap();
    store
        .with_conn_mut("test.seed_two_library_resync", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, album_id, library_id, \
                   duration_sec, deleted, synced_at, raw_json, resync_gen) \
                 VALUES ('s1', 'a-stale', 'A stale', 'A', 'album-a', 'lib-a', \
                   1, 0, 1, '{}', 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, album_id, library_id, \
                   duration_sec, deleted, synced_at, raw_json, resync_gen) \
                 VALUES ('s1', 'b-keep', 'B keep', 'B', 'album-b', 'lib-b', \
                   1, 0, 1, '{}', 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
}

pub(super) fn assert_scoped_resync_kept_unconfirmed_rows(store: &LibraryStore, new_id: &str) {
    let (stale_deleted, other_deleted, new_library): (i64, i64, String) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT deleted FROM track WHERE id = 'a-stale'", [], |r| {
                    r.get(0)
                })?,
                conn.query_row("SELECT deleted FROM track WHERE id = 'b-keep'", [], |r| {
                    r.get(0)
                })?,
                conn.query_row(
                    "SELECT library_id FROM track WHERE id = ?1",
                    [new_id],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(stale_deleted, 0);
    assert_eq!(other_deleted, 0);
    assert_eq!(new_library, "lib-a");
    let stats: PollStats = serde_json::from_value(
        SyncStateRepository::new(store)
            .get_poll_stats_json("s1", "lib-a")
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        stats.last_resync_sweep_skip.map(|skip| skip.reason),
        Some(ResyncSweepSkipReason::MissingExpectedCount)
    );
}

pub(super) fn current_bulk_pragmas(store: &LibraryStore) -> BulkIngestPragmas {
    store
        .with_conn("test.bulk_pragmas", BulkIngestPragmas::capture)
        .unwrap()
}

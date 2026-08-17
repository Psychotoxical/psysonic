use super::*;
use crate::repos::{TrackRepository, TrackRow};
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

fn seed_track(store: &LibraryStore, id: &str, synced_at: i64) {
    seed_scoped_track(store, id, synced_at, None, None);
}

fn seed_scoped_track(
    store: &LibraryStore,
    id: &str,
    synced_at: i64,
    library_id: Option<&str>,
    album_id: Option<&str>,
) {
    TrackRepository::new(store)
        .upsert_batch(&[TrackRow {
            server_id: "s1".into(),
            id: id.into(),
            title: id.into(),
            title_sort: None,
            artist: None,
            artist_id: None,
            album: String::new(),
            album_id: album_id.map(str::to_string),
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
            library_id: library_id.map(str::to_string),
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
            synced_at,
            raw_json: "{}".into(),
        }])
        .unwrap();
}

// ── should_auto_reconcile threshold predicate ─────────────────────

#[test]
fn threshold_fires_when_local_outpaces_server_above_pct() {
    // 110 local vs 100 server → 10% gap > 5% threshold.
    assert!(should_auto_reconcile(110, 100, 5));
}

#[test]
fn threshold_stays_silent_within_tolerance() {
    // 102 local vs 100 server → 2% gap, threshold 5%.
    assert!(!should_auto_reconcile(102, 100, 5));
}

#[test]
fn threshold_silent_when_local_is_below_or_equal_server() {
    assert!(!should_auto_reconcile(100, 100, 0));
    assert!(!should_auto_reconcile(50, 100, 5));
}

#[test]
fn threshold_silent_when_server_count_is_zero() {
    // No signal — never reconcile on a server that's still scanning.
    assert!(!should_auto_reconcile(1000, 0, 5));
}

#[test]
fn threshold_stays_silent_for_scoped_counts() {
    assert!(!should_auto_reconcile_scope("music-folder", 110, 100, 5));
}

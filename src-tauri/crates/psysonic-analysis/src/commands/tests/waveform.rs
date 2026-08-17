use super::super::*;
use super::support::upsert_waveform;
use crate::analysis_cache::{AnalysisCache, WaveformEntry};

#[test]
fn get_waveform_payload_returns_none_for_unknown_key() {
    let cache = AnalysisCache::open_in_memory();
    let payload = get_waveform_payload(&cache, "server-a", "missing", "deadbeef").unwrap();
    assert!(payload.is_none());
}

#[test]
fn get_waveform_payload_returns_payload_for_existing_row() {
    let cache = AnalysisCache::open_in_memory();
    let bins: Vec<u8> = (0..8u8).collect();
    upsert_waveform(&cache, "abc", "deadbeef", bins.clone());
    let payload = get_waveform_payload(&cache, "server-a", "abc", "deadbeef")
        .unwrap()
        .expect("payload exists");
    assert_eq!(payload.bins, bins);
    assert_eq!(payload.bin_count, 4);
    assert!(!payload.is_partial);
    assert_eq!(payload.duration_sec, 60.0);
    assert_eq!(payload.updated_at, 1_700_000_000);
}

#[test]
fn get_waveform_payload_distinguishes_md5_keys() {
    // Same track_id, different md5_16kb → independent rows.
    let cache = AnalysisCache::open_in_memory();
    upsert_waveform(&cache, "abc", "aaaa", vec![0u8; 8]);
    upsert_waveform(&cache, "abc", "bbbb", vec![0xFFu8; 8]);
    let p1 = get_waveform_payload(&cache, "server-a", "abc", "aaaa")
        .unwrap()
        .unwrap();
    let p2 = get_waveform_payload(&cache, "server-a", "abc", "bbbb")
        .unwrap()
        .unwrap();
    assert_ne!(p1.bins, p2.bins);
}

#[test]
fn get_waveform_for_track_finds_row_under_stream_prefix() {
    // Insert under `stream:abc`, look up with bare `abc` — id-variant
    // matching is the whole point of get_latest_waveform_for_track.
    let cache = AnalysisCache::open_in_memory();
    upsert_waveform(&cache, "stream:abc", "deadbeef", vec![1u8; 8]);
    let payload = get_waveform_payload_for_track(&cache, "server-a", "abc")
        .unwrap()
        .expect("bare-id lookup must hit the stream-prefixed row");
    assert_eq!(payload.bin_count, 4);
}

#[test]
fn get_waveform_for_track_returns_none_for_unknown_track() {
    let cache = AnalysisCache::open_in_memory();
    assert!(
        get_waveform_payload_for_track(&cache, "server-a", "phantom")
            .unwrap()
            .is_none()
    );
}

#[test]
fn waveform_payload_from_entry_preserves_all_fields() {
    let entry = WaveformEntry {
        bins: vec![1, 2, 3, 4],
        bin_count: 2,
        is_partial: true,
        known_until_sec: 5.5,
        duration_sec: 10.0,
        updated_at: 42,
    };
    let payload = WaveformCachePayload::from(entry);
    assert_eq!(payload.bins, vec![1, 2, 3, 4]);
    assert_eq!(payload.bin_count, 2);
    assert!(payload.is_partial);
    assert_eq!(payload.known_until_sec, 5.5);
    assert_eq!(payload.duration_sec, 10.0);
    assert_eq!(payload.updated_at, 42);
}

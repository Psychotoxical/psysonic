use super::super::*;
use super::support::upsert_loudness;
use crate::analysis_cache::AnalysisCache;

#[test]
fn get_loudness_for_track_recomputes_gain_against_requested_target() {
    let cache = AnalysisCache::open_in_memory();
    upsert_loudness(&cache, "abc", "deadbeef", -14.0);
    // Cached row: integrated -14, target -14 → gain 0. Request target -10 →
    // recommended gain = -10 - (-14) = +4 dB (capped by true-peak guard).
    let payload = get_loudness_payload_for_track(&cache, "server-a", "abc", Some(-10.0))
        .unwrap()
        .expect("loudness row exists");
    assert_eq!(payload.target_lufs, -10.0);
    assert!(
        payload.recommended_gain_db.is_finite() && payload.recommended_gain_db <= 4.0,
        "recommended_gain_db must reflect the new target, got {}",
        payload.recommended_gain_db
    );
}

#[test]
fn get_loudness_for_track_uses_cached_target_when_request_is_none() {
    let cache = AnalysisCache::open_in_memory();
    upsert_loudness(&cache, "abc", "deadbeef", -16.0);
    let payload = get_loudness_payload_for_track(&cache, "server-a", "abc", None)
        .unwrap()
        .unwrap();
    assert_eq!(payload.target_lufs, -16.0);
}

#[test]
fn get_loudness_for_track_clamps_target_into_supported_range() {
    let cache = AnalysisCache::open_in_memory();
    upsert_loudness(&cache, "abc", "deadbeef", -14.0);
    // Out-of-range target gets clamped to [-30, -8].
    let too_high = get_loudness_payload_for_track(&cache, "server-a", "abc", Some(0.0))
        .unwrap()
        .unwrap();
    assert_eq!(too_high.target_lufs, -8.0);
    let too_low = get_loudness_payload_for_track(&cache, "server-a", "abc", Some(-100.0))
        .unwrap()
        .unwrap();
    assert_eq!(too_low.target_lufs, -30.0);
}

#[test]
fn get_loudness_for_track_returns_none_for_unknown_track() {
    let cache = AnalysisCache::open_in_memory();
    assert!(
        get_loudness_payload_for_track(&cache, "server-a", "phantom", None)
            .unwrap()
            .is_none()
    );
}

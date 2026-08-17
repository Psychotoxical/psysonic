use super::*;

fn approx(a: f32, b: f32, eps: f32) {
    assert!((a - b).abs() < eps, "expected {b}, got {a}");
}

#[test]
fn provisional_returns_none_for_zero_total() {
    assert!(provisional_loudness_gain_from_progress(100, 0, -14.0, -2.0).is_none());
}

#[test]
fn provisional_returns_none_for_zero_downloaded() {
    assert!(provisional_loudness_gain_from_progress(0, 1000, -14.0, -2.0).is_none());
}

#[test]
fn provisional_clamps_start_db_into_range() {
    // start_db_in is clamped to [-24, 0] then min(0). +5 dB is invalid → 0.
    let g = provisional_loudness_gain_from_progress(1, 100, -14.0, 5.0).unwrap();
    // At progress ≈ 0, gain ≈ start_db; clamp pushed start_db to 0.
    // shaped(0.01) = 0.01.powf(0.75) ≈ 0.0316; gain ≈ 0 + (end_db - 0)*0.0316.
    // end_db = (-14 + 6).clamp(-10, -3) = -8 → gain ≈ -0.253
    approx(g, -0.253, 0.05);
}

#[test]
fn provisional_at_full_progress_reaches_end_db() {
    // end_db = (target_lufs + 6).clamp(-10, -3).min(0)
    // target_lufs = -14 → -8
    let g = provisional_loudness_gain_from_progress(100, 100, -14.0, -2.0).unwrap();
    approx(g, -8.0, 0.001);
}

#[test]
fn provisional_clamps_end_db_to_minus_three_floor() {
    // target_lufs = 0 → end_db = (0 + 6).clamp(-10, -3) = -3
    let g = provisional_loudness_gain_from_progress(100, 100, 0.0, 0.0).unwrap();
    approx(g, -3.0, 0.001);
}

#[test]
fn placeholder_clamps_pre_analysis_into_negative_range() {
    // Pre = +5 → clamped to 0; pivot is just recommended_gain_for_target value.
    let g_pos = loudness_gain_placeholder_until_cache(-14.0, 5.0);
    let g_zero = loudness_gain_placeholder_until_cache(-14.0, 0.0);
    assert_eq!(g_pos, g_zero, "positive pre-analysis must be clamped to 0");
}

#[test]
fn placeholder_lifts_when_target_above_pivot() {
    // Pivot integrated LUFS = -14. Higher target (e.g. -10) means more gain.
    let lower = loudness_gain_placeholder_until_cache(-23.0, 0.0);
    let higher = loudness_gain_placeholder_until_cache(-10.0, 0.0);
    assert!(higher > lower, "higher target_lufs must yield higher gain");
}

#[test]
fn placeholder_clamps_result_into_plus_minus_24() {
    let g = loudness_gain_placeholder_until_cache(-14.0, -50.0);
    assert!((-24.0..=24.0).contains(&g));
}

#[test]
fn after_resolve_returns_cache_value_when_present() {
    assert_eq!(
        loudness_gain_db_after_resolve(Some(-3.5), -14.0, 0.0, true, Some(-9.9)),
        Some(-3.5),
        "cache hit must win over JS hint"
    );
}

#[test]
fn after_resolve_uses_js_hint_when_uncached_and_allowed() {
    assert_eq!(
        loudness_gain_db_after_resolve(None, -14.0, 0.0, true, Some(-7.0)),
        Some(-7.0),
    );
}

#[test]
fn after_resolve_ignores_non_finite_js_hint() {
    let g = loudness_gain_db_after_resolve(None, -14.0, 0.0, true, Some(f32::INFINITY))
        .expect("uncached fallback always returns Some");
    // Falls through to placeholder; just verify it's a valid finite gain.
    assert!(g.is_finite());
}

#[test]
fn after_resolve_uses_placeholder_when_js_disabled() {
    let with_js = loudness_gain_db_after_resolve(None, -14.0, 0.0, true, Some(-2.0));
    let without_js = loudness_gain_db_after_resolve(None, -14.0, 0.0, false, Some(-2.0));
    assert_eq!(with_js, Some(-2.0));
    assert_ne!(
        with_js, without_js,
        "allow_js_when_uncached=false ignores js hint"
    );
}

#[test]
fn compute_gain_off_mode_returns_unity_linear() {
    let (lin, eff) = compute_gain(0, Some(-3.0), Some(1.0), Some(-3.0), 0.0, 0.0, 1.0);
    assert_eq!(lin, 1.0, "off mode ignores all gain inputs");
    approx(eff, MASTER_HEADROOM, 0.001);
}

#[test]
fn compute_gain_clamps_volume_into_zero_one() {
    let (_, eff_low) = compute_gain(0, None, None, None, 0.0, 0.0, -1.0);
    let (_, eff_high) = compute_gain(0, None, None, None, 0.0, 0.0, 5.0);
    assert_eq!(eff_low, 0.0, "negative volume clamps to 0");
    approx(eff_high, MASTER_HEADROOM, 0.001);
}

#[test]
fn compute_gain_replaygain_mode_uses_replay_gain_db_with_pre_gain() {
    // replay_gain_db = -6, pre_gain_db = +3 → effective dB = -3 → linear ≈ 0.7079
    let (lin, _) = compute_gain(1, Some(-6.0), Some(1.0), None, 3.0, 0.0, 1.0);
    approx(lin, 10f32.powf(-3.0 / 20.0), 0.001);
}

#[test]
fn compute_gain_replaygain_falls_back_when_replay_gain_db_missing() {
    // No replay_gain_db → uses fallback_db (-6 → linear ≈ 0.5)
    let (lin, _) = compute_gain(1, None, Some(1.0), None, 0.0, -6.0, 1.0);
    approx(lin, 10f32.powf(-6.0 / 20.0), 0.001);
}

#[test]
fn compute_gain_replaygain_caps_by_inverse_peak() {
    // replay_gain_db = +12 → linear ≈ 3.98, but peak = 2 caps it to 1/2 = 0.5.
    let (lin, _) = compute_gain(1, Some(12.0), Some(2.0), None, 0.0, 0.0, 1.0);
    approx(lin, 0.5, 0.001);
}

#[test]
fn compute_gain_loudness_mode_applies_attenuation_db() {
    // loudness_gain_db = -6 → linear ≈ 0.501. Negative gain passes through
    // the implicit unity cap.
    let (lin, _) = compute_gain(2, None, None, Some(-6.0), 0.0, 0.0, 1.0);
    approx(lin, 10f32.powf(-6.0 / 20.0), 0.001);
}

#[test]
fn compute_gain_loudness_mode_caps_positive_gain_at_unity() {
    // Loudness normalisation must not boost above 0 dBFS — it would clip.
    // The implementation forces peak = 1.0 in mode 2, so any positive gain
    // is capped at unity by the `gain_linear.min(1.0 / peak)` step.
    let (lin, _) = compute_gain(2, None, None, Some(6.0), 0.0, 0.0, 1.0);
    assert_eq!(lin, 1.0, "+6 dB loudness gain must cap at unity");
}

#[test]
fn compute_gain_loudness_mode_ignores_replay_gain_peak() {
    // The replay_gain_peak field is irrelevant in loudness mode — different
    // peaks must yield identical gain_linear for the same loudness_gain_db.
    let (lin_low_peak, _) = compute_gain(2, None, Some(0.5), Some(-6.0), 0.0, 0.0, 1.0);
    let (lin_high_peak, _) = compute_gain(2, None, Some(2.0), Some(-6.0), 0.0, 0.0, 1.0);
    assert_eq!(lin_low_peak, lin_high_peak);
}

#[test]
fn compute_gain_loudness_mode_returns_unity_when_no_db_supplied() {
    let (lin, _) = compute_gain(2, None, None, None, 0.0, 0.0, 1.0);
    assert_eq!(lin, 1.0);
}

#[test]
fn engine_name_maps_known_modes() {
    assert_eq!(normalization_engine_name(0), "off");
    assert_eq!(normalization_engine_name(1), "replaygain");
    assert_eq!(normalization_engine_name(2), "loudness");
}

#[test]
fn engine_name_falls_back_to_off_for_unknown_modes() {
    assert_eq!(normalization_engine_name(3), "off");
    assert_eq!(normalization_engine_name(99), "off");
}

#[test]
fn linear_to_db_for_unity_is_zero() {
    approx(gain_linear_to_db(1.0).unwrap(), 0.0, 0.001);
}

#[test]
fn linear_to_db_for_half_is_minus_six() {
    approx(gain_linear_to_db(0.5).unwrap(), -6.020_6, 0.01);
}

#[test]
fn linear_to_db_rejects_zero_and_negative() {
    assert!(gain_linear_to_db(0.0).is_none());
    assert!(gain_linear_to_db(-1.0).is_none());
}

#[test]
fn linear_to_db_rejects_non_finite() {
    assert!(gain_linear_to_db(f32::NAN).is_none());
    assert!(gain_linear_to_db(f32::INFINITY).is_none());
}

use psysonic_analysis::analysis_cache::{AnalysisCache, LoudnessEntry, TrackKey};

fn upsert_loudness_row(cache: &AnalysisCache, track_id: &str, integrated: f64, target: f64) {
    let k = TrackKey {
        server_id: String::new(),
        track_id: track_id.to_string(),
        md5_16kb: "deadbeef".to_string(),
    };
    cache.touch_track_status(&k, "ready").unwrap();
    cache
        .upsert_loudness(
            &k,
            &LoudnessEntry {
                integrated_lufs: integrated,
                true_peak: 0.5,
                recommended_gain_db: 0.0,
                target_lufs: target,
                updated_at: 1_700_000_000,
            },
        )
        .unwrap();
}

#[test]
fn resolve_with_cache_returns_none_for_missing_loudness() {
    let cache = AnalysisCache::open_in_memory();
    let g = resolve_loudness_gain_with_cache(
        &cache,
        "",
        "no-such-track",
        -14.0,
        ResolveLoudnessCacheOpts::default(),
    );
    assert!(g.is_none());
}

#[test]
fn resolve_with_cache_returns_recommended_gain_for_existing_row() {
    let cache = AnalysisCache::open_in_memory();
    // Track at -23 LUFS, target -14 → recommended gain capped by true-peak (0.5 ≈ -6 dB).
    upsert_loudness_row(&cache, "abc", -23.0, -14.0);
    let g = resolve_loudness_gain_with_cache(
        &cache,
        "",
        "abc",
        -14.0,
        ResolveLoudnessCacheOpts::default(),
    )
    .expect("loudness row → Some(gain_db)");
    assert!(g.is_finite());
    // Target - integrated = +9, but true-peak guard caps it: max = -1 - 20*log10(0.5) ≈ +5.
    assert!((-1.0..=10.0).contains(&g), "gain_db = {g}");
}

// (NaN-roundtrip through SQLite is platform-dependent — rusqlite often
// serialises f64::NAN as NULL, which fails column-decode rather than
// round-tripping a non-finite value. The `.is_finite()` guard inside
// `resolve_loudness_gain_with_cache` is defensive code that protects
// against in-memory corruption; not directly testable via the cache API.)

#[test]
fn resolve_with_cache_finds_row_under_other_id_variant() {
    let cache = AnalysisCache::open_in_memory();
    // Insert under stream:abc, look up with bare abc — get_latest_*_for_track
    // walks both id variants.
    upsert_loudness_row(&cache, "stream:abc", -16.0, -14.0);
    let g = resolve_loudness_gain_with_cache(
        &cache,
        "",
        "abc",
        -14.0,
        ResolveLoudnessCacheOpts::default(),
    );
    assert!(g.is_some(), "bare-id lookup must find stream-prefixed row");
}

#[test]
fn resolve_with_cache_respects_target_lufs_for_recommended_gain() {
    let cache = AnalysisCache::open_in_memory();
    upsert_loudness_row(&cache, "abc", -20.0, -14.0);
    let g_quiet = resolve_loudness_gain_with_cache(
        &cache,
        "",
        "abc",
        -20.0,
        ResolveLoudnessCacheOpts::default(),
    )
    .unwrap();
    let g_loud = resolve_loudness_gain_with_cache(
        &cache,
        "",
        "abc",
        -10.0,
        ResolveLoudnessCacheOpts::default(),
    )
    .unwrap();
    assert!(
        g_loud > g_quiet,
        "higher target_lufs must yield higher recommended gain (quiet={g_quiet}, loud={g_loud})"
    );
}

#[test]
fn cached_gain_disables_partial_loudness_hints() {
    let cached = TrackGainInputs {
        target_lufs: -14.0,
        norm_mode: 2,
        cache_loudness_db: Some(-6.0),
        effective_loudness_db: Some(-6.0),
    };
    let uncached = TrackGainInputs {
        cache_loudness_db: None,
        effective_loudness_db: Some(-4.5),
        ..cached
    };

    assert!(!cached.needs_partial_loudness());
    assert!(uncached.needs_partial_loudness());
}

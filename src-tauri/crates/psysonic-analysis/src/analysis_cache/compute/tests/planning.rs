use tauri::Manager;

use super::super::planning::{
    md5_first_16kb, seed_from_bytes_execute, seed_from_bytes_into_cache,
    seed_from_bytes_into_cache_with_policy, SeedFromBytesOutcome,
};
use super::{build_mono_pcm16_wav, sine_440_at_minus_6db};
use crate::analysis_cache::store::now_unix_ts;
use crate::analysis_cache::{AnalysisCache, TrackKey, WaveformEntry};

#[test]
fn md5_of_empty_bytes_matches_md5_empty() {
    assert_eq!(md5_first_16kb(&[]), "d41d8cd98f00b204e9800998ecf8427e");
}

#[test]
fn md5_uses_full_data_when_under_16kb() {
    let data = b"hello world";
    let direct = format!("{:x}", md5::compute(data));
    assert_eq!(md5_first_16kb(data), direct);
}

#[test]
fn md5_truncates_to_first_16kb() {
    let mut data = vec![0xAAu8; 16 * 1024];
    let prefix_only = format!("{:x}", md5::compute(&data));
    data.extend_from_slice(b"---should be ignored by md5_first_16kb---");
    assert_eq!(md5_first_16kb(&data), prefix_only);
}

#[test]
fn trusted_fingerprint_keys_analysis_under_the_original() {
    let cache = AnalysisCache::open_in_memory();
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let original_md5 = md5_first_16kb(&wav);
    let (outcome, md5) = seed_from_bytes_into_cache(
        &cache,
        "server-a",
        "original-track",
        &wav,
        None,
        Some(&original_md5),
    )
    .unwrap();
    assert_eq!(outcome, SeedFromBytesOutcome::Upserted);
    assert_eq!(md5, original_md5);
}

#[test]
fn mismatched_representation_is_rejected_for_a_trusted_fingerprint() {
    let cache = AnalysisCache::open_in_memory();
    let original = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let original_md5 = md5_first_16kb(&original);
    let (first, _) = seed_from_bytes_into_cache(
        &cache,
        "server-a",
        "track-x",
        &original,
        None,
        Some(&original_md5),
    )
    .unwrap();
    assert_eq!(first, SeedFromBytesOutcome::Upserted);
    let transformed = build_mono_pcm16_wav(&sine_440_at_minus_6db(48_000, 1.5), 48_000);
    assert_ne!(md5_first_16kb(&transformed), original_md5);
    let err = seed_from_bytes_into_cache(
        &cache,
        "server-a",
        "track-x",
        &transformed,
        None,
        Some(&original_md5),
    )
    .unwrap_err();
    assert!(err.contains("does not match analysis bytes"));
}

#[test]
fn explicitly_trusted_transcode_is_keyed_under_original_fingerprint() {
    let cache = AnalysisCache::open_in_memory();
    let original = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let trusted = md5_first_16kb(&original);
    let transcode = build_mono_pcm16_wav(&sine_440_at_minus_6db(48_000, 1.5), 48_000);
    assert_ne!(md5_first_16kb(&transcode), trusted);

    let (outcome, stored_md5) = seed_from_bytes_into_cache_with_policy(
        &cache,
        "server-a",
        "track-transcode",
        &transcode,
        None,
        Some(&trusted),
        false,
    )
    .unwrap();

    assert_eq!(outcome, SeedFromBytesOutcome::Upserted);
    assert_eq!(stored_md5, trusted);
    assert!(cache
        .content_cache_coverage("server-a", "track-transcode", &stored_md5)
        .unwrap()
        .complete());
}

#[test]
fn verified_row_purges_stale_fingerprint_variants() {
    let cache = AnalysisCache::open_in_memory();
    let stale_wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(48_000, 1.0), 48_000);
    let (first, stale_md5) =
        seed_from_bytes_into_cache(&cache, "srv", "t1", &stale_wav, None, None).unwrap();
    assert_eq!(first, SeedFromBytesOutcome::Upserted);
    let original = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let trusted = md5_first_16kb(&original);
    let (second, _) =
        seed_from_bytes_into_cache(&cache, "srv", "t1", &original, None, Some(&trusted)).unwrap();
    assert_eq!(second, SeedFromBytesOutcome::Upserted);
    let key = TrackKey {
        server_id: "srv".into(),
        track_id: "t1".into(),
        md5_16kb: trusted.clone(),
    };
    let removed = cache.delete_other_fingerprints(&key).unwrap();
    assert!(removed > 0, "stale rows deleted");
    let stale_key = TrackKey {
        server_id: "srv".into(),
        track_id: "t1".into(),
        md5_16kb: stale_md5,
    };
    assert!(!cache
        .loudness_row_exists_for_key(&stale_key)
        .unwrap_or(true));
    let cov = cache.content_cache_coverage("srv", "t1", &trusted).unwrap();
    assert!(cov.has_waveform);
}

#[test]
fn seed_from_bytes_into_cache_upserts_waveform_and_loudness_for_wav() {
    let cache = AnalysisCache::open_in_memory();
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.5), 44_100);
    let (outcome, md5) =
        seed_from_bytes_into_cache(&cache, "server-a", "wav-track", &wav, None, None).unwrap();
    assert_eq!(outcome, SeedFromBytesOutcome::Upserted);
    assert_eq!(md5, md5_first_16kb(&wav));

    let key = TrackKey {
        server_id: "server-a".to_string(),
        track_id: "wav-track".to_string(),
        md5_16kb: md5_first_16kb(&wav),
    };
    let waveform = cache.get_waveform(&key).unwrap().expect("waveform cached");
    assert_eq!(waveform.bin_count, 500);
    assert_eq!(waveform.bins.len(), 1000);
    assert!(cache.loudness_row_exists_for_key(&key).unwrap());
}

#[test]
fn seed_from_bytes_into_cache_writes_under_the_given_server_scope() {
    let cache = AnalysisCache::open_in_memory();
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.5), 44_100);
    seed_from_bytes_into_cache(&cache, "server-x", "scoped-track", &wav, None, None).unwrap();

    let md5 = md5_first_16kb(&wav);
    let scoped = TrackKey {
        server_id: "server-x".to_string(),
        track_id: "scoped-track".to_string(),
        md5_16kb: md5.clone(),
    };
    assert!(cache.get_waveform(&scoped).unwrap().is_some());
    let other = TrackKey {
        server_id: "server-y".to_string(),
        track_id: "scoped-track".to_string(),
        md5_16kb: md5,
    };
    assert!(cache.get_waveform(&other).unwrap().is_none());
}

#[test]
fn seed_from_bytes_into_cache_returns_skipped_on_second_call() {
    let cache = AnalysisCache::open_in_memory();
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let (first, _) =
        seed_from_bytes_into_cache(&cache, "server-a", "wav-track-2", &wav, None, None).unwrap();
    assert_eq!(first, SeedFromBytesOutcome::Upserted);
    let (second, _) =
        seed_from_bytes_into_cache(&cache, "server-a", "wav-track-2", &wav, None, None).unwrap();
    assert_eq!(second, SeedFromBytesOutcome::SkippedWaveformCacheHit);
}

#[test]
fn seed_from_bytes_into_cache_falls_back_to_byte_envelope_for_undecodable_input() {
    let cache = AnalysisCache::open_in_memory();
    let bytes = vec![0xAAu8; 8 * 1024];
    let (outcome, _) =
        seed_from_bytes_into_cache(&cache, "server-a", "garbage", &bytes, None, None).unwrap();
    assert_eq!(outcome, SeedFromBytesOutcome::Upserted);

    let key = TrackKey {
        server_id: "server-a".to_string(),
        track_id: "garbage".to_string(),
        md5_16kb: md5_first_16kb(&bytes),
    };
    let waveform = cache
        .get_waveform(&key)
        .unwrap()
        .expect("byte-envelope waveform cached");
    assert_eq!(waveform.bin_count, 500);
    assert!(!cache.loudness_row_exists_for_key(&key).unwrap());
}

#[test]
fn seed_from_bytes_reanalyzes_when_waveform_exists_without_loudness() {
    let cache = AnalysisCache::open_in_memory();
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let md5 = md5_first_16kb(&wav);
    let key = TrackKey {
        server_id: "server-a".to_string(),
        track_id: "track-reseed".to_string(),
        md5_16kb: md5,
    };
    cache.touch_track_status(&key, "ready").unwrap();
    cache
        .upsert_waveform(
            &key,
            &WaveformEntry {
                bins: vec![8u8; 1000],
                bin_count: 500,
                is_partial: false,
                known_until_sec: 0.0,
                duration_sec: 0.0,
                updated_at: now_unix_ts(),
            },
        )
        .unwrap();
    assert!(!cache.loudness_row_exists_for_key(&key).unwrap());

    let (outcome, _) =
        seed_from_bytes_into_cache(&cache, "server-a", "track-reseed", &wav, None, None).unwrap();
    assert_eq!(outcome, SeedFromBytesOutcome::Upserted);
    assert!(cache.loudness_row_exists_for_key(&key).unwrap());
}

#[test]
fn seed_from_bytes_execute_returns_no_cache_without_registered_state() {
    let app = tauri::test::mock_app();
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 0.25), 44_100);
    let handle = app.handle().clone();
    let (outcome, timings) =
        seed_from_bytes_execute(&handle, "s", "t", &wav, None, None, None, true)
            .expect("seed execute should return a graceful skip");
    assert_eq!(outcome, SeedFromBytesOutcome::SkippedNoAnalysisCache);
    assert_eq!(timings.seed_ms, 0);
    assert_eq!(timings.bpm_ms, 0);
}

#[test]
fn seed_from_bytes_execute_runs_with_registered_cache() {
    let app = tauri::test::mock_app();
    app.manage(AnalysisCache::open_in_memory());
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 0.5), 44_100);
    let handle = app.handle().clone();

    let (first, timings_first) = seed_from_bytes_execute(
        &handle,
        "server-a",
        "track-exec",
        &wav,
        None,
        None,
        None,
        true,
    )
    .unwrap();
    assert_eq!(first, SeedFromBytesOutcome::Upserted);
    assert!(timings_first.seed_ms <= 30_000);

    let (second, timings_second) = seed_from_bytes_execute(
        &handle,
        "server-a",
        "track-exec",
        &wav,
        None,
        None,
        None,
        true,
    )
    .unwrap();
    assert_eq!(second, SeedFromBytesOutcome::SkippedWaveformCacheHit);
    assert!(timings_second.seed_ms <= 30_000);
}

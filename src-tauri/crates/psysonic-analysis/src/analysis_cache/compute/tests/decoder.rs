use super::super::decoder::{
    analysis_pcm_window, audio_duration_from_bytes, count_mono_frames_from_audio_bytes,
    decode_mono_pcm_limited, decode_mono_pcm_window, format_hint_from_bytes,
};
use super::{build_mono_pcm16_aiff, build_mono_pcm16_wav, sine_440_at_minus_6db};

#[test]
fn analysis_pcm_window_uses_center_for_long_tracks() {
    let w = analysis_pcm_window(180.0, 60.0);
    assert!((w.start_sec - 60.0).abs() < 1e-9);
    assert!((w.duration_sec - 60.0).abs() < 1e-9);
}

#[test]
fn analysis_pcm_window_uses_full_track_when_short() {
    let w = analysis_pcm_window(45.0, 60.0);
    assert_eq!(w.start_sec, 0.0);
    assert!((w.duration_sec - 45.0).abs() < 1e-9);
}

#[test]
fn analysis_pcm_window_handles_negative_and_non_finite_durations() {
    let neg = analysis_pcm_window(-42.0, 60.0);
    assert_eq!(neg.start_sec, 0.0);
    assert_eq!(neg.duration_sec, 60.0);

    let inf = analysis_pcm_window(f64::INFINITY, 60.0);
    assert_eq!(inf.start_sec, 0.0);
    assert!(!inf.duration_sec.is_finite());
}

#[test]
fn count_mono_frames_returns_decoded_length_for_synthetic_wav() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let (frames, _hint) =
        count_mono_frames_from_audio_bytes(&wav, None).expect("WAV decode must succeed");
    assert!(
        (43_900..=44_300).contains(&frames),
        "expected ~44100 frames, got {frames}"
    );
}

#[test]
fn count_mono_frames_decodes_synthetic_aiff_without_external_hint() {
    let aiff = build_mono_pcm16_aiff(&sine_440_at_minus_6db(44_100, 1.0));
    assert_eq!(format_hint_from_bytes(&aiff), Some("aiff".into()));
    let (frames, hint) =
        count_mono_frames_from_audio_bytes(&aiff, None).expect("AIFF decode must succeed");
    assert!(
        (43_900..=44_300).contains(&frames),
        "expected ~44100 frames, got {frames}"
    );
    assert_eq!(hint, Some(44_100));
}

#[test]
fn count_mono_frames_returns_none_for_garbage_bytes() {
    assert!(count_mono_frames_from_audio_bytes(b"not an audio file", None).is_none());
}

#[test]
fn count_mono_frames_returns_none_for_empty_bytes() {
    assert!(count_mono_frames_from_audio_bytes(&[], None).is_none());
}

#[test]
fn audio_duration_from_bytes_reports_duration_for_wav() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 2.0), 44_100);
    let duration = audio_duration_from_bytes(&wav).expect("duration must be available");
    assert!(
        (1.8..=2.2).contains(&duration),
        "expected ~2s duration, got {duration}"
    );
}

#[test]
fn audio_duration_from_bytes_returns_none_for_garbage() {
    assert!(audio_duration_from_bytes(b"not audio").is_none());
}

#[test]
fn decode_mono_pcm_limited_decodes_and_respects_limit() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(48_000, 2.0), 48_000);
    let (full_pcm, sr_full) = decode_mono_pcm_limited(&wav, None).expect("full decode");
    assert_eq!(sr_full, 48_000.0);
    assert!(full_pcm.len() >= 95_000);

    let (limited_pcm, sr_limited) =
        decode_mono_pcm_limited(&wav, Some(0.25)).expect("limited decode");
    assert_eq!(sr_limited, 48_000.0);
    assert!(
        (11_500..=12_500).contains(&limited_pcm.len()),
        "0.25 seconds at 48kHz should decode ~12k samples, got {}",
        limited_pcm.len()
    );
    assert!(limited_pcm.len() < full_pcm.len());
}

#[test]
fn decode_mono_pcm_limited_rejects_empty_buffer() {
    let err = decode_mono_pcm_limited(&[], Some(1.0)).unwrap_err();
    assert!(err.contains("empty audio buffer"));
}

#[test]
fn decode_mono_pcm_limited_rejects_invalid_bytes() {
    let err = decode_mono_pcm_limited(b"not-audio", Some(0.5)).unwrap_err();
    assert!(err.contains("failed to open audio decode session"));
}

#[test]
fn decode_mono_pcm_limited_ignores_non_positive_or_non_finite_cap() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let (full_a, _) = decode_mono_pcm_limited(&wav, None).unwrap();
    let (full_b, _) = decode_mono_pcm_limited(&wav, Some(0.0)).unwrap();
    let (full_c, _) = decode_mono_pcm_limited(&wav, Some(f64::NAN)).unwrap();
    assert_eq!(full_a.len(), full_b.len());
    assert_eq!(full_a.len(), full_c.len());
}

#[test]
fn decode_mono_pcm_window_decodes_center_slice() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 2.0), 44_100);
    let (window_pcm, sr) = decode_mono_pcm_window(&wav, 0.75, 0.5).expect("window decode");
    assert_eq!(sr, 44_100.0);
    assert!(
        (20_000..=24_000).contains(&window_pcm.len()),
        "0.5 seconds at 44.1kHz should decode ~22k samples, got {}",
        window_pcm.len()
    );
}

#[test]
fn decode_mono_pcm_window_rejects_invalid_bytes() {
    let err = decode_mono_pcm_window(b"not-audio", 0.0, 1.0).unwrap_err();
    assert!(
        err.contains("failed to open audio decode session"),
        "unexpected error: {err}"
    );
}

#[test]
fn decode_mono_pcm_window_rejects_empty_buffer() {
    let err = decode_mono_pcm_window(&[], 0.0, 1.0).unwrap_err();
    assert!(err.contains("empty audio buffer"));
}

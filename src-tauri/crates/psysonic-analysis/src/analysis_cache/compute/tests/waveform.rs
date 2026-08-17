use super::super::decoder::count_mono_frames_from_audio_bytes;
use super::super::waveform::{
    analyze_loudness_and_waveform, decode_scan_pcm, derive_waveform_bins, normalize_peak_bins,
    recommended_gain_for_target,
};
use super::{build_mono_pcm16_wav, sine_440_at_minus_6db};

fn approx_f64(a: f64, b: f64, eps: f64) {
    assert!((a - b).abs() < eps, "expected {b}, got {a}");
}

#[test]
fn recommended_gain_is_target_minus_integrated_when_no_peak() {
    approx_f64(recommended_gain_for_target(-14.0, 0.0, -10.0), 4.0, 1e-9);
    approx_f64(recommended_gain_for_target(-23.0, 0.0, -14.0), 9.0, 1e-9);
}

#[test]
fn recommended_gain_caps_to_avoid_clipping_when_true_peak_is_high() {
    let g = recommended_gain_for_target(-14.0, 1.0, -10.0);
    approx_f64(g, -1.0, 1e-6);
}

#[test]
fn recommended_gain_clamps_to_plus_minus_24() {
    let huge_up = recommended_gain_for_target(-100.0, 0.0, 100.0);
    let huge_down = recommended_gain_for_target(100.0, 0.0, -100.0);
    assert_eq!(huge_up, 24.0);
    assert_eq!(huge_down, -24.0);
}

#[test]
fn derive_waveform_returns_empty_for_zero_bin_count() {
    assert_eq!(derive_waveform_bins(&[1u8, 2, 3, 4], 0), Vec::<u8>::new());
}

#[test]
fn derive_waveform_returns_empty_for_empty_bytes() {
    assert_eq!(derive_waveform_bins(&[], 4), Vec::<u8>::new());
}

#[test]
fn derive_waveform_silence_at_midpoint_yields_zero_bins() {
    let silence = vec![128u8; 64];
    let out = derive_waveform_bins(&silence, 8);
    assert!(
        out.iter().all(|&b| b == 0),
        "silence must produce all-zero bins, got {out:?}"
    );
}

#[test]
fn derive_waveform_doubles_the_bin_buffer() {
    let bytes = vec![0u8; 32];
    let out = derive_waveform_bins(&bytes, 4);
    assert_eq!(out.len(), 8, "output must be 2 * bin_count");
    assert_eq!(&out[..4], &out[4..]);
}

#[test]
fn derive_waveform_reaches_max_for_extreme_amplitude() {
    let bytes = vec![0u8; 16];
    let out = derive_waveform_bins(&bytes, 4);
    assert!(
        out.iter().all(|&b| b == 255),
        "max amplitude must yield 255 bins"
    );
}

#[test]
fn normalize_peak_returns_empty_for_empty_input() {
    assert_eq!(normalize_peak_bins(&[]), Vec::<u8>::new());
}

#[test]
fn normalize_peak_uniform_input_collapses_to_base_offset() {
    let bins = vec![0.5f32; 16];
    let out = normalize_peak_bins(&bins);
    assert_eq!(out.len(), 16);
    assert!(out.iter().all(|&b| b == 8), "got {out:?}");
}

#[test]
fn normalize_peak_monotonic_input_yields_increasing_output() {
    let bins: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
    let out = normalize_peak_bins(&bins);
    for win in out.windows(2) {
        assert!(win[0] <= win[1], "non-monotonic output around {:?}", win);
    }
    assert!(out.iter().all(|&b| (8..=255).contains(&b)));
}

#[test]
fn analyze_loudness_and_waveform_returns_loudness_for_synthetic_sine() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.5), 44_100);
    let result =
        analyze_loudness_and_waveform(&wav, -14.0, 100, None).expect("WAV decode must succeed");
    let (integrated_lufs, true_peak, recommended_gain_db, target_lufs, bins) = result;
    assert_eq!(bins.len(), 200);
    assert_eq!(target_lufs, -14.0);
    assert!((-30.0..0.0).contains(&integrated_lufs));
    assert!((0.4..=0.6).contains(&true_peak));
    assert!(recommended_gain_db.is_finite());
    assert!((-24.0..=24.0).contains(&recommended_gain_db));
}

#[test]
fn analyze_loudness_returns_none_for_zero_bin_count() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 0.5), 44_100);
    assert!(analyze_loudness_and_waveform(&wav, -14.0, 0, None).is_none());
}

#[test]
fn analyze_loudness_returns_none_for_empty_bytes() {
    assert!(analyze_loudness_and_waveform(&[], -14.0, 100, None).is_none());
}

#[test]
fn decode_scan_pcm_supports_waveform_only_mode_without_loudness() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let (frames, hint) = count_mono_frames_from_audio_bytes(&wav, None).expect("frame counting");
    let scanned = decode_scan_pcm(&wav, 64, frames, hint, None, None).expect("scan must succeed");
    assert_eq!(scanned.bins.len(), 128);
    assert!(scanned.loudness.is_none());
}

#[test]
fn decode_scan_pcm_with_loudness_target_returns_loudness_tuple() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let (frames, hint) = count_mono_frames_from_audio_bytes(&wav, None).expect("frame counting");
    let scanned =
        decode_scan_pcm(&wav, 64, frames, hint, Some(-14.0), None).expect("scan must succeed");
    assert_eq!(scanned.bins.len(), 128);
    let (integrated_lufs, true_peak, recommended_gain_db, target_lufs) =
        scanned.loudness.expect("loudness tuple must be present");
    assert!(integrated_lufs.is_finite());
    assert!(true_peak.is_finite());
    assert!((-24.0..=24.0).contains(&recommended_gain_db));
    assert_eq!(target_lufs, -14.0);
}

#[test]
fn decode_scan_pcm_returns_none_for_non_audio_input() {
    assert!(decode_scan_pcm(b"nope", 32, 10, None, Some(-14.0), None).is_none());
}

#[test]
fn decode_scan_pcm_returns_none_when_no_frames_decoded() {
    let wav = build_mono_pcm16_wav(&[], 44_100);
    assert!(analyze_loudness_and_waveform(&wav, -14.0, 64, None).is_none());
}

#[test]
fn decode_scan_pcm_ignores_oversized_timeline_hint() {
    let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
    let (frames, _hint) = count_mono_frames_from_audio_bytes(&wav, None).expect("frame counting");
    let scanned = decode_scan_pcm(&wav, 64, frames, Some(frames * 10), None, None).unwrap();
    assert_eq!(scanned.bins.len(), 128);
}

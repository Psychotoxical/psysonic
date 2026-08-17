use super::analyzer::{window_levels, Analyzer};
use super::tests::{base64_len, decode_b64, tone};
use crate::spectrum_dsp::{BAND_COUNT, FFT_SIZE, WAVE_COUNT};

#[test]
fn stereo_frames_carry_both_traces() {
    let mut a = Analyzer::new();
    let left = tone(1_000.0, 48_000.0, FFT_SIZE);
    let right: Vec<f32> = left.iter().map(|s| -s).collect();
    let frame = a.frame((&left, &right), 48_000, 0.016, true).unwrap();
    assert_ne!(frame.waveform_left, frame.waveform_right);
}

#[test]
fn analyzer_emits_nothing_when_idle_and_settled() {
    let mut a = Analyzer::new();
    let silence = vec![0.0; FFT_SIZE];
    assert!(a
        .frame((&silence, &silence), 48_000, 0.016, false)
        .is_none());
}

#[test]
fn analyzer_emits_a_well_formed_frame_for_audio() {
    let mut a = Analyzer::new();
    let window = tone(1_000.0, 48_000.0, FFT_SIZE);
    let frame = a
        .frame((&window, &window), 48_000, 0.016, true)
        .expect("audio should produce a frame");

    assert_eq!(frame.band_count, BAND_COUNT as u32);
    assert_eq!(frame.wave_count, WAVE_COUNT as u32);
    assert_eq!(frame.sample_rate, 48_000);
    // Derived from the constants rather than hardcoded, so tuning
    // BAND_COUNT / WAVE_COUNT doesn't break an unrelated assertion.
    assert_eq!(frame.bands.len(), base64_len(BAND_COUNT));
    assert_eq!(frame.peaks.len(), base64_len(BAND_COUNT));
    assert_eq!(frame.waveform_left.len(), base64_len(WAVE_COUNT));
    assert_eq!(frame.waveform_right.len(), base64_len(WAVE_COUNT));
    assert!(
        frame.rms > 0.6 && frame.rms < 0.8,
        "full-scale sine rms {}",
        frame.rms
    );
    assert!(frame.peak > 0.99, "peak {}", frame.peak);
}

#[test]
fn analyzer_keeps_emitting_while_the_bars_decay_then_stops() {
    let mut a = Analyzer::new();
    let window = tone(1_000.0, 48_000.0, FFT_SIZE);
    for _ in 0..30 {
        a.frame((&window, &window), 48_000, 0.016, true);
    }
    let silence = vec![0.0; FFT_SIZE];
    // Playback stops: frames continue while the envelopes fall...
    assert!(a
        .frame((&silence, &silence), 48_000, 0.016, false)
        .is_some());
    // ...and eventually stop once everything has settled.
    let mut settled_after = None;
    for i in 0..600 {
        if a.frame((&silence, &silence), 48_000, 0.016, false)
            .is_none()
        {
            settled_after = Some(i);
            break;
        }
    }
    assert!(
        settled_after.is_some(),
        "analyzer never went quiet after playback stopped"
    );
}

#[test]
fn analyzer_rebuilds_its_band_layout_when_the_sample_rate_changes() {
    let mut a = Analyzer::new();
    let window = tone(1_000.0, 44_100.0, FFT_SIZE);
    let frame = a.frame((&window, &window), 44_100, 0.016, true).unwrap();
    assert_eq!(frame.sample_rate, 44_100);
    let window = tone(1_000.0, 96_000.0, FFT_SIZE);
    let frame = a.frame((&window, &window), 96_000, 0.016, true).unwrap();
    assert_eq!(frame.sample_rate, 96_000);
}

#[test]
fn analyzer_hi_res_low_bands_do_not_plateau() {
    for sample_rate in [96_000u32, 192_000] {
        let mut analyzer = Analyzer::new();
        let window: Vec<f32> = tone(60.0, sample_rate as f32, FFT_SIZE)
            .into_iter()
            .map(|sample| sample * 0.1)
            .collect();
        analyzer
            .frame((&window, &window), sample_rate, 0.016, true)
            .unwrap();

        let below_first_bin = analyzer
            .layout
            .iter()
            .take_while(|band| band.centre_bin < 1.0)
            .count();
        assert!(
            below_first_bin > 1,
            "test rate has no sub-bin low-end group"
        );
        assert!(
            analyzer.bands[..below_first_bin]
                .windows(2)
                .all(|pair| (pair[0] - pair[1]).abs() > 1e-6),
            "rate {sample_rate}: analyzer low bands still plateau: {:?}",
            &analyzer.bands[..below_first_bin]
        );
    }
}

#[test]
fn analyzer_falls_back_to_48k_for_an_unknown_rate() {
    let mut a = Analyzer::new();
    let window = tone(1_000.0, 48_000.0, FFT_SIZE);
    let frame = a.frame((&window, &window), 0, 0.016, true).unwrap();
    assert_eq!(frame.sample_rate, 48_000);
}

#[test]
fn analyzer_tolerates_a_short_window() {
    let mut a = Analyzer::new();
    let window = tone(1_000.0, 48_000.0, 64);
    assert!(a.frame((&window, &window), 48_000, 0.016, true).is_some());
}

#[test]
fn louder_audio_produces_taller_bands() {
    fn peak_band_byte(amp: f32) -> u8 {
        let mut a = Analyzer::new();
        let window: Vec<f32> = tone(1_000.0, 48_000.0, FFT_SIZE)
            .iter()
            .map(|s| s * amp)
            .collect();
        let mut last = 0;
        for _ in 0..60 {
            if let Some(f) = a.frame((&window, &window), 48_000, 0.016, true) {
                last = decode_b64(&f.bands).into_iter().max().unwrap_or(0);
            }
        }
        last
    }
    assert!(
        peak_band_byte(1.0) > peak_band_byte(0.05),
        "louder audio must read higher"
    );
}

#[test]
fn silent_audio_produces_flat_bands() {
    let mut a = Analyzer::new();
    let silence = vec![0.0; FFT_SIZE];
    let frame = a.frame((&silence, &silence), 48_000, 0.016, true).unwrap();
    assert!(decode_b64(&frame.bands).iter().all(|b| *b == 0));
    assert_eq!(frame.rms, 0.0);
}

#[test]
fn idle_frames_carry_a_centred_waveform() {
    let mut a = Analyzer::new();
    let window = tone(1_000.0, 48_000.0, FFT_SIZE);
    a.frame((&window, &window), 48_000, 0.016, true);
    let silence = vec![0.0; FFT_SIZE];
    let frame = a.frame((&silence, &silence), 48_000, 0.016, false).unwrap();
    assert!(decode_b64(&frame.waveform_left).iter().all(|b| *b == 128));
    assert!(decode_b64(&frame.waveform_right).iter().all(|b| *b == 128));
}

#[test]
fn window_levels_of_silence_are_zero() {
    assert_eq!(window_levels(&vec![0.0; 128]), (0.0, 0.0));
}

#[test]
fn window_levels_of_an_empty_window_are_zero() {
    assert_eq!(window_levels(&[]), (0.0, 0.0));
}

#[test]
fn window_levels_report_rms_and_peak() {
    let (rms, peak) = window_levels(&[1.0, -1.0, 1.0, -1.0]);
    assert!((rms - 1.0).abs() < 1e-5);
    assert!((peak - 1.0).abs() < 1e-5);
}

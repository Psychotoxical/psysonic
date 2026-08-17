use std::sync::atomic::Ordering;

use super::analyzer::Analyzer;
use super::tests::{
    decode_b64, lock_globals, reset_globals, samples_source, tone, Alternating, Silence,
};
use super::*;
use crate::spectrum_dsp::{BAND_COUNT, FFT_SIZE};

#[test]
fn tap_keeps_the_two_channels_apart() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);

    // Interleaved stereo: left rail at +0.5, right at −0.5.
    let mut tap = SpectrumTapSource::new(Alternating {
        remaining: 8,
        channels: 2,
        rate: 48_000,
        next_left: true,
    });
    let _: Vec<f32> = (&mut tap).collect();
    ACTIVE.store(false, Ordering::Relaxed);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    let pos = snapshot(&mut left, &mut right);
    assert_eq!(pos, 4, "8 stereo samples = 4 frames");
    // Fewer frames than the window means they sit at its head.
    // A mono downmix would have cancelled these to zero.
    assert_eq!(&left[..4], &[0.5, 0.5, 0.5, 0.5]);
    assert_eq!(&right[..4], &[-0.5, -0.5, -0.5, -0.5]);
}

#[test]
fn activation_mid_frame_keeps_subsequent_stereo_frames_aligned() {
    let _guard = lock_globals();
    reset_globals();
    let (source, _) = samples_source(vec![0.1, -0.1, 0.2, -0.2, 0.3, -0.3], 2, 48_000);
    let mut tap = SpectrumTapSource::new(source);

    assert_eq!(tap.next(), Some(0.1));
    ACTIVE.store(true, Ordering::Relaxed);
    let _: Vec<f32> = (&mut tap).collect();
    ACTIVE.store(false, Ordering::Relaxed);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    let pos = snapshot(&mut left, &mut right);
    assert_eq!(pos, 2, "the partial frame at activation must be skipped");
    assert_eq!(&left[..2], &[0.2, 0.3]);
    assert_eq!(&right[..2], &[-0.2, -0.3]);
}

#[test]
fn mono_sources_drive_both_traces() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);
    let mut tap = SpectrumTapSource::new(Silence {
        remaining: 4,
        channels: 1,
        rate: 44_100,
    });
    let _: Vec<f32> = (&mut tap).collect();
    ACTIVE.store(false, Ordering::Relaxed);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    snapshot(&mut left, &mut right);
    // Otherwise a mono track would show half an empty screen.
    assert_eq!(&left[..4], &[0.25, 0.25, 0.25, 0.25]);
    assert_eq!(&right[..4], &[0.25, 0.25, 0.25, 0.25]);
}

#[test]
fn out_of_phase_channels_still_produce_a_spectrum() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);

    let left_tone = tone(1_000.0, 48_000.0, FFT_SIZE);
    let mut interleaved = Vec::with_capacity(FFT_SIZE * 2);
    for left in &left_tone {
        interleaved.extend_from_slice(&[*left, -*left]);
    }
    let (source, _) = samples_source(interleaved, 2, 48_000);
    let _: Vec<f32> = SpectrumTapSource::new(source).collect();
    ACTIVE.store(false, Ordering::Relaxed);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    snapshot(&mut left, &mut right);

    let mut a = Analyzer::new();
    let frame = a.frame((&left, &right), 48_000, 0.016, true).unwrap();
    assert_eq!(frame.band_count, BAND_COUNT as u32);
    assert!(decode_b64(&frame.bands).iter().any(|band| *band > 0));
    // Folded stereo is still exact L/R for ordinary stereo input.
    assert!(decode_b64(&frame.waveform_left).iter().any(|b| *b != 128));
    assert!(decode_b64(&frame.waveform_right).iter().any(|b| *b != 128));
}

#[test]
fn centre_only_5_1_reaches_spectrum_and_folded_waveforms() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);

    let centre = tone(1_000.0, 48_000.0, FFT_SIZE);
    let mut interleaved = Vec::with_capacity(FFT_SIZE * 6);
    for sample in centre {
        interleaved.extend_from_slice(&[0.0, 0.0, sample, 0.0, 0.0, 0.0]);
    }
    let (source, _) = samples_source(interleaved, 6, 48_000);
    let _: Vec<f32> = SpectrumTapSource::new(source).collect();
    ACTIVE.store(false, Ordering::Relaxed);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    snapshot(&mut left, &mut right);
    assert!(left.iter().any(|sample| sample.abs() > 0.1));
    assert_eq!(
        left, right,
        "centre should fold equally into left and right"
    );

    let frame = Analyzer::new()
        .frame((&left, &right), 48_000, 0.016, true)
        .unwrap();
    assert!(decode_b64(&frame.bands).iter().any(|band| *band > 0));
    let waveform_left = decode_b64(&frame.waveform_left);
    let waveform_right = decode_b64(&frame.waveform_right);
    assert!(waveform_left.iter().any(|sample| *sample != 128));
    assert_eq!(waveform_left, waveform_right);
}

#[test]
fn five_point_one_fold_routes_lfe_and_surrounds_to_the_expected_traces() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);

    let (source, _) = samples_source(vec![0.0, 0.0, 0.0, 1.0, 0.5, -0.25], 6, 48_000);
    let _: Vec<f32> = SpectrumTapSource::new(source).collect();
    ACTIVE.store(false, Ordering::Relaxed);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    snapshot(&mut left, &mut right);
    let surround_gain = std::f32::consts::FRAC_1_SQRT_2;
    assert!((left[0] - (0.5 + 0.5 * surround_gain)).abs() < f32::EPSILON);
    assert!((right[0] - (0.5 - 0.25 * surround_gain)).abs() < f32::EPSILON);
}

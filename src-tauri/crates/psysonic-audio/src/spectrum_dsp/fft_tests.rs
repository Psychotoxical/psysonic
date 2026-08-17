use super::test_support::windowed_spectrum;
use super::*;

#[test]
fn fft_of_silence_is_zero() {
    let mut re = vec![0.0; FFT_SIZE];
    let mut im = vec![0.0; FFT_SIZE];
    fft_in_place(&mut re, &mut im);
    assert!(re.iter().all(|v| v.abs() < 1e-6));
    assert!(im.iter().all(|v| v.abs() < 1e-6));
}

#[test]
fn fft_of_dc_puts_all_energy_in_bin_zero() {
    let mut re = vec![1.0; FFT_SIZE];
    let mut im = vec![0.0; FFT_SIZE];
    fft_in_place(&mut re, &mut im);
    assert!((re[0] - FFT_SIZE as f32).abs() < 1e-2, "bin0 = {}", re[0]);
    assert!(re[1..].iter().all(|v| v.abs() < 1e-2));
}

#[test]
fn fft_peaks_at_the_bin_of_the_input_tone() {
    // Bin-centred tone: 48000 / 2048 * 100 = 2343.75 Hz.
    let sample_rate = 48_000.0;
    let bin = 100usize;
    let freq = sample_rate / FFT_SIZE as f32 * bin as f32;
    let mags = windowed_spectrum(freq, sample_rate, 1.0);
    let (peak_bin, _) = mags
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .unwrap();
    assert_eq!(peak_bin, bin);
}

#[test]
fn full_scale_sine_normalises_to_unity_magnitude() {
    let sample_rate = 48_000.0;
    let freq = sample_rate / FFT_SIZE as f32 * 100.0;
    let mags = windowed_spectrum(freq, sample_rate, 1.0);
    let peak = mags.iter().copied().fold(0.0f32, f32::max);
    assert!(
        (peak - 1.0).abs() < 0.02,
        "peak magnitude {peak} should be ~1.0"
    );
}

#[test]
fn half_amplitude_sine_is_about_six_db_down() {
    let sample_rate = 48_000.0;
    let freq = sample_rate / FFT_SIZE as f32 * 100.0;
    let full = windowed_spectrum(freq, sample_rate, 1.0)
        .iter()
        .copied()
        .fold(0.0f32, f32::max);
    let half = windowed_spectrum(freq, sample_rate, 0.5)
        .iter()
        .copied()
        .fold(0.0f32, f32::max);
    let delta_db = 20.0 * (full / half).log10();
    assert!(
        (delta_db - 6.02).abs() < 0.1,
        "delta {delta_db} dB should be ~6 dB"
    );
}

#[test]
fn stereo_power_combination_keeps_real_tones_without_products() {
    let sample_rate = 48_000.0;
    let left = windowed_spectrum(750.0, sample_rate, 1.0);
    let right = windowed_spectrum(2_250.0, sample_rate, 1.0);
    let mut combined = vec![0.0; FFT_SIZE / 2];
    combine_power_magnitudes(&left, &right, &mut combined);

    let bin = |frequency: f32| (frequency / (sample_rate / FFT_SIZE as f32)).round() as usize;
    let left_component = combined[bin(750.0)];
    let right_component = combined[bin(2_250.0)];
    let product_3750 = combined[bin(3_750.0)];
    let product_5250 = combined[bin(5_250.0)];

    assert!(
        left_component > 0.65,
        "750 Hz component was {left_component}"
    );
    assert!(
        right_component > 0.65,
        "2250 Hz component was {right_component}"
    );
    assert!(
        product_3750 < right_component * 0.01,
        "invented 3750 Hz product {product_3750} rivalled real tone {right_component}"
    );
    assert!(
        product_5250 < right_component * 0.01,
        "invented 5250 Hz product {product_5250} rivalled real tone {right_component}"
    );
}

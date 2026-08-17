use super::*;

#[test]
fn quantize_maps_the_unit_range_to_bytes() {
    assert_eq!(quantize(&[0.0, 0.5, 1.0]), vec![0, 128, 255]);
}

#[test]
fn quantize_clamps_out_of_range_input() {
    assert_eq!(quantize(&[-3.0, 7.0]), vec![0, 255]);
}

#[test]
fn waveform_is_centred_for_silence() {
    let out = downsample_waveform(&vec![0.0; FFT_SIZE]);
    assert_eq!(out.len(), WAVE_COUNT);
    assert!(out.iter().all(|v| *v == 128));
}

#[test]
fn waveform_keeps_the_extreme_of_each_bucket() {
    let mut samples = vec![0.0f32; FFT_SIZE];
    samples[3] = 1.0; // inside the first bucket
    let out = downsample_waveform(&samples);
    assert_eq!(out[0], 255);
    assert_eq!(out[1], 128);
}

#[test]
fn waveform_preserves_sign() {
    let mut samples = vec![0.0f32; FFT_SIZE];
    samples[3] = -1.0;
    let out = downsample_waveform(&samples);
    assert_eq!(out[0], 1);
}

#[test]
fn waveform_handles_an_empty_window() {
    assert_eq!(downsample_waveform(&[]).len(), WAVE_COUNT);
}

#[test]
fn base64_matches_known_vectors() {
    assert_eq!(base64(b""), "");
    assert_eq!(base64(b"f"), "Zg==");
    assert_eq!(base64(b"fo"), "Zm8=");
    assert_eq!(base64(b"foo"), "Zm9v");
    assert_eq!(base64(b"foob"), "Zm9vYg==");
    assert_eq!(base64(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64(b"foobar"), "Zm9vYmFy");
}

#[test]
fn base64_covers_the_full_byte_range() {
    let all: Vec<u8> = (0..=255u8).collect();
    let encoded = base64(&all);
    assert_eq!(encoded.len(), 344);
    assert!(encoded
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c)));
}

use super::*;

pub(super) fn sine(freq: f32, sample_rate: f32, amp: f32) -> (Vec<f32>, Vec<f32>) {
    let re: Vec<f32> = (0..FFT_SIZE)
        .map(|i| {
            let t = i as f32 / sample_rate;
            amp * (std::f32::consts::TAU * freq * t).sin()
        })
        .collect();
    (re, vec![0.0; FFT_SIZE])
}

pub(super) fn windowed_spectrum(freq: f32, sample_rate: f32, amp: f32) -> Vec<f32> {
    let (mut re, mut im) = sine(freq, sample_rate, amp);
    let w = hann_window();
    for (s, win) in re.iter_mut().zip(w.iter()) {
        *s *= win;
    }
    fft_in_place(&mut re, &mut im);
    let mut mags = vec![0.0; FFT_SIZE / 2];
    magnitudes(&re, &im, &mut mags);
    mags
}

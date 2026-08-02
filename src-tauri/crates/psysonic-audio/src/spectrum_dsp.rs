//! Pure DSP behind the visualizer spectrum feed: Hann window, radix-2 FFT,
//! log-spaced band mapping, attack/decay smoothing with peak-hold, and the
//! compact base64 wire encoding.
//!
//! Everything here is deliberately free of engine/Tauri state so it can be unit
//! tested directly. The stateful side (ring buffer, tap source, emit loop) lives
//! in `spectrum.rs`.

use std::sync::OnceLock;

/// FFT window size. At 48 kHz this is ~43 ms of audio → ~23 Hz bin spacing,
/// which is the usual trade-off point for a music visualizer: fine enough to
/// separate bass notes, short enough that transients still feel immediate.
pub(crate) const FFT_SIZE: usize = 2048;
/// Number of log-spaced bands sent to the frontend.
pub(crate) const BAND_COUNT: usize = 128;
/// Number of time-domain points sent for the oscilloscope mode.
pub(crate) const WAVE_COUNT: usize = 256;

/// Bottom of the displayed dynamic range. Anything at or below this maps to 0.
pub(crate) const FLOOR_DB: f32 = -60.0;
/// Lowest band centre frequency.
const BAND_MIN_HZ: f32 = 28.0;
/// Highest band centre frequency (clamped against Nyquist per sample rate).
const BAND_MAX_HZ: f32 = 16_000.0;
/// Pink-noise compensation. Music loses roughly 3 dB per octave as frequency
/// rises, so an untilted spectrum renders as a bass-only blob with the treble
/// bands permanently dead. Tilting by this much per octave above `TILT_REF_HZ`
/// makes a pink-noise input read as a flat row of bars — the same trick
/// hardware analyzers and Winamp's own spectrum used.
///
/// Kept at the true pink slope (3 dB). Over-tilting looks like a fuller
/// spectrum but is really just pushing the treble bands into the ceiling, which
/// flattens the whole picture into a uniform wall of near-full-height bars.
const TILT_DB_PER_OCTAVE: f32 = 3.0;
const TILT_REF_HZ: f32 = 200.0;
/// Cap on the tilt so the top bands can't be lifted into permanent clipping.
const TILT_MAX_DB: f32 = 18.0;

// ── Window ───────────────────────────────────────────────────────────────────

static HANN: OnceLock<Vec<f32>> = OnceLock::new();

/// Periodic Hann window, computed once.
pub(crate) fn hann_window() -> &'static [f32] {
    HANN.get_or_init(|| {
        (0..FFT_SIZE)
            .map(|i| {
                let t = i as f32 / FFT_SIZE as f32;
                0.5 - 0.5 * (std::f32::consts::TAU * t).cos()
            })
            .collect()
    })
}

/// Coherent gain of the Hann window (mean of its samples, 0.5). A windowed
/// full-scale sine therefore peaks at `FFT_SIZE * 0.5 / 2` in its bin, which is
/// the divisor [`magnitude_to_db`] normalises against.
const HANN_COHERENT_GAIN: f32 = 0.5;

// ── FFT ──────────────────────────────────────────────────────────────────────

struct Twiddles {
    cos: Vec<f32>,
    sin: Vec<f32>,
}

static TWIDDLES: OnceLock<Twiddles> = OnceLock::new();

fn twiddles() -> &'static Twiddles {
    TWIDDLES.get_or_init(|| {
        let half = FFT_SIZE / 2;
        let mut cos = Vec::with_capacity(half);
        let mut sin = Vec::with_capacity(half);
        for k in 0..half {
            let angle = -std::f32::consts::TAU * k as f32 / FFT_SIZE as f32;
            cos.push(angle.cos());
            sin.push(angle.sin());
        }
        Twiddles { cos, sin }
    })
}

/// In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` must both be
/// [`FFT_SIZE`] long; a mismatch is a no-op rather than a panic because this
/// runs on a background thread we never want to take down.
pub(crate) fn fft_in_place(re: &mut [f32], im: &mut [f32]) {
    let n = FFT_SIZE;
    if re.len() != n || im.len() != n {
        return;
    }

    // Bit-reversal permutation.
    let bits = n.trailing_zeros();
    for i in 0..n {
        let j = (i as u32).reverse_bits() >> (32 - bits);
        let j = j as usize;
        if j > i {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let tw = twiddles();
    let mut len = 2;
    while len <= n {
        let step = n / len;
        let half = len / 2;
        let mut start = 0;
        while start < n {
            for k in 0..half {
                let t = k * step;
                let (wr, wi) = (tw.cos[t], tw.sin[t]);
                let i = start + k;
                let j = i + half;
                let xr = re[j] * wr - im[j] * wi;
                let xi = re[j] * wi + im[j] * wr;
                re[j] = re[i] - xr;
                im[j] = im[i] - xi;
                re[i] += xr;
                im[i] += xi;
            }
            start += len;
        }
        len <<= 1;
    }
}

/// Magnitude spectrum of the first half (positive frequencies) of a completed
/// FFT, normalised so a full-scale sine reads 1.0 in its bin.
pub(crate) fn magnitudes(re: &[f32], im: &[f32], out: &mut [f32]) {
    let half = FFT_SIZE / 2;
    if re.len() != FFT_SIZE || im.len() != FFT_SIZE || out.len() != half {
        return;
    }
    // A real sine of amplitude 1 splits its energy across the ± frequency pair,
    // so its positive-frequency bin holds N·gain/2.
    let norm = 2.0 / (FFT_SIZE as f32 * HANN_COHERENT_GAIN);
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = (re[i] * re[i] + im[i] * im[i]).sqrt() * norm;
    }
}

// ── Band mapping ─────────────────────────────────────────────────────────────

/// Inclusive bin range and tilt gain for one display band.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Band {
    pub(crate) lo: usize,
    pub(crate) hi: usize,
    pub(crate) tilt_db: f32,
}

/// Log-spaced band layout for one sample rate.
pub(crate) fn band_layout(sample_rate: u32) -> Vec<Band> {
    let nyquist = (sample_rate as f32 / 2.0).max(1_000.0);
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let max_bin = FFT_SIZE / 2 - 1;

    let lo_hz = BAND_MIN_HZ;
    let hi_hz = BAND_MAX_HZ.min(nyquist * 0.94).max(lo_hz * 4.0);
    let ratio = (hi_hz / lo_hz).ln() / BAND_COUNT as f32;

    let mut bands = Vec::with_capacity(BAND_COUNT);
    let mut prev_hi: Option<usize> = None;
    for b in 0..BAND_COUNT {
        let f_lo = lo_hz * (ratio * b as f32).exp();
        let f_hi = lo_hz * (ratio * (b + 1) as f32).exp();

        let mut lo = (f_lo / bin_hz).floor() as usize;
        let mut hi = (f_hi / bin_hz).ceil() as usize;
        // Skip DC — it carries offset, not music.
        lo = lo.max(1).min(max_bin);
        hi = hi.max(lo).min(max_bin);
        // Below the point where bands are narrower than one bin, neighbouring
        // bands would otherwise share a bin and move in lockstep. Nudge each
        // band past the previous one so the low end still has visible detail.
        if let Some(p) = prev_hi {
            if lo <= p && p < max_bin {
                lo = p + 1;
                hi = hi.max(lo);
            }
        }
        prev_hi = Some(hi);

        let centre = (f_lo * f_hi).sqrt().max(1.0);
        let tilt_db = (TILT_DB_PER_OCTAVE * (centre / TILT_REF_HZ).log2()).clamp(0.0, TILT_MAX_DB);
        bands.push(Band { lo, hi, tilt_db });
    }
    bands
}

/// Linear magnitude → normalised 0..1 display level over `FLOOR_DB..0 dB`.
pub(crate) fn magnitude_to_level(mag: f32, tilt_db: f32) -> f32 {
    if mag <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * mag.log10() + tilt_db;
    ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
}

/// Collapse the magnitude spectrum onto the display bands. Each band takes the
/// *peak* of its bins rather than the mean: means wash out narrow tones as the
/// bands widen towards the treble, which is exactly where music detail lives.
pub(crate) fn bands_from_magnitudes(mags: &[f32], layout: &[Band], out: &mut [f32]) {
    for (band, slot) in layout.iter().zip(out.iter_mut()) {
        let hi = band.hi.min(mags.len().saturating_sub(1));
        let lo = band.lo.min(hi);
        let peak = mags[lo..=hi].iter().copied().fold(0.0f32, f32::max);
        *slot = magnitude_to_level(peak, band.tilt_db);
    }
}

// ── Smoothing ────────────────────────────────────────────────────────────────

/// Neutral responsiveness. Biased towards the snappy end: the analysis window
/// already smears transients by ~43 ms, so a long envelope tail on top of that
/// is what makes a visualizer feel like it is lagging the music.
pub(crate) const DEFAULT_RESPONSIVENESS: f32 = 0.65;

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Envelope timings, derived from a single 0..1 "responsiveness" control.
///
/// 0 is a slow VU-meter feel with long tails; 1 is a near-instant Winamp-style
/// strobe. Every constant moves together because they are not independent —
/// a fast fall with a long peak hold just leaves caps floating over nothing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SmoothingProfile {
    pub(crate) attack_tau: f32,
    pub(crate) decay_tau: f32,
    pub(crate) peak_hold: f32,
    pub(crate) peak_fall: f32,
}

impl SmoothingProfile {
    pub(crate) fn from_responsiveness(responsiveness: f32) -> Self {
        let r = if responsiveness.is_finite() {
            responsiveness.clamp(0.0, 1.0)
        } else {
            DEFAULT_RESPONSIVENESS
        };
        Self {
            attack_tau: lerp(0.014, 0.0015, r),
            decay_tau: lerp(0.20, 0.03, r),
            peak_hold: lerp(0.70, 0.20, r),
            peak_fall: lerp(0.55, 1.80, r),
        }
    }
}

impl Default for SmoothingProfile {
    fn default() -> Self {
        Self::from_responsiveness(DEFAULT_RESPONSIVENESS)
    }
}

/// Per-band envelope follower with Winamp-style peak caps.
pub(crate) struct Smoother {
    levels: Vec<f32>,
    peaks: Vec<f32>,
    hold: Vec<f32>,
    profile: SmoothingProfile,
}

impl Smoother {
    pub(crate) fn new(profile: SmoothingProfile) -> Self {
        Self {
            levels: vec![0.0; BAND_COUNT],
            peaks: vec![0.0; BAND_COUNT],
            hold: vec![0.0; BAND_COUNT],
            profile,
        }
    }

    /// Retune without dropping the envelopes — changing the setting mid-track
    /// should shift the motion, not blank the bars.
    pub(crate) fn set_profile(&mut self, profile: SmoothingProfile) {
        self.profile = profile;
    }

    pub(crate) fn profile(&self) -> SmoothingProfile {
        self.profile
    }

    pub(crate) fn levels(&self) -> &[f32] {
        &self.levels
    }

    pub(crate) fn peaks(&self) -> &[f32] {
        &self.peaks
    }

    /// True once every band and cap has settled at zero — the emit loop uses
    /// this to stop sending frames after playback stops instead of streaming
    /// all-zero payloads forever.
    pub(crate) fn is_settled(&self) -> bool {
        self.levels
            .iter()
            .chain(self.peaks.iter())
            .all(|v| *v <= 0.0005)
    }

    /// Advance the envelopes towards `target` over `dt` seconds. Coefficients
    /// are time-based rather than per-frame so the motion looks identical at
    /// any emit rate the user picks.
    pub(crate) fn step(&mut self, target: &[f32], dt: f32) {
        let dt = dt.clamp(0.001, 0.5);
        let attack = 1.0 - (-dt / self.profile.attack_tau).exp();
        let decay = 1.0 - (-dt / self.profile.decay_tau).exp();

        for i in 0..BAND_COUNT {
            let t = target.get(i).copied().unwrap_or(0.0);
            let cur = self.levels[i];
            let coef = if t > cur { attack } else { decay };
            let next = cur + (t - cur) * coef;
            self.levels[i] = if next.abs() < 0.0005 { 0.0 } else { next };

            if next >= self.peaks[i] {
                self.peaks[i] = next;
                self.hold[i] = self.profile.peak_hold;
            } else if self.hold[i] > 0.0 {
                self.hold[i] -= dt;
            } else {
                self.peaks[i] = (self.peaks[i] - self.profile.peak_fall * dt)
                    .max(next)
                    .max(0.0);
            }
        }
    }
}

// ── Wire encoding ────────────────────────────────────────────────────────────

/// Quantise 0..1 levels to bytes.
pub(crate) fn quantize(levels: &[f32]) -> Vec<u8> {
    levels
        .iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8)
        .collect()
}

/// Decimate the analysis window to [`WAVE_COUNT`] points for the oscilloscope.
/// Each output point is the bucket's largest-magnitude sample, so a zero
/// crossing between two loud peaks can't alias the trace flat.
pub(crate) fn downsample_waveform(samples: &[f32]) -> Vec<u8> {
    let mut out = vec![128u8; WAVE_COUNT];
    if samples.is_empty() {
        return out;
    }
    let bucket = samples.len() as f32 / WAVE_COUNT as f32;
    for (i, slot) in out.iter_mut().enumerate() {
        let start = (i as f32 * bucket) as usize;
        let end = (((i + 1) as f32 * bucket) as usize)
            .min(samples.len())
            .max(start + 1);
        let mut extreme = 0.0f32;
        for s in &samples[start..end.min(samples.len())] {
            if s.abs() > extreme.abs() {
                extreme = *s;
            }
        }
        // Centre at 128 so the frontend reads it as a signed trace.
        *slot = ((extreme.clamp(-1.0, 1.0) * 127.0) + 128.0)
            .round()
            .clamp(0.0, 255.0) as u8;
    }
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding. The payloads are small fixed-size byte arrays;
/// encoding them as a string instead of a JSON number array cuts the IPC text
/// roughly 4× per frame, which matters on WebView2 where the pipe is the
/// bottleneck (see the note in `ipc.rs`).
pub(crate) fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sample_rate: f32, amp: f32) -> (Vec<f32>, Vec<f32>) {
        let re: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let t = i as f32 / sample_rate;
                amp * (std::f32::consts::TAU * freq * t).sin()
            })
            .collect();
        (re, vec![0.0; FFT_SIZE])
    }

    fn windowed_spectrum(freq: f32, sample_rate: f32, amp: f32) -> Vec<f32> {
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

    // ── FFT ──────────────────────────────────────────────────────────────────

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

    // ── Level mapping ────────────────────────────────────────────────────────

    #[test]
    fn silence_maps_to_zero_level() {
        assert_eq!(magnitude_to_level(0.0, 0.0), 0.0);
    }

    #[test]
    fn full_scale_maps_to_one() {
        assert!((magnitude_to_level(1.0, 0.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn floor_db_maps_to_zero() {
        let mag = 10f32.powf(FLOOR_DB / 20.0);
        assert!(magnitude_to_level(mag, 0.0).abs() < 1e-5);
    }

    #[test]
    fn level_mapping_is_monotonic() {
        let mut prev = -1.0;
        for step in 0..50 {
            let mag = 10f32.powf((FLOOR_DB + step as f32 * 1.5) / 20.0);
            let level = magnitude_to_level(mag, 0.0);
            assert!(level >= prev, "level fell at step {step}");
            prev = level;
        }
    }

    #[test]
    fn tilt_lifts_a_band_by_the_requested_db() {
        let mag = 10f32.powf(-40.0 / 20.0);
        let flat = magnitude_to_level(mag, 0.0);
        let tilted = magnitude_to_level(mag, 12.0);
        let delta_db = (tilted - flat) * -FLOOR_DB;
        assert!((delta_db - 12.0).abs() < 0.01, "tilt delta {delta_db} dB");
    }

    // ── Band layout ──────────────────────────────────────────────────────────

    #[test]
    fn band_layout_produces_the_expected_count() {
        assert_eq!(band_layout(48_000).len(), BAND_COUNT);
    }

    #[test]
    fn band_layout_never_reads_dc_or_exceeds_nyquist() {
        for rate in [22_050u32, 44_100, 48_000, 96_000, 192_000] {
            let layout = band_layout(rate);
            for band in &layout {
                assert!(band.lo >= 1, "rate {rate} band reads DC");
                assert!(
                    band.hi < FFT_SIZE / 2,
                    "rate {rate} band exceeds Nyquist bins"
                );
                assert!(band.lo <= band.hi, "rate {rate} band inverted");
            }
        }
    }

    #[test]
    fn band_layout_is_ascending_and_non_degenerate() {
        let layout = band_layout(48_000);
        // Each band must start no earlier than the previous one, and the layout
        // must actually span a range rather than collapsing onto one bin.
        for pair in layout.windows(2) {
            assert!(pair[1].lo >= pair[0].lo, "bands not ascending: {pair:?}");
        }
        assert!(layout[BAND_COUNT - 1].hi > layout[0].hi * 4);
    }

    #[test]
    fn band_layout_survives_absurd_sample_rates() {
        for rate in [0u32, 1, 8_000] {
            let layout = band_layout(rate);
            assert_eq!(layout.len(), BAND_COUNT);
            assert!(layout.iter().all(|b| b.lo >= 1 && b.hi < FFT_SIZE / 2));
        }
    }

    #[test]
    fn tilt_stays_near_the_true_pink_slope() {
        // Over-tilting pushes the treble bands into the ceiling, which flattens
        // the whole spectrum into a uniform wall of near-full-height bars —
        // exactly the "everything looks the same height" failure mode.
        let layout = band_layout(48_000);
        let top = layout[BAND_COUNT - 1].tilt_db;
        assert!(top <= 20.0, "top-band tilt {top} dB is too aggressive");
        assert!(
            top >= 10.0,
            "top-band tilt {top} dB is too weak to lift the treble"
        );
    }

    #[test]
    fn a_realistic_pink_spectrum_keeps_visible_contrast() {
        // Pink noise (−3 dB/octave) is the reference "flat-looking" input. Real
        // music departs from it, and those departures are what the eye reads —
        // so bands must not all pin to the top for a pink-ish input.
        let layout = band_layout(48_000);
        let mut levels = Vec::new();
        for band in &layout {
            let centre_bin = (band.lo + band.hi) as f32 / 2.0;
            let freq = centre_bin * (48_000.0 / FFT_SIZE as f32);
            // −3 dB per octave above 200 Hz, starting at −18 dBFS.
            let db = -18.0 - 3.0 * (freq / 200.0).log2();
            levels.push(magnitude_to_level(10f32.powf(db / 20.0), band.tilt_db));
        }
        let max = levels.iter().copied().fold(0.0f32, f32::max);
        assert!(
            max < 0.98,
            "pink input pinned a band at the ceiling ({max})"
        );
        assert!(max > 0.3, "pink input barely registered ({max})");
    }

    #[test]
    fn tilt_rises_with_frequency() {
        let layout = band_layout(48_000);
        assert!(layout[BAND_COUNT - 1].tilt_db > layout[0].tilt_db);
        assert!(layout.iter().all(|b| b.tilt_db <= TILT_MAX_DB));
    }

    #[test]
    fn a_tone_lights_the_band_containing_it() {
        let sample_rate = 48_000u32;
        let layout = band_layout(sample_rate);
        let freq = 1_000.0;
        let mags = windowed_spectrum(freq, sample_rate as f32, 1.0);
        let mut bands = vec![0.0; BAND_COUNT];
        bands_from_magnitudes(&mags, &layout, &mut bands);

        let bin = (freq / (sample_rate as f32 / FFT_SIZE as f32)).round() as usize;
        let expected = layout
            .iter()
            .position(|b| bin >= b.lo && bin <= b.hi)
            .unwrap();
        let (loudest, _) = bands
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .unwrap();
        assert_eq!(loudest, expected, "1 kHz tone should light its own band");
    }

    #[test]
    fn silence_produces_all_zero_bands() {
        let layout = band_layout(48_000);
        let mags = vec![0.0; FFT_SIZE / 2];
        let mut bands = vec![0.0; BAND_COUNT];
        bands_from_magnitudes(&mags, &layout, &mut bands);
        assert!(bands.iter().all(|v| *v == 0.0));
    }

    // ── Smoother ─────────────────────────────────────────────────────────────

    // ── SmoothingProfile ─────────────────────────────────────────────────────

    #[test]
    fn responsiveness_shortens_every_timing_as_it_rises() {
        let smooth = SmoothingProfile::from_responsiveness(0.0);
        let snappy = SmoothingProfile::from_responsiveness(1.0);
        assert!(snappy.attack_tau < smooth.attack_tau);
        assert!(snappy.decay_tau < smooth.decay_tau);
        assert!(snappy.peak_hold < smooth.peak_hold);
        assert!(
            snappy.peak_fall > smooth.peak_fall,
            "caps must fall faster, not slower"
        );
    }

    #[test]
    fn responsiveness_is_clamped_and_nan_safe() {
        assert_eq!(
            SmoothingProfile::from_responsiveness(-5.0),
            SmoothingProfile::from_responsiveness(0.0)
        );
        assert_eq!(
            SmoothingProfile::from_responsiveness(9.0),
            SmoothingProfile::from_responsiveness(1.0)
        );
        assert_eq!(
            SmoothingProfile::from_responsiveness(f32::NAN),
            SmoothingProfile::default()
        );
    }

    #[test]
    fn every_profile_keeps_positive_time_constants() {
        for step in 0..=10 {
            let p = SmoothingProfile::from_responsiveness(step as f32 / 10.0);
            assert!(p.attack_tau > 0.0 && p.decay_tau > 0.0, "{p:?}");
            assert!(p.peak_hold >= 0.0 && p.peak_fall > 0.0, "{p:?}");
        }
    }

    #[test]
    fn a_snappier_profile_falls_faster_from_the_same_state() {
        fn fall_after(responsiveness: f32) -> f32 {
            let mut s = Smoother::new(SmoothingProfile::from_responsiveness(responsiveness));
            for _ in 0..200 {
                s.step(&vec![1.0; BAND_COUNT], 0.016);
            }
            for _ in 0..6 {
                s.step(&vec![0.0; BAND_COUNT], 0.016);
            }
            s.levels()[0]
        }
        assert!(
            fall_after(1.0) < fall_after(0.0),
            "snappy must decay faster than smooth"
        );
    }

    #[test]
    fn retuning_keeps_the_current_envelope() {
        let mut s = Smoother::new(SmoothingProfile::from_responsiveness(0.0));
        for _ in 0..200 {
            s.step(&vec![1.0; BAND_COUNT], 0.016);
        }
        let before = s.levels()[0];
        s.set_profile(SmoothingProfile::from_responsiveness(1.0));
        // Changing the setting mid-track must shift the motion, not blank the bars.
        assert_eq!(s.levels()[0], before);
        assert_eq!(s.profile(), SmoothingProfile::from_responsiveness(1.0));
    }

    #[test]
    fn default_profile_decays_quicker_than_a_third_of_a_second() {
        // Guards the responsiveness complaint that prompted this control: at the
        // default the bars must be most of the way down within ~200 ms.
        let mut s = Smoother::new(SmoothingProfile::default());
        for _ in 0..200 {
            s.step(&vec![1.0; BAND_COUNT], 0.016);
        }
        for _ in 0..12 {
            s.step(&vec![0.0; BAND_COUNT], 0.016);
        }
        assert!(
            s.levels()[0] < 0.2,
            "level after ~190 ms was {}",
            s.levels()[0]
        );
    }

    #[test]
    fn smoother_starts_settled() {
        assert!(Smoother::new(SmoothingProfile::default()).is_settled());
    }

    #[test]
    fn smoother_attacks_faster_than_it_decays() {
        let target = vec![1.0; BAND_COUNT];
        let mut up = Smoother::new(SmoothingProfile::default());
        up.step(&target, 0.016);
        let risen = up.levels()[0];

        let mut down = Smoother::new(SmoothingProfile::default());
        for _ in 0..200 {
            down.step(&target, 0.016);
        }
        let before = down.levels()[0];
        down.step(&vec![0.0; BAND_COUNT], 0.016);
        let fallen = before - down.levels()[0];

        assert!(
            risen > fallen,
            "attack {risen} should outpace decay {fallen}"
        );
    }

    #[test]
    fn smoother_converges_to_its_target() {
        let target = vec![0.75; BAND_COUNT];
        let mut s = Smoother::new(SmoothingProfile::default());
        for _ in 0..500 {
            s.step(&target, 0.016);
        }
        assert!(
            (s.levels()[0] - 0.75).abs() < 0.01,
            "level {}",
            s.levels()[0]
        );
    }

    #[test]
    fn smoother_settles_after_the_signal_stops() {
        let mut s = Smoother::new(SmoothingProfile::default());
        for _ in 0..100 {
            s.step(&vec![1.0; BAND_COUNT], 0.016);
        }
        assert!(!s.is_settled());
        for _ in 0..600 {
            s.step(&vec![0.0; BAND_COUNT], 0.016);
        }
        assert!(s.is_settled(), "levels {:?}", &s.levels()[..4]);
    }

    #[test]
    fn peak_cap_holds_then_falls_and_never_drops_below_the_level() {
        let mut s = Smoother::new(SmoothingProfile::default());
        for _ in 0..300 {
            s.step(&vec![1.0; BAND_COUNT], 0.016);
        }
        let peak_at_top = s.peaks()[0];
        assert!(peak_at_top > 0.9);

        // Immediately after the signal cuts, the cap is still held.
        s.step(&vec![0.0; BAND_COUNT], 0.016);
        assert!(s.peaks()[0] > 0.9, "cap should hang before falling");

        // Well past the hold window it has fallen, but never under the bar.
        for _ in 0..40 {
            s.step(&vec![0.0; BAND_COUNT], 0.016);
        }
        assert!(s.peaks()[0] < peak_at_top, "cap should fall after the hold");
        assert!(
            s.peaks()[0] >= s.levels()[0] - 1e-6,
            "cap fell below its bar"
        );
    }

    #[test]
    fn smoother_motion_is_frame_rate_independent() {
        let target = vec![1.0; BAND_COUNT];
        let mut fast = Smoother::new(SmoothingProfile::default());
        for _ in 0..60 {
            fast.step(&target, 1.0 / 60.0);
        }
        let mut slow = Smoother::new(SmoothingProfile::default());
        for _ in 0..15 {
            slow.step(&target, 1.0 / 15.0);
        }
        // One second of rise either way should land in the same place.
        assert!(
            (fast.levels()[0] - slow.levels()[0]).abs() < 0.02,
            "60fps {} vs 15fps {}",
            fast.levels()[0],
            slow.levels()[0]
        );
    }

    // ── Encoding ─────────────────────────────────────────────────────────────

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
}

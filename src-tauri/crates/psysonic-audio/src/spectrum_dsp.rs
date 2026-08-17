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

/// Combine independent linear-channel FFT magnitudes as average per-bin power.
/// Keeping channel combination after the FFT prevents phase cancellation and
/// cannot synthesize intermodulation products that were absent from both lanes.
pub(crate) fn combine_power_magnitudes(left: &[f32], right: &[f32], out: &mut [f32]) {
    for (i, slot) in out.iter_mut().enumerate() {
        let left = left.get(i).copied().unwrap_or(0.0);
        let right = right.get(i).copied().unwrap_or(0.0);
        *slot = ((left * left + right * right) * 0.5).sqrt();
    }
}

// ── Band mapping ─────────────────────────────────────────────────────────────

/// Bin range, centre sampling mode, and tilt gain for one display band.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Band {
    pub(crate) lo: usize,
    pub(crate) hi: usize,
    /// Fractional bin position of the band's centre frequency, for
    /// interpolating bands narrower than one FFT bin.
    pub(crate) centre_bin: f32,
    /// Whether the band's frequency span is narrower than one FFT bin.
    pub(crate) interpolate_centre: bool,
    pub(crate) tilt_db: f32,
}

/// Log-spaced band layout for one sample rate.
pub(crate) fn band_layout(sample_rate: u32) -> Vec<Band> {
    let effective_rate = sample_rate.max(1);
    let nyquist = (effective_rate as f32 / 2.0).max(1_000.0);
    let bin_hz = effective_rate as f32 / FFT_SIZE as f32;
    let max_bin = FFT_SIZE / 2 - 1;

    let lo_hz = BAND_MIN_HZ;
    let hi_hz = BAND_MAX_HZ.min(nyquist * 0.94).max(lo_hz * 4.0);
    let ratio = (hi_hz / lo_hz).ln() / BAND_COUNT as f32;

    let mut bands = Vec::with_capacity(BAND_COUNT);
    for b in 0..BAND_COUNT {
        let f_lo = lo_hz * (ratio * b as f32).exp();
        let f_hi = lo_hz * (ratio * (b + 1) as f32).exp();

        let centre = (f_lo * f_hi).sqrt().max(1.0);
        // Select FFT-bin centres that actually lie in this half-open frequency
        // interval. If none do, keep the nearest real bin as the band's range
        // fallback. Assigning each such band a unique higher bin invents
        // resolution and relabels midrange energy as bass, especially at high
        // sample rates. Narrow bands are sampled at their fractional centre
        // below, independently of whether a bin centre falls inside the range.
        let first = (f_lo / bin_hz).ceil() as usize;
        let last = ((f_hi / bin_hz).ceil() as usize).saturating_sub(1);
        let (lo, hi) = if first <= last && first <= max_bin {
            (first.max(1), last.min(max_bin))
        } else {
            let nearest = ((centre / bin_hz).round() as usize).clamp(1, max_bin);
            (nearest, nearest)
        };

        let centre_bin = (centre / bin_hz).clamp(0.0, max_bin as f32);
        let interpolate_centre = f_hi - f_lo < bin_hz;
        let tilt_db = (TILT_DB_PER_OCTAVE * (centre / TILT_REF_HZ).log2()).clamp(0.0, TILT_MAX_DB);
        bands.push(Band {
            lo,
            hi,
            centre_bin,
            interpolate_centre,
            tilt_db,
        });
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
        let mag = if band.interpolate_centre {
            // Bands narrower than one FFT bin can collapse onto a shared bin.
            // Taking that bin's value verbatim renders runs of neighbouring
            // bars as flat lockstep plateaus. Sampling the spectrum at each
            // band's own centre keeps adjacent bars distinct without moving
            // the band's frequency range.
            interpolated_magnitude(mags, band.centre_bin)
        } else {
            mags[lo..=hi].iter().copied().fold(0.0f32, f32::max)
        };
        *slot = magnitude_to_level(mag, band.tilt_db);
    }
}

/// Linear interpolation of the magnitude spectrum at a fractional bin position.
fn interpolated_magnitude(mags: &[f32], centre_bin: f32) -> f32 {
    let max = mags.len().saturating_sub(1);
    if max == 0 {
        return mags.first().copied().unwrap_or(0.0);
    }
    // Bin zero is never a display band, but its windowed magnitude is a useful
    // interpolation endpoint for real frequencies below the first positive bin.
    let pos = centre_bin.clamp(0.0, max as f32);
    let i0 = pos.floor() as usize;
    let i1 = (i0 + 1).min(max);
    let frac = pos - i0 as f32;
    mags[i0] * (1.0 - frac) + mags[i1] * frac
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

/// Decimate one folded stereo lane to [`WAVE_COUNT`] points for the oscilloscope.
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
#[path = "spectrum_dsp/test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "spectrum_dsp/fft_tests.rs"]
mod fft_tests;

#[cfg(test)]
#[path = "spectrum_dsp/band_tests.rs"]
mod band_tests;

#[cfg(test)]
#[path = "spectrum_dsp/smoothing_tests.rs"]
mod smoothing_tests;

#[cfg(test)]
#[path = "spectrum_dsp/encoding_tests.rs"]
mod encoding_tests;

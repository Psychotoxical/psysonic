use serde::Serialize;

use super::current_responsiveness;
use crate::spectrum_dsp::{
    band_layout, bands_from_magnitudes, base64, combine_power_magnitudes, downsample_waveform,
    fft_in_place, hann_window, magnitudes, quantize, Band, Smoother, SmoothingProfile, BAND_COUNT,
    FFT_SIZE, WAVE_COUNT,
};

/// `audio:spectrum` payload. All four arrays are base64 bytes:
///   • bands / peaks — `bandCount` entries, 0..255 over the dB display range
///   • waveformLeft / waveformRight — `waveCount` entries from the conventional
///     folded stereo lanes, signed and centred on 128. Ordinary stereo remains
///     exact L/R; mono and multichannel energy are present in the relevant lane.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpectrumPayload {
    pub(crate) bands: String,
    pub(crate) peaks: String,
    pub(crate) waveform_left: String,
    pub(crate) waveform_right: String,
    /// Window RMS, 0..1 linear.
    pub(crate) rms: f32,
    /// Window absolute peak, 0..1 linear.
    pub(crate) peak: f32,
    pub(crate) band_count: u32,
    pub(crate) wave_count: u32,
    pub(crate) sample_rate: u32,
}

type StereoWindow<'a> = (&'a [f32], &'a [f32]);

/// Owns the scratch buffers and envelope state for the emit loop. Kept separate
/// from the loop itself so frame production is testable without an audio device
/// or a Tauri app handle.
pub(crate) struct Analyzer {
    pub(super) layout: Vec<Band>,
    layout_rate: u32,
    smoother: Smoother,
    re: Vec<f32>,
    im: Vec<f32>,
    mags_left: Vec<f32>,
    mags_right: Vec<f32>,
    mags: Vec<f32>,
    pub(super) bands: Vec<f32>,
}

impl Analyzer {
    pub(crate) fn new() -> Self {
        Self {
            layout: band_layout(48_000),
            layout_rate: 48_000,
            smoother: Smoother::new(SmoothingProfile::default()),
            re: vec![0.0; FFT_SIZE],
            im: vec![0.0; FFT_SIZE],
            mags_left: vec![0.0; FFT_SIZE / 2],
            mags_right: vec![0.0; FFT_SIZE / 2],
            mags: vec![0.0; FFT_SIZE / 2],
            bands: vec![0.0; BAND_COUNT],
        }
    }

    pub(crate) fn is_settled(&self) -> bool {
        self.smoother.is_settled()
    }

    /// Produce one frame from the latest conventional folded stereo lanes.
    ///
    /// `fresh` is false when the ring hasn't advanced since the last tick —
    /// paused, stopped, or between tracks. The envelopes then decay towards
    /// zero, and once everything has settled this returns `None` so the loop
    /// stops putting all-zero frames on the IPC pipe.
    pub(crate) fn frame(
        &mut self,
        lanes: StereoWindow<'_>,
        sample_rate: u32,
        dt: f32,
        fresh: bool,
    ) -> Option<SpectrumPayload> {
        let (left, right) = lanes;
        if !fresh && self.smoother.is_settled() {
            return None;
        }

        if fresh {
            let rate = if sample_rate == 0 {
                48_000
            } else {
                sample_rate
            };
            if rate != self.layout_rate {
                self.layout = band_layout(rate);
                self.layout_rate = rate;
            }

            lane_magnitudes(left, &mut self.re, &mut self.im, &mut self.mags_left);
            lane_magnitudes(right, &mut self.re, &mut self.im, &mut self.mags_right);
            combine_power_magnitudes(&self.mags_left, &self.mags_right, &mut self.mags);
            bands_from_magnitudes(&self.mags, &self.layout, &mut self.bands);
        } else {
            self.bands.iter_mut().for_each(|b| *b = 0.0);
        }

        // Retune in place if the user moved the responsiveness control.
        let wanted = SmoothingProfile::from_responsiveness(current_responsiveness());
        if wanted != self.smoother.profile() {
            self.smoother.set_profile(wanted);
        }

        self.smoother.step(&self.bands, dt);

        let (rms, peak) = if fresh {
            stereo_window_levels(left, right)
        } else {
            (0.0, 0.0)
        };

        Some(SpectrumPayload {
            bands: base64(&quantize(self.smoother.levels())),
            peaks: base64(&quantize(self.smoother.peaks())),
            waveform_left: base64(&if fresh {
                downsample_waveform(left)
            } else {
                vec![128u8; WAVE_COUNT]
            }),
            waveform_right: base64(&if fresh {
                downsample_waveform(right)
            } else {
                vec![128u8; WAVE_COUNT]
            }),
            rms,
            peak,
            band_count: BAND_COUNT as u32,
            wave_count: WAVE_COUNT as u32,
            sample_rate: self.layout_rate,
        })
    }
}

fn lane_magnitudes(input: &[f32], re: &mut [f32], im: &mut [f32], out: &mut [f32]) {
    let hann = hann_window();
    for (i, (sample, window)) in re.iter_mut().zip(hann.iter()).enumerate() {
        *sample = input.get(i).copied().unwrap_or(0.0) * window;
    }
    im.iter_mut().for_each(|value| *value = 0.0);
    fft_in_place(re, im);
    magnitudes(re, im, out);
}

impl Default for Analyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// RMS and absolute peak of an analysis window, both 0..1.
#[cfg(test)]
pub(crate) fn window_levels(window: &[f32]) -> (f32, f32) {
    if window.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    for s in window {
        sum_sq += (*s as f64) * (*s as f64);
        peak = peak.max(s.abs());
    }
    let rms = (sum_sq / window.len() as f64).sqrt() as f32;
    (rms.clamp(0.0, 1.0), peak.clamp(0.0, 1.0))
}

fn stereo_window_levels(left: &[f32], right: &[f32]) -> (f32, f32) {
    let samples = left.len().min(right.len());
    if samples == 0 {
        return (0.0, 0.0);
    }
    let mut sum_sq = 0.0f64;
    let mut peak = 0.0f32;
    for i in 0..samples {
        let left = left[i];
        let right = right[i];
        sum_sq += left as f64 * left as f64 + right as f64 * right as f64;
        peak = peak.max(left.abs()).max(right.abs());
    }
    let rms = (sum_sq / (samples * 2) as f64).sqrt() as f32;
    (rms.clamp(0.0, 1.0), peak.clamp(0.0, 1.0))
}

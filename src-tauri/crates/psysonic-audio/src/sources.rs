//! Rodio `Source` wrappers: EQ, type erasure, fades, end-of-source notify, sample counter.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm2Transposed, ToHertz, Type as FilterType};
use rodio::Source;

// ─── 10-Band Graphic Equalizer ────────────────────────────────────────────────

const EQ_BANDS_HZ: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
const EQ_Q: f32 = 1.41;
const EQ_CHECK_INTERVAL: usize = 1024;

pub(crate) struct EqSource<S: Source<Item = f32>> {
    inner: S,
    sample_rate: rodio::SampleRate,
    channels: rodio::ChannelCount,
    gains: Arc<[AtomicU32; 10]>,
    enabled: Arc<AtomicBool>,
    pre_gain: Arc<AtomicU32>,
    filters: [[DirectForm2Transposed<f32>; 2]; 10],
    current_gains: [f32; 10],
    sample_counter: usize,
    channel_idx: usize,
}

impl<S: Source<Item = f32>> EqSource<S> {
    pub(crate) fn new(inner: S, gains: Arc<[AtomicU32; 10]>, enabled: Arc<AtomicBool>, pre_gain: Arc<AtomicU32>) -> Self {
        let sample_rate = inner.sample_rate();
        let channels = inner.channels();
        let filters = std::array::from_fn(|band| {
            let freq = EQ_BANDS_HZ[band].clamp(20.0, (sample_rate.get() as f32 / 2.0) - 100.0);
            std::array::from_fn(|_| {
                let coeffs = Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(0.0),
                    (sample_rate.get() as f32).hz(),
                    freq.hz(),
                    EQ_Q,
                ).unwrap_or_else(|_| Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(0.0),
                    (sample_rate.get() as f32).hz(),
                    1000.0f32.hz(),
                    EQ_Q,
                ).unwrap());
                DirectForm2Transposed::<f32>::new(coeffs)
            })
        });
        Self {
            inner, sample_rate, channels, gains, enabled, pre_gain,
            filters,
            current_gains: [0.0; 10],
            sample_counter: 0,
            channel_idx: 0,
        }
    }

    #[allow(clippy::needless_range_loop)]
    fn refresh_if_needed(&mut self) {
        for band in 0..10 {
            let gain_db = f32::from_bits(self.gains[band].load(Ordering::Relaxed));
            if (gain_db - self.current_gains[band]).abs() > 0.01 {
                self.current_gains[band] = gain_db;
                let freq = EQ_BANDS_HZ[band].clamp(20.0, (self.sample_rate.get() as f32 / 2.0) - 100.0);
                if let Ok(coeffs) = Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(gain_db),
                    (self.sample_rate.get() as f32).hz(),
                    freq.hz(),
                    EQ_Q,
                ) {
                    for ch in 0..2 {
                        self.filters[band][ch].update_coefficients(coeffs);
                    }
                }
            }
        }
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;

        if self.sample_counter.is_multiple_of(EQ_CHECK_INTERVAL) {
            self.refresh_if_needed();
        }
        self.sample_counter = self.sample_counter.wrapping_add(1);

        if !self.enabled.load(Ordering::Relaxed) {
            self.channel_idx = (self.channel_idx + 1) % self.channels.get() as usize;
            return Some(sample);
        }

        let ch = self.channel_idx.min(1);
        self.channel_idx = (self.channel_idx + 1) % self.channels.get() as usize;

        let pre_gain_db = f32::from_bits(self.pre_gain.load(Ordering::Relaxed));
        let pre_gain_factor = 10_f32.powf(pre_gain_db / 20.0);
        let mut s = sample * pre_gain_factor;
        for band in 0..10 {
            s = self.filters[band][ch].run(s);
        }
        Some(s.clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.channels }
    fn sample_rate(&self) -> rodio::SampleRate { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }

    #[allow(clippy::needless_range_loop)]
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Reset biquad filter state to avoid glitches after seek.
        for band in 0..10 {
            let gain_db = f32::from_bits(self.gains[band].load(Ordering::Relaxed));
            self.current_gains[band] = gain_db;
            let freq = EQ_BANDS_HZ[band].clamp(20.0, (self.sample_rate.get() as f32 / 2.0) - 100.0);
            if let Ok(coeffs) = Coefficients::<f32>::from_params(
                FilterType::PeakingEQ(gain_db),
                (self.sample_rate.get() as f32).hz(),
                freq.hz(),
                EQ_Q,
            ) {
                for ch in 0..2 {
                    self.filters[band][ch] = DirectForm2Transposed::<f32>::new(coeffs);
                }
            }
        }
        self.channel_idx = 0;
        self.sample_counter = 0;
        self.inner.try_seek(pos)
    }
}

// ─── DynSource — type-erased Source wrapper ───────────────────────────────────
//
// Allows chaining differently-typed sources (with trimming applied) into a
// single concrete type accepted by EqSource<S: Source<Item=f32>>.

pub(crate) struct DynSource {
    inner: Box<dyn Source<Item = f32> + Send>,
    channels: rodio::ChannelCount,
    sample_rate: rodio::SampleRate,
}

impl DynSource {
    pub(crate) fn new(src: impl Source<Item = f32> + Send + 'static) -> Self {
        let channels = src.channels();
        let sample_rate = src.sample_rate();
        Self { inner: Box::new(src), channels, sample_rate }
    }
}

impl Iterator for DynSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> { self.inner.next() }
}

impl Source for DynSource {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.channels }
    fn sample_rate(&self) -> rodio::SampleRate { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}

// ─── EqualPowerFadeIn — per-sample sin(t·π/2) fade-in envelope ───────────────
//
// Applied to every new track:
//   • Crossfade: fade_dur = crossfade_secs  → symmetric equal-power fade-in
//   • Hard cut:  fade_dur = 5 ms            → micro-fade eliminates DC-click
//   • Gapless:   fade_dur = 0               → unity gain (no modification)
//
// gain(t) = sin(t · π/2),  t ∈ [0, 1)
// At t = 0 gain = 0, at t = 1 gain = 1.
// Equal-power property: cos²+sin² = 1 → combined with cos fade-out on Track A
// the total perceived loudness stays constant across the crossfade.

pub(crate) struct EqualPowerFadeIn<S: Source<Item = f32>> {
    inner: S,
    sample_count: u64,
    fade_samples: u64,
}

impl<S: Source<Item = f32>> EqualPowerFadeIn<S> {
    pub(crate) fn new(inner: S, fade_dur: Duration) -> Self {
        let sample_rate = inner.sample_rate();
        let channels = inner.channels().get() as u64;
        let fade_samples = if fade_dur.is_zero() {
            0
        } else {
            (fade_dur.as_secs_f64() * sample_rate.get() as f64 * channels as f64) as u64
        };
        Self { inner, sample_count: 0, fade_samples }
    }
}

impl<S: Source<Item = f32>> Iterator for EqualPowerFadeIn<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        let gain = if self.fade_samples == 0 || self.sample_count >= self.fade_samples {
            1.0
        } else {
            let t = self.sample_count as f32 / self.fade_samples as f32;
            (t * std::f32::consts::FRAC_PI_2).sin()
        };
        self.sample_count += 1;
        Some((sample * gain).clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for EqualPowerFadeIn<S> {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // For mid-track seeks: skip straight to unity gain so the new position
        // plays at full volume immediately — no audible fade-in glitch.
        // For seeks to the very start (< 100 ms): keep the micro-fade to
        // suppress any DC-offset click from the fresh decode.
        if pos.as_millis() < 100 {
            self.sample_count = 0;
        } else {
            self.sample_count = self.fade_samples;
        }
        self.inner.try_seek(pos)
    }
}

// ─── TriggeredFadeOut — sample-level cos(t·π/2) fade-out triggered externally ─
//
// Every track source is wrapped with this. It passes through at unity gain
// until `trigger` is set to true, at which point it reads `fade_total_samples`
// and applies a cos(t·π/2) envelope:
//   gain(t) = cos(t · π/2),  t ∈ [0, 1]
//   At t = 0 gain = 1, at t = 1 gain = 0.
// After the fade completes, returns None to exhaust the source.
//
// Combined with EqualPowerFadeIn (sin curve) on Track B, this gives a
// symmetric constant-power crossfade: sin²+cos² = 1.

pub(crate) struct TriggeredFadeOut<S: Source<Item = f32>> {
    inner: S,
    trigger: Arc<AtomicBool>,
    fade_total_samples: Arc<AtomicU64>,
    fade_progress: u64,
    fading: bool,
    cached_total: u64,
}

impl<S: Source<Item = f32>> TriggeredFadeOut<S> {
    pub(crate) fn new(inner: S, trigger: Arc<AtomicBool>, fade_total_samples: Arc<AtomicU64>) -> Self {
        Self {
            inner,
            trigger,
            fade_total_samples,
            fade_progress: 0,
            fading: false,
            cached_total: 0,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for TriggeredFadeOut<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        // Check trigger on first fade sample only (avoid atomic load per sample).
        if !self.fading && self.trigger.load(Ordering::Relaxed) {
            self.fading = true;
            self.cached_total = self.fade_total_samples.load(Ordering::Relaxed).max(1);
            self.fade_progress = 0;
        }

        if self.fading {
            if self.fade_progress >= self.cached_total {
                // Fade complete — exhaust the source.
                return None;
            }
            let sample = self.inner.next()?;
            let t = self.fade_progress as f32 / self.cached_total as f32;
            let gain = (t * std::f32::consts::FRAC_PI_2).cos();
            self.fade_progress += 1;
            Some((sample * gain).clamp(-1.0, 1.0))
        } else {
            self.inner.next()
        }
    }
}

impl<S: Source<Item = f32>> Source for TriggeredFadeOut<S> {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // If we seek back during a fade, cancel the fade.
        if self.fading {
            self.fading = false;
            self.trigger.store(false, Ordering::Relaxed);
        }
        self.fade_progress = 0;
        self.inner.try_seek(pos)
    }
}

// ─── NotifyingSource — sets a flag when the inner iterator is exhausted ───────
//
// This is the key mechanism for gapless: the progress task polls `done` to know
// exactly when source N has finished inside the Sink, without relying on
// wall-clock estimation or the unreliable `Sink::empty()`.

pub(crate) struct NotifyingSource<S: Source<Item = f32>> {
    inner: S,
    done: Arc<AtomicBool>,
    signalled: bool,
}

impl<S: Source<Item = f32>> NotifyingSource<S> {
    pub(crate) fn new(inner: S, done: Arc<AtomicBool>) -> Self {
        Self { inner, done, signalled: false }
    }
}

impl<S: Source<Item = f32>> Iterator for NotifyingSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next();
        if sample.is_none() && !self.signalled {
            self.signalled = true;
            self.done.store(true, Ordering::SeqCst);
        }
        sample
    }
}

impl<S: Source<Item = f32>> Source for NotifyingSource<S> {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // If we seek backwards the source is no longer exhausted.
        self.signalled = false;
        self.done.store(false, Ordering::SeqCst);
        self.inner.try_seek(pos)
    }
}

// ─── CountingSource — atomic sample counter for drift-free position tracking ─
//
// Wraps the outermost source and increments a shared AtomicU64 on every sample.
// The progress task reads this counter and divides by (sample_rate * channels)
// to get the exact playback position — no wall-clock drift.

pub(crate) struct CountingSource<S: Source<Item = f32>> {
    inner: S,
    counter: Arc<AtomicU64>,
    /// When set, count samples only while the flag is true (legacy track stream).
    count_gate: Option<Arc<AtomicBool>>,
}

impl<S: Source<Item = f32>> CountingSource<S> {
    pub(crate) fn new(inner: S, counter: Arc<AtomicU64>) -> Self {
        Self {
            inner,
            counter,
            count_gate: None,
        }
    }

    pub(crate) fn new_gated(inner: S, counter: Arc<AtomicU64>, gate: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            counter,
            count_gate: Some(gate),
        }
    }

    fn should_count(&self) -> bool {
        self.count_gate
            .as_ref()
            .is_none_or(|g| g.load(Ordering::Relaxed))
    }
}

impl<S: Source<Item = f32>> Iterator for CountingSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next();
        if sample.is_some() && self.should_count() {
            self.counter.fetch_add(1, Ordering::Relaxed);
        }
        sample
    }
}

impl<S: Source<Item = f32>> Source for CountingSource<S> {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Reset counter only after confirming the inner seek succeeded.
        // If we reset first and the seek fails, the counter ends up at the
        // new position while the decoder is still at the old one — causing
        // a permanent desync between displayed time and actual audio.
        let result = self.inner.try_seek(pos);
        if result.is_ok() && self.should_count() {
            let samples = (pos.as_secs_f64() * self.inner.sample_rate().get() as f64
                * self.inner.channels().get() as f64) as u64;
            self.counter.store(samples, Ordering::Relaxed);
        }
        result
    }
}

// ─── PriorityBoostSource — promote the calling thread on first sample ────────
//
// rodio's `Sink` runs `Source::next` inside the cpal output-stream callback.
// On Windows that callback is the WASAPI render thread, which by default has
// only normal priority — when WebView2 / DWM / GPU work spikes the system,
// the audio thread gets preempted and underruns produce audible click /
// stutter. This wrapper sets the MMCSS "Pro Audio" task class on the first
// `next()` call so the kernel keeps the render thread on a real-time class
// alongside other audio applications. On Linux/macOS the wrapper compiles to
// a no-op — those platforms already promote their audio threads externally
// (PipeWire/rtkit, CoreAudio).
//
// Idempotent across track changes: each new track instantiates a fresh
// PriorityBoostSource, but `AvSetMmThreadCharacteristicsW` can be called
// repeatedly on the same thread.

#[cfg(target_os = "windows")]
fn promote_thread_to_pro_audio() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;

    static LOGGED: AtomicBool = AtomicBool::new(false);

    // Null-terminated UTF-16 task name, lifetime-pinned for the call.
    let task: [u16; 10] = [
        b'P' as u16, b'r' as u16, b'o' as u16, b' ' as u16,
        b'A' as u16, b'u' as u16, b'd' as u16, b'i' as u16,
        b'o' as u16, 0,
    ];
    let mut idx: u32 = 0;
    let result = unsafe { AvSetMmThreadCharacteristicsW(PCWSTR(task.as_ptr()), &mut idx) };

    if result.is_ok() && !LOGGED.swap(true, Ordering::Relaxed) {
        // First-time log: not in the hot path on subsequent track starts.
        // Logging is file IO (blocking) but we only run it once per process
        // lifetime, on the very first render-callback invocation.
        crate::app_eprintln!("[psysonic] WASAPI render thread promoted to MMCSS \"Pro Audio\"");
    }
    // Handle leaks intentionally — promotion lasts until the thread exits,
    // which matches the WASAPI render-thread lifetime.
}

#[cfg(not(target_os = "windows"))]
#[inline(always)]
fn promote_thread_to_pro_audio() {}

pub(crate) struct PriorityBoostSource<S: Source<Item = f32>> {
    inner: S,
    promoted: bool,
}

impl<S: Source<Item = f32>> PriorityBoostSource<S> {
    pub(crate) fn new(inner: S) -> Self {
        Self { inner, promoted: false }
    }
}

impl<S: Source<Item = f32>> Iterator for PriorityBoostSource<S> {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        if !self.promoted {
            self.promoted = true;
            promote_thread_to_pro_audio();
        }
        self.inner.next()
    }
}

impl<S: Source<Item = f32>> Source for PriorityBoostSource<S> {
    fn current_span_len(&self) -> Option<usize> { self.inner.current_span_len() }
    fn channels(&self) -> rodio::ChannelCount { self.inner.channels() }
    fn sample_rate(&self) -> rodio::SampleRate { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}

#[cfg(test)]
mod counting_source_tests {
    use super::*;
    use rodio::Source;
    use std::time::Duration;

    struct TwoSamples(u8);
    impl Iterator for TwoSamples {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            match self.0 {
                0 => {
                    self.0 = 1;
                    Some(0.1)
                }
                1 => {
                    self.0 = 2;
                    Some(0.2)
                }
                _ => None,
            }
        }
    }
    impl Source for TwoSamples {
        fn current_span_len(&self) -> Option<usize> {
            Some(1)
        }
        fn channels(&self) -> rodio::ChannelCount {
            std::num::NonZero::new(1).unwrap()
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            std::num::NonZero::new(44_100).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs_f32(2.0 / 44_100.0))
        }
    }

    #[test]
    fn gated_counter_skips_samples_until_gate_is_set() {
        let counter = Arc::new(AtomicU64::new(0));
        let gate = Arc::new(AtomicBool::new(false));
        let mut src = CountingSource::new_gated(TwoSamples(0), counter.clone(), gate.clone());
        assert_eq!(src.next(), Some(0.1));
        assert_eq!(src.next(), Some(0.2));
        assert_eq!(counter.load(Ordering::Relaxed), 0);
        gate.store(true, Ordering::SeqCst);
        let mut src2 = CountingSource::new_gated(TwoSamples(0), counter.clone(), gate);
        assert_eq!(src2.next(), Some(0.1));
        assert_eq!(counter.load(Ordering::Relaxed), 1);
    }
}

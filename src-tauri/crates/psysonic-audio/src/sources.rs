//! Rodio `Source` wrappers: EQ, type erasure, fades, end-of-source notify, sample counter.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;

mod eq;

pub(crate) use eq::EqSource;

// ─── DynSource — type-erased Source wrapper ───────────────────────────────────
//
// Allows chaining differently-typed sources (with trimming applied) into a
// single concrete type accepted by EqSource<S: Source<Item=f32>>.

pub(crate) struct DynSource {
    inner: Box<dyn Source<Item = f32> + Send>,
    channels: rodio::ChannelCount,
}

impl DynSource {
    pub(crate) fn new(src: impl Source<Item = f32> + Send + 'static) -> Self {
        let channels = src.channels();
        Self {
            inner: Box::new(src),
            channels,
        }
    }
}

impl Iterator for DynSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        self.inner.next()
    }
}

impl Source for DynSource {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}

// ─── CancellableSource — exhaust a queued source without stopping its Sink ──

pub(crate) struct CancellableSource<S: Source<Item = f32>> {
    inner: S,
    cancel: Arc<AtomicBool>,
}

impl<S: Source<Item = f32>> CancellableSource<S> {
    pub(crate) fn new(inner: S, cancel: Arc<AtomicBool>) -> Self {
        Self { inner, cancel }
    }
}

impl<S: Source<Item = f32>> Iterator for CancellableSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.cancel.load(Ordering::Acquire) {
            None
        } else {
            self.inner.next()
        }
    }
}

impl<S: Source<Item = f32>> Source for CancellableSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        if self.cancel.load(Ordering::Acquire) {
            Some(0)
        } else {
            self.inner.current_span_len()
        }
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
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
        Self {
            inner,
            sample_count: 0,
            fade_samples,
        }
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
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        if self.sample_count == 0 {
            // Seek before any audio has played → this is the initial start-offset
            // seek (B-head: skip the incoming track's leading silence). Keep the
            // fade-in (`sample_count` stays 0) so a crossfaded track still rises
            // in from its trimmed start instead of popping in at full gain.
        } else if pos.as_millis() < 100 {
            // Mid-playback seek to the very start: keep the micro-fade to
            // suppress any DC-offset click from the fresh decode.
            self.sample_count = 0;
        } else {
            // Mid-playback seek elsewhere (user dragging the seekbar): skip
            // straight to unity gain so the new position is at full volume.
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
    pub(crate) fn new(
        inner: S,
        trigger: Arc<AtomicBool>,
        fade_total_samples: Arc<AtomicU64>,
    ) -> Self {
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
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
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
        Self {
            inner,
            done,
            signalled: false,
        }
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
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
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
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Reset counter only after confirming the inner seek succeeded.
        // If we reset first and the seek fails, the counter ends up at the
        // new position while the decoder is still at the old one — causing
        // a permanent desync between displayed time and actual audio.
        let result = self.inner.try_seek(pos);
        if result.is_ok() && self.should_count() {
            let samples = (pos.as_secs_f64()
                * self.inner.sample_rate().get() as f64
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
// a no-op so platform scheduling stays outside the render callback.
//
// Idempotent across track changes: each new track instantiates a fresh
// PriorityBoostSource, but `AvSetMmThreadCharacteristicsW` can be called
// repeatedly on the same thread. Linux promotes the CPAL and PipeWire threads
// asynchronously after opening the output stream instead of doing D-Bus work
// from this callback.

#[cfg(target_os = "windows")]
fn promote_thread_to_pro_audio() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;

    static LOGGED: AtomicBool = AtomicBool::new(false);

    // Null-terminated UTF-16 task name, lifetime-pinned for the call.
    let task: [u16; 10] = [
        b'P' as u16,
        b'r' as u16,
        b'o' as u16,
        b' ' as u16,
        b'A' as u16,
        b'u' as u16,
        b'd' as u16,
        b'i' as u16,
        b'o' as u16,
        0,
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
        Self {
            inner,
            promoted: false,
        }
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
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}

#[cfg(test)]
mod counting_source_tests;

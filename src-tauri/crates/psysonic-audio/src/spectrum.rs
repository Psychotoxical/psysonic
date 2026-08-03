//! Visualizer spectrum tap: a rodio `Source` wrapper that mirrors the audio it
//! passes through into a lock-free ring, plus the background task that turns
//! that ring into `audio:spectrum` frames for the frontend.
//!
//! Design constraints, in priority order:
//!
//! 1. **Never risk the audio thread.** Inactive and losing taps only advance an
//!    interleaved-channel index. Active leaseholders do a small linear stereo
//!    fold and relaxed stores at complete frame boundaries. There are no locks,
//!    allocations, or syscalls on the callback.
//! 2. **Cost nothing when unused.** The FFT task only exists while the frontend
//!    has a visualizer mounted (`audio_spectrum_set_active`), and it stops
//!    emitting entirely once the bars have decayed to zero after playback ends.
//! 3. **Stay off the IPC pipe.** Frames are quantised to bytes and base64'd
//!    rather than sent as JSON number arrays — see the WebView2 note in `ipc.rs`.
//!
//! The tap sits inside each track source after its EQ and fade stages but
//! *before* the rodio sink's volume. During a crossfade the exclusive lease
//! follows the incoming track, matching the metadata handoff; this is not a
//! post-mix capture of the outgoing and incoming players' summed output.

use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;

use rodio::Source;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::spectrum_dsp::{
    band_layout, bands_from_magnitudes, base64, combine_power_magnitudes, downsample_waveform,
    fft_in_place, hann_window, magnitudes, quantize, Band, Smoother, SmoothingProfile,
    BAND_COUNT, DEFAULT_RESPONSIVENESS, FFT_SIZE, WAVE_COUNT,
};

/// Ring capacity in audio frames. Four FFT windows of slack means a badly
/// timed emit tick still reads a contiguous, un-overwritten window.
const RING_LEN: usize = FFT_SIZE * 4;
const RING_MASK: u64 = (RING_LEN - 1) as u64;

/// Emit-rate bounds. The ceiling is above 60 so high-refresh displays can opt
/// in; the floor keeps a misconfigured client from pinning a core.
pub(crate) const MIN_FPS: u32 = 10;
pub(crate) const MAX_FPS: u32 = 90;
pub(crate) const DEFAULT_FPS: u32 = 60;

/// Conventional folded-stereo sample rings. `AtomicU32` holds `f32::to_bits`,
/// which keeps the whole path safe Rust — no `UnsafeCell`, no `unsafe impl Sync`.
/// Ordinary stereo remains exact L/R, mono drives both lanes, and multichannel
/// centre/LFE/surround energy is folded linearly. The same lanes drive waveform
/// payloads and independent FFTs, whose magnitudes are combined by power.
static RING_L: [AtomicU32; RING_LEN] = [const { AtomicU32::new(0) }; RING_LEN];
static RING_R: [AtomicU32; RING_LEN] = [const { AtomicU32::new(0) }; RING_LEN];
/// Monotonic count of audio frames ever written. Never wraps in practice
/// (u64 frames at 192 kHz outlasts the heat death of the playlist).
static WRITE_POS: AtomicU64 = AtomicU64::new(0);
/// Whether any frontend surface currently wants spectrum frames.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Requested emit rate, already clamped.
static FPS: AtomicU32 = AtomicU32::new(DEFAULT_FPS);
/// Bumped only on lifecycle edges so a stale emit task exits after a stop or a
/// later restart. Parameter-only updates leave the running analyzer intact.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Id of the tap allowed to write to the ring. During a crossfade two sources
/// are pulled concurrently; without this they would interleave into one ring
/// and produce garbage.
static LEASE: AtomicU64 = AtomicU64::new(0);
static NEXT_TAP_ID: AtomicU64 = AtomicU64::new(1);
/// Sample rate of the leaseholder, so band layout matches the live audio.
static SOURCE_RATE: AtomicU32 = AtomicU32::new(0);
/// Envelope responsiveness (0..1) as `f32::to_bits`, set from the frontend.
/// Seeded with the default rather than 0 — `0.0f32.to_bits()` is `0`, so a
/// zero sentinel would be indistinguishable from the smoothest setting.
static RESPONSIVENESS: AtomicU32 = AtomicU32::new(DEFAULT_RESPONSIVENESS.to_bits());
/// Serializes command-side lifecycle edges. It is never touched by the audio
/// callback; the lock only prevents concurrent stop/start commands from
/// publishing contradictory ACTIVE/generation pairs.
static FEED_CONTROL: Mutex<()> = Mutex::new(());

/// Responsiveness last requested by the frontend, or the default before any
/// visualizer has been mounted.
fn current_responsiveness() -> f32 {
    let v = f32::from_bits(RESPONSIVENESS.load(Ordering::Relaxed));
    if v.is_finite() { v.clamp(0.0, 1.0) } else { DEFAULT_RESPONSIVENESS }
}

fn push_frame(left: f32, right: f32) {
    let pos = WRITE_POS.load(Ordering::Relaxed);
    let slot = (pos & RING_MASK) as usize;
    RING_L[slot].store(left.to_bits(), Ordering::Relaxed);
    RING_R[slot].store(right.to_bits(), Ordering::Relaxed);
    // Release so the reader's Acquire load of the position can't observe the
    // index without the samples it refers to.
    WRITE_POS.store(pos.wrapping_add(1), Ordering::Release);
}

/// Copy the most recent [`FFT_SIZE`] frames ending at a previously acquired
/// write position. The caller can therefore decide whether a copy is needed
/// before touching any ring slots.
fn snapshot_at(
    end: u64,
    left: &mut [f32],
    right: &mut [f32],
) {
    let start = end.saturating_sub(FFT_SIZE as u64);
    for i in 0..FFT_SIZE {
        let pos = start.wrapping_add(i as u64);
        let (l, r) = if pos < end {
            let slot = (pos & RING_MASK) as usize;
            (
                f32::from_bits(RING_L[slot].load(Ordering::Relaxed)),
                f32::from_bits(RING_R[slot].load(Ordering::Relaxed)),
            )
        } else {
            (0.0, 0.0)
        };
        left[i] = l;
        right[i] = r;
    }
}

/// Test/helper wrapper that snapshots the current position.
#[cfg(test)]
fn snapshot(left: &mut [f32], right: &mut [f32]) -> u64 {
    let end = WRITE_POS.load(Ordering::Acquire);
    snapshot_at(end, left, right);
    end
}

// ── Tap source ───────────────────────────────────────────────────────────────

/// Rodio source wrapper that mirrors what passes through it into the rings.
/// Audio is forwarded byte-identically; this stage is acoustically transparent.
pub(crate) struct SpectrumTapSource<S: Source<Item = f32>> {
    inner: S,
    channels: usize,
    id: u64,
    /// Folded stereo values for the interleaved frame being assembled.
    left: f32,
    right: f32,
    channel_idx: usize,
    capture_frame: bool,
    published_rate: u32,
    /// Whether this source has already made its one bid for the lease.
    claimed: bool,
    /// Once a newer tap wins, this source can never reclaim the monotonic lease.
    lease_lost: bool,
}

impl<S: Source<Item = f32>> SpectrumTapSource<S> {
    pub(crate) fn new(inner: S) -> Self {
        let channels = inner.channels().get() as usize;
        Self {
            inner,
            channels: channels.max(1),
            id: NEXT_TAP_ID.fetch_add(1, Ordering::Relaxed),
            left: 0.0,
            right: 0.0,
            channel_idx: 0,
            capture_frame: false,
            published_rate: 0,
            claimed: false,
            lease_lost: false,
        }
    }

    /// Claim the ring on the first complete frame this source produces while
    /// analysis is active, not at construction. Gapless preload builds the next
    /// source long before it is audible; claiming early would blank the current
    /// track. Monotonic tap ids ensure an older crossfade tail cannot reclaim
    /// the lease from the incoming metadata owner.
    #[inline]
    fn owns_ring(&mut self) -> bool {
        if self.lease_lost {
            return false;
        }
        if LEASE.load(Ordering::Relaxed) == self.id {
            return true;
        }
        if self.claimed {
            self.lease_lost = true;
            return false;
        }
        self.claimed = true;
        LEASE.fetch_max(self.id, Ordering::Relaxed);
        let owns = LEASE.load(Ordering::Relaxed) == self.id;
        self.lease_lost = !owns;
        owns
    }

    #[inline]
    fn begin_frame_capture(&mut self) -> bool {
        !self.lease_lost && ACTIVE.load(Ordering::Acquire) && self.owns_ring()
    }

    #[inline]
    fn publish_sample_rate(&mut self) {
        let rate = self.inner.sample_rate().get();
        if rate != self.published_rate {
            SOURCE_RATE.store(rate, Ordering::Relaxed);
            self.published_rate = rate;
        }
    }

    #[inline]
    fn reset_frame_assembly(&mut self) {
        self.left = 0.0;
        self.right = 0.0;
        self.channel_idx = 0;
        self.capture_frame = false;
    }

    /// Conventional linear fold for the layouts available through rodio's
    /// channel-count-only API: L/R pass through, centre is -3 dB to both, LFE
    /// is -6 dB to both, and surround pairs are -3 dB to their matching side.
    #[inline]
    fn capture_sample(&mut self, sample: f32) {
        const MINUS_3_DB: f32 = std::f32::consts::FRAC_1_SQRT_2;
        const MINUS_6_DB: f32 = 0.5;

        match self.channel_idx {
            0 => {
                self.left = sample;
            }
            1 => {
                self.right = sample;
            }
            2 if self.channels == 4 => self.left += sample * MINUS_3_DB,
            3 if self.channels == 4 => self.right += sample * MINUS_3_DB,
            2 => {
                self.left += sample * MINUS_3_DB;
                self.right += sample * MINUS_3_DB;
            }
            3 if self.channels == 5 => self.left += sample * MINUS_3_DB,
            4 if self.channels == 5 => self.right += sample * MINUS_3_DB,
            3 => {
                self.left += sample * MINUS_6_DB;
                self.right += sample * MINUS_6_DB;
            }
            channel => {
                if (channel - 4).is_multiple_of(2) {
                    self.left += sample * MINUS_3_DB;
                } else {
                    self.right += sample * MINUS_3_DB;
                }
            }
        }
    }
}

impl<S: Source<Item = f32>> Iterator for SpectrumTapSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        if self.channel_idx == 0 {
            // Capture is fixed for the whole interleaved frame. Enabling after
            // channel zero therefore skips that partial frame and starts at the
            // next correctly aligned boundary.
            self.capture_frame = self.begin_frame_capture();
        }
        if self.capture_frame {
            self.capture_sample(sample);
        }
        self.channel_idx += 1;

        if self.channel_idx >= self.channels {
            if self.capture_frame {
                let owns = LEASE.load(Ordering::Relaxed) == self.id;
                if ACTIVE.load(Ordering::Acquire) && owns {
                    // Mono drives both folded traces and both FFT lanes.
                    if self.channels == 1 {
                        self.right = self.left;
                    }
                    self.publish_sample_rate();
                    push_frame(self.left, self.right);
                } else if !owns {
                    self.lease_lost = true;
                }
            }
            self.reset_frame_assembly();
        }
        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for SpectrumTapSource<S> {
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
        self.inner.try_seek(pos)?;
        self.reset_frame_assembly();
        self.published_rate = 0;
        Ok(())
    }
}

// ── Frame payload ────────────────────────────────────────────────────────────

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

// ── Analyzer ─────────────────────────────────────────────────────────────────

type StereoWindow<'a> = (&'a [f32], &'a [f32]);

/// Owns the scratch buffers and envelope state for the emit loop. Kept separate
/// from the loop itself so frame production is testable without an audio device
/// or a Tauri app handle.
pub(crate) struct Analyzer {
    layout: Vec<Band>,
    layout_rate: u32,
    smoother: Smoother,
    re: Vec<f32>,
    im: Vec<f32>,
    mags_left: Vec<f32>,
    mags_right: Vec<f32>,
    mags: Vec<f32>,
    bands: Vec<f32>,
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
            let rate = if sample_rate == 0 { 48_000 } else { sample_rate };
            if rate != self.layout_rate {
                self.layout = band_layout(rate);
                self.layout_rate = rate;
            }

            lane_magnitudes(
                left,
                &mut self.re,
                &mut self.im,
                &mut self.mags_left,
            );
            lane_magnitudes(
                right,
                &mut self.re,
                &mut self.im,
                &mut self.mags_right,
            );
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

// ── Emit loop ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EmitWork {
    Snapshot,
    Decay,
    Idle,
}

fn emit_work(write_pos: u64, last_pos: u64, settled: bool) -> EmitWork {
    if write_pos != last_pos {
        EmitWork::Snapshot
    } else if settled {
        EmitWork::Idle
    } else {
        EmitWork::Decay
    }
}

async fn run_emit_loop(app: AppHandle, generation: u64) {
    let mut analyzer = Analyzer::new();
    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    let mut last_pos = WRITE_POS.load(Ordering::Acquire);

    loop {
        let fps = FPS.load(Ordering::Relaxed).clamp(MIN_FPS, MAX_FPS);
        let period = Duration::from_micros(1_000_000 / fps as u64);
        tokio::time::sleep(period).await;

        // Exit if we were deactivated, or superseded by a newer activation.
        if !ACTIVE.load(Ordering::Acquire) || GENERATION.load(Ordering::Acquire) != generation {
            return;
        }

        let pos = WRITE_POS.load(Ordering::Acquire);
        let fresh = match emit_work(pos, last_pos, analyzer.is_settled()) {
            EmitWork::Idle => continue,
            EmitWork::Decay => false,
            EmitWork::Snapshot => {
                snapshot_at(pos, &mut left, &mut right);
                last_pos = pos;
                true
            }
        };

        let rate = if fresh {
            SOURCE_RATE.load(Ordering::Relaxed)
        } else {
            0
        };
        if let Some(payload) =
            analyzer.frame((&left, &right), rate, period.as_secs_f32(), fresh)
        {
            let _ = app.emit("audio:spectrum", payload);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FeedTransition {
    Start(u64),
    Update,
    Stop,
    AlreadyStopped,
}

/// Apply command parameters and return the lifecycle action separately from
/// Tauri task creation so repeated active updates are deterministic and
/// directly testable.
fn update_feed_state(
    active: bool,
    fps: Option<u32>,
    responsiveness: Option<f32>,
) -> FeedTransition {
    let _guard = FEED_CONTROL.lock().unwrap_or_else(|error| error.into_inner());

    FPS.store(
        fps.unwrap_or(DEFAULT_FPS).clamp(MIN_FPS, MAX_FPS),
        Ordering::Relaxed,
    );
    RESPONSIVENESS.store(
        responsiveness
            .filter(|v| v.is_finite())
            .unwrap_or(DEFAULT_RESPONSIVENESS)
            .clamp(0.0, 1.0)
            .to_bits(),
        Ordering::Relaxed,
    );

    if active {
        if ACTIVE.load(Ordering::Acquire) {
            FeedTransition::Update
        } else {
            let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
            ACTIVE.store(true, Ordering::Release);
            FeedTransition::Start(generation)
        }
    } else if ACTIVE.load(Ordering::Acquire) {
        ACTIVE.store(false, Ordering::Release);
        GENERATION.fetch_add(1, Ordering::AcqRel);
        FeedTransition::Stop
    } else {
        FeedTransition::AlreadyStopped
    }
}

/// Start or stop the spectrum feed.
///
/// Idempotent by design: only the inactive→active edge starts an analyzer task.
/// Repeated `true` calls update FPS/responsiveness atomics in place, preserving
/// the running analyzer's envelope state; `false` stops the current generation.
#[tauri::command]
#[specta::specta]
pub fn audio_spectrum_set_active(
    active: bool,
    fps: Option<u32>,
    responsiveness: Option<f32>,
    app: AppHandle,
) {
    if let FeedTransition::Start(generation) =
        update_feed_state(active, fps, responsiveness)
    {
        tauri::async_runtime::spawn(run_emit_loop(app, generation));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU32, AtomicUsize, Ordering},
        Arc, Barrier,
    };

    /// The ring and lease are process-global (they are reached from the audio
    /// callback, where threading an `Arc` through twelve constructor arguments
    /// would be worse). Tests that touch them must not interleave.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take the shared lock without propagating poisoning: a single failing
    /// test would otherwise cascade into every other test that touches the
    /// globals, burying the actual failure.
    fn lock_globals() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct Silence {
        remaining: usize,
        channels: u16,
        rate: u32,
    }

    impl Iterator for Silence {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.remaining == 0 {
                return None;
            }
            self.remaining -= 1;
            Some(0.25)
        }
    }

    impl Source for Silence {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> rodio::ChannelCount {
            rodio::ChannelCount::new(self.channels).unwrap()
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            rodio::SampleRate::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    /// Interleaved stereo whose channels differ: +0.5 left, −0.5 right.
    struct Alternating {
        remaining: usize,
        channels: u16,
        rate: u32,
        next_left: bool,
    }

    impl Iterator for Alternating {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.remaining == 0 {
                return None;
            }
            self.remaining -= 1;
            let v = if self.next_left { 0.5 } else { -0.5 };
            self.next_left = !self.next_left;
            Some(v)
        }
    }

    impl Source for Alternating {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> rodio::ChannelCount {
            rodio::ChannelCount::new(self.channels).unwrap()
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            rodio::SampleRate::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    struct Samples {
        inner: std::vec::IntoIter<f32>,
        channels: u16,
        rate: Arc<AtomicU32>,
        rate_reads: Arc<AtomicUsize>,
    }

    impl Iterator for Samples {
        type Item = f32;

        fn next(&mut self) -> Option<Self::Item> {
            self.inner.next()
        }
    }

    impl Source for Samples {
        fn current_span_len(&self) -> Option<usize> {
            Some(self.inner.len())
        }
        fn channels(&self) -> rodio::ChannelCount {
            rodio::ChannelCount::new(self.channels).unwrap()
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            self.rate_reads.fetch_add(1, Ordering::Relaxed);
            rodio::SampleRate::new(self.rate.load(Ordering::Relaxed)).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            None
        }
    }

    fn samples_source(
        samples: Vec<f32>,
        channels: u16,
        rate: u32,
    ) -> (Samples, Arc<AtomicU32>) {
        let (source, rate, _) = counted_samples_source(samples, channels, rate);
        (source, rate)
    }

    fn counted_samples_source(
        samples: Vec<f32>,
        channels: u16,
        rate: u32,
    ) -> (Samples, Arc<AtomicU32>, Arc<AtomicUsize>) {
        let rate = Arc::new(AtomicU32::new(rate));
        let rate_reads = Arc::new(AtomicUsize::new(0));
        (
            Samples {
                inner: samples.into_iter(),
                channels,
                rate: Arc::clone(&rate),
                rate_reads: Arc::clone(&rate_reads),
            },
            rate,
            rate_reads,
        )
    }

    /// Encoded length of `bytes` bytes of base64, including padding.
    fn base64_len(bytes: usize) -> usize {
        bytes.div_ceil(3) * 4
    }

    fn tone(freq: f32, rate: f32, len: usize) -> Vec<f32> {
        (0..len)
            .map(|i| (std::f32::consts::TAU * freq * i as f32 / rate).sin())
            .collect()
    }

    fn reset_globals() {
        ACTIVE.store(false, Ordering::Relaxed);
        FPS.store(DEFAULT_FPS, Ordering::Relaxed);
        RESPONSIVENESS.store(DEFAULT_RESPONSIVENESS.to_bits(), Ordering::Relaxed);
        GENERATION.store(0, Ordering::Relaxed);
        WRITE_POS.store(0, Ordering::Relaxed);
        LEASE.store(0, Ordering::Relaxed);
        SOURCE_RATE.store(0, Ordering::Relaxed);
    }

    // ── Tap ──────────────────────────────────────────────────────────────────

    #[test]
    fn tap_is_transparent_to_the_audio_it_passes() {
        let _guard = lock_globals();
        reset_globals();
        let mut tap = SpectrumTapSource::new(Silence { remaining: 8, channels: 2, rate: 44_100 });
        let out: Vec<f32> = (&mut tap).collect();
        assert_eq!(out, vec![0.25; 8], "tap must not alter the signal");
    }

    #[test]
    fn tap_preserves_source_metadata() {
        let _guard = lock_globals();
        reset_globals();
        let tap = SpectrumTapSource::new(Silence { remaining: 4, channels: 2, rate: 96_000 });
        assert_eq!(tap.channels().get(), 2);
        assert_eq!(tap.sample_rate().get(), 96_000);
    }

    #[test]
    fn tap_writes_nothing_while_inactive() {
        let _guard = lock_globals();
        reset_globals();
        let mut tap = SpectrumTapSource::new(Silence { remaining: 64, channels: 2, rate: 44_100 });
        let _: Vec<f32> = (&mut tap).collect();
        assert_eq!(WRITE_POS.load(Ordering::Acquire), 0, "inactive tap must stay silent");
    }

    #[test]
    fn inactive_and_losing_taps_only_track_interleaved_position() {
        let _guard = lock_globals();
        reset_globals();

        let (source, _, rate_reads) =
            counted_samples_source(vec![0.5, -0.5, 0.25, -0.25], 2, 48_000);
        let mut inactive = SpectrumTapSource::new(source);
        inactive.next();
        assert_eq!(inactive.channel_idx, 1);
        assert!(!inactive.capture_frame);
        assert_eq!(inactive.left, 0.0);
        assert_eq!(inactive.right, 0.0);
        assert_eq!(rate_reads.load(Ordering::Relaxed), 0);

        ACTIVE.store(true, Ordering::Relaxed);
        let (old_source, _, old_rate_reads) =
            counted_samples_source(vec![0.4, -0.4, 0.3, -0.3], 2, 48_000);
        let mut old = SpectrumTapSource::new(old_source);
        old.next();
        old.next();

        let (new_source, _) = samples_source(vec![0.2, -0.2], 2, 48_000);
        let mut new = SpectrumTapSource::new(new_source);
        new.next();
        new.next();

        let reads_before_loss = old_rate_reads.load(Ordering::Relaxed);
        old.next();
        assert_eq!(old.channel_idx, 1);
        assert!(old.lease_lost);
        assert!(!old.capture_frame);
        assert_eq!(old.left, 0.0);
        assert_eq!(old.right, 0.0);
        assert_eq!(old_rate_reads.load(Ordering::Relaxed), reads_before_loss);
        ACTIVE.store(false, Ordering::Relaxed);
    }

    #[test]
    fn tap_writes_one_folded_frame_per_channel_group() {
        let _guard = lock_globals();
        reset_globals();
        ACTIVE.store(true, Ordering::Relaxed);
        let mut tap = SpectrumTapSource::new(Silence { remaining: 64, channels: 2, rate: 44_100 });
        let _: Vec<f32> = (&mut tap).collect();
        ACTIVE.store(false, Ordering::Relaxed);
        assert_eq!(WRITE_POS.load(Ordering::Acquire), 32, "64 stereo samples = 32 audio frames");
    }

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
        let mut tap = SpectrumTapSource::new(Silence { remaining: 4, channels: 1, rate: 44_100 });
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
    fn stereo_frames_carry_both_traces() {
        let mut a = Analyzer::new();
        let left = tone(1_000.0, 48_000.0, FFT_SIZE);
        let right: Vec<f32> = left.iter().map(|s| -s).collect();
        let frame = a
            .frame((&left, &right), 48_000, 0.016, true)
            .unwrap();
        assert_ne!(frame.waveform_left, frame.waveform_right);
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
        let frame = a
            .frame((&left, &right), 48_000, 0.016, true)
            .unwrap();
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
        assert_eq!(left, right, "centre should fold equally into left and right");

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

    #[test]
    fn tap_records_the_leaseholders_sample_rate() {
        let _guard = lock_globals();
        reset_globals();
        ACTIVE.store(true, Ordering::Relaxed);
        let mut tap = SpectrumTapSource::new(Silence { remaining: 8, channels: 2, rate: 88_200 });
        let _: Vec<f32> = (&mut tap).collect();
        ACTIVE.store(false, Ordering::Relaxed);
        assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 88_200);
    }

    #[test]
    fn tap_refreshes_a_dynamic_source_rate_at_frame_boundaries() {
        let _guard = lock_globals();
        reset_globals();
        ACTIVE.store(true, Ordering::Relaxed);
        let (source, rate) = samples_source(vec![0.25; 6], 2, 44_100);
        let mut tap = SpectrumTapSource::new(source);

        tap.next();
        tap.next();
        assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 44_100);
        rate.store(88_200, Ordering::Relaxed);
        tap.next();
        tap.next();
        assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 88_200);
        rate.store(22_050, Ordering::Relaxed);
        tap.next();
        tap.next();
        assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 22_050);
        ACTIVE.store(false, Ordering::Relaxed);
    }

    #[test]
    fn crossfade_capture_follows_the_incoming_metadata_source_not_the_post_mix() {
        let _guard = lock_globals();
        reset_globals();
        ACTIVE.store(true, Ordering::Relaxed);

        // Outgoing track starts first and claims the ring.
        let (old_source, _) = samples_source(vec![0.75; 64], 1, 44_100);
        let mut old = SpectrumTapSource::new(old_source);
        old.next();
        assert_eq!(WRITE_POS.load(Ordering::Acquire), 1);

        // Crossfade begins: the incoming source produces its first complete
        // frame and takes over when the UI switches metadata.
        let (new_source, _) = samples_source(vec![0.25; 64], 1, 48_000);
        let mut new = SpectrumTapSource::new(new_source);
        new.next();
        assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 48_000, "lease should follow the newest source");

        // From here the outgoing source must not interleave into the ring.
        let before = WRITE_POS.load(Ordering::Acquire);
        for _ in 0..10 {
            old.next();
        }
        assert_eq!(WRITE_POS.load(Ordering::Acquire), before, "old source kept writing after handoff");

        for _ in 0..10 {
            new.next();
        }
        assert_eq!(WRITE_POS.load(Ordering::Acquire), before + 10);

        let mut left = vec![0.0f32; FFT_SIZE];
        let mut right = vec![0.0f32; FFT_SIZE];
        snapshot(&mut left, &mut right);
        assert!((left[0] - 0.75).abs() < f32::EPSILON);
        assert!((right[0] - 0.75).abs() < f32::EPSILON);
        assert!(
            left[1..12]
                .iter()
                .chain(&right[1..12])
                .all(|sample| (*sample - 0.25).abs() < f32::EPSILON),
            "the outgoing source must not be summed into incoming-track capture"
        );
        ACTIVE.store(false, Ordering::Relaxed);
    }

    #[test]
    fn snapshot_returns_the_most_recent_window_oldest_first() {
        let _guard = lock_globals();
        reset_globals();
        for i in 0..(FFT_SIZE + 100) {
            push_frame(i as f32, -(i as f32));
        }
        let mut left = vec![0.0f32; FFT_SIZE];
        let mut right = vec![0.0f32; FFT_SIZE];
        let pos = snapshot(&mut left, &mut right);
        assert_eq!(pos, (FFT_SIZE + 100) as u64);
        assert_eq!(left[0], 100.0);
        assert_eq!(left[FFT_SIZE - 1], (FFT_SIZE + 99) as f32);
        // Channels must stay separate all the way through the ring.
        assert_eq!(right[0], -100.0);
        assert_eq!(right[FFT_SIZE - 1], -((FFT_SIZE + 99) as f32));
    }

    #[test]
    fn snapshot_zero_fills_before_any_audio_has_played() {
        let _guard = lock_globals();
        reset_globals();
        let mut left = vec![9.0f32; FFT_SIZE];
        let mut right = vec![9.0f32; FFT_SIZE];
        let pos = snapshot(&mut left, &mut right);
        assert_eq!(pos, 0);
        assert!(left.iter().all(|v| *v == 0.0));
        assert!(right.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn settled_and_decay_ticks_do_not_request_ring_snapshots() {
        assert_eq!(emit_work(10, 10, true), EmitWork::Idle);
        assert_eq!(emit_work(10, 10, false), EmitWork::Decay);
        assert_eq!(emit_work(11, 10, true), EmitWork::Snapshot);
        assert_eq!(emit_work(11, 10, false), EmitWork::Snapshot);
    }

    #[test]
    fn repeated_activation_updates_parameters_without_replacing_the_task_generation() {
        let _guard = lock_globals();
        reset_globals();

        assert_eq!(
            update_feed_state(true, Some(30), Some(0.2)),
            FeedTransition::Start(1)
        );
        let generation = GENERATION.load(Ordering::Relaxed);
        assert_eq!(
            update_feed_state(true, Some(75), Some(0.9)),
            FeedTransition::Update
        );
        assert_eq!(GENERATION.load(Ordering::Relaxed), generation);
        assert_eq!(FPS.load(Ordering::Relaxed), 75);
        assert!((current_responsiveness() - 0.9).abs() < f32::EPSILON);

        assert_eq!(
            update_feed_state(false, None, None),
            FeedTransition::Stop
        );
        assert!(!ACTIVE.load(Ordering::Relaxed));
        assert!(GENERATION.load(Ordering::Relaxed) > generation);
        assert_eq!(
            update_feed_state(false, None, None),
            FeedTransition::AlreadyStopped
        );
    }

    #[test]
    fn concurrent_stop_start_publishes_one_consistent_lifecycle_order() {
        let _guard = lock_globals();
        reset_globals();
        assert_eq!(
            update_feed_state(true, Some(60), Some(0.5)),
            FeedTransition::Start(1)
        );

        let barrier = Arc::new(Barrier::new(3));
        let stop_barrier = Arc::clone(&barrier);
        let stop = std::thread::spawn(move || {
            stop_barrier.wait();
            update_feed_state(false, None, None)
        });
        let start_barrier = Arc::clone(&barrier);
        let start = std::thread::spawn(move || {
            start_barrier.wait();
            update_feed_state(true, Some(75), Some(0.8))
        });
        barrier.wait();

        let stop = stop.join().unwrap();
        let start = start.join().unwrap();
        let restarted = matches!(stop, FeedTransition::Stop)
            && matches!(start, FeedTransition::Start(_));
        assert_eq!(ACTIVE.load(Ordering::Acquire), restarted);
        assert_eq!(
            GENERATION.load(Ordering::Acquire),
            if restarted { 3 } else { 2 }
        );
        assert!(matches!(stop, FeedTransition::Stop));
        assert!(matches!(
            start,
            FeedTransition::Start(_) | FeedTransition::Update
        ));

        update_feed_state(false, None, None);
    }

    // ── Analyzer ─────────────────────────────────────────────────────────────

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
        assert!(frame.rms > 0.6 && frame.rms < 0.8, "full-scale sine rms {}", frame.rms);
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
            if a
                .frame((&silence, &silence), 48_000, 0.016, false)
                .is_none()
            {
                settled_after = Some(i);
                break;
            }
        }
        assert!(settled_after.is_some(), "analyzer never went quiet after playback stopped");
    }

    #[test]
    fn analyzer_rebuilds_its_band_layout_when_the_sample_rate_changes() {
        let mut a = Analyzer::new();
        let window = tone(1_000.0, 44_100.0, FFT_SIZE);
        let frame = a
            .frame((&window, &window), 44_100, 0.016, true)
            .unwrap();
        assert_eq!(frame.sample_rate, 44_100);
        let window = tone(1_000.0, 96_000.0, FFT_SIZE);
        let frame = a
            .frame((&window, &window), 96_000, 0.016, true)
            .unwrap();
        assert_eq!(frame.sample_rate, 96_000);
    }

    #[test]
    fn analyzer_falls_back_to_48k_for_an_unknown_rate() {
        let mut a = Analyzer::new();
        let window = tone(1_000.0, 48_000.0, FFT_SIZE);
        let frame = a
            .frame((&window, &window), 0, 0.016, true)
            .unwrap();
        assert_eq!(frame.sample_rate, 48_000);
    }

    #[test]
    fn analyzer_tolerates_a_short_window() {
        let mut a = Analyzer::new();
        let window = tone(1_000.0, 48_000.0, 64);
        assert!(a
            .frame((&window, &window), 48_000, 0.016, true)
            .is_some());
    }

    #[test]
    fn louder_audio_produces_taller_bands() {
        fn peak_band_byte(amp: f32) -> u8 {
            let mut a = Analyzer::new();
            let window: Vec<f32> = tone(1_000.0, 48_000.0, FFT_SIZE).iter().map(|s| s * amp).collect();
            let mut last = 0;
            for _ in 0..60 {
                if let Some(f) = a.frame((&window, &window), 48_000, 0.016, true) {
                    last = decode_b64(&f.bands).into_iter().max().unwrap_or(0);
                }
            }
            last
        }
        assert!(peak_band_byte(1.0) > peak_band_byte(0.05), "louder audio must read higher");
    }

    #[test]
    fn silent_audio_produces_flat_bands() {
        let mut a = Analyzer::new();
        let silence = vec![0.0; FFT_SIZE];
        let frame = a
            .frame((&silence, &silence), 48_000, 0.016, true)
            .unwrap();
        assert!(decode_b64(&frame.bands).iter().all(|b| *b == 0));
        assert_eq!(frame.rms, 0.0);
    }

    #[test]
    fn idle_frames_carry_a_centred_waveform() {
        let mut a = Analyzer::new();
        let window = tone(1_000.0, 48_000.0, FFT_SIZE);
        a.frame((&window, &window), 48_000, 0.016, true);
        let silence = vec![0.0; FFT_SIZE];
        let frame = a
            .frame((&silence, &silence), 48_000, 0.016, false)
            .unwrap();
        assert!(decode_b64(&frame.waveform_left).iter().all(|b| *b == 128));
        assert!(decode_b64(&frame.waveform_right).iter().all(|b| *b == 128));
    }

    /// Minimal base64 decoder, test-only — mirrors what the frontend does with
    /// `atob`, and keeps these assertions independent of the encoder's internals.
    fn decode_b64(s: &str) -> Vec<u8> {
        let idx = |c: u8| -> u32 {
            match c {
                b'A'..=b'Z' => (c - b'A') as u32,
                b'a'..=b'z' => (c - b'a') as u32 + 26,
                b'0'..=b'9' => (c - b'0') as u32 + 52,
                b'+' => 62,
                b'/' => 63,
                _ => 0,
            }
        };
        let bytes: Vec<u8> = s.bytes().collect();
        let mut out = Vec::new();
        for chunk in bytes.chunks(4) {
            let n = (idx(chunk[0]) << 18)
                | (idx(chunk[1]) << 12)
                | (idx(*chunk.get(2).unwrap_or(&b'A')) << 6)
                | idx(*chunk.get(3).unwrap_or(&b'A'));
            out.push((n >> 16) as u8);
            if chunk.get(2).is_some_and(|c| *c != b'=') {
                out.push((n >> 8) as u8);
            }
            if chunk.get(3).is_some_and(|c| *c != b'=') {
                out.push(n as u8);
            }
        }
        out
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
}

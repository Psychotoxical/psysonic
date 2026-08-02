//! Visualizer spectrum tap: a rodio `Source` wrapper that mirrors the audio it
//! passes through into a lock-free ring, plus the background task that turns
//! that ring into `audio:spectrum` frames for the frontend.
//!
//! Design constraints, in priority order:
//!
//! 1. **Never risk the audio thread.** The tap does one relaxed atomic load per
//!    sample when nobody is watching, and one extra relaxed store per *frame*
//!    (post-downmix) when someone is. No locks, no allocation, no syscalls —
//!    a stall here is an audible dropout, which is unacceptable in a hi-fi
//!    player.
//! 2. **Cost nothing when unused.** The FFT task only exists while the frontend
//!    has a visualizer mounted (`audio_spectrum_set_active`), and it stops
//!    emitting entirely once the bars have decayed to zero after playback ends.
//! 3. **Stay off the IPC pipe.** Frames are quantised to bytes and base64'd
//!    rather than sent as JSON number arrays — see the WebView2 note in `ipc.rs`.
//!
//! The tap sits after the EQ and fade stages but *before* the rodio sink's
//! volume, so the visualizer shows the audio as shaped by the EQ (what you
//! hear) without collapsing to nothing when you turn the volume down.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use rodio::Source;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::spectrum_dsp::{
    band_layout, bands_from_magnitudes, base64, downsample_waveform, fft_in_place, hann_window,
    magnitudes, quantize, Band, Smoother, SmoothingProfile, BAND_COUNT, DEFAULT_RESPONSIVENESS,
    FFT_SIZE, WAVE_COUNT,
};

/// Ring capacity in mono frames. Four analysis windows of slack means a badly
/// timed emit tick still reads a contiguous, un-overwritten window.
const RING_LEN: usize = FFT_SIZE * 4;
const RING_MASK: u64 = (RING_LEN - 1) as u64;

/// Emit-rate bounds. The ceiling is above 60 so high-refresh displays can opt
/// in; the floor keeps a misconfigured client from pinning a core.
pub(crate) const MIN_FPS: u32 = 10;
pub(crate) const MAX_FPS: u32 = 90;
pub(crate) const DEFAULT_FPS: u32 = 60;

/// Per-channel sample rings. `AtomicU32` holds `f32::to_bits`, which keeps the
/// whole path safe Rust — no `UnsafeCell`, no `unsafe impl Sync`.
///
/// Left and right are kept separate rather than pre-mixed so the oscilloscope
/// can draw them as distinct traces. This costs one extra relaxed store per
/// audio frame and no extra FFT: the spectrum analysis sums them back to mono
/// on the *reader* side, off the audio thread.
static RING_L: [AtomicU32; RING_LEN] = [const { AtomicU32::new(0) }; RING_LEN];
static RING_R: [AtomicU32; RING_LEN] = [const { AtomicU32::new(0) }; RING_LEN];
/// Monotonic count of mono frames ever written. Never wraps in practice
/// (u64 frames at 192 kHz outlasts the heat death of the playlist).
static WRITE_POS: AtomicU64 = AtomicU64::new(0);
/// Whether any frontend surface currently wants spectrum frames.
static ACTIVE: AtomicBool = AtomicBool::new(false);
/// Requested emit rate, already clamped.
static FPS: AtomicU32 = AtomicU32::new(DEFAULT_FPS);
/// Bumped on every activation so a stale emit task exits instead of racing a
/// newer one (rapid mount/unmount, HMR reloads).
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

/// Copy the most recent [`FFT_SIZE`] frames into `left`/`right`, oldest first.
/// Returns the write position the snapshot was taken at.
fn snapshot(left: &mut [f32], right: &mut [f32]) -> u64 {
    let end = WRITE_POS.load(Ordering::Acquire);
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
    end
}

// ── Tap source ───────────────────────────────────────────────────────────────

/// Rodio source wrapper that mirrors what passes through it into [`RING`].
/// Audio is forwarded byte-identically; this stage is acoustically transparent.
pub(crate) struct SpectrumTapSource<S: Source<Item = f32>> {
    inner: S,
    channels: usize,
    sample_rate: u32,
    id: u64,
    /// First two channels of the interleaved frame currently being assembled.
    left: f32,
    right: f32,
    channel_idx: usize,
    /// Whether this source has already made its one bid for the lease.
    claimed: bool,
}

impl<S: Source<Item = f32>> SpectrumTapSource<S> {
    pub(crate) fn new(inner: S) -> Self {
        let channels = inner.channels().get() as usize;
        let sample_rate = inner.sample_rate().get();
        Self {
            inner,
            channels: channels.max(1),
            sample_rate,
            id: NEXT_TAP_ID.fetch_add(1, Ordering::Relaxed),
            left: 0.0,
            right: 0.0,
            channel_idx: 0,
            claimed: false,
        }
    }

    /// Claim the ring on the first sample this source actually produces — not
    /// at construction. Gapless preload builds the next source long before it
    /// is audible; claiming early would blank the visualizer for the tail of
    /// the current track. Claiming on first output means a crossfade hands the
    /// visualizer to the incoming track at the moment it starts, which is when
    /// the UI switches track metadata too.
    #[inline]
    fn owns_ring(&mut self) -> bool {
        if LEASE.load(Ordering::Relaxed) == self.id {
            return true;
        }
        if self.claimed {
            // Someone newer took over — go quiet rather than interleave.
            return false;
        }
        self.claimed = true;
        LEASE.store(self.id, Ordering::Relaxed);
        SOURCE_RATE.store(self.sample_rate, Ordering::Relaxed);
        true
    }
}

impl<S: Source<Item = f32>> Iterator for SpectrumTapSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        if ACTIVE.load(Ordering::Relaxed) && self.owns_ring() {
            // First two channels are L/R in every layout rodio hands us; any
            // further channels are centre/surround and don't belong in a
            // stereo trace.
            if self.channel_idx == 0 {
                self.left = sample;
            } else if self.channel_idx == 1 {
                self.right = sample;
            }
            self.channel_idx += 1;
            if self.channel_idx >= self.channels {
                // Mono sources drive both traces so the scope still shows a
                // line rather than half an empty screen.
                let right = if self.channels >= 2 { self.right } else { self.left };
                push_frame(self.left, right);
                self.channel_idx = 0;
            }
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
        self.inner.try_seek(pos)
    }
}

// ── Frame payload ────────────────────────────────────────────────────────────

/// `audio:spectrum` payload. All four arrays are base64 bytes:
///   • bands / peaks — `bandCount` entries, 0..255 over the dB display range
///   • waveformLeft / waveformRight — `waveCount` entries, signed traces
///     centred on 128. The frontend derives the mono trace from the pair, so
///     nothing is sent twice.
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

/// Owns the scratch buffers and envelope state for the emit loop. Kept separate
/// from the loop itself so frame production is testable without an audio device
/// or a Tauri app handle.
pub(crate) struct Analyzer {
    layout: Vec<Band>,
    layout_rate: u32,
    smoother: Smoother,
    re: Vec<f32>,
    im: Vec<f32>,
    mags: Vec<f32>,
    bands: Vec<f32>,
    /// Scratch for the L+R sum the FFT runs on.
    mono: Vec<f32>,
}

impl Analyzer {
    pub(crate) fn new() -> Self {
        Self {
            layout: band_layout(48_000),
            layout_rate: 48_000,
            smoother: Smoother::new(SmoothingProfile::default()),
            re: vec![0.0; FFT_SIZE],
            im: vec![0.0; FFT_SIZE],
            mags: vec![0.0; FFT_SIZE / 2],
            bands: vec![0.0; BAND_COUNT],
            mono: Vec::with_capacity(FFT_SIZE),
        }
    }

    /// Produce one frame from the latest `left`/`right` windows.
    ///
    /// `fresh` is false when the ring hasn't advanced since the last tick —
    /// paused, stopped, or between tracks. The envelopes then decay towards
    /// zero, and once everything has settled this returns `None` so the loop
    /// stops putting all-zero frames on the IPC pipe.
    pub(crate) fn frame(
        &mut self,
        left: &[f32],
        right: &[f32],
        sample_rate: u32,
        dt: f32,
        fresh: bool,
    ) -> Option<SpectrumPayload> {
        if !fresh && self.smoother.is_settled() {
            return None;
        }

        // The spectrum stays mono: summing here, on the analysis thread, keeps
        // the stereo scope free of any extra FFT work.
        if fresh {
            let n = left.len().min(right.len()).min(FFT_SIZE);
            self.mono.clear();
            self.mono.extend((0..n).map(|i| (left[i] + right[i]) * 0.5));
        }
        let window: &[f32] = &self.mono;

        if fresh {
            let rate = if sample_rate == 0 { 48_000 } else { sample_rate };
            if rate != self.layout_rate {
                self.layout = band_layout(rate);
                self.layout_rate = rate;
            }

            let hann = hann_window();
            for (i, (re, w)) in self.re.iter_mut().zip(hann.iter()).enumerate() {
                *re = window.get(i).copied().unwrap_or(0.0) * w;
            }
            self.im.iter_mut().for_each(|v| *v = 0.0);
            fft_in_place(&mut self.re, &mut self.im);
            magnitudes(&self.re, &self.im, &mut self.mags);
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
            window_levels(window)
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

impl Default for Analyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// RMS and absolute peak of an analysis window, both 0..1.
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

// ── Emit loop ────────────────────────────────────────────────────────────────

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
        if !ACTIVE.load(Ordering::Relaxed) || GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }

        let pos = snapshot(&mut left, &mut right);
        let fresh = pos != last_pos;
        last_pos = pos;

        let rate = SOURCE_RATE.load(Ordering::Relaxed);
        if let Some(payload) = analyzer.frame(&left, &right, rate, period.as_secs_f32(), fresh) {
            let _ = app.emit("audio:spectrum", payload);
        }
    }
}

/// Start or stop the spectrum feed.
///
/// Idempotent by design: the frontend keeps a single refcount across every
/// mounted visualizer surface and calls this only on the 0↔1 edges, but a
/// duplicate `true` (a reload that lost the previous count, for instance) just
/// replaces the running task rather than stacking a second one.
#[tauri::command]
#[specta::specta]
pub fn audio_spectrum_set_active(
    active: bool,
    fps: Option<u32>,
    responsiveness: Option<f32>,
    app: AppHandle,
) {
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

    if !active {
        ACTIVE.store(false, Ordering::Relaxed);
        // Bump so any in-flight tick of the old loop exits at its next check.
        GENERATION.fetch_add(1, Ordering::Relaxed);
        return;
    }

    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    ACTIVE.store(true, Ordering::Relaxed);
    tauri::async_runtime::spawn(run_emit_loop(app, generation));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

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
    fn tap_downmixes_one_mono_frame_per_channel_group() {
        let _guard = lock_globals();
        reset_globals();
        ACTIVE.store(true, Ordering::Relaxed);
        let mut tap = SpectrumTapSource::new(Silence { remaining: 64, channels: 2, rate: 44_100 });
        let _: Vec<f32> = (&mut tap).collect();
        ACTIVE.store(false, Ordering::Relaxed);
        assert_eq!(WRITE_POS.load(Ordering::Acquire), 32, "64 stereo samples = 32 mono frames");
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
        let frame = a.frame(&left, &right, 48_000, 0.016, true).unwrap();
        assert_ne!(frame.waveform_left, frame.waveform_right);
    }

    #[test]
    fn out_of_phase_channels_still_produce_a_spectrum() {
        // L and R summed to mono would cancel to silence; the bands come from
        // that sum, so this pins the behaviour rather than pretending otherwise.
        let mut a = Analyzer::new();
        let left = tone(1_000.0, 48_000.0, FFT_SIZE);
        let right: Vec<f32> = left.iter().map(|s| -s).collect();
        let frame = a.frame(&left, &right, 48_000, 0.016, true).unwrap();
        assert_eq!(frame.band_count, BAND_COUNT as u32);
        // The scope still shows both traces even when the sum is silent.
        assert!(decode_b64(&frame.waveform_left).iter().any(|b| *b != 128));
        assert!(decode_b64(&frame.waveform_right).iter().any(|b| *b != 128));
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
    fn newest_source_takes_the_ring_and_the_older_one_stops_writing() {
        let _guard = lock_globals();
        reset_globals();
        ACTIVE.store(true, Ordering::Relaxed);

        // Outgoing track starts first and claims the ring.
        let mut old = SpectrumTapSource::new(Silence { remaining: 64, channels: 1, rate: 44_100 });
        old.next();
        assert_eq!(WRITE_POS.load(Ordering::Acquire), 1);

        // Crossfade begins: the incoming source produces its first sample and
        // takes over.
        let mut new = SpectrumTapSource::new(Silence { remaining: 64, channels: 1, rate: 48_000 });
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

    // ── Analyzer ─────────────────────────────────────────────────────────────

    #[test]
    fn analyzer_emits_nothing_when_idle_and_settled() {
        let mut a = Analyzer::new();
        assert!(a.frame(&vec![0.0; FFT_SIZE], &vec![0.0; FFT_SIZE], 48_000, 0.016, false).is_none());
    }

    #[test]
    fn analyzer_emits_a_well_formed_frame_for_audio() {
        let mut a = Analyzer::new();
        let window = tone(1_000.0, 48_000.0, FFT_SIZE);
        let frame = a.frame(&window, &window, 48_000, 0.016, true).expect("audio should produce a frame");

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
            a.frame(&window, &window, 48_000, 0.016, true);
        }
        // Playback stops: frames continue while the envelopes fall...
        assert!(a.frame(&vec![0.0; FFT_SIZE], &vec![0.0; FFT_SIZE], 48_000, 0.016, false).is_some());
        // ...and eventually stop once everything has settled.
        let mut settled_after = None;
        for i in 0..600 {
            if a.frame(&vec![0.0; FFT_SIZE], &vec![0.0; FFT_SIZE], 48_000, 0.016, false).is_none() {
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
        let frame = a.frame(&window, &window, 44_100, 0.016, true).unwrap();
        assert_eq!(frame.sample_rate, 44_100);
        let frame = a.frame(&tone(1_000.0, 96_000.0, FFT_SIZE), &tone(1_000.0, 96_000.0, FFT_SIZE), 96_000, 0.016, true).unwrap();
        assert_eq!(frame.sample_rate, 96_000);
    }

    #[test]
    fn analyzer_falls_back_to_48k_for_an_unknown_rate() {
        let mut a = Analyzer::new();
        let frame = a.frame(&tone(1_000.0, 48_000.0, FFT_SIZE), &tone(1_000.0, 48_000.0, FFT_SIZE), 0, 0.016, true).unwrap();
        assert_eq!(frame.sample_rate, 48_000);
    }

    #[test]
    fn analyzer_tolerates_a_short_window() {
        let mut a = Analyzer::new();
        assert!(a.frame(&tone(1_000.0, 48_000.0, 64), &tone(1_000.0, 48_000.0, 64), 48_000, 0.016, true).is_some());
    }

    #[test]
    fn louder_audio_produces_taller_bands() {
        fn peak_band_byte(amp: f32) -> u8 {
            let mut a = Analyzer::new();
            let window: Vec<f32> = tone(1_000.0, 48_000.0, FFT_SIZE).iter().map(|s| s * amp).collect();
            let mut last = 0;
            for _ in 0..60 {
                if let Some(f) = a.frame(&window, &window, 48_000, 0.016, true) {
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
        let frame = a.frame(&vec![0.0; FFT_SIZE], &vec![0.0; FFT_SIZE], 48_000, 0.016, true).unwrap();
        assert!(decode_b64(&frame.bands).iter().all(|b| *b == 0));
        assert_eq!(frame.rms, 0.0);
    }

    #[test]
    fn idle_frames_carry_a_centred_waveform() {
        let mut a = Analyzer::new();
        a.frame(&tone(1_000.0, 48_000.0, FFT_SIZE), &tone(1_000.0, 48_000.0, FFT_SIZE), 48_000, 0.016, true);
        let frame = a.frame(&vec![0.0; FFT_SIZE], &vec![0.0; FFT_SIZE], 48_000, 0.016, false).unwrap();
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

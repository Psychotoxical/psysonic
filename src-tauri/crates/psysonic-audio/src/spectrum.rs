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
use tauri::{AppHandle, Emitter};

use super::spectrum_dsp::{DEFAULT_RESPONSIVENESS, FFT_SIZE};

mod analyzer;

#[allow(unused_imports)]
pub(crate) use analyzer::{Analyzer, SpectrumPayload};

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
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        DEFAULT_RESPONSIVENESS
    }
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
fn snapshot_at(end: u64, left: &mut [f32], right: &mut [f32]) {
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

    /// Folds one interleaved sample into the left/right analysis lanes, using
    /// the same gains the playback path folds with (`channel_fold`). Shared on
    /// purpose: if the two ever drift, the waveform stops describing what comes
    /// out of the speakers.
    #[inline]
    fn capture_sample(&mut self, sample: f32) {
        let (left_gain, right_gain) =
            crate::channel_fold::fold_gains(self.channel_idx, self.channels);
        // Channel 0 and 1 assign rather than accumulate: they open the frame.
        if self.channel_idx < 2 {
            if self.channel_idx == 0 {
                self.left = sample * left_gain;
            } else {
                self.right = sample * right_gain;
            }
            return;
        }
        self.left += sample * left_gain;
        self.right += sample * right_gain;
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
        if let Some(payload) = analyzer.frame((&left, &right), rate, period.as_secs_f32(), fresh) {
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
    let _guard = FEED_CONTROL
        .lock()
        .unwrap_or_else(|error| error.into_inner());

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
    if let FeedTransition::Start(generation) = update_feed_state(active, fps, responsiveness) {
        tauri::async_runtime::spawn(run_emit_loop(app, generation));
    }
}

#[cfg(test)]
#[path = "spectrum/tests.rs"]
pub(crate) mod tests;

#[cfg(test)]
#[path = "spectrum/tap_tests.rs"]
mod tap_tests;

#[cfg(test)]
#[path = "spectrum/channel_tests.rs"]
mod channel_tests;

#[cfg(test)]
#[path = "spectrum/analyzer_tests.rs"]
mod analyzer_tests;

#[cfg(test)]
#[path = "spectrum/feed_tests.rs"]
mod feed_tests;

//! Per-generation progress + ended-detection task. Spawned once per
//! `audio_play` / `audio_play_radio` invocation, the task ticks at 100 ms,
//! emits `audio:progress` (throttled), handles the gapless transition
//! when the current source exhausts and a chained successor is queued,
//! and finally emits `audio:ended` when no successor exists.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Runtime};

use super::engine::AudioCurrent;
use super::helpers::{ramp_sink_volume, ProgressPayload, MASTER_HEADROOM};
use super::state::ChainedInfo;

/// Sink for the three progress events the task emits. Production wraps an
/// `AppHandle<R>` (any Tauri runtime) via the blanket impl below; tests pass
/// a `MockProgressEmitter` that records every call.
///
/// Pulled out of `spawn_progress_task` so the timer-driven loop can be
/// exercised against a mock emitter under `#[tokio::test(start_paused = true)]`
/// without a live Tauri app.
pub trait ProgressEmitter: Send + Sync + 'static {
    fn emit_progress(&self, payload: ProgressPayload);
    fn emit_track_switched(&self, duration_secs: f64);
    fn emit_ended(&self);
}

impl<R: Runtime> ProgressEmitter for AppHandle<R> {
    fn emit_progress(&self, payload: ProgressPayload) {
        let _ = Emitter::emit(self, "audio:progress", payload);
    }
    fn emit_track_switched(&self, duration_secs: f64) {
        let _ = Emitter::emit(self, "audio:track_switched", duration_secs);
    }
    fn emit_ended(&self) {
        let _ = Emitter::emit(self, "audio:ended", ());
    }
}

/// Spawns the per-generation progress + ended-detection task.
///
/// The task owns a local `done: Arc<AtomicBool>` reference that starts as
/// the current track's done flag. When the progress task detects that the
/// done flag is set AND `chained_info` has data, it swaps `done` to the
/// chained source's flag and transitions state — all without creating a new
/// task or changing the generation counter.
///
/// Key changes from the previous implementation:
///   • 100 ms tick (was 500 ms) — halves worst-case event latency
///   • Position from atomic sample counter (no wall-clock drift)
///   • Immediate `audio:track_switched` event at decoder boundary
///   • `audio:ended` only fires when no chained successor exists
#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_progress_task<E: ProgressEmitter>(
    gen: u64,
    gen_counter: Arc<AtomicU64>,
    current_arc: Arc<Mutex<AudioCurrent>>,
    chained_arc: Arc<Mutex<Option<ChainedInfo>>>,
    crossfade_enabled_arc: Arc<AtomicBool>,
    crossfade_secs_arc: Arc<AtomicU32>,
    initial_done: Arc<AtomicBool>,
    emitter: E,
    samples_played: Arc<AtomicU64>,
    sample_rate_arc: Arc<AtomicU32>,
    channels_arc: Arc<AtomicU32>,
    gapless_switch_at: Arc<AtomicU64>,
    current_playback_url: Arc<Mutex<Option<String>>>,
) {
    // Keep progress aligned with audible output (ALSA/PipeWire/Pulse queue) on
    // Linux; mirrors the quantum policy used for stream open/reopen plus a small
    // scheduler/mixer cushion so the UI doesn't run ahead. Other platforms have
    // their own latency reporting paths and don't need the compensation here.
    #[cfg(target_os = "linux")]
    fn estimated_output_latency_secs(sample_rate_hz: f64) -> f64 {
        let rate = sample_rate_hz.max(1.0);
        let frames = if rate > 48_000.0 { 8192.0 } else { 4096.0 };
        (frames / rate) + 0.012
    }
    #[cfg(not(target_os = "linux"))]
    fn estimated_output_latency_secs(_sample_rate_hz: f64) -> f64 {
        0.0
    }

    // Keep near-end detection at 100 ms, but throttle progress IPC to webview.
    const PROGRESS_EMIT_MIN_MS: u64 = 1500;
    const PROGRESS_EMIT_MIN_DELTA_SECS: f64 = 0.9;

    tokio::spawn(async move {
        let mut near_end_ticks: u32 = 0;
        // Local done-flag reference; swapped on gapless transition.
        let mut current_done = initial_done;
        // Local sample counter; swapped to chained source's counter on transition.
        let mut samples_played = samples_played;
        let mut last_progress_emit_at = Instant::now() - Duration::from_millis(PROGRESS_EMIT_MIN_MS);
        let mut last_progress_emit_pos = -1.0f64;
        let mut last_progress_emit_paused = false;

        loop {
            // 100 ms tick keeps near-end detection timely for crossfade/gapless
            // handoff while frontend still interpolates smoothly via rAF.
            tokio::time::sleep(Duration::from_millis(100)).await;

            if gen_counter.load(Ordering::SeqCst) != gen {
                break;
            }

            // ── Gapless transition detection ─────────────────────────────────
            // If the current source is exhausted AND we have a chained track
            // ready, transition seamlessly: swap tracking state, emit
            // audio:track_switched for the new track, and continue the loop.
            if current_done.load(Ordering::SeqCst) {
                // Radio (dur == 0): stream exhausted / connection dropped → stop.
                let cur_dur = current_arc.lock().unwrap().duration_secs;
                if cur_dur <= 0.0 {
                    crate::app_eprintln!("[radio] current_done fired → emitting audio:ended (dur=0)");
                    gen_counter.fetch_add(1, Ordering::SeqCst);
                    emitter.emit_ended();
                    break;
                }

                let chained = chained_arc.lock().unwrap().take();
                if let Some(info) = chained {
                    // Swap to the chained source's done flag.
                    current_done = info.source_done;

                    // Swap to the chained source's sample counter.
                    // The chained CountingSource increments its own Arc,
                    // so we must rebind our local reference to it —
                    // a one-time value copy would go stale immediately.
                    samples_played = info.sample_counter;

                    // Update tracking state and apply the chained track's
                    // effective volume. Deferred from `audio_chain_preload`
                    // (which runs ~30 s before the current track ends) to
                    // avoid changing loudness of the still-playing current
                    // track. `Sink::set_volume` affects the whole Sink, so it
                    // must only be called at the boundary, not at preload.
                    {
                        let mut cur = current_arc.lock().unwrap();
                        let prev_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
                        cur.replay_gain_linear = info.replay_gain_linear;
                        cur.base_volume = info.base_volume;
                        cur.duration_secs = info.duration_secs;
                        cur.seek_offset = 0.0;
                        cur.play_started = Some(Instant::now());
                        if let Some(sink) = &cur.sink {
                            let effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
                            ramp_sink_volume(Arc::clone(sink), prev_effective, effective);
                        }
                    }

                    *current_playback_url.lock().unwrap() = Some(info.url.clone());

                    // Record the gapless switch timestamp for ghost-command guard.
                    let switch_ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    gapless_switch_at.store(switch_ts, Ordering::SeqCst);

                    // Emit the new track_switched event — this is immediate,
                    // not delayed by 500 ms like the old audio:playing was.
                    emitter.emit_track_switched(info.duration_secs);
                    near_end_ticks = 0;
                    continue;
                }
                // Current source exhausted but no chain queued — the Sink is
                // likely draining; audio:ended will fire on the next tick via
                // the near-end logic below.
            }

            // ── Position from atomic sample counter ──────────────────────────
            let rate = sample_rate_arc.load(Ordering::Relaxed) as f64;
            let ch = channels_arc.load(Ordering::Relaxed) as f64;
            let samples = samples_played.load(Ordering::Relaxed) as f64;
            let divisor = (rate * ch).max(1.0);

            // Read playback snapshot under a single lock to minimize contention
            // with seek/play/pause commands that also touch `current`.
            let (dur, paused_at) = {
                let cur = current_arc.lock().unwrap();
                (cur.duration_secs, cur.paused_at)
            };
            let is_paused = paused_at.is_some();

            let pos_raw = if let Some(p) = paused_at {
                p
            } else {
                (samples / divisor).min(dur.max(0.001))
            };
            let progress_latency = if is_paused {
                0.0
            } else {
                estimated_output_latency_secs(rate)
            };
            let pos = (pos_raw - progress_latency).max(0.0);

            let now = Instant::now();
            let should_emit_progress = is_paused != last_progress_emit_paused
                || now.duration_since(last_progress_emit_at) >= Duration::from_millis(PROGRESS_EMIT_MIN_MS)
                || (pos - last_progress_emit_pos).abs() >= PROGRESS_EMIT_MIN_DELTA_SECS;
            if should_emit_progress {
                emitter.emit_progress(ProgressPayload { current_time: pos, duration: dur });
                last_progress_emit_at = now;
                last_progress_emit_pos = pos;
                last_progress_emit_paused = is_paused;
            }

            if is_paused {
                continue;
            }

            let cf_enabled = crossfade_enabled_arc.load(Ordering::Relaxed);
            let cf_secs = f32::from_bits(crossfade_secs_arc.load(Ordering::Relaxed)).clamp(0.5, 12.0) as f64;
            let end_threshold = if cf_enabled { cf_secs.max(1.0) } else { 1.0 };

            if dur > end_threshold && pos_raw >= dur - end_threshold {
                near_end_ticks += 1;
                // At 100 ms ticks, 10 ticks ≈ 1 s — equivalent to the old 2×500ms.
                if near_end_ticks >= 10 {
                    // If a gapless chain is pending, the source hasn't
                    // exhausted yet — duration_hint (integer seconds from
                    // Subsonic) is shorter than the actual audio content.
                    // Don't emit audio:ended; let the gapless transition
                    // handle it when current_done fires.
                    let has_chain = chained_arc.lock().unwrap().is_some();
                    if has_chain {
                        continue;
                    }
                    gen_counter.fetch_add(1, Ordering::SeqCst);
                    emitter.emit_ended();
                    break;
                }
            } else {
                near_end_ticks = 0;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory `ProgressEmitter` that records every event for assertion.
    #[derive(Default)]
    struct MockEmitter {
        progress: Mutex<Vec<ProgressPayload>>,
        track_switched: Mutex<Vec<f64>>,
        ended: std::sync::atomic::AtomicUsize,
    }

    impl MockEmitter {
        fn progress_count(&self) -> usize {
            self.progress.lock().unwrap().len()
        }
        fn ended_count(&self) -> usize {
            self.ended.load(Ordering::SeqCst)
        }
        fn track_switched_count(&self) -> usize {
            self.track_switched.lock().unwrap().len()
        }
    }

    impl ProgressEmitter for Arc<MockEmitter> {
        fn emit_progress(&self, payload: ProgressPayload) {
            self.progress.lock().unwrap().push(payload);
        }
        fn emit_track_switched(&self, duration_secs: f64) {
            self.track_switched.lock().unwrap().push(duration_secs);
        }
        fn emit_ended(&self) {
            self.ended.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Bundle of every Arc<…> the spawn function needs, with sane defaults.
    struct TaskHarness {
        gen: u64,
        gen_counter: Arc<AtomicU64>,
        current: Arc<Mutex<AudioCurrent>>,
        chained: Arc<Mutex<Option<ChainedInfo>>>,
        crossfade_enabled: Arc<AtomicBool>,
        crossfade_secs: Arc<AtomicU32>,
        done: Arc<AtomicBool>,
        samples_played: Arc<AtomicU64>,
        sample_rate: Arc<AtomicU32>,
        channels: Arc<AtomicU32>,
        gapless_switch_at: Arc<AtomicU64>,
        playback_url: Arc<Mutex<Option<String>>>,
    }

    impl TaskHarness {
        fn new(duration_secs: f64) -> Self {
            let current = AudioCurrent {
                sink: None,
                duration_secs,
                seek_offset: 0.0,
                play_started: None,
                paused_at: None,
                replay_gain_linear: 1.0,
                base_volume: 1.0,
                fadeout_trigger: None,
                fadeout_samples: None,
            };
            Self {
                gen: 1,
                gen_counter: Arc::new(AtomicU64::new(1)),
                current: Arc::new(Mutex::new(current)),
                chained: Arc::new(Mutex::new(None)),
                crossfade_enabled: Arc::new(AtomicBool::new(false)),
                crossfade_secs: Arc::new(AtomicU32::new(0f32.to_bits())),
                done: Arc::new(AtomicBool::new(false)),
                samples_played: Arc::new(AtomicU64::new(0)),
                sample_rate: Arc::new(AtomicU32::new(44_100)),
                channels: Arc::new(AtomicU32::new(2)),
                gapless_switch_at: Arc::new(AtomicU64::new(0)),
                playback_url: Arc::new(Mutex::new(None)),
            }
        }

        fn spawn_with(&self, emitter: Arc<MockEmitter>) {
            spawn_progress_task(
                self.gen,
                self.gen_counter.clone(),
                self.current.clone(),
                self.chained.clone(),
                self.crossfade_enabled.clone(),
                self.crossfade_secs.clone(),
                self.done.clone(),
                emitter,
                self.samples_played.clone(),
                self.sample_rate.clone(),
                self.channels.clone(),
                self.gapless_switch_at.clone(),
                self.playback_url.clone(),
            );
        }
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn task_breaks_immediately_when_generation_already_changed() {
        let h = TaskHarness::new(120.0);
        // Bump the generation BEFORE spawn — the first 100 ms tick will see
        // the mismatch and exit the loop without emitting anything.
        h.gen_counter.store(99, Ordering::SeqCst);

        let emitter = Arc::new(MockEmitter::default());
        h.spawn_with(emitter.clone());

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(emitter.progress_count(), 0);
        assert_eq!(emitter.ended_count(), 0);
        assert_eq!(emitter.track_switched_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn radio_with_dur_zero_emits_ended_when_done_flag_flips() {
        // Radio streams have duration_secs == 0; the "done" flag is the only
        // exhaustion signal. Loop must emit audio:ended and bump the
        // generation counter.
        //
        // Multi-thread runtime with real time — start_paused under
        // current_thread doesn't reliably drive the spawned task's loop body
        // after tokio::time::advance, even with repeated yields. Real 100 ms
        // sleeps are tolerable because the test only waits one tick.
        let h = TaskHarness::new(0.0);
        h.done.store(true, Ordering::SeqCst);

        let emitter = Arc::new(MockEmitter::default());
        h.spawn_with(emitter.clone());

        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(emitter.ended_count(), 1, "audio:ended must fire");
        assert_eq!(emitter.progress_count(), 0, "no progress emit before exhaustion");
        assert!(
            h.gen_counter.load(Ordering::SeqCst) > h.gen,
            "generation counter must bump so following commands see the new gen"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn task_emits_progress_payload_with_duration_after_first_tick() {
        let h = TaskHarness::new(120.0);
        // 5 s of playback at 44.1 kHz × 2 ch.
        let played = (5.0 * 44_100.0 * 2.0) as u64;
        h.samples_played.store(played, Ordering::SeqCst);

        let emitter = Arc::new(MockEmitter::default());
        h.spawn_with(emitter.clone());

        tokio::time::sleep(Duration::from_millis(200)).await;
        let first_payload = {
            let payloads = emitter.progress.lock().unwrap();
            assert!(!payloads.is_empty(), "first tick must emit progress");
            payloads[0].clone()
        };
        assert_eq!(first_payload.duration, 120.0, "duration_secs propagates verbatim");
        // current_time is computed from samples_played but possibly trimmed by
        // platform output latency — accept anything in [0, duration].
        assert!(first_payload.current_time >= 0.0 && first_payload.current_time <= 120.0);

        // Stop the task so the test runtime can end.
        h.gen_counter.store(99, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn done_with_chained_info_swaps_to_chain_and_emits_track_switched() {
        let h = TaskHarness::new(120.0);
        // Mark current source exhausted AND queue a chained successor.
        h.done.store(true, Ordering::SeqCst);
        let chain_url = "psysonic-local:///next/track.flac".to_string();
        let chained_done = Arc::new(AtomicBool::new(false));
        let chained_samples = Arc::new(AtomicU64::new(0));
        *h.chained.lock().unwrap() = Some(ChainedInfo {
            url: chain_url.clone(),
            raw_bytes: Arc::new(Vec::new()),
            duration_secs: 200.0,
            replay_gain_linear: 1.0,
            base_volume: 1.0,
            source_done: chained_done,
            sample_counter: chained_samples,
        });

        let emitter = Arc::new(MockEmitter::default());
        h.spawn_with(emitter.clone());

        tokio::time::sleep(Duration::from_millis(200)).await;

        assert_eq!(
            emitter.track_switched_count(),
            1,
            "audio:track_switched must fire on gapless transition"
        );
        let switched_dur = emitter.track_switched.lock().unwrap()[0];
        assert_eq!(switched_dur, 200.0, "duration of the chained track");

        assert_eq!(
            emitter.ended_count(),
            0,
            "audio:ended must NOT fire when a chain is present"
        );
        assert_eq!(
            *h.playback_url.lock().unwrap(),
            Some(chain_url),
            "current_playback_url updated to the chained URL"
        );
        assert!(
            h.gapless_switch_at.load(Ordering::SeqCst) > 0,
            "gapless_switch_at timestamp recorded for ghost-command guard"
        );

        // Stop the task.
        h.gen_counter.store(99, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

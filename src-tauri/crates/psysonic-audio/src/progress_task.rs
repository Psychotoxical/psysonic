//! Per-generation progress + ended-detection task. Spawned once per
//! `audio_play` / `audio_play_radio` invocation, the task ticks at 100 ms,
//! emits `audio:progress` (throttled), handles the gapless transition
//! when the current source exhausts and a chained successor is queued,
//! and finally emits `audio:ended` when no successor exists.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::engine::AudioCurrent;
use super::helpers::{ramp_sink_volume, ProgressPayload, MASTER_HEADROOM};
use super::state::ChainedInfo;

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
pub(super) fn spawn_progress_task(
    gen: u64,
    gen_counter: Arc<AtomicU64>,
    current_arc: Arc<Mutex<AudioCurrent>>,
    chained_arc: Arc<Mutex<Option<ChainedInfo>>>,
    crossfade_enabled_arc: Arc<AtomicBool>,
    crossfade_secs_arc: Arc<AtomicU32>,
    initial_done: Arc<AtomicBool>,
    app: AppHandle,
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
                    app.emit("audio:ended", ()).ok();
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
                    app.emit("audio:track_switched", info.duration_secs).ok();
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
                app.emit("audio:progress", ProgressPayload { current_time: pos, duration: dur }).ok();
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
                    app.emit("audio:ended", ()).ok();
                    break;
                }
            } else {
                near_end_ticks = 0;
            }
        }
    });
}

//! Sink-lifecycle glue for `audio_play`: atomically swap a freshly built sink
//! into `state.current` (handing off the old one to a crossfade tail or a hard
//! stop), and the legacy non-seekable path that holds a sink paused until the
//! download task arms playback. Split out of `play_input.rs` so source
//! selection and source building stay focused on their own concerns.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use super::engine::{AudioCurrent, AudioEngine};

/// Args for [`spawn_legacy_stream_start_when_armed`].
pub(super) struct LegacyStreamStartWhenArmed {
    pub gen: u64,
    pub gen_arc: Arc<AtomicU64>,
    pub playback_armed: Arc<AtomicBool>,
    pub samples_played: Arc<AtomicU64>,
    pub current: Arc<Mutex<AudioCurrent>>,
    pub app: AppHandle,
    pub duration_secs: f64,
    pub hold_paused: bool,
}

/// Legacy `AudioStreamReader`: keep the sink paused until the download task arms
/// playback, then reset counters and emit `audio:playing` so the UI does not
/// extrapolate ahead of audible output.
pub(super) fn spawn_legacy_stream_start_when_armed(args: LegacyStreamStartWhenArmed) {
    let LegacyStreamStartWhenArmed {
        gen,
        gen_arc,
        playback_armed,
        samples_played,
        current,
        app,
        duration_secs,
        hold_paused,
    } = args;
    tokio::spawn(async move {
        loop {
            if gen_arc.load(Ordering::SeqCst) != gen {
                return;
            }
            if playback_armed.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if gen_arc.load(Ordering::SeqCst) != gen {
            return;
        }
        samples_played.store(0, Ordering::Relaxed);
        let sink = current.lock().unwrap().sink.clone();
        if let Some(sink) = sink {
            if hold_paused {
                sink.pause();
                let mut cur = current.lock().unwrap();
                cur.play_started = None;
                if cur.paused_at.is_none() {
                    cur.paused_at = Some(0.0);
                }
                cur.seek_offset = 0.0;
                crate::app_deprintln!(
                    "[stream] legacy track-stream: buffer ready, holding paused (silent prepare)"
                );
            } else {
                {
                    let mut cur = current.lock().unwrap();
                    cur.play_started = Some(Instant::now());
                    cur.paused_at = None;
                    cur.seek_offset = 0.0;
                }
                sink.play();
                app.emit("audio:playing", duration_secs).ok();
                crate::app_deprintln!("[stream] legacy track-stream: playback started after buffer ready");
            }
        }
    });
}

/// State + decisions audio_play computed before the sink swap.
pub(crate) struct SinkSwapInputs {
    pub(crate) sink: Arc<rodio::Player>,
    pub(crate) duration_secs: f64,
    pub(crate) volume: f32,
    pub(crate) gain_linear: f32,
    pub(crate) fadeout_trigger: Arc<AtomicBool>,
    pub(crate) fadeout_samples: Arc<AtomicU64>,
    pub(crate) crossfade_enabled: bool,
    pub(crate) actual_fade_secs: f32,
    /// Track A fade-out length (decoupled from B's `actual_fade_secs` fade-in).
    /// `0` ⇒ don't fade A — it rides its own recorded fade-out (scenario A).
    pub(crate) outgoing_fade_secs: f32,
    pub(crate) start_paused: bool,
}

/// Atomically swap the new sink into `state.current`, then handle the old
/// sink: trigger sample-level fade-out (crossfade enabled) or stop it
/// immediately (hard cut). The fade-out is handed off to a small spawned
/// task that drops the old sink ~`actual_fade_secs + 0.5 s` later.
pub(crate) fn swap_in_new_sink(state: &State<'_, AudioEngine>, inputs: SinkSwapInputs) {
    let SinkSwapInputs {
        sink,
        duration_secs,
        volume,
        gain_linear,
        fadeout_trigger: new_fadeout_trigger,
        fadeout_samples: new_fadeout_samples,
        crossfade_enabled,
        actual_fade_secs,
        outgoing_fade_secs,
        start_paused,
    } = inputs;

    let (old_sink, old_fadeout_trigger, old_fadeout_samples) = {
        let mut cur = state.current.lock().unwrap();
        let old = cur.sink.take();
        let old_fo_trigger = cur.fadeout_trigger.take();
        let old_fo_samples = cur.fadeout_samples.take();
        cur.sink = Some(sink.clone());
        cur.duration_secs = duration_secs;
        cur.seek_offset = 0.0;
        if start_paused {
            sink.pause();
            cur.play_started = None;
            cur.paused_at = Some(0.0);
        } else {
            cur.play_started = Some(Instant::now());
            cur.paused_at = None;
        }
        cur.replay_gain_linear = gain_linear;
        cur.base_volume = volume.clamp(0.0, 1.0);
        cur.fadeout_trigger = Some(new_fadeout_trigger);
        cur.fadeout_samples = Some(new_fadeout_samples);
        (old, old_fo_trigger, old_fo_samples)
    };

    if crossfade_enabled {
        if let Some(old) = old_sink {
            // Trigger sample-level fade-out on Track A via TriggeredFadeOut —
            // unless `outgoing_fade_secs` is 0 (scenario A): then A keeps full
            // engine gain and its own recorded fade carries it down while B
            // rises underneath. Either way the old sink is kept alive until B's
            // fade-in window elapses, so A plays out its tail before being
            // dropped.
            if outgoing_fade_secs > 0.0 {
                let rate = state.current_sample_rate.load(Ordering::Relaxed);
                let ch = state.current_channels.load(Ordering::Relaxed);
                let fade_total = (outgoing_fade_secs as f64 * rate as f64 * ch as f64) as u64;

                if let (Some(trigger), Some(samples)) = (old_fadeout_trigger, old_fadeout_samples) {
                    samples.store(fade_total.max(1), Ordering::SeqCst);
                    trigger.store(true, Ordering::SeqCst);
                }
            }

            // Keep old sink alive until the fade completes + small margin,
            // then drop it. No volume stepping needed — the fade-out runs
            // at sample level inside the audio thread.
            *state.fading_out_sink.lock().unwrap() = Some(old);
            let fo_arc = state.fading_out_sink.clone();
            let cleanup_dur = Duration::from_secs_f32(actual_fade_secs.max(outgoing_fade_secs) + 0.5);
            tokio::spawn(async move {
                tokio::time::sleep(cleanup_dur).await;
                if let Some(s) = fo_arc.lock().unwrap().take() {
                    s.stop();
                }
            });
        }
    } else if let Some(old) = old_sink {
        old.stop();
    }
}

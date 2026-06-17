//! Release the CPAL/rodio output stream after playback has been idle so the OS
//! can sleep (issue #1071 — Windows `powercfg` "audio stream in use").

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::engine::AudioEngine;

/// Wall-clock idle period before closing the output device handle.
pub(crate) const OUTPUT_STREAM_IDLE_RELEASE_SECS: u64 = 60;

const IDLE_POLL_SECS: u64 = 5;

/// Returns true while the app must keep an open output stream (playing, preview, crossfade).
pub(crate) fn output_stream_is_needed(engine: &AudioEngine) -> bool {
    if engine.preview_sink.lock().unwrap().is_some() {
        return true;
    }
    if engine.fading_out_sink.lock().unwrap().is_some() {
        return true;
    }

    let cur = engine.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if sink.empty() {
            return false;
        }
        if cur.play_started.is_some() && cur.paused_at.is_none() {
            return true;
        }
    }

    if let Some(rs) = engine.radio_state.lock().unwrap().as_ref() {
        if !rs.flags.is_paused.load(Ordering::Relaxed) {
            return true;
        }
    }

    false
}

/// Stop sinks tied to the open stream; keep pause position / URLs for cold resume.
pub(crate) fn teardown_playback_sinks_for_idle_release(engine: &AudioEngine) {
    if let Some(s) = engine.preview_sink.lock().unwrap().take() {
        s.stop();
    }
    if let Some(s) = engine.fading_out_sink.lock().unwrap().take() {
        s.stop();
    }
    let mut cur = engine.current.lock().unwrap();
    if let Some(s) = cur.sink.take() {
        s.stop();
    }
    cur.play_started = None;
}

fn close_output_device_handle(engine: &AudioEngine, app: &AppHandle) -> Result<(), String> {
    super::engine::request_stream_release(engine)?;
    *engine.stream_handle.lock().unwrap() = None;
    let _ = app.emit("audio:output-released", ());
    Ok(())
}

/// Release the output device after the idle timer (pause with no other active audio).
pub(crate) fn release_output_stream(
    engine: &AudioEngine,
    app: &AppHandle,
) -> Result<(), String> {
    if engine.stream_handle.lock().unwrap().is_none() {
        return Ok(());
    }
    teardown_playback_sinks_for_idle_release(engine);
    close_output_device_handle(engine, app)?;
    crate::app_eprintln!(
        "[psysonic] audio output stream released after {}s idle",
        OUTPUT_STREAM_IDLE_RELEASE_SECS
    );
    Ok(())
}

/// Release immediately on explicit stop / queue end — do not wait for the idle timer.
pub(crate) fn release_output_stream_on_stop(
    engine: &AudioEngine,
    app: &AppHandle,
) -> Result<(), String> {
    if engine.stream_handle.lock().unwrap().is_none() {
        return Ok(());
    }
    // `audio_stop` already tore down the main sink; clear any crossfade/preview tail
    // still tied to the open device before closing the handle.
    if engine.preview_sink.lock().unwrap().is_some()
        || engine.fading_out_sink.lock().unwrap().is_some()
    {
        teardown_playback_sinks_for_idle_release(engine);
    }
    close_output_device_handle(engine, app)?;
    crate::app_eprintln!("[psysonic] audio output stream released on stop");
    Ok(())
}

/// Resolves the engine from `app` each poll (the engine is managed Tauri state),
/// so it takes only the `AppHandle` — no engine reference is needed here.
pub fn start_stream_idle_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut idle_since: Option<Instant> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(IDLE_POLL_SECS)).await;
            let Some(state) = app.try_state::<AudioEngine>() else {
                idle_since = None;
                continue;
            };
            let engine = state.inner();
            let stream_open = engine.stream_handle.lock().unwrap().is_some();
            if !stream_open {
                idle_since = None;
                continue;
            }
            if output_stream_is_needed(engine) {
                idle_since = None;
                continue;
            }
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() < Duration::from_secs(OUTPUT_STREAM_IDLE_RELEASE_SECS) {
                continue;
            }
            let _ = release_output_stream(engine, &app);
            idle_since = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
    use std::sync::{Arc, Mutex, RwLock};

    use ringbuf::HeapCons;
    use rodio::source::Zero;
    use rodio::{ChannelCount, Player, SampleRate};

    use super::super::engine::AudioCurrent;
    use super::super::playback_rate::PlaybackRateAtomics;
    use super::super::stream::{RadioLiveState, RadioSharedFlags};

    /// A device-less rodio `Player` with one infinite source appended, so
    /// `empty()` reports `false` without ever opening an output device.
    /// Returns the queue output too — keep it alive for the test's duration.
    fn nonempty_player() -> (Arc<Player>, rodio::queue::SourcesQueueOutput) {
        let (player, out) = Player::new();
        player.append(Zero::new(
            ChannelCount::new(2).unwrap(),
            SampleRate::new(44_100).unwrap(),
        ));
        (Arc::new(player), out)
    }

    fn radio_session(is_paused: bool) -> RadioLiveState {
        let (tx, _rx) = std::sync::mpsc::channel::<HeapCons<u8>>();
        RadioLiveState {
            url: "http://example.test/stream".to_string(),
            gen: 0,
            // Detached no-op task; never polled. Drop just aborts it.
            task: tokio::spawn(async {}),
            flags: Arc::new(RadioSharedFlags {
                is_paused: AtomicBool::new(is_paused),
                is_hard_paused: AtomicBool::new(false),
                new_cons_tx: Mutex::new(tx),
            }),
        }
    }

    fn minimal_engine() -> AudioEngine {
        let (stream_thread_tx, _) = std::sync::mpsc::sync_channel(0);
        AudioEngine {
            stream_handle: Arc::new(Mutex::new(None)),
            stream_sample_rate: Arc::new(AtomicU32::new(0)),
            device_default_rate: 48_000,
            stream_thread_tx,
            selected_device: Arc::new(Mutex::new(None)),
            current: Arc::new(Mutex::new(AudioCurrent {
                sink: None,
                duration_secs: 0.0,
                seek_offset: 0.0,
                play_started: None,
                paused_at: None,
                replay_gain_linear: 1.0,
                base_volume: 0.8,
                fadeout_trigger: None,
                fadeout_samples: None,
            })),
            generation: Arc::new(AtomicU64::new(0)),
            http_client: Arc::new(RwLock::new(reqwest::Client::new())),
            eq_gains: Arc::new(std::array::from_fn(|_| AtomicU32::new(0))),
            eq_enabled: Arc::new(AtomicBool::new(false)),
            eq_pre_gain: Arc::new(AtomicU32::new(0)),
            playback_rate: PlaybackRateAtomics::new(),
            preloaded: Arc::new(Mutex::new(None)),
            stream_completed_cache: Arc::new(Mutex::new(None)),
            stream_completed_spill: Arc::new(Mutex::new(None)),
            current_is_seekable: Arc::new(AtomicBool::new(true)),
            stream_playback_armed: Arc::new(AtomicBool::new(true)),
            crossfade_enabled: Arc::new(AtomicBool::new(false)),
            crossfade_secs: Arc::new(AtomicU32::new(0)),
            autodj_suppress_autocrossfade: Arc::new(AtomicBool::new(false)),
            fading_out_sink: Arc::new(Mutex::new(None)),
            gapless_enabled: Arc::new(AtomicBool::new(false)),
            normalization_engine: Arc::new(AtomicU32::new(0)),
            normalization_target_lufs: Arc::new(AtomicU32::new(0)),
            loudness_pre_analysis_attenuation_db: Arc::new(AtomicU32::new(0)),
            chained_info: Arc::new(Mutex::new(None)),
            samples_played: Arc::new(AtomicU64::new(0)),
            current_sample_rate: Arc::new(AtomicU32::new(44_100)),
            current_channels: Arc::new(AtomicU32::new(2)),
            gapless_switch_at: Arc::new(AtomicU64::new(0)),
            radio_state: Mutex::new(None),
            current_playback_url: Arc::new(Mutex::new(None)),
            current_analysis_track_id: Arc::new(Mutex::new(None)),
            current_playback_server_id: Arc::new(Mutex::new(None)),
            ranged_loudness_seed_hold: Arc::new(Mutex::new(None)),
            preview_sink: Arc::new(Mutex::new(None)),
            preview_gen: Arc::new(AtomicU64::new(0)),
            preview_main_resume: Arc::new(AtomicBool::new(false)),
            preview_song_id: Arc::new(Mutex::new(None)),
        }
    }

    #[test]
    fn idle_when_no_sink_and_no_preview() {
        let engine = minimal_engine();
        assert!(!output_stream_is_needed(&engine));
    }

    #[test]
    fn idle_when_sink_empty() {
        // A live but drained main sink (track finished) must not pin the device.
        let (player, _out) = Player::new(); // no source appended → empty()
        let player = Arc::new(player);
        let engine = minimal_engine();
        {
            let mut cur = engine.current.lock().unwrap();
            cur.sink = Some(player);
            cur.play_started = Some(Instant::now());
            cur.paused_at = None;
        }
        assert!(!output_stream_is_needed(&engine));
    }

    #[test]
    fn needed_when_sink_playing() {
        let (sink, _out) = nonempty_player();
        let engine = minimal_engine();
        {
            let mut cur = engine.current.lock().unwrap();
            cur.sink = Some(sink);
            cur.play_started = Some(Instant::now());
            cur.paused_at = None; // actively playing
        }
        assert!(output_stream_is_needed(&engine));
    }

    #[test]
    fn idle_when_sink_paused() {
        // Non-empty sink but paused (paused_at set) — the idle watcher may release.
        let (sink, _out) = nonempty_player();
        let engine = minimal_engine();
        {
            let mut cur = engine.current.lock().unwrap();
            cur.sink = Some(sink);
            cur.play_started = Some(Instant::now());
            cur.paused_at = Some(12.0);
        }
        assert!(!output_stream_is_needed(&engine));
    }

    #[test]
    fn needed_when_preview_sink_present() {
        let (sink, _out) = nonempty_player();
        let engine = minimal_engine();
        *engine.preview_sink.lock().unwrap() = Some(sink);
        assert!(output_stream_is_needed(&engine));
    }

    #[test]
    fn needed_when_fading_out_sink_present() {
        let (sink, _out) = nonempty_player();
        let engine = minimal_engine();
        *engine.fading_out_sink.lock().unwrap() = Some(sink);
        assert!(output_stream_is_needed(&engine));
    }

    #[tokio::test]
    async fn needed_when_radio_playing() {
        let engine = minimal_engine();
        *engine.radio_state.lock().unwrap() = Some(radio_session(false));
        assert!(output_stream_is_needed(&engine));
    }

    #[tokio::test]
    async fn idle_when_radio_paused() {
        let engine = minimal_engine();
        *engine.radio_state.lock().unwrap() = Some(radio_session(true));
        assert!(!output_stream_is_needed(&engine));
    }
}

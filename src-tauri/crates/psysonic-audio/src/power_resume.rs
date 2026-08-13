//! Reopen CPAL/rodio output after system sleep/resume when the old stream can be silent
//! while the reported default device name is unchanged (Windows WASAPI, Linux PipeWire/ALSA, etc.).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::device_watcher::{
    reopen_output_stream_with_retry, ReopenNotify, ReopenOutcome,
};
use super::engine::{
    request_stream_release_after_attachments_locked, wait_for_stream_attachments_locked,
    AudioEngine,
};
use super::stream_idle::{output_stream_is_needed, teardown_playback_sinks_for_idle_release};

static RESUME_REOPEN_DEBOUNCE: Mutex<Option<Instant>> = Mutex::new(None);
const DEBOUNCE: Duration = Duration::from_millis(900);

/// Returns false if this resume should be ignored (coalesce bursts from the OS).
pub(crate) fn debounce_allow_resume_reopen() -> bool {
    let mut g = RESUME_REOPEN_DEBOUNCE.lock().unwrap();
    let now = Instant::now();
    if let Some(t) = *g {
        if now.duration_since(t) < DEBOUNCE {
            return false;
        }
    }
    *g = Some(now);
    true
}

/// Delay so the audio stack re-enumerates before we open a new stream.
pub(crate) async fn reopen_audio_after_system_resume(app: &AppHandle) {
    tokio::time::sleep(Duration::from_millis(400)).await;

    let Some(state) = app.try_state::<AudioEngine>() else {
        return;
    };
    let engine = state.inner();

    {
        let _stream_guard = engine.stream_open_lock.lock().unwrap();
        if !output_stream_is_needed(engine) {
            wait_for_stream_attachments_locked(engine);
            let _commit_guard = engine.playback_commit_lock.lock().unwrap();
            if output_stream_is_needed(engine) {
                return;
            }
            if engine.stream_handle.lock().unwrap().is_some() {
                teardown_playback_sinks_for_idle_release(engine);
                let _ = request_stream_release_after_attachments_locked(engine);
                let _ = app.emit("audio:output-released", ());
            }
            return;
        }
    }

    let device_name = engine.selected_device.lock().unwrap().clone();

    match reopen_output_stream_with_retry(app, device_name, ReopenNotify::DeviceChanged).await {
        Ok(ReopenOutcome::Reopened) => {
            crate::app_eprintln!("[psysonic] audio output reopened after system resume")
        }
        Ok(ReopenOutcome::Superseded) => {}
        Err(error) => crate::app_eprintln!(
            "[psysonic] audio: stream reopen failed after system resume: {error}"
        ),
    }
}

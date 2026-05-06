//! Reopen CPAL/rodio output after system sleep/resume when the old stream can be silent
//! while the reported default device name is unchanged (Windows WASAPI, Linux PipeWire/ALSA, etc.).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri::Manager;

use super::device_watcher::{reopen_output_stream, ReopenNotify};
use super::engine::AudioEngine;

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

    let device_name = match app.try_state::<AudioEngine>() {
        Some(e) => e.selected_device.lock().unwrap().clone(),
        None => return,
    };

    if reopen_output_stream(app, device_name, ReopenNotify::DeviceChanged).await {
        crate::app_eprintln!("[psysonic] audio output reopened after system resume");
    } else {
        crate::app_eprintln!(
            "[psysonic] audio: stream reopen failed or timed out after system resume"
        );
    }
}

//! Tauri commands for output-device listing + selection. Pulled out of
//! `commands.rs` so playback / radio / EQ aren't entangled with the device
//! enumeration + reopen path.

use std::sync::atomic::Ordering;

use tauri::{Emitter, State};

use super::dev_io::{
    enumerate_output_device_names, output_devices_logically_same,
    output_enumeration_includes_pinned, with_suppressed_alsa_stderr,
};
use super::engine::AudioEngine;

/// When the saved `selected_device` no longer literally matches any listed
/// physical sink (e.g. suffix drift), rewrite `selected_device` to the listed form.
#[tauri::command]
#[specta::specta]
pub fn audio_canonicalize_selected_device(state: State<'_, AudioEngine>) -> Option<String> {
    let pinned = state.selected_device.lock().unwrap().clone()?;
    if pinned.is_empty() {
        return None;
    }
    let list = enumerate_output_device_names();
    if list.iter().any(|d| d == &pinned) {
        return None;
    }
    let canon = list
        .iter()
        .find(|d| output_devices_logically_same(d, &pinned))?
        .clone();
    *state.selected_device.lock().unwrap() = Some(canon.clone());
    Some(canon)
}

/// Same device list as [`audio_list_devices`] without the Tauri `State` wrapper (CLI / single-instance).
pub fn audio_list_devices_for_engine(engine: &AudioEngine) -> Vec<String> {
    let mut list = enumerate_output_device_names();
    if let Some(ref name) = *engine.selected_device.lock().unwrap() {
        if !name.is_empty() && !output_enumeration_includes_pinned(&list, name) {
            list.push(name.clone());
        }
    }
    list
}

/// Returns the names of all available audio output devices on the current host.
/// On Linux, ALSA probes unavailable backends (JACK, OSS, dmix) and prints errors to
/// stderr. We suppress fd 2 for the duration of enumeration to keep the terminal clean.
///
/// The user-pinned device name is appended when cpal omits it (e.g. HDMI busy while
/// streaming) so the Settings dropdown still matches `audioOutputDevice`.
#[tauri::command]
#[specta::specta]
pub fn audio_list_devices(state: State<'_, AudioEngine>) -> Vec<String> {
    audio_list_devices_for_engine(&state)
}

/// Device id string for the host default output (matches an entry from `audio_list_devices` when present).
#[tauri::command]
#[specta::specta]
pub fn audio_default_output_device_name() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.default_output_device()
            .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
    })
}

/// Switch the audio output device. `device_name = null` → follow system default.
/// Reopens the stream immediately; frontend must restart playback via audio:device-changed.
#[tauri::command]
#[specta::specta]
pub async fn audio_set_device(
    device_name: Option<String>,
    state: State<'_, AudioEngine>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    *state.selected_device.lock().unwrap() = device_name.clone();

    let rate = state.stream_sample_rate.load(Ordering::Relaxed);
    let open_rate = if rate > 0 {
        rate
    } else {
        state.device_default_rate
    };
    super::engine::open_output_stream_blocking(&state, open_rate, false, device_name.clone())
        .map_err(|_| "device open timed out".to_string())?;

    // Capture position and drop the active sink atomically so the position
    // reading is still valid (play_started / paused_at intact before take).
    let current_time = {
        let mut cur = state.current.lock().unwrap();
        let pos = cur.position();
        if let Some(s) = cur.sink.take() { s.stop(); }
        pos
    };
    if let Some(s) = state.fading_out_sink.lock().unwrap().take() { s.stop(); }

    // Emit the saved position so the frontend can use seekFallbackVisualTarget
    // and resume from where the track was, rather than restarting from the beginning.
    // null is reserved for "Rust already resumed internally" (see reopen_output_stream).
    app.emit("audio:device-changed", current_time).map_err(|e| e.to_string())?;
    Ok(())
}

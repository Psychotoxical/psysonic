//! `psysonic-audio` — Symphonia decode, rodio output, HTTP radio/streaming,
//! gapless, previews. Submodules (`sources`, `decode`, `stream`, `commands`, …)
//! preserve the historical single `audio.rs` partitioning.

// Re-export the logging facade so submodules can keep using
// `crate::app_eprintln!()` / `crate::app_deprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

pub mod autoeq_commands;
mod codec;
pub mod commands;
mod decode;
mod dev_io;
pub mod device_commands;
pub mod mix_commands;
mod play_input;
pub mod preload_commands;
pub(crate) mod progress_task;
pub mod radio_commands;
pub mod transport_commands;
mod device_watcher;
mod engine;
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod power_resume;
#[cfg(target_os = "windows")]
mod power_notify_win;
#[cfg(target_os = "linux")]
mod power_notify_linux;
mod helpers;
mod ipc;
pub mod preview;
mod sources;
mod state;
mod stream;

pub use device_commands::{audio_default_output_device_name, audio_list_devices_for_engine};
pub use device_watcher::start_device_watcher;
pub use engine::{create_engine, refresh_http_user_agent, AudioEngine};
pub use helpers::take_stream_completed_for_url;

/// Register platform-specific listeners so the output stream is reopened after sleep/resume
/// when the device name may be unchanged (Windows WASAPI, Linux PipeWire, …).
pub fn register_post_sleep_audio_recovery(app: tauri::AppHandle) {
    #[cfg(target_os = "windows")]
    power_notify_win::register(app);
    #[cfg(target_os = "linux")]
    power_notify_linux::register(app);
    // macOS intentionally falls through for now: we only ship native resume hooks
    // where we have verified regressions (Windows WASAPI, Linux logind/PipeWire).
    // macOS currently relies on the generic device watcher path.
    #[cfg(all(
        not(target_os = "windows"),
        not(target_os = "linux")
    ))]
    let _ = app;
}

pub use engine::{analysis_track_id_is_current_playback, ranged_loudness_backfill_should_defer, stop_audio_engine};

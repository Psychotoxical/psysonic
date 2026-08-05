use std::sync::Mutex;

use tauri::{Emitter, Manager};

use crate::analysis_cache;
use crate::lib_commands::sync::stop_audio_engine;
use crate::runtime_subsonic_wire_user_agent;

#[derive(Default)]
struct MainWindowLifecycleInner {
    frontend_ready: bool,
    close_pending: bool,
}

#[derive(Default)]
pub(crate) struct MainWindowLifecycleState(Mutex<MainWindowLifecycleInner>);

impl MainWindowLifecycleState {
    pub(crate) fn request_close(&self) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.frontend_ready {
            true
        } else {
            state.close_pending = true;
            false
        }
    }

    fn mark_frontend_ready(&self) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.frontend_ready = true;
        std::mem::take(&mut state.close_pending)
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_ready(
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) {
    if state.mark_frontend_ready() {
        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.emit("window:close-requested", ());
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn exit_app(app_handle: tauri::AppHandle) {
    if let Some(cache) = app_handle.try_state::<analysis_cache::AnalysisCache>() {
        let _ = cache.checkpoint_wal("exit");
    }
    stop_audio_engine(&app_handle);
    app_handle.exit(0);
}

#[cfg(test)]
mod tests {
    use super::MainWindowLifecycleState;

    #[test]
    fn close_is_queued_until_the_frontend_is_ready() {
        let state = MainWindowLifecycleState::default();

        assert!(!state.request_close());
        assert!(state.mark_frontend_ready());
        assert!(!state.mark_frontend_ready());
        assert!(state.request_close());
    }

    #[test]
    fn repeated_early_close_requests_coalesce() {
        let state = MainWindowLifecycleState::default();

        assert!(!state.request_close());
        assert!(!state.request_close());
        assert!(state.mark_frontend_ready());
        assert!(!state.mark_frontend_ready());
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_logging_mode(mode: String) -> Result<(), String> {
    crate::logging::set_logging_mode_from_str(&mode)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_psylab_albums_browse_trace(enabled: bool) -> Result<(), String> {
    psysonic_core::logging::set_psylab_albums_browse_trace(enabled);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_psylab_artists_browse_trace(enabled: bool) -> Result<(), String> {
    psysonic_core::logging::set_psylab_artists_browse_trace(enabled);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_logging_mode() -> String {
    crate::logging::current_mode_str().to_string()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn export_runtime_logs(path: String) -> Result<usize, String> {
    crate::logging::export_logs_to_file(&path)
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogLineDto {
    pub seq: u64,
    pub text: String,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogTailDto {
    pub lines: Vec<LogLineDto>,
    pub last_seq: u64,
    pub dropped: bool,
}

/// Incremental tail of the in-memory runtime log buffer for the PsyLab Logs tab.
/// `after_seq` is the highest seq the UI already has (omit for
/// the initial fetch of the most recent `max` lines).
#[tauri::command]
#[specta::specta]
pub(crate) fn tail_runtime_logs(after_seq: Option<u64>, max: Option<usize>) -> LogTailDto {
    let tail = crate::logging::tail_logs(after_seq, max.unwrap_or(2000));
    LogTailDto {
        lines: tail
            .lines
            .into_iter()
            .map(|l| LogLineDto { seq: l.seq, text: l.text })
            .collect(),
        last_seq: tail.last_seq,
        dropped: tail.dropped,
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn frontend_debug_log(scope: String, message: String) -> Result<(), String> {
    crate::app_deprintln!("[frontend][{}] {}", scope, message);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn set_subsonic_wire_user_agent(
    user_agent: String,
    window_label: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if window_label != "main" {
        return Ok(());
    }
    let ua = user_agent.trim();
    if ua.is_empty() {
        return Err("user agent is empty".to_string());
    }
    let mut guard = runtime_subsonic_wire_user_agent()
        .write()
        .map_err(|_| "user agent state poisoned".to_string())?;
    guard.clear();
    guard.push_str(ua);
    drop(guard);

    crate::audio::refresh_http_user_agent(&app_handle.state::<crate::audio::AudioEngine>(), ua);
    Ok(())
}

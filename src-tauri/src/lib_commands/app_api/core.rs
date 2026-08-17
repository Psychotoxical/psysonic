use tauri::{Emitter, Manager};

use crate::analysis_cache;
use crate::lib_commands::sync::stop_audio_engine;
use crate::lib_commands::ui::{PAUSE_RENDERING_JS, RESUME_RENDERING_JS};
use crate::runtime_subsonic_wire_user_agent;

mod lifecycle;

pub(crate) use lifecycle::{
    run_native_lifecycle_fallback, LifecycleRequest, MainWindowLifecycleState,
    PendingLifecycleAction,
};

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_generation(
    state: tauri::State<'_, MainWindowLifecycleState>,
) -> u64 {
    state.generation()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_begin(
    generation: u64,
    attempt: u64,
    state: tauri::State<'_, MainWindowLifecycleState>,
) -> Result<(), String> {
    state
        .begin_frontend_registration(generation, attempt)
        .then_some(())
        .ok_or_else(|| "stale window lifecycle registration".to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_ready(
    generation: u64,
    attempt: u64,
    minimize_to_tray: bool,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) {
    if let Some(action) = state.mark_frontend_ready(generation, attempt, minimize_to_tray) {
        let emitted =
            app_handle
                .get_webview_window("main")
                .ok_or(())
                .and_then(|window| match action {
                    PendingLifecycleAction::Close { transition } => window
                        .emit("window:close-requested", transition)
                        .map_err(|_| ()),
                    PendingLifecycleAction::ForceQuit => {
                        window.emit("app:force-quit", ()).map_err(|_| ())
                    }
                });
        if emitted.is_err() {
            let request = state.native_request_after_emit_failure(action);
            let _ = run_native_lifecycle_fallback(request, app_handle);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_hide(
    generation: u64,
    transition: u64,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let Some(window) = app_handle.get_webview_window("main") else {
        return Ok(false);
    };
    match state.apply_frontend_visibility(generation, transition, || {
        let _ = window.eval(PAUSE_RENDERING_JS);
        if let Err(error) = window.hide() {
            let _ = window.eval(RESUME_RENDERING_JS);
            return Err(error.to_string());
        }
        Ok(())
    }) {
        Some(result) => result.map(|()| true),
        None => Ok(false),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_startup_visibility(
    hidden: bool,
    generation: u64,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let Some(window) = app_handle.get_webview_window("main") else {
        return Ok(false);
    };
    state
        .apply_startup_visibility(generation, || {
            if hidden { window.hide() } else { window.show() }.map_err(|error| error.to_string())
        })
        .map(|result| result.is_some())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_fallback(
    generation: u64,
    attempt: u64,
    minimize_to_tray: bool,
    state: tauri::State<'_, MainWindowLifecycleState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    if let Some(request) = state.enable_native_fallback(generation, attempt, minimize_to_tray)? {
        run_native_lifecycle_fallback(request, app_handle)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn window_lifecycle_update_fallback_policy(
    generation: u64,
    minimize_to_tray: bool,
    state: tauri::State<'_, MainWindowLifecycleState>,
) {
    state.update_native_fallback_policy(generation, minimize_to_tray);
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
            .map(|l| LogLineDto {
                seq: l.seq,
                text: l.text,
            })
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

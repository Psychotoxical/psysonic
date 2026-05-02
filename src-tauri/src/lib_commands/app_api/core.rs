use super::*;

#[tauri::command]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
pub(crate) fn exit_app(app_handle: tauri::AppHandle) {
    stop_audio_engine(&app_handle);
    app_handle.exit(0);
}

/// Writes `psysonic-cli-snapshot.json` for `psysonic --info` (debounced from the frontend).
#[tauri::command]
pub(crate) fn cli_publish_player_snapshot(snapshot: serde_json::Value) -> Result<(), String> {
    crate::cli::write_cli_snapshot(&snapshot)
}

/// Writes `psysonic-cli-library.json` for `psysonic --player library list`.
#[tauri::command]
pub(crate) fn cli_publish_library_list(payload: serde_json::Value) -> Result<(), String> {
    crate::cli::write_library_cli_response(&payload)
}

/// Writes `psysonic-cli-servers.json` for `psysonic --player server list`.
#[tauri::command]
pub(crate) fn cli_publish_server_list(payload: serde_json::Value) -> Result<(), String> {
    crate::cli::write_server_list_cli_response(&payload)
}

/// Writes `psysonic-cli-search.json` for `psysonic --player search …`.
#[tauri::command]
pub(crate) fn cli_publish_search_results(payload: serde_json::Value) -> Result<(), String> {
    crate::cli::write_search_cli_response(&payload)
}

/// Toggle native window decorations at runtime (Linux custom title bar opt-out).
#[tauri::command]
pub(crate) fn set_window_decorations(enabled: bool, app_handle: tauri::AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.set_decorations(enabled);
        // Re-enabling native decorations on GTK causes the window manager to
        // re-stack the window, which drops focus. Bring it back immediately.
        if enabled {
            let _ = win.set_focus();
        }
    }
}

/// WebKitGTK: `enable-smooth-scrolling` also drives deferred / kinetic wheel scrolling.
#[cfg(target_os = "linux")]
pub(crate) fn linux_webkit_apply_smooth_scrolling(win: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    win.with_webview(move |platform| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = platform.inner().settings() {
            settings.set_enable_smooth_scrolling(enabled);
        }
    })
    .map_err(|e| e.to_string())
}

/// Called from the frontend settings toggle (Linux); no-op on other platforms.
#[tauri::command]
pub(crate) fn set_linux_webkit_smooth_scrolling(enabled: bool, app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        // Each WebviewWindow has its own WebKitGTK Settings — main-only left the
        // mini player on the default (inertial) wheel until the user toggled again.
        for label in ["main", "mini"] {
            if let Some(win) = app_handle.get_webview_window(label) {
                linux_webkit_apply_smooth_scrolling(&win, enabled)?;
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (enabled, app_handle);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn set_logging_mode(mode: String) -> Result<(), String> {
    crate::logging::set_logging_mode_from_str(&mode)
}

#[tauri::command]
pub(crate) fn export_runtime_logs(path: String) -> Result<usize, String> {
    crate::logging::export_logs_to_file(&path)
}

#[tauri::command]
pub(crate) fn frontend_debug_log(scope: String, message: String) -> Result<(), String> {
    crate::app_deprintln!("[frontend][{}] {}", scope, message);
    Ok(())
}

#[tauri::command]
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



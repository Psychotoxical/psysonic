use super::*;
use serde::Serialize;

#[cfg(target_os = "linux")]
use std::fs;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PerformanceCpuSnapshot {
    pub supported: bool,
    pub total_jiffies: u64,
    pub app_jiffies: u64,
    pub webkit_jiffies: u64,
    pub logical_cpus: u32,
}

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

#[cfg(target_os = "linux")]
fn parse_proc_stat_line(stat_line: &str) -> Option<(String, i32, u64, u64)> {
    let close_idx = stat_line.rfind(')')?;
    let open_idx = stat_line.find('(')?;
    if open_idx + 1 >= close_idx {
        return None;
    }
    let comm = stat_line.get(open_idx + 1..close_idx)?.to_string();
    let after = stat_line.get(close_idx + 2..)?;
    let mut parts = after.split_whitespace();
    let _state = parts.next()?;
    let ppid = parts.next()?.parse::<i32>().ok()?;
    let rest: Vec<&str> = parts.collect();
    // After `state` and `ppid`, remaining fields start at `pgrp` (field #5).
    // `utime` = field #14 => rest[9], `stime` = field #15 => rest[10].
    let utime = rest.get(9)?.parse::<u64>().ok()?;
    let stime = rest.get(10)?.parse::<u64>().ok()?;
    Some((comm, ppid, utime, stime))
}

#[cfg(target_os = "linux")]
fn read_total_jiffies() -> Option<u64> {
    let content = fs::read_to_string("/proc/stat").ok()?;
    let line = content.lines().next()?;
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    Some(it.filter_map(|n| n.parse::<u64>().ok()).sum())
}

#[cfg(target_os = "linux")]
fn collect_proc_stats() -> Vec<(i32, String, i32, u64)> {
    let mut rows = Vec::new();
    let entries = match fs::read_dir("/proc") {
        Ok(v) => v,
        Err(_) => return rows,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = match name.to_string_lossy().parse::<i32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let stat_path = format!("/proc/{pid}/stat");
        let stat_line = match fs::read_to_string(stat_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some((comm, ppid, utime, stime)) = parse_proc_stat_line(stat_line.trim()) {
            rows.push((pid, comm, ppid, utime.saturating_add(stime)));
        }
    }
    rows
}

#[tauri::command]
pub(crate) fn performance_cpu_snapshot() -> PerformanceCpuSnapshot {
    #[cfg(target_os = "linux")]
    {
        let total_jiffies = read_total_jiffies().unwrap_or(0);
        let logical_cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1);
        let self_pid = std::process::id() as i32;
        let rows = collect_proc_stats();
        let app_jiffies = rows
            .iter()
            .find(|(pid, _, _, _)| *pid == self_pid)
            .map(|(_, _, _, ticks)| *ticks)
            .unwrap_or(0);
        let webkit_jiffies = rows
            .iter()
            // Linux `/proc/*/stat` `comm` is capped to 15 chars, so
            // "WebKitWebProcess" appears as "WebKitWebProces".
            .filter(|(_, comm, ppid, _)| comm.starts_with("WebKitWebProces") && *ppid == self_pid)
            .map(|(_, _, _, ticks)| *ticks)
            .sum::<u64>();
        return PerformanceCpuSnapshot {
            supported: true,
            total_jiffies,
            app_jiffies,
            webkit_jiffies,
            logical_cpus,
        };
    }
    #[cfg(not(target_os = "linux"))]
    {
        PerformanceCpuSnapshot {
            supported: false,
            total_jiffies: 0,
            app_jiffies: 0,
            webkit_jiffies: 0,
            logical_cpus: 1,
        }
    }
}



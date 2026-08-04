use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::presenters::{print_library_human, print_search_human, print_server_list_human};

// ─── Response file paths ─────────────────────────────────────────────────────

/// JSON snapshot path (written by the GUI process, read by `psysonic --info`).
pub fn cli_snapshot_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-snapshot.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-snapshot.json")
}

pub fn cli_audio_device_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-audio-devices.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-audio-devices.json")
}

pub fn cli_library_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-library.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-library.json")
}

pub fn cli_server_list_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-servers.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-servers.json")
}

pub fn cli_search_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-search.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-search.json")
}

pub fn cli_benchmark_response_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir).join("psysonic-cli-benchmark.json");
        }
    }
    std::env::temp_dir().join("psysonic-cli-benchmark.json")
}

// ─── Snapshot writer ─────────────────────────────────────────────────────────

pub fn write_cli_snapshot(payload: &Value) -> Result<(), String> {
    let path = cli_snapshot_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── List/search response IPC ────────────────────────────────────────────────

pub(super) fn read_library_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_library_response_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if v.get("folders").and_then(|x| x.as_array()).is_some() {
                    return text;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub(super) fn print_library_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        print_library_human(&v);
    } else {
        println!("{}", text.trim());
    }
}

pub fn write_library_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_library_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn write_server_list_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_server_list_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn write_search_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_search_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Wait for `psysonic-cli-servers.json` after `cli:server-list`.
pub(super) fn read_server_list_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_server_list_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                if v.get("servers").and_then(|x| x.as_array()).is_some() {
                    return text;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub(super) fn print_server_list_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        print_server_list_human(&v);
    } else {
        println!("{}", text.trim());
    }
}

/// Wait for `psysonic-cli-search.json` after `cli:search`.
pub(super) fn read_search_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_search_response_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let trimmed = text.trim();
            if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
                let ready = v.get("ready").and_then(|x| x.as_bool()) == Some(true);
                let has_err = v.get("error").and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty());
                if ready || has_err {
                    return text;
                }
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub(super) fn print_search_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        print_search_human(&v);
    } else {
        println!("{}", text.trim());
    }
}

pub fn write_benchmark_cli_response(payload: &Value) -> Result<(), String> {
    let path = cli_benchmark_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn read_benchmark_cli_response_blocking(max_wait: Duration) -> String {
    let path = cli_benchmark_response_path();
    let deadline = Instant::now() + max_wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|value| value.get("ready").and_then(Value::as_bool)) == Some(true)
            {
                return text;
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into())
}

pub(super) fn print_benchmark_cli_stdout(text: &str, json_out: bool) {
    if json_out {
        println!("{}", text.trim());
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        println!("{}", text.trim());
        return;
    };
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        eprintln!("NOT OK: {error}");
        return;
    }
    if let Some(path) = value.get("path").and_then(Value::as_str) {
        println!("Benchmark report: {path}");
    }
    if let Some(rows) = value.get("summary").and_then(Value::as_array) {
        for row in rows.iter().take(10) {
            let route = row.get("route").and_then(Value::as_str).unwrap_or("?");
            let median = row.get("medianTotalMs").and_then(Value::as_u64).unwrap_or(0);
            let max = row.get("maxTotalMs").and_then(Value::as_u64).unwrap_or(0);
            println!("  {route:<24} median {median:>6} ms  max {max:>6} ms");
        }
    }
    if let Some(rows) = value.pointer("/comparison/rows").and_then(Value::as_array) {
        println!("Compared with previous run:");
        for row in rows.iter().take(10) {
            let route = row.get("route").and_then(Value::as_str).unwrap_or("?");
            let delta = row.get("deltaMs").and_then(Value::as_i64).unwrap_or(0);
            let percent = row.get("deltaPercent").and_then(Value::as_f64).unwrap_or(0.0);
            println!("  {route:<24} {delta:>+6} ms  {percent:>+6.0}%");
        }
    }
}

// ─── Audio devices response writer ───────────────────────────────────────────

pub fn write_audio_device_cli_response(engine: &crate::audio::AudioEngine) -> Result<(), String> {
    let devices = crate::audio::audio_list_devices_for_engine(engine);
    let default_device = crate::audio::audio_default_output_device_name();
    let selected = engine.selected_device.lock().unwrap().clone();
    let v = serde_json::json!({
        "devices": devices,
        "default": default_device,
        "selected": selected,
    });
    let path = cli_audio_device_response_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

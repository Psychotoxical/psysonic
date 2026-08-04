use serde_json::Value;
use tauri::Manager;
use std::sync::{Mutex, OnceLock};

fn pending_request() -> &'static Mutex<Option<Value>> {
    static REQUEST: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    REQUEST.get_or_init(|| Mutex::new(None))
}

pub(crate) fn queue_request<R: tauri::Runtime, T: serde::Serialize>(
    app: &tauri::AppHandle<R>,
    request: &T,
) -> Result<(), String> {
    let value = serde_json::to_value(request).map_err(|e| e.to_string())?;
    *pending_request().lock().map_err(|_| "benchmark request lock poisoned".to_string())? = Some(value);
    use tauri::Emitter;
    app.emit("cli:benchmark-run", ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn benchmark_take_pending_request() -> Result<Option<Value>, String> {
    Ok(pending_request().lock()
        .map_err(|_| "benchmark request lock poisoned".to_string())?
        .take())
}

fn benchmark_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?
        .join("performance")
        .join("benchmarks"))
}

fn atomic_write(path: &std::path::Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn response_for_report(path: &std::path::Path, payload: &Value) -> Value {
    serde_json::json!({
        "ready": true,
        "path": path.to_string_lossy(),
        "id": payload.get("id"),
        "startedAt": payload.get("startedAt"),
        "finishedAt": payload.get("finishedAt"),
        "scenario": payload.get("scenario"),
        "profile": payload.get("profile"),
        "summary": payload.get("summary"),
        "comparison": payload.get("comparison"),
        "error": payload.get("error"),
    })
}

fn summary_median_by_route(payload: &Value) -> std::collections::BTreeMap<String, i64> {
    payload.get("summary").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|row| Some((
            row.get("route")?.as_str()?.to_string(),
            row.get("medianTotalMs")?.as_i64()?,
        )))
        .collect()
}

fn comparison_with_previous(previous: &Value, current: &Value) -> Value {
    let before = summary_median_by_route(previous);
    let after = summary_median_by_route(current);
    let rows = after.into_iter().filter_map(|(route, current_ms)| {
        let previous_ms = *before.get(&route)?;
        Some(serde_json::json!({
            "route": route,
            "previousMedianMs": previous_ms,
            "currentMedianMs": current_ms,
            "deltaMs": current_ms - previous_ms,
            "deltaPercent": if previous_ms > 0 {
                ((current_ms - previous_ms) as f64 / previous_ms as f64 * 100.0).round()
            } else { 0.0 },
        }))
    }).collect::<Vec<_>>();
    serde_json::json!({
        "previousId": previous.get("id"),
        "rows": rows,
    })
}

fn has_matching_run_configuration(previous: &Value, current: &Value) -> bool {
    ["scenario", "profile", "runs"]
        .into_iter()
        .all(|key| previous.get(key) == current.get(key))
}

fn latest_matching_history_entry(history: &str, current: &Value) -> Option<Value> {
    history.lines().rev().find_map(|line| {
        let candidate = serde_json::from_str::<Value>(line).ok()?;
        has_matching_run_configuration(&candidate, current).then_some(candidate)
    })
}

fn previous_comparable_run(root: &std::path::Path, current: &Value) -> Option<Value> {
    if let Ok(history) = std::fs::read_to_string(root.join("history.ndjson")) {
        if let Some(candidate) = latest_matching_history_entry(&history, current) {
            return Some(candidate);
        }
    }

    std::fs::read_to_string(root.join("latest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(|candidate| has_matching_run_configuration(candidate, current))
}

fn append_history(root: &std::path::Path, payload: &Value, report_path: &std::path::Path) -> Result<(), String> {
    let path = root.join("history.ndjson");
    let row = serde_json::json!({
        "id": payload.get("id"),
        "startedAt": payload.get("startedAt"),
        "finishedAt": payload.get("finishedAt"),
        "scenario": payload.get("scenario"),
        "profile": payload.get("profile"),
        "runs": payload.get("runs"),
        "path": report_path.to_string_lossy(),
        "summary": payload.get("summary"),
        "comparison": payload.get("comparison"),
        "error": payload.get("error"),
    });
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", serde_json::to_string(&row).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn benchmark_publish_run(
    app: tauri::AppHandle,
    mut payload: Value,
) -> Result<Value, String> {
    let id = payload.get("id").and_then(Value::as_str)
        .ok_or_else(|| "benchmark payload has no id".to_string())?
        .to_string();
    let root = benchmark_root(&app)?;
    let previous = previous_comparable_run(&root, &payload);
    if let Some(previous) = previous.as_ref() {
        let comparison = comparison_with_previous(previous, &payload);
        if let Some(object) = payload.as_object_mut() {
            object.insert("comparison".to_string(), comparison);
        }
    }
    let run_dir = root.join(&id);
    let report_path = run_dir.join("report.json");
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    atomic_write(&report_path, &json)?;
    if let Some(markdown) = payload.get("markdown").and_then(Value::as_str) {
        atomic_write(&run_dir.join("report.md"), markdown)?;
    }
    atomic_write(&root.join("latest.json"), &json)?;
    append_history(&root, &payload, &report_path)?;
    let response = response_for_report(&report_path, &payload);
    crate::cli::write_benchmark_cli_response(&response)?;
    Ok(response)
}

pub(crate) fn publish_latest_to_cli<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let root = benchmark_root(app)?;
    let latest_path = root.join("latest.json");
    let payload: Value = serde_json::from_str(
        &std::fs::read_to_string(&latest_path).map_err(|e| e.to_string())?
    ).map_err(|e| e.to_string())?;
    crate::cli::write_benchmark_cli_response(&response_for_report(&latest_path, &payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: &str, scenario: &str, profile: &str, runs: u64, total_ms: i64) -> Value {
        serde_json::json!({
            "id": id,
            "scenario": scenario,
            "profile": profile,
            "runs": runs,
            "summary": [{
                "route": "/",
                "medianTotalMs": total_ms,
            }],
        })
    }

    #[test]
    fn latest_matching_history_entry_uses_latest_matching_configuration() {
        let rows = [
            report("core-1", "core-pages", "realistic", 1, 100),
            report("all-1", "all-pages", "realistic", 1, 200),
            report("all-2", "all-pages", "realistic", 2, 300),
            report("all-isolated", "all-pages", "isolated", 1, 400),
        ];
        let history = rows
            .iter()
            .map(|row| serde_json::to_string(row).expect("serialize history row"))
            .collect::<Vec<_>>()
            .join("\n");

        let current = report("current", "all-pages", "realistic", 1, 250);
        let previous = latest_matching_history_entry(&history, &current)
            .expect("matching benchmark run");

        assert_eq!(previous.get("id").and_then(Value::as_str), Some("all-1"));
        assert_eq!(
            comparison_with_previous(&previous, &current),
            serde_json::json!({
                "previousId": "all-1",
                "rows": [{
                    "route": "/",
                    "previousMedianMs": 200,
                    "currentMedianMs": 250,
                    "deltaMs": 50,
                    "deltaPercent": 25.0,
                }],
            })
        );
    }

    #[test]
    fn run_configuration_requires_matching_scenario_profile_and_runs() {
        let current = report("current", "all-pages", "realistic", 1, 250);

        assert!(!has_matching_run_configuration(
            &report("previous", "core-pages", "realistic", 1, 100),
            &current,
        ));
        assert!(!has_matching_run_configuration(
            &report("previous", "all-pages", "isolated", 1, 100),
            &current,
        ));
        assert!(!has_matching_run_configuration(
            &report("previous", "all-pages", "realistic", 2, 100),
            &current,
        ));
        assert!(has_matching_run_configuration(
            &report("previous", "all-pages", "realistic", 1, 100),
            &current,
        ));
    }
}

//! Deduped emits for normalization UI and partial loudness analysis.
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PartialLoudnessPayload {
    pub(crate) track_id: Option<String>,
    pub(crate) gain_db: f32,
    pub(crate) target_lufs: f32,
    pub(crate) is_partial: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NormalizationStatePayload {
    pub(crate) engine: String,
    pub(crate) current_gain_db: Option<f32>,
    pub(crate) target_lufs: f32,
}

/// Last `audio:normalization-state` emit, kept so we can suppress duplicate
/// payloads. The frontend already debounces this event, but on Windows
/// (WebView2) the IPC pipe is the bottleneck — every echo we skip here is
/// renderer-thread time we don't pay.
pub(crate) static LAST_NORM_STATE_EMIT: OnceLock<Mutex<Option<NormalizationStatePayload>>> = OnceLock::new();

pub(crate) fn norm_state_lock() -> &'static Mutex<Option<NormalizationStatePayload>> {
    LAST_NORM_STATE_EMIT.get_or_init(|| Mutex::new(None))
}

pub(crate) fn norm_state_changed(prev: &NormalizationStatePayload, next: &NormalizationStatePayload) -> bool {
    if prev.engine != next.engine { return true; }
    if (prev.target_lufs - next.target_lufs).abs() >= 0.02 { return true; }
    match (prev.current_gain_db, next.current_gain_db) {
        (None, None) => false,
        (Some(a), Some(b)) => (a - b).abs() >= 0.05,
        _ => true, // None ↔ Some transition is significant
    }
}

pub(crate) fn maybe_emit_normalization_state(app: &AppHandle, payload: NormalizationStatePayload) {
    let mut guard = norm_state_lock().lock().unwrap();
    let should_emit = match guard.as_ref() {
        Some(prev) => norm_state_changed(prev, &payload),
        None => true,
    };
    if !should_emit { return; }
    *guard = Some(payload.clone());
    drop(guard);
    let _ = app.emit("audio:normalization-state", payload);
}

/// Last `analysis:loudness-partial` gain emitted per track-identity, used to
/// suppress emits whose gain hasn't moved meaningfully (≥ 0.1 dB). The partial
/// heuristic in `emit_partial_loudness_from_bytes` and the ranged-progress curve
/// both produce values that drift by hundredths of a dB even on identical input,
/// so the time-based throttle alone is not enough to keep the loop quiet.
pub(crate) static LAST_PARTIAL_LOUDNESS_EMIT: OnceLock<Mutex<std::collections::HashMap<String, f32>>> = OnceLock::new();
pub(crate) const PARTIAL_LOUDNESS_DELTA_THRESHOLD_DB: f32 = 0.1;

pub(crate) fn partial_loudness_should_emit(track_key: &str, gain_db: f32) -> bool {
    let mut guard = LAST_PARTIAL_LOUDNESS_EMIT
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap();
    let prev = guard.get(track_key).copied();
    if let Some(p) = prev {
        if (p - gain_db).abs() < PARTIAL_LOUDNESS_DELTA_THRESHOLD_DB {
            return false;
        }
    }
    guard.insert(track_key.to_string(), gain_db);
    true
}

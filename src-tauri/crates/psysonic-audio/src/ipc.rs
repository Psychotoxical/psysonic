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

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(engine: &str, gain: Option<f32>, target: f32) -> NormalizationStatePayload {
        NormalizationStatePayload {
            engine: engine.to_string(),
            current_gain_db: gain,
            target_lufs: target,
        }
    }

    // ── norm_state_changed ────────────────────────────────────────────────────

    #[test]
    fn norm_state_unchanged_for_identical_payloads() {
        let p = payload("loudness", Some(-3.0), -14.0);
        assert!(!norm_state_changed(&p, &p.clone()));
    }

    #[test]
    fn norm_state_changes_when_engine_differs() {
        let a = payload("off", Some(0.0), -14.0);
        let b = payload("loudness", Some(0.0), -14.0);
        assert!(norm_state_changed(&a, &b));
    }

    #[test]
    fn norm_state_ignores_micro_target_lufs_drift_below_two_centibels() {
        let a = payload("loudness", Some(-3.0), -14.0);
        let b = payload("loudness", Some(-3.0), -14.01);
        assert!(!norm_state_changed(&a, &b));
    }

    #[test]
    fn norm_state_changes_when_target_lufs_moves_at_least_2_centibels() {
        let a = payload("loudness", Some(-3.0), -14.0);
        let b = payload("loudness", Some(-3.0), -13.97);
        assert!(norm_state_changed(&a, &b));
    }

    #[test]
    fn norm_state_ignores_micro_gain_drift_below_5_centibels() {
        let a = payload("loudness", Some(-3.00), -14.0);
        let b = payload("loudness", Some(-3.04), -14.0);
        assert!(!norm_state_changed(&a, &b));
    }

    #[test]
    fn norm_state_changes_when_gain_moves_at_least_5_centibels() {
        let a = payload("loudness", Some(-3.00), -14.0);
        let b = payload("loudness", Some(-3.06), -14.0);
        assert!(norm_state_changed(&a, &b));
    }

    #[test]
    fn norm_state_changes_when_gain_appears_or_disappears() {
        let a = payload("loudness", None, -14.0);
        let b = payload("loudness", Some(-3.0), -14.0);
        assert!(norm_state_changed(&a, &b));
        assert!(norm_state_changed(&b, &a));
    }

    #[test]
    fn norm_state_unchanged_when_both_gains_none() {
        let a = payload("off", None, -14.0);
        let b = payload("off", None, -14.0);
        assert!(!norm_state_changed(&a, &b));
    }

    // ── partial_loudness_should_emit ──────────────────────────────────────────
    //
    // Note: this function reads/writes a process-global static map. Tests share
    // that state, so each test uses a unique track-key to avoid cross-test
    // pollution. (Don't run tests in parallel that share keys.)

    #[test]
    fn partial_loudness_emits_on_first_call_for_a_track_key() {
        let key = "test-emits-first-call";
        assert!(partial_loudness_should_emit(key, -3.0));
    }

    #[test]
    fn partial_loudness_suppresses_micro_drift_below_threshold() {
        let key = "test-emits-micro-drift";
        assert!(partial_loudness_should_emit(key, -3.0));
        assert!(
            !partial_loudness_should_emit(key, -3.05),
            "delta < 0.1 dB is suppressed"
        );
    }

    #[test]
    fn partial_loudness_emits_again_when_threshold_is_crossed() {
        let key = "test-emits-after-threshold";
        assert!(partial_loudness_should_emit(key, -3.0));
        assert!(partial_loudness_should_emit(key, -3.5), "delta >= 0.1 dB re-emits");
    }

    #[test]
    fn partial_loudness_treats_each_track_key_independently() {
        assert!(partial_loudness_should_emit("track-A-independent", -3.0));
        assert!(
            partial_loudness_should_emit("track-B-independent", -3.0),
            "different track keys do not share suppression state"
        );
    }
}

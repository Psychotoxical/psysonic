//! Per-track analysis timing events for the Performance Probe overlay.

use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, Default)]
pub struct AnalysisSeedTimings {
    pub seed_ms: u64,
    pub bpm_ms: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisTrackPerfPayload {
    pub track_id: String,
    pub fetch_ms: u64,
    pub seed_ms: u64,
    pub bpm_ms: u64,
    pub total_ms: u64,
}

pub fn emit_analysis_track_perf(
    app: &AppHandle,
    track_id: &str,
    fetch_ms: u64,
    seed_ms: u64,
    bpm_ms: u64,
) {
    let total_ms = fetch_ms.saturating_add(seed_ms).saturating_add(bpm_ms);
    if total_ms == 0 {
        return;
    }
    let _ = app.emit(
        "analysis:track-perf",
        AnalysisTrackPerfPayload {
            track_id: track_id.to_string(),
            fetch_ms,
            seed_ms,
            bpm_ms,
            total_ms,
        },
    );
}

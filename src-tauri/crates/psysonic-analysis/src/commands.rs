//! Tauri commands that read/write the analysis cache and steer the backfill
//! queue. Thin wrappers around `analysis_cache::*` and `analysis_runtime::*`
//! plus the playback-query port (for "is this track currently playing? /
//! is a ranged playback already going to seed it?").

use std::collections::HashSet;

use crate::analysis_cache;
use crate::analysis_runtime::{
    analysis_backfill_queue_stats, analysis_pipeline_queue_stats,
    clear_analysis_backfill_failure_state, enqueue_seed_from_url, prune_analysis_queues,
    AnalysisBackfillPriority, EnqueueSeedFromUrlOutcome, PlaybackPriorityHints,
};

mod cache_payloads;

pub use cache_payloads::{
    get_loudness_payload_for_track, get_waveform_payload, get_waveform_payload_for_track,
    LoudnessCachePayload, WaveformCachePayload,
};

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisDeleteServerReportDto {
    pub analysis_tracks: u64,
    pub waveforms: u64,
    pub loudness: u64,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisFailedTrackDto {
    pub track_id: String,
    pub md5_16kb: String,
    pub updated_at: i64,
}

impl From<analysis_cache::AnalysisDeleteServerReport> for AnalysisDeleteServerReportDto {
    fn from(value: analysis_cache::AnalysisDeleteServerReport) -> Self {
        Self {
            analysis_tracks: value.analysis_tracks,
            waveforms: value.waveforms,
            loudness: value.loudness,
        }
    }
}

impl From<analysis_cache::FailedTrackEntry> for AnalysisFailedTrackDto {
    fn from(value: analysis_cache::FailedTrackEntry) -> Self {
        Self {
            track_id: value.track_id,
            md5_16kb: value.md5_16kb,
            updated_at: value.updated_at,
        }
    }
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisServerKeyMigrationDto {
    pub legacy_id: String,
    pub index_key: String,
}

#[tauri::command]
#[specta::specta]
pub fn analysis_get_waveform(
    track_id: String,
    md5_16kb: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let server_id = server_id.unwrap_or_default();
    let result = get_waveform_payload(cache.inner(), &server_id, &track_id, &md5_16kb);
    if let Ok(ref payload) = result {
        match payload {
            Some(v) => crate::app_deprintln!(
                "[analysis][waveform] db hit (exact key) track_id={} md5_16kb={} bins_len={} bin_count={} updated_at={}",
                track_id, md5_16kb, v.bins.len(), v.bin_count, v.updated_at
            ),
            None => crate::app_deprintln!(
                "[analysis][waveform] db miss (exact key) track_id={} md5_16kb={}",
                track_id, md5_16kb
            ),
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub fn analysis_get_waveform_for_track(
    track_id: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let server_id = server_id.unwrap_or_default();
    let result = get_waveform_payload_for_track(cache.inner(), &server_id, &track_id);
    if let Ok(ref payload) = result {
        match payload {
            Some(v) => {
                crate::app_deprintln!(
                "[analysis][waveform] db hit track_id={} bins_len={} bin_count={} updated_at={}",
                track_id, v.bins.len(), v.bin_count, v.updated_at
            )
            }
            None => crate::app_deprintln!("[analysis][waveform] db miss track_id={}", track_id),
        }
    }
    result
}

#[tauri::command]
#[specta::specta]
pub fn analysis_get_loudness_for_track(
    track_id: String,
    target_lufs: Option<f64>,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<LoudnessCachePayload>, String> {
    let server_id = server_id.unwrap_or_default();
    get_loudness_payload_for_track(cache.inner(), &server_id, &track_id, target_lufs)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_delete_loudness_for_track(
    track_id: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_loudness_for_track_id(&server_id.unwrap_or_default(), &track_id)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_delete_waveform_for_track(
    track_id: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_waveform_for_track_id(&server_id.unwrap_or_default(), &track_id)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_delete_all_waveforms(
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_all_waveforms()
}

#[tauri::command]
#[specta::specta]
pub fn analysis_delete_all_for_server(
    server_id: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<AnalysisDeleteServerReportDto, String> {
    if server_id.trim().is_empty() {
        return Err("server_id required".to_string());
    }
    let report = cache.delete_all_for_server(&server_id)?;
    Ok(report.into())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_get_failed_track_count(
    server_id: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<i64, String> {
    let server_id = server_id.trim().to_string();
    if server_id.is_empty() {
        return Ok(0);
    }
    cache.count_failed_tracks(&server_id)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_list_failed_tracks(
    server_id: String,
    limit: Option<u32>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Vec<AnalysisFailedTrackDto>, String> {
    let server_id = server_id.trim().to_string();
    if server_id.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit
        .map(|v| usize::try_from(v).unwrap_or(usize::MAX))
        .map(|v| v.clamp(1, 5_000));
    let rows = cache.list_failed_tracks(&server_id, limit)?;
    Ok(rows.into_iter().map(AnalysisFailedTrackDto::from).collect())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_clear_failed_tracks(
    server_id: String,
    track_ids: Option<Vec<String>>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    let server_id = server_id.trim().to_string();
    if server_id.is_empty() {
        return Err("server_id required".to_string());
    }
    let track_ids = track_ids
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let cleared = cache.clear_failed_tracks(&server_id, &track_ids)?;
    clear_analysis_backfill_failure_state(&server_id, &track_ids);
    Ok(cleared)
}

#[tauri::command]
#[specta::specta]
pub fn analysis_migrate_server_index_keys(
    mappings: Vec<AnalysisServerKeyMigrationDto>,
    _cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<(), String> {
    for mapping in mappings {
        let _ = (mapping.legacy_id, mapping.index_key);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_enqueue_seed_from_url(
    track_id: String,
    url: String,
    force: Option<bool>,
    server_id: Option<String>,
    priority: Option<String>,
    app: tauri::AppHandle,
) -> Result<EnqueueSeedFromUrlOutcome, String> {
    let explicit = AnalysisBackfillPriority::from_optional_str(priority.as_deref());
    enqueue_seed_from_url(
        &app,
        &track_id,
        &url,
        server_id.as_deref(),
        explicit,
        force.unwrap_or(false),
    )
}

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPriorityHintDto {
    pub server_id: String,
    pub track_id: String,
}

#[tauri::command]
#[specta::specta]
pub fn analysis_set_playback_priority_hints(
    middle_track_refs: Vec<AnalysisPriorityHintDto>,
    hints: tauri::State<'_, PlaybackPriorityHints>,
) -> Result<(), String> {
    let pairs = middle_track_refs
        .into_iter()
        .map(|r| (r.server_id, r.track_id));
    hints.set_middle_track_ids(pairs);
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisBackfillQueueStatsDto {
    pub queued: usize,
    pub in_progress_count: usize,
    pub in_progress_track_id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn analysis_set_pipeline_parallelism(workers: u32) -> Result<(), String> {
    crate::analysis_runtime::analysis_set_pipeline_parallelism(workers as usize);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_get_pipeline_queue_stats(
) -> Result<crate::analysis_runtime::AnalysisPipelineQueueStatsDto, String> {
    Ok(analysis_pipeline_queue_stats())
}

#[tauri::command]
#[specta::specta]
pub fn analysis_get_backfill_queue_stats() -> Result<AnalysisBackfillQueueStatsDto, String> {
    let (queued, in_progress_count, in_progress_track_id) = analysis_backfill_queue_stats();
    Ok(AnalysisBackfillQueueStatsDto {
        queued,
        in_progress_count,
        in_progress_track_id,
    })
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPrunePendingResult {
    pub keep_count: usize,
    pub http_removed: usize,
    pub cpu_removed_jobs: usize,
    pub cpu_removed_waiters: usize,
}

/// Prunes pending analysis work for tracks no longer present in the playback queue.
///
/// Keeps currently-running jobs untouched; only queued (not-yet-started) jobs are removed.
#[tauri::command]
#[specta::specta]
pub fn analysis_prune_pending_to_track_ids(
    track_ids: Vec<String>,
    server_id: String,
) -> Result<AnalysisPrunePendingResult, String> {
    let mut normalized: Vec<String> = Vec::with_capacity(track_ids.len());
    let mut seen = HashSet::new();
    for raw in track_ids {
        let tid = raw.trim();
        if tid.is_empty() {
            continue;
        }
        if seen.insert(tid.to_string()) {
            normalized.push(tid.to_string());
        }
    }
    let keep_track_ids: HashSet<&str> = normalized.iter().map(|s| s.as_str()).collect();

    let server_id = server_id.trim().to_string();
    let server_filter = if server_id.is_empty() {
        None
    } else {
        Some(server_id.as_str())
    };
    let (http_removed, cpu_removed_jobs, cpu_removed_waiters) =
        prune_analysis_queues(&keep_track_ids, server_filter)?;

    if http_removed > 0 || cpu_removed_jobs > 0 {
        crate::app_deprintln!(
            "[analysis] pruned pending queues keep={} removed_http={} removed_cpu_jobs={} removed_cpu_waiters={}",
            keep_track_ids.len(),
            http_removed,
            cpu_removed_jobs,
            cpu_removed_waiters
        );
    }

    Ok(AnalysisPrunePendingResult {
        keep_count: keep_track_ids.len(),
        http_removed,
        cpu_removed_jobs,
        cpu_removed_waiters,
    })
}

#[cfg(test)]
mod tests;

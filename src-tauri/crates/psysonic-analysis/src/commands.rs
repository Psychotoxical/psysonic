//! Tauri commands that read/write the analysis cache and steer the backfill
//! queue. Thin wrappers around `analysis_cache::*` and `analysis_runtime::*`
//! plus the playback-query port (for "is this track currently playing? /
//! is a ranged playback already going to seed it?").

use std::collections::HashSet;

use tauri::Manager;

use psysonic_core::ports::PlaybackQueryHandle;

use crate::analysis_cache;
use crate::analysis_runtime::{
    analysis_backfill_queue_stats, analysis_backfill_resolve_priority, analysis_backfill_shared,
    analysis_pipeline_queue_stats, prune_analysis_queues, track_analysis_needs_work,
    AnalysisBackfillEnqueueKind,
    AnalysisBackfillPriority, PlaybackPriorityHints,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformCachePayload {
    pub bins: Vec<u8>,
    pub bin_count: i64,
    pub is_partial: bool,
    pub known_until_sec: f64,
    pub duration_sec: f64,
    pub updated_at: i64,
}

impl From<analysis_cache::WaveformEntry> for WaveformCachePayload {
    fn from(v: analysis_cache::WaveformEntry) -> Self {
        Self {
            bins: v.bins,
            bin_count: v.bin_count,
            is_partial: v.is_partial,
            known_until_sec: v.known_until_sec,
            duration_sec: v.duration_sec,
            updated_at: v.updated_at,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessCachePayload {
    pub integrated_lufs: f64,
    pub true_peak: f64,
    pub recommended_gain_db: f64,
    pub target_lufs: f64,
    pub updated_at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisDeleteServerReportDto {
    pub analysis_tracks: u64,
    pub waveforms: u64,
    pub loudness: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisServerKeyMigrationDto {
    pub legacy_id: String,
    pub index_key: String,
}

/// AppHandle-free helper: looks up a waveform by exact `(server_id, track_id,
/// md5_16kb)` key. Converts the `WaveformEntry` into the JSON-serialisable
/// `WaveformCachePayload`. Pulled out of [`analysis_get_waveform`] so it can be
/// tested with `AnalysisCache::open_in_memory()` and direct upserts.
pub fn get_waveform_payload(
    cache: &analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
    md5_16kb: &str,
) -> Result<Option<WaveformCachePayload>, String> {
    let exact = analysis_cache::TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: md5_16kb.to_string(),
    };
    Ok(cache
        .get_waveform(&exact)?
        .map(WaveformCachePayload::from))
}

/// AppHandle-free helper: looks up the latest waveform for `(server_id, track_id)`
/// across all id variants (bare ↔ `stream:` prefix). See [`get_waveform_payload`].
pub fn get_waveform_payload_for_track(
    cache: &analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
) -> Result<Option<WaveformCachePayload>, String> {
    Ok(cache
        .get_latest_waveform_for_track(server_id, track_id)?
        .map(WaveformCachePayload::from))
}

/// AppHandle-free helper: looks up the latest loudness row for `(server_id,
/// track_id)` and recomputes `recommended_gain_db`
/// against the optional requested target (clamped to [-30, -8]). When
/// `target_lufs` is `None`, the cached row's own target is used.
pub fn get_loudness_payload_for_track(
    cache: &analysis_cache::AnalysisCache,
    server_id: &str,
    track_id: &str,
    target_lufs: Option<f64>,
) -> Result<Option<LoudnessCachePayload>, String> {
    Ok(cache.get_latest_loudness_for_track(server_id, track_id)?.map(|v| {
        let requested_target = target_lufs.unwrap_or(v.target_lufs).clamp(-30.0, -8.0);
        let recommended_gain_db = analysis_cache::recommended_gain_for_target(
            v.integrated_lufs,
            v.true_peak,
            requested_target,
        );
        LoudnessCachePayload {
            integrated_lufs: v.integrated_lufs,
            true_peak: v.true_peak,
            recommended_gain_db,
            target_lufs: requested_target,
            updated_at: v.updated_at,
        }
    }))
}

#[tauri::command]
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
pub fn analysis_get_waveform_for_track(
    track_id: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let server_id = server_id.unwrap_or_default();
    let result = get_waveform_payload_for_track(cache.inner(), &server_id, &track_id);
    if let Ok(ref payload) = result {
        match payload {
            Some(v) => crate::app_deprintln!(
                "[analysis][waveform] db hit track_id={} bins_len={} bin_count={} updated_at={}",
                track_id, v.bins.len(), v.bin_count, v.updated_at
            ),
            None => crate::app_deprintln!("[analysis][waveform] db miss track_id={}", track_id),
        }
    }
    result
}

#[tauri::command]
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
pub fn analysis_delete_loudness_for_track(
    track_id: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_loudness_for_track_id(&server_id.unwrap_or_default(), &track_id)
}

#[tauri::command]
pub fn analysis_delete_waveform_for_track(
    track_id: String,
    server_id: Option<String>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_waveform_for_track_id(&server_id.unwrap_or_default(), &track_id)
}

#[tauri::command]
pub fn analysis_delete_all_waveforms(
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_all_waveforms()
}

#[tauri::command]
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
    cache.clear_failed_tracks(&server_id, &track_ids)
}

#[tauri::command]
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
pub fn analysis_enqueue_seed_from_url(
    track_id: String,
    url: String,
    force: Option<bool>,
    server_id: Option<String>,
    priority: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if track_id.trim().is_empty() || url.trim().is_empty() {
        return Ok(());
    }
    let server_id = if let Ok(parsed) = reqwest::Url::parse(&url) {
        if parsed.scheme() == "http" || parsed.scheme() == "https" {
            let host = parsed.host_str().unwrap_or_default();
            let mut base_path = parsed.path().to_string();
            if let Some(idx) = base_path.find("/rest") {
                base_path.truncate(idx);
            }
            while base_path.ends_with('/') {
                base_path.pop();
            }
            if host.is_empty() {
                server_id.unwrap_or_default()
            } else {
                let mut base = host.to_string();
                if let Some(port) = parsed.port() {
                    base.push_str(&format!(":{port}"));
                }
                if !base_path.is_empty() {
                    base.push_str(&base_path);
                }
                base
            }
        } else {
            server_id.unwrap_or_default()
        }
    } else {
        server_id.unwrap_or_default()
    };
    let force = force.unwrap_or(false);
    if !force {
        if let Some(playback) = app.try_state::<PlaybackQueryHandle>() {
            if playback.ranged_loudness_backfill_should_defer(&track_id) {
                crate::app_deprintln!(
                    "[analysis] backfill skip track_id={} reason=ranged_playback_will_seed",
                    track_id
                );
                return Ok(());
            }
        }
    }
    if !force {
        if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
            if cache.cpu_seed_redundant_for_track(&server_id, &track_id)? {
                if server_id.is_empty() {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (no server scope): {}",
                        track_id
                    );
                    return Ok(());
                }
                if !track_analysis_needs_work(&app, &server_id, &track_id)? {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (analysis complete): {}",
                        track_id
                    );
                    return Ok(());
                }
                crate::app_deprintln!(
                    "[analysis] backfill enqueue (analysis pending) track_id={}",
                    track_id
                );
            }
        }
    }
    let tid_log = track_id.clone();
    let explicit = AnalysisBackfillPriority::from_optional_str(priority.as_deref());
    let resolved =
        analysis_backfill_resolve_priority(&app, &server_id, &track_id, explicit);
    let shared = analysis_backfill_shared(&app);
    let kind = {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.enqueue(server_id, track_id, url, resolved)
    };
    match kind {
        AnalysisBackfillEnqueueKind::NewLow
        | AnalysisBackfillEnqueueKind::NewMiddle
        | AnalysisBackfillEnqueueKind::NewHigh => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill enqueued: track_id={} priority={resolved:?}",
                tid_log,
            );
        }
        AnalysisBackfillEnqueueKind::ReorderedHigher => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill bumped tier track_id={} priority={resolved:?}",
                tid_log,
            );
        }
        AnalysisBackfillEnqueueKind::DuplicateSkipped | AnalysisBackfillEnqueueKind::RunningSkipped => {}
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisPriorityHintDto {
    pub server_id: String,
    pub track_id: String,
}

#[tauri::command]
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisBackfillQueueStatsDto {
    pub queued: usize,
    pub in_progress_count: usize,
    pub in_progress_track_id: Option<String>,
}

#[tauri::command]
pub fn analysis_set_pipeline_parallelism(workers: u32) -> Result<(), String> {
    crate::analysis_runtime::analysis_set_pipeline_parallelism(workers as usize);
    Ok(())
}

#[tauri::command]
pub fn analysis_get_pipeline_queue_stats() -> Result<crate::analysis_runtime::AnalysisPipelineQueueStatsDto, String> {
    Ok(analysis_pipeline_queue_stats())
}

#[tauri::command]
pub fn analysis_get_backfill_queue_stats() -> Result<AnalysisBackfillQueueStatsDto, String> {
    let (queued, in_progress_count, in_progress_track_id) =
        analysis_backfill_queue_stats();
    Ok(AnalysisBackfillQueueStatsDto {
        queued,
        in_progress_count,
        in_progress_track_id,
    })
}

#[derive(Debug, Clone, serde::Serialize)]
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
    let server_filter = if server_id.is_empty() { None } else { Some(server_id.as_str()) };
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
mod tests {
    use super::*;
    use crate::analysis_cache::{
        AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry,
    };

    fn key(track_id: &str, md5: &str) -> TrackKey {
        TrackKey {
            server_id: "server-a".to_string(),
            track_id: track_id.to_string(),
            md5_16kb: md5.to_string(),
        }
    }

    fn upsert_waveform(cache: &AnalysisCache, track_id: &str, md5: &str, bins: Vec<u8>) {
        let k = key(track_id, md5);
        cache.touch_track_status(&k, "ready").unwrap();
        cache
            .upsert_waveform(
                &k,
                &WaveformEntry {
                    bin_count: (bins.len() / 2) as i64,
                    bins,
                    is_partial: false,
                    known_until_sec: 0.0,
                    duration_sec: 60.0,
                    updated_at: 1_700_000_000,
                },
            )
            .unwrap();
    }

    fn upsert_loudness(cache: &AnalysisCache, track_id: &str, md5: &str, target_lufs: f64) {
        let k = key(track_id, md5);
        cache.touch_track_status(&k, "ready").unwrap();
        cache
            .upsert_loudness(
                &k,
                &LoudnessEntry {
                    integrated_lufs: -14.0,
                    true_peak: 0.5,
                    recommended_gain_db: 0.0,
                    target_lufs,
                    updated_at: 1_700_000_000,
                },
            )
            .unwrap();
    }

    // ── get_waveform_payload ──────────────────────────────────────────────────

    #[test]
    fn get_waveform_payload_returns_none_for_unknown_key() {
        let cache = AnalysisCache::open_in_memory();
        let payload = get_waveform_payload(&cache, "server-a", "missing", "deadbeef").unwrap();
        assert!(payload.is_none());
    }

    #[test]
    fn get_waveform_payload_returns_payload_for_existing_row() {
        let cache = AnalysisCache::open_in_memory();
        let bins: Vec<u8> = (0..8u8).collect();
        upsert_waveform(&cache, "abc", "deadbeef", bins.clone());
        let payload = get_waveform_payload(&cache, "server-a", "abc", "deadbeef")
            .unwrap()
            .expect("payload exists");
        assert_eq!(payload.bins, bins);
        assert_eq!(payload.bin_count, 4);
        assert!(!payload.is_partial);
        assert_eq!(payload.duration_sec, 60.0);
        assert_eq!(payload.updated_at, 1_700_000_000);
    }

    #[test]
    fn get_waveform_payload_distinguishes_md5_keys() {
        // Same track_id, different md5_16kb → independent rows.
        let cache = AnalysisCache::open_in_memory();
        upsert_waveform(&cache, "abc", "aaaa", vec![0u8; 8]);
        upsert_waveform(&cache, "abc", "bbbb", vec![0xFFu8; 8]);
        let p1 = get_waveform_payload(&cache, "server-a", "abc", "aaaa").unwrap().unwrap();
        let p2 = get_waveform_payload(&cache, "server-a", "abc", "bbbb").unwrap().unwrap();
        assert_ne!(p1.bins, p2.bins);
    }

    // ── get_waveform_payload_for_track ────────────────────────────────────────

    #[test]
    fn get_waveform_for_track_finds_row_under_stream_prefix() {
        // Insert under `stream:abc`, look up with bare `abc` — id-variant
        // matching is the whole point of get_latest_waveform_for_track.
        let cache = AnalysisCache::open_in_memory();
        upsert_waveform(&cache, "stream:abc", "deadbeef", vec![1u8; 8]);
        let payload = get_waveform_payload_for_track(&cache, "server-a", "abc")
            .unwrap()
            .expect("bare-id lookup must hit the stream-prefixed row");
        assert_eq!(payload.bin_count, 4);
    }

    #[test]
    fn get_waveform_for_track_returns_none_for_unknown_track() {
        let cache = AnalysisCache::open_in_memory();
        assert!(get_waveform_payload_for_track(&cache, "server-a", "phantom").unwrap().is_none());
    }

    // ── get_loudness_payload_for_track ────────────────────────────────────────

    #[test]
    fn get_loudness_for_track_recomputes_gain_against_requested_target() {
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness(&cache, "abc", "deadbeef", -14.0);
        // Cached row: integrated -14, target -14 → gain 0. Request target -10 →
        // recommended gain = -10 - (-14) = +4 dB (capped by true-peak guard).
        let payload = get_loudness_payload_for_track(&cache, "server-a", "abc", Some(-10.0))
            .unwrap()
            .expect("loudness row exists");
        assert_eq!(payload.target_lufs, -10.0);
        assert!(
            payload.recommended_gain_db.is_finite() && payload.recommended_gain_db <= 4.0,
            "recommended_gain_db must reflect the new target, got {}",
            payload.recommended_gain_db
        );
    }

    #[test]
    fn get_loudness_for_track_uses_cached_target_when_request_is_none() {
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness(&cache, "abc", "deadbeef", -16.0);
        let payload = get_loudness_payload_for_track(&cache, "server-a", "abc", None)
            .unwrap()
            .unwrap();
        assert_eq!(payload.target_lufs, -16.0);
    }

    #[test]
    fn get_loudness_for_track_clamps_target_into_supported_range() {
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness(&cache, "abc", "deadbeef", -14.0);
        // Out-of-range target gets clamped to [-30, -8].
        let too_high = get_loudness_payload_for_track(&cache, "server-a", "abc", Some(0.0))
            .unwrap()
            .unwrap();
        assert_eq!(too_high.target_lufs, -8.0);
        let too_low = get_loudness_payload_for_track(&cache, "server-a", "abc", Some(-100.0))
            .unwrap()
            .unwrap();
        assert_eq!(too_low.target_lufs, -30.0);
    }

    #[test]
    fn get_loudness_for_track_returns_none_for_unknown_track() {
        let cache = AnalysisCache::open_in_memory();
        assert!(get_loudness_payload_for_track(&cache, "server-a", "phantom", None)
            .unwrap()
            .is_none());
    }

    // ── WaveformCachePayload::from(WaveformEntry) ─────────────────────────────

    #[test]
    fn waveform_payload_from_entry_preserves_all_fields() {
        let entry = WaveformEntry {
            bins: vec![1, 2, 3, 4],
            bin_count: 2,
            is_partial: true,
            known_until_sec: 5.5,
            duration_sec: 10.0,
            updated_at: 42,
        };
        let payload = WaveformCachePayload::from(entry);
        assert_eq!(payload.bins, vec![1, 2, 3, 4]);
        assert_eq!(payload.bin_count, 2);
        assert!(payload.is_partial);
        assert_eq!(payload.known_until_sec, 5.5);
        assert_eq!(payload.duration_sec, 10.0);
        assert_eq!(payload.updated_at, 42);
    }
}

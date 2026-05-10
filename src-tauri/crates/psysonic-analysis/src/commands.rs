//! Tauri commands that read/write the analysis cache and steer the backfill
//! queue. Thin wrappers around `analysis_cache::*` and `analysis_runtime::*`
//! plus the playback-query port (for "is this track currently playing? /
//! is a ranged playback already going to seed it?").

use std::collections::HashSet;

use tauri::Manager;

use psysonic_core::ports::PlaybackQueryHandle;

use crate::analysis_cache;
use crate::analysis_runtime::{
    analysis_backfill_is_current_track, analysis_backfill_shared, prune_analysis_queues,
    AnalysisBackfillEnqueueKind,
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

/// AppHandle-free helper: looks up a waveform by exact `(track_id, md5_16kb)`
/// key and converts the `WaveformEntry` into the JSON-serialisable
/// `WaveformCachePayload`. Pulled out of [`analysis_get_waveform`] so it can
/// be tested with `AnalysisCache::open_in_memory()` and direct upserts.
pub fn get_waveform_payload(
    cache: &analysis_cache::AnalysisCache,
    track_id: &str,
    md5_16kb: &str,
) -> Result<Option<WaveformCachePayload>, String> {
    let key = analysis_cache::TrackKey {
        track_id: track_id.to_string(),
        md5_16kb: md5_16kb.to_string(),
    };
    Ok(cache.get_waveform(&key)?.map(WaveformCachePayload::from))
}

/// AppHandle-free helper: looks up the latest waveform for `track_id`
/// across all id variants (bare ↔ `stream:` prefix). See [`get_waveform_payload`].
pub fn get_waveform_payload_for_track(
    cache: &analysis_cache::AnalysisCache,
    track_id: &str,
) -> Result<Option<WaveformCachePayload>, String> {
    Ok(cache
        .get_latest_waveform_for_track(track_id)?
        .map(WaveformCachePayload::from))
}

/// AppHandle-free helper: looks up the latest loudness row for `track_id`
/// and recomputes `recommended_gain_db` against the optional requested target
/// (clamped to [-30, -8]). When `target_lufs` is `None`, the cached row's own
/// target is used.
pub fn get_loudness_payload_for_track(
    cache: &analysis_cache::AnalysisCache,
    track_id: &str,
    target_lufs: Option<f64>,
) -> Result<Option<LoudnessCachePayload>, String> {
    Ok(cache.get_latest_loudness_for_track(track_id)?.map(|v| {
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
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let result = get_waveform_payload(cache.inner(), &track_id, &md5_16kb);
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
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let result = get_waveform_payload_for_track(cache.inner(), &track_id);
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
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<LoudnessCachePayload>, String> {
    get_loudness_payload_for_track(cache.inner(), &track_id, target_lufs)
}

#[tauri::command]
pub fn analysis_delete_loudness_for_track(
    track_id: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_loudness_for_track_id(&track_id)
}

#[tauri::command]
pub fn analysis_delete_waveform_for_track(
    track_id: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_waveform_for_track_id(&track_id)
}

#[tauri::command]
pub fn analysis_delete_all_waveforms(
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_all_waveforms()
}

#[tauri::command]
pub fn analysis_enqueue_seed_from_url(
    track_id: String,
    url: String,
    force: Option<bool>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    if track_id.trim().is_empty() || url.trim().is_empty() {
        return Ok(());
    }
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
            if cache.get_latest_loudness_for_track(&track_id)?.is_some() {
                crate::app_deprintln!(
                    "[analysis] backfill skip (already cached): {}",
                    track_id
                );
                return Ok(());
            }
        }
    }
    let tid_log = track_id.clone();
    let high_priority = analysis_backfill_is_current_track(&app, &track_id);
    let shared = analysis_backfill_shared(&app);
    let kind = {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.enqueue(track_id, url, high_priority)
    };
    match kind {
        AnalysisBackfillEnqueueKind::NewBack | AnalysisBackfillEnqueueKind::NewFront => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill enqueued: track_id={} position={}",
                tid_log,
                if high_priority { "front" } else { "back" }
            );
        }
        AnalysisBackfillEnqueueKind::ReorderedFront => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill bumped to front (current track) track_id={}",
                tid_log
            );
        }
        AnalysisBackfillEnqueueKind::DuplicateSkipped | AnalysisBackfillEnqueueKind::RunningSkipped => {}
    }
    Ok(())
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

    let (http_removed, cpu_removed_jobs, cpu_removed_waiters) =
        prune_analysis_queues(&keep_track_ids)?;

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
        let payload = get_waveform_payload(&cache, "missing", "deadbeef").unwrap();
        assert!(payload.is_none());
    }

    #[test]
    fn get_waveform_payload_returns_payload_for_existing_row() {
        let cache = AnalysisCache::open_in_memory();
        let bins: Vec<u8> = (0..8u8).collect();
        upsert_waveform(&cache, "abc", "deadbeef", bins.clone());
        let payload = get_waveform_payload(&cache, "abc", "deadbeef")
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
        let p1 = get_waveform_payload(&cache, "abc", "aaaa").unwrap().unwrap();
        let p2 = get_waveform_payload(&cache, "abc", "bbbb").unwrap().unwrap();
        assert_ne!(p1.bins, p2.bins);
    }

    // ── get_waveform_payload_for_track ────────────────────────────────────────

    #[test]
    fn get_waveform_for_track_finds_row_under_stream_prefix() {
        // Insert under `stream:abc`, look up with bare `abc` — id-variant
        // matching is the whole point of get_latest_waveform_for_track.
        let cache = AnalysisCache::open_in_memory();
        upsert_waveform(&cache, "stream:abc", "deadbeef", vec![1u8; 8]);
        let payload = get_waveform_payload_for_track(&cache, "abc")
            .unwrap()
            .expect("bare-id lookup must hit the stream-prefixed row");
        assert_eq!(payload.bin_count, 4);
    }

    #[test]
    fn get_waveform_for_track_returns_none_for_unknown_track() {
        let cache = AnalysisCache::open_in_memory();
        assert!(get_waveform_payload_for_track(&cache, "phantom").unwrap().is_none());
    }

    // ── get_loudness_payload_for_track ────────────────────────────────────────

    #[test]
    fn get_loudness_for_track_recomputes_gain_against_requested_target() {
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness(&cache, "abc", "deadbeef", -14.0);
        // Cached row: integrated -14, target -14 → gain 0. Request target -10 →
        // recommended gain = -10 - (-14) = +4 dB (capped by true-peak guard).
        let payload = get_loudness_payload_for_track(&cache, "abc", Some(-10.0))
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
        let payload = get_loudness_payload_for_track(&cache, "abc", None)
            .unwrap()
            .unwrap();
        assert_eq!(payload.target_lufs, -16.0);
    }

    #[test]
    fn get_loudness_for_track_clamps_target_into_supported_range() {
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness(&cache, "abc", "deadbeef", -14.0);
        // Out-of-range target gets clamped to [-30, -8].
        let too_high = get_loudness_payload_for_track(&cache, "abc", Some(0.0))
            .unwrap()
            .unwrap();
        assert_eq!(too_high.target_lufs, -8.0);
        let too_low = get_loudness_payload_for_track(&cache, "abc", Some(-100.0))
            .unwrap()
            .unwrap();
        assert_eq!(too_low.target_lufs, -30.0);
    }

    #[test]
    fn get_loudness_for_track_returns_none_for_unknown_track() {
        let cache = AnalysisCache::open_in_memory();
        assert!(get_loudness_payload_for_track(&cache, "phantom", None)
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

use super::*;

#[tauri::command]
pub(crate) fn analysis_get_waveform(
    track_id: String,
    md5_16kb: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let key = analysis_cache::TrackKey {
        track_id: track_id.clone(),
        md5_16kb: md5_16kb.clone(),
    };
    let row = cache.get_waveform(&key)?;
    match &row {
        Some(v) => {
            crate::app_deprintln!(
                "[analysis][waveform] db hit (exact key) track_id={} md5_16kb={} bins_len={} bin_count={} updated_at={}",
                track_id,
                md5_16kb,
                v.bins.len(),
                v.bin_count,
                v.updated_at
            );
        }
        None => {
            crate::app_deprintln!(
                "[analysis][waveform] db miss (exact key) track_id={} md5_16kb={}",
                track_id,
                md5_16kb
            );
        }
    }
    Ok(row.map(|v| WaveformCachePayload {
        bins: v.bins,
        bin_count: v.bin_count,
        is_partial: v.is_partial,
        known_until_sec: v.known_until_sec,
        duration_sec: v.duration_sec,
        updated_at: v.updated_at,
    }))
}

#[tauri::command]
pub(crate) fn analysis_get_waveform_for_track(
    track_id: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<WaveformCachePayload>, String> {
    let row = cache.get_latest_waveform_for_track(&track_id)?;
    match &row {
        Some(v) => {
            crate::app_deprintln!(
                "[analysis][waveform] db hit track_id={} bins_len={} bin_count={} updated_at={}",
                track_id,
                v.bins.len(),
                v.bin_count,
                v.updated_at
            );
        }
        None => {
            crate::app_deprintln!(
                "[analysis][waveform] db miss track_id={}",
                track_id
            );
        }
    }
    Ok(row.map(|v| WaveformCachePayload {
        bins: v.bins,
        bin_count: v.bin_count,
        is_partial: v.is_partial,
        known_until_sec: v.known_until_sec,
        duration_sec: v.duration_sec,
        updated_at: v.updated_at,
    }))
}

#[tauri::command]
pub(crate) fn analysis_get_loudness_for_track(
    track_id: String,
    target_lufs: Option<f64>,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<Option<LoudnessCachePayload>, String> {
    let row = cache.get_latest_loudness_for_track(&track_id)?;
    Ok(row.map(|v| {
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
    }}))
}

#[tauri::command]
pub(crate) fn analysis_delete_loudness_for_track(
    track_id: String,
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_loudness_for_track_id(&track_id)
}

#[tauri::command]
pub(crate) fn analysis_delete_all_waveforms(
    cache: tauri::State<'_, analysis_cache::AnalysisCache>,
) -> Result<u64, String> {
    cache.delete_all_waveforms()
}

#[tauri::command]
pub(crate) fn analysis_enqueue_seed_from_url(
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
        if let Some(engine) = app.try_state::<crate::audio::AudioEngine>() {
            if crate::audio::ranged_loudness_backfill_should_defer(&engine, &track_id) {
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

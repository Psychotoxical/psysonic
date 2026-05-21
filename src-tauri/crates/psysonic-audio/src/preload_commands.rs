//! Background audio_preload: fetch the next track's bytes ahead of time
//! and seed the analysis cache. Distinct from `audio_chain_preload`
//! (which constructs the gapless source chain) and `audio_play` (which
//! starts playback). All three live in this audio submodule.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use super::engine::{audio_http_client, AudioEngine};
use super::helpers::{analysis_cache_track_id, same_playback_target};
use super::state::PreloadedTrack;

#[tauri::command]
pub async fn audio_preload(
    url: String,
    duration_hint: f64,
    analysis_track_id: Option<String>,
    server_id: Option<String>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    {
        let preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, &url)) {
            let _ = app.emit("audio:preload-ready", url.clone());
            return Ok(());
        }
    }
    // Throttle: wait 8 s before starting the background download so it does not
    // compete with the decode + sink-feed work of the just-started current track.
    // If the user skips during the wait the generation counter changes and we abort.
    let gen_snapshot = state.generation.load(Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(8)).await;
    if state.generation.load(Ordering::Relaxed) != gen_snapshot {
        return Ok(());
    }
    let data: Vec<u8> = if let Some(path) = url.strip_prefix("psysonic-local://") {
        tokio::fs::read(path).await.map_err(|e| e.to_string())?
    } else {
        let response = audio_http_client(&state).get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Ok(());
        }
        response.bytes().await.map_err(|e| e.to_string())?.into()
    };
    let _ = duration_hint; // kept in API for compatibility
    let logical_trim = analysis_track_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(track_id) = analysis_cache_track_id(logical_trim.as_deref(), &url) {
        crate::app_deprintln!(
            "[stream] audio_preload: bytes ready track_id={} size_mib={:.2} — invoking full-track analysis",
            track_id,
            data.len() as f64 / (1024.0 * 1024.0)
        );
        let high = crate::engine::analysis_track_id_is_current_playback(&state, &track_id);
        let sid = server_id.clone().unwrap_or_default();
        if let Err(e) = psysonic_analysis::analysis_runtime::submit_analysis_cpu_seed(app.clone(), sid, track_id.clone(), data.clone(), high).await {
            crate::app_eprintln!("[analysis] preload seed failed for {}: {}", track_id, e);
        }
    }
    let url_for_emit = url.clone();
    *state.preloaded.lock().unwrap() = Some(PreloadedTrack { url, data });
    let _ = app.emit("audio:preload-ready", url_for_emit);
    Ok(())
}

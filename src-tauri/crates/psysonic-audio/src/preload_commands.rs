//! Background audio_preload: fetch the next track's bytes ahead of time
//! and seed the analysis cache. Distinct from `audio_chain_preload`
//! (which constructs the gapless source chain) and `audio_play` (which
//! starts playback). All three live in this audio submodule.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::analysis_dispatch::{
    dispatch_track_analysis_bytes, prepare_playback_analysis, TrackAnalysisOrigin,
};
use super::engine::{audio_http_client, AudioEngine};
use super::helpers::{analysis_cache_track_id, same_playback_target};
use super::state::PreloadedTrack;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreloadEventPayload {
    url: String,
    track_id: Option<String>,
}

async fn seed_preload_analysis(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    url: &str,
    data: &[u8],
    analysis_track_id: Option<&str>,
    server_id: Option<&str>,
) {
    if let Some(track_id) = analysis_cache_track_id(analysis_track_id, url) {
        let (sid, high) = prepare_playback_analysis(
            app,
            state,
            server_id,
            &track_id,
            // Next-track prefetch — never steal CPU from the audible track.
            Some(false),
        );
        if let Err(e) = dispatch_track_analysis_bytes(
            app,
            TrackAnalysisOrigin::PrefetchOrCacheFile,
            &sid,
            &track_id,
            data.to_vec(),
            high,
        )
        .await
        {
            crate::app_eprintln!("[analysis] preload seed failed for {track_id}: {e}");
        }
    }
}

fn emit_preload_ready(app: &AppHandle, url: String, track_id: Option<String>) {
    let _ = app.emit(
        "audio:preload-ready",
        PreloadEventPayload {
            url,
            track_id,
        },
    );
}

fn emit_preload_cancelled(app: &AppHandle, url: String, track_id: Option<String>) {
    let _ = app.emit(
        "audio:preload-cancelled",
        PreloadEventPayload {
            url,
            track_id,
        },
    );
}

#[tauri::command]
pub async fn audio_preload(
    url: String,
    duration_hint: f64,
    analysis_track_id: Option<String>,
    server_id: Option<String>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let logical_trim = analysis_track_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let track_id_for_events = logical_trim.clone();

    // RAM slot already holds this URL — still run analysis if the planner says work is needed.
    {
        let cached = {
            let preloaded = state.preloaded.lock().unwrap();
            preloaded
                .as_ref()
                .filter(|p| same_playback_target(&p.url, &url))
                .map(|p| p.data.clone())
        };
        if let Some(data) = cached {
            if !data.is_empty() {
                seed_preload_analysis(
                    &app,
                    &state,
                    &url,
                    &data,
                    logical_trim.as_deref(),
                    server_id.as_deref(),
                )
                .await;
            }
            emit_preload_ready(&app, url, track_id_for_events);
            return Ok(());
        }
    }

    let is_local = url.starts_with("psysonic-local://");
    // Local hot-cache reads are cheap — skip the HTTP throttle so enrichment can start early.
    if !is_local {
        // Throttle: wait 8 s before starting the background download so it does not
        // compete with the decode + sink-feed work of the just-started current track.
        // If the user skips during the wait the generation counter changes and we abort.
        let gen_snapshot = state.generation.load(Ordering::Relaxed);
        tokio::time::sleep(Duration::from_secs(8)).await;
        if state.generation.load(Ordering::Relaxed) != gen_snapshot {
            emit_preload_cancelled(&app, url, track_id_for_events);
            return Ok(());
        }
    }

    let data: Vec<u8> = if let Some(path) = url.strip_prefix("psysonic-local://") {
        tokio::fs::read(path).await.map_err(|e| e.to_string())?
    } else {
        let response = audio_http_client(&state).get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            emit_preload_cancelled(&app, url, track_id_for_events);
            return Ok(());
        }
        response.bytes().await.map_err(|e| e.to_string())?.into()
    };

    let _ = duration_hint; // kept in API for compatibility

    if !data.is_empty() {
        seed_preload_analysis(
            &app,
            &state,
            &url,
            &data,
            logical_trim.as_deref(),
            server_id.as_deref(),
        )
        .await;
    }

    let url_for_emit = url.clone();
    *state.preloaded.lock().unwrap() = Some(PreloadedTrack { url, data });
    emit_preload_ready(&app, url_for_emit, track_id_for_events);
    Ok(())
}

//! Background audio_preload: fetch the next track's bytes ahead of time
//! and seed the analysis cache. Distinct from `audio_chain_preload`
//! (which constructs the gapless source chain) and `audio_play` (which
//! starts playback). All three live in this audio submodule.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use super::analysis_dispatch::{
    dispatch_track_analysis_bytes, prepare_playback_analysis, spawn_track_analysis_file,
    TrackAnalysisOrigin,
};
use super::engine::AudioEngine;
use super::helpers::{analysis_cache_track_id, same_playback_target};
use super::state::PreloadedTrack;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreloadEventPayload {
    url: String,
    track_id: Option<String>,
}

async fn seed_preload_analysis_bytes(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    url: &str,
    data: &[u8],
    analysis_track_id: Option<&str>,
    server_id: Option<&str>,
) {
    let Some(track_id) = analysis_cache_track_id(analysis_track_id, url) else {
        return;
    };
    let (sid, priority) = prepare_playback_analysis(
        app,
        state,
        server_id,
        &track_id,
        Some(AnalysisBackfillPriority::Middle),
    );
    if let Err(e) = dispatch_track_analysis_bytes(
        app,
        TrackAnalysisOrigin::PrefetchOrCacheFile,
        &sid,
        &track_id,
        data.to_vec(),
        priority,
    )
    .await
    {
        crate::app_eprintln!("[analysis] preload seed failed for {track_id}: {e}");
    }
}

fn seed_preload_analysis_file(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    url: &str,
    file_path: PathBuf,
    analysis_track_id: Option<&str>,
    server_id: Option<&str>,
) {
    let Some(track_id) = analysis_cache_track_id(analysis_track_id, url) else {
        return;
    };
    let (sid, priority) = prepare_playback_analysis(
        app,
        state,
        server_id,
        &track_id,
        Some(AnalysisBackfillPriority::Middle),
    );
    crate::app_deprintln!(
        "[stream] audio_preload: local file analysis track_id={} path={}",
        track_id,
        file_path.display()
    );
    spawn_track_analysis_file(
        app.clone(),
        TrackAnalysisOrigin::LocalFilePlayback,
        sid,
        track_id,
        file_path,
        priority,
        None,
    );
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
#[specta::specta]
pub async fn audio_preload(
    url: String,
    duration_hint: f64,
    analysis_track_id: Option<String>,
    server_id: Option<String>,
    eager: Option<bool>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let logical_trim = analysis_track_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let track_id_for_events = logical_trim.clone();

    let is_local = url.starts_with("psysonic-local://");

    // Hot/offline cache: playback reads from disk — seed analysis from the file
    // (512 MiB cap) without copying into the RAM preload slot.
    if is_local {
        let path = PathBuf::from(url.strip_prefix("psysonic-local://").unwrap());
        if !path.is_file() {
            crate::app_deprintln!(
                "[stream] audio_preload: local file missing path={}",
                path.display()
            );
            emit_preload_cancelled(&app, url, track_id_for_events);
            return Ok(());
        }
        seed_preload_analysis_file(
            &app,
            &state,
            &url,
            path,
            logical_trim.as_deref(),
            server_id.as_deref(),
        );
        emit_preload_ready(&app, url, track_id_for_events);
        return Ok(());
    }

    // Remote URL — reuse in-memory bytes when a prior HTTP preload finished.
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
                seed_preload_analysis_bytes(
                    &app,
                    &state,
                    &url,
                    &data,
                    logical_trim.as_deref(),
                    server_id.as_deref(),
                )
                .await;
            }
            return Ok(());
        }
    }

    let _ = duration_hint; // kept in API for compatibility

    // Throttle: wait 8 s before starting the background download so it does not
    // compete with the decode + sink-feed work of the just-started current track.
    // Eager callers (crossfade/AutoDJ pre-buffer, fired ~30 s before the fade
    // when the current track is long-settled) skip the wait so the RAM slot
    // fills in time for the fade to fire. If the user skips during the wait the
    // generation counter changes and we abort.
    let gen_snapshot = state.generation.load(Ordering::Relaxed);
    if !eager.unwrap_or(false) {
        tokio::time::sleep(Duration::from_secs(8)).await;
        if state.generation.load(Ordering::Relaxed) != gen_snapshot {
            emit_preload_cancelled(&app, url, track_id_for_events);
            return Ok(());
        }
    }

    let response = crate::engine::playback_scoped_get(
        &state,
        &app,
        &url,
        server_id.as_deref(),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        emit_preload_cancelled(&app, url, track_id_for_events);
        return Ok(());
    }
    let data: Vec<u8> = response.bytes().await.map_err(|e| e.to_string())?.into();

    if !data.is_empty() {
        seed_preload_analysis_bytes(
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

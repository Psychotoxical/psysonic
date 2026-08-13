//! Background audio_preload: fetch the next track's bytes ahead of time
//! and seed the analysis cache. Distinct from `audio_chain_preload`
//! (which constructs the gapless source chain) and `audio_play` (which
//! starts playback). All three live in this audio submodule.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use super::analysis_dispatch::{
    prepare_playback_analysis, spawn_track_analysis_bytes, spawn_track_analysis_file,
    TrackAnalysisOrigin,
};
use super::engine::AudioEngine;
use super::helpers::{analysis_cache_track_id, same_playback_target};
use super::state::{ChainedInfo, PreloadedTrack};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreloadEventPayload {
    url: String,
    track_id: Option<String>,
}

#[derive(Clone, Copy)]
pub(crate) struct PreloadSnapshot {
    pub(crate) generation: u64,
    pub(crate) epoch: u64,
}

impl PreloadSnapshot {
    pub(crate) fn capture(state: &AudioEngine) -> Self {
        Self {
            generation: state.generation.load(Ordering::SeqCst),
            epoch: state.preload_epoch.load(Ordering::SeqCst),
        }
    }

    pub(crate) fn is_current(self, state: &AudioEngine) -> bool {
        preload_snapshot_is_current(&state.generation, &state.preload_epoch, self)
    }
}

fn preload_snapshot_is_current(
    generation: &AtomicU64,
    preload_epoch: &AtomicU64,
    snapshot: PreloadSnapshot,
) -> bool {
    generation.load(Ordering::SeqCst) == snapshot.generation
        && preload_epoch.load(Ordering::SeqCst) == snapshot.epoch
}

pub(crate) fn publish_preloaded_if_current(
    generation: &AtomicU64,
    preload_epoch: &AtomicU64,
    snapshot: PreloadSnapshot,
    preloaded: &Mutex<Option<PreloadedTrack>>,
    value: PreloadedTrack,
) -> bool {
    let mut slot = preloaded.lock().unwrap();
    if !preload_snapshot_is_current(generation, preload_epoch, snapshot) {
        return false;
    }
    *slot = Some(value);
    true
}

fn publish_fresh_preload_if_current(
    generation: &AtomicU64,
    preload_epoch: &AtomicU64,
    snapshot: PreloadSnapshot,
    preloaded: &Mutex<Option<PreloadedTrack>>,
    value: PreloadedTrack,
    emit_ready: impl FnOnce(),
    spawn_analysis: impl FnOnce(),
) -> bool {
    if !publish_preloaded_if_current(
        generation,
        preload_epoch,
        snapshot,
        preloaded,
        value,
    ) {
        return false;
    }
    emit_ready();
    spawn_analysis();
    true
}

fn seed_preload_analysis_bytes(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    url: &str,
    data: Vec<u8>,
    analysis_track_id: Option<&str>,
    server_id: Option<&str>,
    generation: u64,
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
    spawn_track_analysis_bytes(
        app.clone(),
        TrackAnalysisOrigin::PrefetchOrCacheFile,
        sid,
        track_id,
        data,
        Some(url.to_string()),
        priority,
        Some((generation, state.generation.clone())),
    );
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
        None,
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

fn invalidate_preload_state(
    preload_epoch: &AtomicU64,
    preloaded: &Mutex<Option<PreloadedTrack>>,
    chained_info: &Mutex<Option<ChainedInfo>>,
) {
    preload_epoch.fetch_add(1, Ordering::SeqCst);
    *preloaded.lock().unwrap() = None;
    if let Some(info) = chained_info.lock().unwrap().take() {
        info.cancel.store(true, Ordering::Release);
    }
}

/// Drop byte and gapless successor preloads after their URL-affecting inputs
/// change. The main playback generation and currently audible source stay live.
#[tauri::command]
#[specta::specta]
pub fn audio_invalidate_preloads(state: State<'_, AudioEngine>) {
    invalidate_preload_state(
        &state.preload_epoch,
        &state.preloaded,
        &state.chained_info,
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
    let snapshot = PreloadSnapshot::capture(&state);

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
        if !snapshot.is_current(&state) {
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
        if !snapshot.is_current(&state) {
            emit_preload_cancelled(&app, url, track_id_for_events);
            return Ok(());
        }
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
            if !snapshot.is_current(&state) {
                emit_preload_cancelled(&app, url, track_id_for_events);
                return Ok(());
            }
            if !data.is_empty() {
                seed_preload_analysis_bytes(
                    &app,
                    &state,
                    &url,
                    data,
                    logical_trim.as_deref(),
                    server_id.as_deref(),
                    snapshot.generation,
                );
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
    if !eager.unwrap_or(false) {
        tokio::time::sleep(Duration::from_secs(8)).await;
        if !snapshot.is_current(&state) {
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

    if !snapshot.is_current(&state) {
        emit_preload_cancelled(&app, url, track_id_for_events);
        return Ok(());
    }

    let analysis_data = (!data.is_empty()).then(|| data.clone());
    let ready_url = url.clone();
    let ready_track_id = track_id_for_events.clone();
    if !publish_fresh_preload_if_current(
        &state.generation,
        &state.preload_epoch,
        snapshot,
        &state.preloaded,
        PreloadedTrack {
            url: url.clone(),
            data,
        },
        || emit_preload_ready(&app, ready_url, ready_track_id),
        || {
            if let Some(data) = analysis_data {
                seed_preload_analysis_bytes(
                    &app,
                    &state,
                    &url,
                    data,
                    logical_trim.as_deref(),
                    server_id.as_deref(),
                    snapshot.generation,
                );
            }
        },
    ) {
        emit_preload_cancelled(&app, url, track_id_for_events);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn fresh_preload_emits_ready_before_analysis_callback() {
        let generation = AtomicU64::new(4);
        let preload_epoch = AtomicU64::new(2);
        let preloaded = Mutex::new(None);
        let ready_emitted = AtomicBool::new(false);
        let analysis_started = AtomicBool::new(false);

        let published = publish_fresh_preload_if_current(
            &generation,
            &preload_epoch,
            PreloadSnapshot { generation: 4, epoch: 2 },
            &preloaded,
            PreloadedTrack {
                url: "https://example.test/stream".to_string(),
                data: vec![1, 2, 3],
            },
            || {
                assert!(preloaded.lock().unwrap().is_some());
                ready_emitted.store(true, Ordering::SeqCst);
            },
            || {
                assert!(ready_emitted.load(Ordering::SeqCst));
                assert!(preloaded.lock().unwrap().is_some());
                analysis_started.store(true, Ordering::SeqCst);
            },
        );

        assert!(published);
        assert!(analysis_started.load(Ordering::SeqCst));
    }

    #[test]
    fn superseded_generation_publishes_nothing() {
        let generation = AtomicU64::new(5);
        let preload_epoch = AtomicU64::new(2);
        let preloaded = Mutex::new(None);
        let ready_emitted = AtomicBool::new(false);
        let analysis_started = AtomicBool::new(false);

        let published = publish_fresh_preload_if_current(
            &generation,
            &preload_epoch,
            PreloadSnapshot { generation: 4, epoch: 2 },
            &preloaded,
            PreloadedTrack {
                url: "https://example.test/stale".to_string(),
                data: vec![9, 9, 9],
            },
            || ready_emitted.store(true, Ordering::SeqCst),
            || analysis_started.store(true, Ordering::SeqCst),
        );

        assert!(!published);
        assert!(preloaded.lock().unwrap().is_none());
        assert!(!ready_emitted.load(Ordering::SeqCst));
        assert!(!analysis_started.load(Ordering::SeqCst));
    }

    #[test]
    fn stale_preload_epoch_publishes_nothing_without_changing_generation() {
        let generation = AtomicU64::new(4);
        let preload_epoch = AtomicU64::new(3);
        let preloaded = Mutex::new(None);

        let published = publish_preloaded_if_current(
            &generation,
            &preload_epoch,
            PreloadSnapshot { generation: 4, epoch: 2 },
            &preloaded,
            PreloadedTrack {
                url: "https://example.test/stale-epoch".to_string(),
                data: vec![1],
            },
        );

        assert!(!published);
        assert!(preloaded.lock().unwrap().is_none());
        assert_eq!(generation.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn invalidation_clears_slots_and_cancels_chain_without_bumping_playback() {
        let generation = AtomicU64::new(8);
        let preload_epoch = AtomicU64::new(3);
        let preloaded = Mutex::new(Some(PreloadedTrack {
            url: "https://example.test/preloaded".into(),
            data: vec![1, 2, 3],
        }));
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let chained = Mutex::new(Some(ChainedInfo {
            url: "https://example.test/chained".into(),
            analysis_track_id: Some("next".into()),
            server_id: Some("server".into()),
            generation: 8,
            raw_bytes: std::sync::Arc::new(vec![4, 5, 6]),
            resolved_format: None,
            output_rate: 44_100,
            output_channels: 2,
            duration_secs: 60.0,
            replay_gain_linear: 1.0,
            base_volume: 1.0,
            source_done: std::sync::Arc::new(AtomicBool::new(false)),
            cancel: cancel.clone(),
            sample_counter: std::sync::Arc::new(AtomicU64::new(0)),
        }));

        invalidate_preload_state(&preload_epoch, &preloaded, &chained);

        assert_eq!(generation.load(Ordering::SeqCst), 8);
        assert_eq!(preload_epoch.load(Ordering::SeqCst), 4);
        assert!(preloaded.lock().unwrap().is_none());
        assert!(chained.lock().unwrap().is_none());
        assert!(cancel.load(Ordering::Acquire));
    }
}

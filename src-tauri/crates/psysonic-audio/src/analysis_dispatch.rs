//! Unified playback → track analysis dispatch.
//!
//! Stream completion, hot/offline files, gapless chain, preload, and in-memory
//! replay all funnel through here before [`psysonic_analysis::analysis_runtime::enqueue_track_analysis`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use crate::engine::{analysis_track_id_is_current_playback, AudioEngine};
use crate::helpers::{analysis_cache_track_id, current_playback_server_id_str};
use url::Url;
use crate::state::ChainedInfo;
use crate::stream::{LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES, TRACK_STREAM_PROMOTE_MAX_BYTES};

/// Where playback obtained the bytes — used for logging and size caps only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrackAnalysisOrigin {
    InMemoryReplay,
    StreamDownloadComplete,
    LocalFilePlayback,
    StreamSpillFile,
    PrefetchOrCacheFile,
    GaplessChainReady,
    GaplessTransition,
}

fn max_bytes_for_origin(origin: TrackAnalysisOrigin) -> usize {
    match origin {
        TrackAnalysisOrigin::LocalFilePlayback => LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES,
        _ => TRACK_STREAM_PROMOTE_MAX_BYTES,
    }
}

/// Playback server scope: explicit IPC value, else pinned engine scope.
pub(crate) fn resolve_analysis_server_id(
    explicit: Option<&str>,
    engine: Option<&AudioEngine>,
) -> String {
    if let Some(engine) = engine {
        if let Some(url) = engine
            .current_playback_url
            .lock()
            .ok()
            .and_then(|g| (*g).clone())
        {
            if let Some(derived) = server_id_from_playback_url(&url) {
                return derived;
            }
        }
    }
    explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| engine.map(current_playback_server_id_str).unwrap_or_default())
}

fn server_id_from_playback_url(url_raw: &str) -> Option<String> {
    if url_raw.starts_with("psysonic-local://") {
        return None;
    }
    let parsed = Url::parse(url_raw).ok()?;
    let host = parsed.host_str()?;
    let mut base_path = parsed.path().to_string();
    if let Some(idx) = base_path.find("/rest") {
        base_path.truncate(idx);
    }
    while base_path.ends_with('/') {
        base_path.pop();
    }
    let mut base = host.to_string();
    if let Some(port) = parsed.port() {
        base.push_str(&format!(":{port}"));
    }
    if !base_path.is_empty() {
        base.push_str(&base_path);
    }
    Some(base)
}

fn resolve_analysis_priority(
    app: &AppHandle,
    engine: Option<&AudioEngine>,
    server_id: &str,
    track_id: &str,
    explicit: Option<AnalysisBackfillPriority>,
) -> AnalysisBackfillPriority {
    if let Some(priority) = explicit {
        return priority;
    }
    if psysonic_analysis::analysis_runtime::analysis_backfill_is_current_track(app, track_id)
        || engine.is_some_and(|e| analysis_track_id_is_current_playback(e, track_id))
    {
        return AnalysisBackfillPriority::High;
    }
    psysonic_analysis::analysis_runtime::analysis_backfill_resolve_priority(
        app,
        server_id,
        track_id,
        None,
    )
}

/// Resolve `(server_id, priority)` when the caller has live engine state.
pub(crate) fn prepare_playback_analysis(
    app: &AppHandle,
    engine: &AudioEngine,
    explicit_server_id: Option<&str>,
    track_id: &str,
    priority: Option<AnalysisBackfillPriority>,
) -> (String, AnalysisBackfillPriority) {
    let sid = resolve_analysis_server_id(explicit_server_id, Some(engine));
    let resolved = resolve_analysis_priority(app, Some(engine), &sid, track_id, priority);
    (sid, resolved)
}

pub(crate) fn resolve_server_id_for_app(
    app: &AppHandle,
    explicit: Option<&str>,
) -> String {
    let engine = app.try_state::<AudioEngine>();
    resolve_analysis_server_id(explicit, engine.as_deref())
}

pub(crate) fn analysis_priority_for_app(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
    explicit: Option<AnalysisBackfillPriority>,
) -> AnalysisBackfillPriority {
    let engine = app.try_state::<AudioEngine>();
    resolve_analysis_priority(app, engine.as_deref(), server_id, track_id, explicit)
}

/// Gapless boundary: chained track became audible — run unified analysis if needed.
pub(crate) fn spawn_gapless_transition_analysis(app: &AppHandle, info: &ChainedInfo) {
    let track_id = analysis_cache_track_id(
        info.analysis_track_id.as_deref(),
        &info.url,
    );
    let Some(track_id) = track_id else {
        return;
    };
    let engine = app.state::<AudioEngine>();
    let (sid, priority) = prepare_playback_analysis(
        app,
        &engine,
        info.server_id.as_deref(),
        &track_id,
        Some(AnalysisBackfillPriority::High),
    );
    let bytes = (*info.raw_bytes).clone();
    spawn_track_analysis_bytes(
        app.clone(),
        TrackAnalysisOrigin::GaplessTransition,
        sid,
        track_id,
        bytes,
        priority,
        None,
    );
}

/// Byte-backed analysis — the single audio-side entry before the analysis crate planner.
pub(crate) async fn dispatch_track_analysis_bytes(
    app: &AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: &str,
    track_id: &str,
    bytes: Vec<u8>,
    priority: AnalysisBackfillPriority,
) -> Result<(), String> {
    let track_id = track_id.trim();
    if track_id.is_empty() {
        return Ok(());
    }
    if bytes.is_empty() {
        return Ok(());
    }
    let max = max_bytes_for_origin(origin);
    if bytes.len() > max {
        crate::app_deprintln!(
            "[analysis][dispatch] skip origin={origin:?} track_id={track_id} bytes={} max={max}",
            bytes.len(),
        );
        return Ok(());
    }
    crate::app_deprintln!(
        "[analysis][dispatch] origin={origin:?} track_id={track_id} server_id={} size_mib={:.2} priority={priority:?}",
        if server_id.is_empty() { "''" } else { server_id },
        bytes.len() as f64 / (1024.0 * 1024.0),
    );
    psysonic_analysis::analysis_runtime::enqueue_track_analysis(
        app,
        server_id,
        track_id,
        &bytes,
        None,
        priority,
    )
    .await
    .map(|_| ())
}

/// Non-blocking wrapper with optional play-generation supersede guard.
pub(crate) fn spawn_track_analysis_bytes(
    app: AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    priority: AnalysisBackfillPriority,
    generation_guard: Option<(u64, Arc<AtomicU64>)>,
) {
    if track_id.trim().is_empty() || bytes.is_empty() {
        return;
    }
    tokio::spawn(async move {
        if let Some((gen, gen_arc)) = generation_guard {
            if gen_arc.load(Ordering::SeqCst) != gen {
                return;
            }
        }
        if let Err(e) = dispatch_track_analysis_bytes(
            &app,
            origin,
            &server_id,
            &track_id,
            bytes,
            priority,
        )
        .await
        {
            crate::app_eprintln!(
                "[analysis][dispatch] failed origin={origin:?} track_id={track_id}: {e}"
            );
        }
    });
}

pub(crate) fn spawn_track_analysis_file(
    app: AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: String,
    track_id: String,
    file_path: PathBuf,
    priority: AnalysisBackfillPriority,
    generation_guard: Option<(u64, Arc<AtomicU64>)>,
) {
    if track_id.trim().is_empty() {
        return;
    }
    tokio::spawn(async move {
        if let Some((gen, gen_arc)) = &generation_guard {
            if gen_arc.load(Ordering::SeqCst) != *gen {
                return;
            }
        }
        let bytes = match tokio::fs::read(&file_path).await {
            Ok(b) if !b.is_empty() => b,
            _ => return,
        };
        if let Some((gen, gen_arc)) = generation_guard {
            if gen_arc.load(Ordering::SeqCst) != gen {
                return;
            }
        }
        if let Err(e) = dispatch_track_analysis_bytes(
            &app,
            origin,
            &server_id,
            &track_id,
            bytes,
            priority,
        )
        .await
        {
            crate::app_eprintln!(
                "[analysis][dispatch] file failed origin={origin:?} track_id={track_id}: {e}"
            );
        }
    });
}

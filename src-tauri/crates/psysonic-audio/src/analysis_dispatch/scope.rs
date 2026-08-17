use tauri::{AppHandle, Manager};
use url::Url;

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use crate::engine::{analysis_track_id_is_current_playback, AudioEngine};
use crate::helpers::{analysis_cache_track_id, current_playback_server_id_str};
use crate::state::ChainedInfo;

use super::{spawn_track_analysis_bytes, TrackAnalysisOrigin};

/// Playback server scope: explicit IPC value, else pinned engine scope.
pub(crate) fn resolve_analysis_server_id(
    explicit: Option<&str>,
    engine: Option<&AudioEngine>,
) -> String {
    let pinned = engine
        .map(current_playback_server_id_str)
        .filter(|s| !s.is_empty());
    let url_derived = engine
        .and_then(|e| {
            e.current_playback_url
                .lock()
                .ok()
                .and_then(|g| (*g).clone())
        })
        .and_then(|url| server_id_from_playback_url(&url));
    resolve_analysis_scope(explicit, pinned.as_deref(), url_derived.as_deref())
}

/// Canonical analysis scope precedence. The EXPLICIT canonical server key
/// always wins: the selected playback address (URL-derived) is transport
/// state — a profile's primary and alternate addresses must not create
/// separate analysis rows for the same original track. URL derivation is the
/// last resort for legacy callers that pass no scope at all.
pub(super) fn resolve_analysis_scope(
    explicit: Option<&str>,
    pinned: Option<&str>,
    url_derived: Option<&str>,
) -> String {
    explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(pinned)
        .or(url_derived)
        .unwrap_or_default()
        .to_string()
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
        app, server_id, track_id, None,
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

pub(crate) fn resolve_server_id_for_app(app: &AppHandle, explicit: Option<&str>) -> String {
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
    let track_id = analysis_cache_track_id(info.analysis_track_id.as_deref(), &info.url);
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
        Some(info.url.clone()),
        priority,
        Some((info.generation, engine.generation.clone())),
        None,
    );
}

//! Unified playback → track analysis dispatch.
//!
//! Stream completion, hot/offline files, gapless chain, preload, and in-memory
//! replay all funnel through here before [`psysonic_analysis::analysis_runtime::enqueue_track_analysis`].

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use crate::engine::AudioEngine;
use crate::stream::{
    AnalysisSeedHoldGuard, LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES, TRACK_STREAM_PROMOTE_MAX_BYTES,
};

mod file_dispatch;
mod scope;

pub(crate) use file_dispatch::{
    prepare_track_analysis_file, spawn_track_analysis_file, spawn_track_analysis_prepared_file,
};
#[cfg(test)]
use scope::resolve_analysis_scope;
#[allow(unused_imports)]
pub(crate) use scope::{
    analysis_priority_for_app, prepare_playback_analysis, resolve_analysis_server_id,
    resolve_server_id_for_app, spawn_gapless_transition_analysis,
};

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

/// Whether the bytes captured from the live stream are the original file,
/// a server transcode, or unverifiable on this server/endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StreamProvenance {
    Original,
    Transcoded,
    Unknown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamProvenanceEvent {
    track_id: String,
    server_id: String,
    generation: u64,
    provenance: StreamProvenance,
}

pub(crate) type GenerationGuard = (u64, Arc<AtomicU64>);

pub(crate) struct PreparedTrackAnalysisFile {
    file: std::fs::File,
    file_len: u64,
}

pub(crate) struct TrackAnalysisDispatchOptions<'a> {
    pub(crate) priority: AnalysisBackfillPriority,
    pub(crate) generation_guard: Option<&'a GenerationGuard>,
}

fn is_http_stream_url(stream_url: Option<&str>) -> bool {
    stream_url.is_some_and(|u| u.starts_with("http://") || u.starts_with("https://"))
}

fn live_capture_origin(origin: TrackAnalysisOrigin) -> bool {
    matches!(
        origin,
        TrackAnalysisOrigin::InMemoryReplay
            | TrackAnalysisOrigin::StreamDownloadComplete
            | TrackAnalysisOrigin::StreamSpillFile
            | TrackAnalysisOrigin::GaplessTransition
    )
}

fn generation_guard_is_current(guard: &GenerationGuard) -> bool {
    guard.1.load(Ordering::SeqCst) == guard.0
}

fn generation_guard_allows_analysis(
    origin: TrackAnalysisOrigin,
    generation_guard: Option<&GenerationGuard>,
) -> bool {
    matches!(origin, TrackAnalysisOrigin::StreamSpillFile)
        || generation_guard.is_none_or(generation_guard_is_current)
}

fn provenance_event_generation(
    origin: TrackAnalysisOrigin,
    stream_url: Option<&str>,
    generation_guard: Option<&GenerationGuard>,
) -> Option<u64> {
    if !live_capture_origin(origin) || !is_http_stream_url(stream_url) {
        return None;
    }
    let guard = generation_guard?;
    generation_guard_is_current(guard).then_some(guard.0)
}

pub(crate) fn emit_stream_provenance_if_current(
    app: &AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: &str,
    track_id: &str,
    stream_url: Option<&str>,
    provenance: StreamProvenance,
    generation_guard: Option<&GenerationGuard>,
) {
    let Some(generation) = provenance_event_generation(origin, stream_url, generation_guard) else {
        return;
    };
    let _ = app.emit(
        "audio:stream-provenance",
        StreamProvenanceEvent {
            track_id: track_id.to_string(),
            server_id: server_id.to_string(),
            generation,
            provenance,
        },
    );
}

fn max_bytes_for_dispatch(origin: TrackAnalysisOrigin) -> usize {
    match origin {
        TrackAnalysisOrigin::LocalFilePlayback | TrackAnalysisOrigin::StreamSpillFile => {
            LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES
        }
        _ => TRACK_STREAM_PROMOTE_MAX_BYTES,
    }
}

fn max_http_fetch_bytes_for_dispatch() -> usize {
    TRACK_STREAM_PROMOTE_MAX_BYTES
}

/// Byte-backed analysis — the single audio-side entry before the analysis crate planner.
///
/// `stream_url`: the URL the bytes were streamed from (None for local files).
/// Every HTTP stream is treated as potentially transcoded — the server may
/// force transcoding without any client-visible URL marker — so canonical
/// identity is established by a raw-prefix probe of the original
/// (`format=raw`, capability-gated). Captured bytes are analysed only when they
/// match that prefix; otherwise the bounded full raw original is fetched and
/// analysed instead. Any probe/fetch failure skips canonical writes.
fn provenance_from_trusted_bytes(bytes: &[u8], trusted: &str) -> StreamProvenance {
    if psysonic_analysis::raw_probe::bytes_match_trusted(bytes, trusted) {
        StreamProvenance::Original
    } else {
        StreamProvenance::Transcoded
    }
}

fn should_fetch_trusted_original(in_cpu_pipeline: bool, plan_has_work: bool) -> bool {
    !in_cpu_pipeline && plan_has_work
}

fn trusted_original_fetch_needed(
    app: &AppHandle,
    server_id: &str,
    track_id: &str,
    trusted_md5_16kb: &str,
) -> bool {
    should_fetch_trusted_original(
        psysonic_analysis::analysis_runtime::analysis_revision_in_cpu_pipeline(
            server_id,
            track_id,
            trusted_md5_16kb,
        ),
        psysonic_analysis::track_analysis_plan::plan_track_analysis(
            app,
            server_id,
            track_id,
            trusted_md5_16kb,
        )
        .any(),
    )
}

pub(crate) async fn dispatch_track_analysis_bytes(
    app: &AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: &str,
    track_id: &str,
    bytes: Vec<u8>,
    stream_url: Option<&str>,
    options: TrackAnalysisDispatchOptions<'_>,
) -> Result<StreamProvenance, String> {
    let TrackAnalysisDispatchOptions {
        priority,
        generation_guard,
    } = options;
    let is_http_stream = is_http_stream_url(stream_url);
    let track_id = track_id.trim();
    if track_id.is_empty() {
        return Ok(if is_http_stream {
            StreamProvenance::Unknown
        } else {
            StreamProvenance::Original
        });
    }
    if bytes.is_empty() {
        return Ok(if is_http_stream {
            StreamProvenance::Unknown
        } else {
            StreamProvenance::Original
        });
    }
    let max = max_bytes_for_dispatch(origin);
    crate::app_deprintln!(
        "[analysis][dispatch] origin={origin:?} track_id={track_id} server_id={} size_mib={:.2} priority={priority:?}",
        if server_id.is_empty() { "''" } else { server_id },
        bytes.len() as f64 / (1024.0 * 1024.0),
    );
    if is_http_stream {
        let client = app
            .try_state::<AudioEngine>()
            .map(|e| crate::engine::audio_http_client(&e))
            .unwrap_or_default();
        let registry = app
            .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
            .map(|s| Arc::clone(&*s));
        use psysonic_analysis::raw_probe::TrustedProbeVerdict;
        let verdict = psysonic_analysis::raw_probe::resolve_trusted_identity(
            &client,
            registry.as_deref(),
            Some(server_id).filter(|s| !s.is_empty()),
            stream_url.unwrap_or_default(),
        )
        .await;
        match verdict {
            TrustedProbeVerdict::Trusted(trusted) => {
                let provenance = provenance_from_trusted_bytes(&bytes, &trusted);
                if !generation_guard_allows_analysis(origin, generation_guard) {
                    return Ok(provenance);
                }
                let trusted_generation =
                    psysonic_analysis::analysis_runtime::begin_trusted_revision(
                        server_id, track_id, &trusted,
                    );
                emit_stream_provenance_if_current(
                    app,
                    origin,
                    server_id,
                    track_id,
                    stream_url,
                    provenance,
                    generation_guard,
                );
                if provenance == StreamProvenance::Transcoded
                    && !psysonic_analysis::track_analysis_plan::plan_track_analysis(
                        app, server_id, track_id, &trusted,
                    )
                    .any()
                {
                    return psysonic_analysis::analysis_runtime::enqueue_track_analysis_trusted_owned(
                        app,
                        server_id,
                        track_id,
                        bytes,
                        None,
                        psysonic_analysis::analysis_runtime::TrustedAnalysisRevision {
                            md5_16kb: trusted,
                            generation: trusted_generation,
                            analysis_bytes_transcoded: true,
                            content_hash_server_id: None,
                        },
                        priority,
                    )
                    .await
                    .map(|_| provenance);
                }
                let mut trusted_fetch_permit = None;
                let (analysis_bytes, analysis_bytes_transcoded) = if provenance
                    == StreamProvenance::Original
                {
                    if bytes.len() > max {
                        crate::app_deprintln!(
                            "[analysis][dispatch] skip origin={origin:?} track_id={track_id} bytes={} max={max}",
                            bytes.len(),
                        );
                        return Ok(provenance);
                    }
                    (bytes, false)
                } else {
                    if !trusted_original_fetch_needed(app, server_id, track_id, &trusted) {
                        crate::app_deprintln!(
                            "[analysis][dispatch] skip raw original fetch track_id={track_id}: analysis complete or already queued"
                        );
                        return Ok(provenance);
                    }
                    crate::app_deprintln!(
                        "[analysis][dispatch] captured bytes differ from trusted original track_id={track_id}; fetching bounded raw original"
                    );
                    let permit =
                        psysonic_analysis::analysis_runtime::reserve_trusted_analysis_fetch(
                            server_id, track_id, &trusted,
                        )
                        .await;
                    if permit.waited()
                        && !trusted_original_fetch_needed(app, server_id, track_id, &trusted)
                    {
                        crate::app_deprintln!(
                            "[analysis][dispatch] skip completed duplicate raw original fetch track_id={track_id}"
                        );
                        return Ok(provenance);
                    }
                    trusted_fetch_permit = Some(permit);
                    match psysonic_analysis::raw_probe::fetch_trusted_original_bytes(
                        &client,
                        registry.as_deref(),
                        Some(server_id).filter(|s| !s.is_empty()),
                        stream_url.unwrap_or_default(),
                        &trusted,
                        max_http_fetch_bytes_for_dispatch(),
                    )
                    .await
                    {
                        Some(original) => (original, false),
                        None => {
                            if bytes.len() > max {
                                crate::app_deprintln!(
                                    "[analysis][dispatch] skip captured transcode origin={origin:?} track_id={track_id} bytes={} max={max}",
                                    bytes.len(),
                                );
                                return Ok(provenance);
                            }
                            crate::app_deprintln!(
                                "[analysis][dispatch] raw original unavailable or exceeds HTTP cap; analyzing captured transcode track_id={track_id}"
                            );
                            (bytes, true)
                        }
                    }
                };
                let result =
                    psysonic_analysis::analysis_runtime::enqueue_track_analysis_trusted_owned(
                        app,
                        server_id,
                        track_id,
                        analysis_bytes,
                        None,
                        psysonic_analysis::analysis_runtime::TrustedAnalysisRevision {
                            md5_16kb: trusted,
                            generation: trusted_generation,
                            analysis_bytes_transcoded,
                            content_hash_server_id: None,
                        },
                        priority,
                    )
                    .await
                    .map(|_| provenance);
                drop(trusted_fetch_permit);
                result
            }
            TrustedProbeVerdict::SkipCanonicalWrites => {
                // No positive provenance for these HTTP-stream bytes (the
                // server may be force-transcoding invisibly). Playback is
                // unaffected; canonical writes are skipped.
                crate::app_deprintln!(
                    "[analysis][dispatch] skip origin={origin:?} track_id={track_id}: stream identity unverified — no canonical writes"
                );
                emit_stream_provenance_if_current(
                    app,
                    origin,
                    server_id,
                    track_id,
                    stream_url,
                    StreamProvenance::Unknown,
                    generation_guard,
                );
                Ok(StreamProvenance::Unknown)
            }
        }
    } else {
        if bytes.len() > max {
            crate::app_deprintln!(
                "[analysis][dispatch] skip origin={origin:?} track_id={track_id} bytes={} max={max}",
                bytes.len(),
            );
            return Ok(StreamProvenance::Original);
        }
        psysonic_analysis::analysis_runtime::enqueue_track_analysis(
            app, server_id, track_id, &bytes, None, priority,
        )
        .await
        .map(|_| StreamProvenance::Original)
    }
}

/// Non-blocking wrapper with optional play-generation supersede guard.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_track_analysis_bytes(
    app: AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    stream_url: Option<String>,
    priority: AnalysisBackfillPriority,
    generation_guard: Option<GenerationGuard>,
    analysis_seed_hold: Option<AnalysisSeedHoldGuard>,
) {
    if track_id.trim().is_empty() || bytes.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let _analysis_seed_hold = analysis_seed_hold;
        if !generation_guard_allows_analysis(origin, generation_guard.as_ref()) {
            return;
        }
        match dispatch_track_analysis_bytes(
            &app,
            origin,
            &server_id,
            &track_id,
            bytes,
            stream_url.as_deref(),
            TrackAnalysisDispatchOptions {
                priority,
                generation_guard: generation_guard.as_ref(),
            },
        )
        .await
        {
            Ok(_) => {}
            Err(e) => {
                crate::app_eprintln!(
                    "[analysis][dispatch] failed origin={origin:?} track_id={track_id}: {e}"
                );
            }
        }
    });
}

#[cfg(test)]
mod scope_tests;

#[cfg(test)]
mod provenance_tests;

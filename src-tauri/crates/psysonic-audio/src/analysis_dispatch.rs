//! Unified playback → track analysis dispatch.
//!
//! Stream completion, hot/offline files, gapless chain, preload, and in-memory
//! replay all funnel through here before [`psysonic_analysis::analysis_runtime::enqueue_track_analysis`].

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use crate::engine::{analysis_track_id_is_current_playback, AudioEngine};
use crate::helpers::{analysis_cache_track_id, current_playback_server_id_str};
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
fn resolve_analysis_scope(
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
    );
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
        psysonic_analysis::analysis_runtime::analysis_track_in_cpu_pipeline(server_id, track_id),
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
    let max = max_bytes_for_origin(origin);
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
                emit_stream_provenance_if_current(
                    app,
                    origin,
                    server_id,
                    track_id,
                    stream_url,
                    provenance,
                    generation_guard,
                );
                let analysis_bytes = if provenance == StreamProvenance::Original {
                    if bytes.len() > max {
                        crate::app_deprintln!(
                            "[analysis][dispatch] skip origin={origin:?} track_id={track_id} bytes={} max={max}",
                            bytes.len(),
                        );
                        return Ok(provenance);
                    }
                    bytes
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
                    let Some(original) = psysonic_analysis::raw_probe::fetch_trusted_original_bytes(
                        &client,
                        registry.as_deref(),
                        Some(server_id).filter(|s| !s.is_empty()),
                        stream_url.unwrap_or_default(),
                        &trusted,
                        max,
                    )
                    .await
                    else {
                        crate::app_deprintln!(
                            "[analysis][dispatch] skip origin={origin:?} track_id={track_id}: raw original unavailable or exceeds cap"
                        );
                        return Ok(provenance);
                    };
                    original
                };
                let trusted_generation =
                    psysonic_analysis::analysis_runtime::begin_trusted_revision(
                        server_id,
                        track_id,
                        &trusted,
                    );
                psysonic_analysis::analysis_runtime::enqueue_track_analysis_trusted(
                    app,
                    server_id,
                    track_id,
                    &analysis_bytes,
                    None,
                    psysonic_analysis::analysis_runtime::TrustedAnalysisRevision {
                        md5_16kb: trusted,
                        generation: trusted_generation,
                        content_hash_server_id: None,
                    },
                    priority,
                )
                .await
                .map(|_| provenance)
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
            app,
            server_id,
            track_id,
            &bytes,
            None,
            priority,
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
) {
    if track_id.trim().is_empty() || bytes.is_empty() {
        return;
    }
    tokio::spawn(async move {
        if generation_guard
            .as_ref()
            .is_some_and(|guard| !generation_guard_is_current(guard))
        {
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

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_track_analysis_file(
    app: AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: String,
    track_id: String,
    file_path: PathBuf,
    // URL the file's bytes came from when it is a SPILLED/CAPTURED HTTP
    // stream (None for genuine local library files). Spilled bytes carry the
    // same provenance requirements as the live stream they came from.
    stream_url: Option<String>,
    priority: AnalysisBackfillPriority,
    generation_guard: Option<GenerationGuard>,
) {
    if track_id.trim().is_empty() {
        return;
    }
    tokio::spawn(async move {
        if generation_guard
            .as_ref()
            .is_some_and(|guard| !generation_guard_is_current(guard))
        {
            return;
        }
        let bytes = match tokio::fs::read(&file_path).await {
            Ok(b) if !b.is_empty() => b,
            _ => return,
        };
        if generation_guard
            .as_ref()
            .is_some_and(|guard| !generation_guard_is_current(guard))
        {
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
                    "[analysis][dispatch] file failed origin={origin:?} track_id={track_id}: {e}"
                );
            }
        }
    });
}

#[cfg(test)]
mod scope_tests {
    use super::resolve_analysis_scope;

    #[test]
    fn explicit_canonical_key_beats_the_selected_transport_address() {
        // Primary vs alternate address must share one analysis scope: the
        // explicit canonical key wins over the URL-derived transport host.
        assert_eq!(
            resolve_analysis_scope(Some("canonical.example"), Some("canonical.example"), Some("lan.local:4533")),
            "canonical.example"
        );
        assert_eq!(
            resolve_analysis_scope(Some("canonical.example"), None, Some("public.example/nav")),
            "canonical.example"
        );
    }

    #[test]
    fn pinned_scope_then_url_are_fallbacks_only() {
        assert_eq!(
            resolve_analysis_scope(None, Some("pinned.example"), Some("lan.local")),
            "pinned.example"
        );
        assert_eq!(resolve_analysis_scope(None, None, Some("lan.local")), "lan.local");
        assert_eq!(resolve_analysis_scope(Some("  "), None, None), "");
    }
}

#[cfg(test)]
mod provenance_tests {
    use super::*;

    #[test]
    fn trusted_prefix_distinguishes_original_from_transcoded_capture() {
        let original = vec![7u8; 20 * 1024];
        let trusted = psysonic_analysis::analysis_cache::md5_first_16kb(&original);
        assert_eq!(
            provenance_from_trusted_bytes(&original, &trusted),
            StreamProvenance::Original,
        );
        assert_eq!(
            provenance_from_trusted_bytes(&vec![9u8; 20 * 1024], &trusted),
            StreamProvenance::Transcoded,
        );
    }

    #[test]
    fn raw_original_fetch_requires_work_outside_the_cpu_pipeline() {
        assert!(should_fetch_trusted_original(false, true));
        assert!(!should_fetch_trusted_original(true, true));
        assert!(!should_fetch_trusted_original(false, false));
    }

    #[test]
    fn live_http_provenance_requires_a_current_generation_guard() {
        let generation = Arc::new(AtomicU64::new(6));
        let guard = (6, generation.clone());
        assert_eq!(
            provenance_event_generation(
                TrackAnalysisOrigin::InMemoryReplay,
                Some("https://example.test/rest/stream.view?id=t1"),
                Some(&guard),
            ),
            Some(6),
        );
        assert_eq!(
            provenance_event_generation(
                TrackAnalysisOrigin::PrefetchOrCacheFile,
                Some("https://example.test/rest/stream.view?id=t1"),
                Some(&guard),
            ),
            None,
            "prefetch analysis must not create a live now-playing event",
        );
        assert_eq!(
            provenance_event_generation(
                TrackAnalysisOrigin::LocalFilePlayback,
                Some("psysonic-local:///music/t1.flac"),
                Some(&guard),
            ),
            None,
            "local originals do not need a stream-provenance event",
        );

        generation.store(7, Ordering::SeqCst);
        assert_eq!(
            provenance_event_generation(
                TrackAnalysisOrigin::StreamDownloadComplete,
                Some("https://example.test/rest/stream.view?id=t1"),
                Some(&guard),
            ),
            None,
            "superseded captures must not emit stale provenance",
        );
    }
}

use psysonic_core::ports::PlaybackQueryHandle;
use psysonic_core::track_enrichment::TrackEnrichmentOutcome;
use std::borrow::Cow;
use tauri::Manager;

use super::backfill_queue::{analysis_backfill_shared, PlaybackPriorityHints};
use super::cpu_seed::submit_analysis_cpu_seed;
use super::trusted_revision::{activate_trusted_enrichment, activate_trusted_identity};
use super::types::{
    AnalysisBackfillEnqueueKind, AnalysisBackfillPriority, EnqueueSeedFromUrlOutcome,
    EnqueueTrackAnalysisOutcome, TrustedAnalysisRevision,
};
use crate::analysis_cache;
use crate::analysis_perf::emit_analysis_track_perf;
use crate::track_analysis_plan::plan_track_analysis;

/// **Single entry point** for byte-backed track analysis.
///
/// 1. Plan: waveform / LUFS gaps in analysis cache + enrichment facts in library.
/// 2. If nothing missing → no-op.
/// 3. If waveform or LUFS missing → CPU seed queue (Symphonia + EBU R128).
mod offline;

pub use offline::{enqueue_offline_library_analysis_from_file, enqueue_track_analysis_from_file};

pub async fn enqueue_track_analysis(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Borrowed(bytes),
        format_hint,
        None,
        priority,
        0,
        None,
    )
    .await
}

/// Like [`enqueue_track_analysis`] but with a verified original fingerprint.
/// Original bytes are prefix-verified; an explicitly marked server transcode
/// is analysed under the separately verified original identity.
pub async fn enqueue_track_analysis_trusted(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    format_hint: Option<&str>,
    trusted_revision: TrustedAnalysisRevision,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Borrowed(bytes),
        format_hint,
        Some(trusted_revision),
        priority,
        0,
        None,
    )
    .await
}

/// Owned-byte variant for completed playback captures. Large spill files can
/// enter the CPU queue without cloning the complete track a second time.
pub async fn enqueue_track_analysis_trusted_owned(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: Vec<u8>,
    format_hint: Option<&str>,
    trusted_revision: TrustedAnalysisRevision,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Owned(bytes),
        format_hint,
        Some(trusted_revision),
        priority,
        0,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn enqueue_track_analysis_with_fetch(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: Cow<'_, [u8]>,
    format_hint: Option<&str>,
    trusted_revision: Option<TrustedAnalysisRevision>,
    priority: AnalysisBackfillPriority,
    fetch_ms: u64,
    cpu_admitted: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    if bytes.is_empty() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    if let Some(trusted) = trusted_revision
        .as_ref()
        .filter(|trusted| !trusted.analysis_bytes_transcoded)
    {
        if !crate::raw_probe::bytes_match_trusted(bytes.as_ref(), &trusted.md5_16kb) {
            return Err("trusted original fingerprint does not match analysis bytes".to_string());
        }
    }
    // Trusted-original identity wins: planning against it reuses an existing
    // complete result for the original.
    let content_hash = trusted_revision
        .as_ref()
        .map(|trusted| trusted.md5_16kb.clone())
        .unwrap_or_else(|| analysis_cache::md5_first_16kb(bytes.as_ref()));
    let plan = plan_track_analysis(app, server_id, track_id, &content_hash);
    if !plan.any() {
        crate::app_deprintln!(
            "[analysis] track complete track_id={} hash={}",
            track_id,
            content_hash
        );
        if let Some(trusted) = trusted_revision.as_ref() {
            let content_hash_server_id = trusted
                .content_hash_server_id
                .as_deref()
                .unwrap_or(server_id);
            activate_trusted_identity(
                app,
                server_id,
                content_hash_server_id,
                track_id,
                &content_hash,
                trusted.generation,
            );
        }
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    if plan.needs_full_cpu_seed() {
        crate::app_deprintln!(
            "[analysis] queue full seed track_id={} hash={} need_waveform={} need_loudness={} need_enrichment={}",
            track_id,
            content_hash,
            plan.need_waveform,
            plan.need_loudness,
            plan.enrichment.any()
        );
        submit_analysis_cpu_seed(
            app.clone(),
            server_id.to_string(),
            track_id.to_string(),
            bytes.into_owned(),
            format_hint.map(str::to_string),
            trusted_revision,
            priority,
            fetch_ms,
            cpu_admitted,
        )
        .await?;
        return Ok(EnqueueTrackAnalysisOutcome::QueuedFullSeed);
    }
    if plan.needs_enrichment_only() {
        crate::app_deprintln!(
            "[analysis] enrichment-only track_id={} hash={}",
            track_id,
            content_hash
        );
        let bpm_started = std::time::Instant::now();
        let trusted_guard = trusted_revision
            .as_ref()
            .map(|trusted| (server_id.to_string(), trusted.generation));
        let outcome = run_track_enrichment_from_owned_bytes(
            app,
            server_id,
            track_id,
            bytes.into_owned(),
            Some(content_hash.clone()),
            trusted_guard,
            analysis_emits_ui_events(priority),
        )
        .await;
        if matches!(outcome, TrackEnrichmentOutcome::Failed) {
            if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
                let key = analysis_cache::TrackKey {
                    server_id: server_id.to_string(),
                    track_id: track_id.to_string(),
                    md5_16kb: content_hash.clone(),
                };
                let _ = cache.touch_track_status(&key, "failed");
            }
            return Err("track enrichment failed".to_string());
        }
        if let Some(trusted) = trusted_revision.as_ref() {
            let content_hash_server_id = trusted
                .content_hash_server_id
                .as_deref()
                .unwrap_or(server_id);
            activate_trusted_enrichment(
                app,
                server_id,
                content_hash_server_id,
                track_id,
                &content_hash,
                trusted.generation,
                outcome,
            );
        }
        let bpm_ms = bpm_started.elapsed().as_millis() as u64;
        emit_analysis_track_perf(app, track_id, fetch_ms, 0, bpm_ms);
        return Ok(EnqueueTrackAnalysisOutcome::RanEnrichmentOnly);
    }
    Ok(EnqueueTrackAnalysisOutcome::Complete)
}

/// Re-export for HTTP backfill gate (no bytes yet).
pub use crate::track_analysis_plan::track_analysis_needs_work;

/// Oximedia BPM/mood pass only — prefer [`enqueue_track_analysis`].
pub async fn run_track_enrichment_from_bytes(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
    trusted_md5_16kb: Option<String>,
    notify_ui: bool,
) -> TrackEnrichmentOutcome {
    run_track_enrichment_from_owned_bytes(
        app,
        server_id,
        track_id,
        bytes.to_vec(),
        trusted_md5_16kb,
        None,
        notify_ui,
    )
    .await
}

async fn run_track_enrichment_from_owned_bytes(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    data: Vec<u8>,
    trusted_md5_16kb: Option<String>,
    trusted_guard: Option<(String, u64)>,
    notify_ui: bool,
) -> TrackEnrichmentOutcome {
    if server_id.is_empty() {
        return TrackEnrichmentOutcome::SkippedNoServer;
    }
    let app = app.clone();
    let sid = server_id.to_string();
    let tid = track_id.to_string();
    match tokio::task::spawn_blocking(move || {
        crate::track_enrichment::run_track_enrichment_if_needed(
            &app,
            &sid,
            &tid,
            &data,
            trusted_md5_16kb.as_deref(),
            trusted_guard
                .as_ref()
                .map(|(server_id, generation)| (server_id.as_str(), *generation)),
            notify_ui,
        )
    })
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => TrackEnrichmentOutcome::Failed,
    }
}

/// Read a local file and run [`enqueue_track_analysis`] (hot cache, offline, spill promote).
/// Decode `bytes` for `track_id` via the cpu-seed queue. Prefer [`enqueue_track_analysis`].
pub async fn enqueue_analysis_seed(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
) -> Result<bool, String> {
    let priority = analysis_backfill_resolve_priority(app, server_id, track_id, None);
    let outcome = enqueue_track_analysis(app, server_id, track_id, bytes, None, priority).await?;
    Ok(!matches!(outcome, EnqueueTrackAnalysisOutcome::Complete))
}
pub fn analysis_backfill_is_current_track(app: &tauri::AppHandle, track_id: &str) -> bool {
    app.try_state::<psysonic_core::ports::PlaybackQueryHandle>()
        .is_some_and(|p| p.is_track_currently_playing(track_id))
}

pub fn analysis_backfill_resolve_priority(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    explicit: Option<AnalysisBackfillPriority>,
) -> AnalysisBackfillPriority {
    if let Some(priority) = explicit {
        return priority;
    }
    if analysis_backfill_is_current_track(app, track_id) {
        return AnalysisBackfillPriority::High;
    }
    if app
        .try_state::<PlaybackPriorityHints>()
        .is_some_and(|h| h.is_middle_priority(server_id, track_id))
    {
        return AnalysisBackfillPriority::Middle;
    }
    AnalysisBackfillPriority::Low
}

/// Library backfill uses `Low` — skip waveform / enrichment refresh IPC (`analysis:track-perf` still emits for probes).
pub fn analysis_emits_ui_events(priority: AnalysisBackfillPriority) -> bool {
    !matches!(priority, AnalysisBackfillPriority::Low)
}

/// Enqueue HTTP download + analysis seed (native coordinator + optional UI invoke).
pub(super) fn resolve_backfill_server_id(url: &str, server_id_hint: Option<&str>) -> String {
    if let Some(hint) = server_id_hint
        .map(str::trim)
        .filter(|hint| !hint.is_empty())
    {
        return hint.to_string();
    }
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return String::new();
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return String::new();
    }
    let host = parsed.host_str().unwrap_or_default();
    if host.is_empty() {
        return String::new();
    }
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
    base
}

pub fn enqueue_seed_from_url(
    app: &tauri::AppHandle,
    track_id: &str,
    url: &str,
    server_id_hint: Option<&str>,
    explicit_priority: Option<AnalysisBackfillPriority>,
    force: bool,
) -> Result<EnqueueSeedFromUrlOutcome, String> {
    if track_id.trim().is_empty() || url.trim().is_empty() {
        return Ok(EnqueueSeedFromUrlOutcome::Skipped);
    }
    let server_id = resolve_backfill_server_id(url, server_id_hint);
    let is_http = url.starts_with("http://") || url.starts_with("https://");
    if is_http && crate::raw_probe::build_original_download_url(url).is_none() {
        crate::app_deprintln!(
            "[analysis] backfill unsupported track_id={track_id}: no original-download endpoint"
        );
        return Ok(EnqueueSeedFromUrlOutcome::Unsupported);
    }
    if !force {
        if let Some(playback) = app.try_state::<PlaybackQueryHandle>() {
            if playback.analysis_backfill_should_defer(track_id) {
                crate::app_deprintln!(
                    "[analysis] backfill skip track_id={} reason=playback_stream_will_seed",
                    track_id
                );
                return Ok(EnqueueSeedFromUrlOutcome::Skipped);
            }
        }
    }
    if !force {
        if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
            if cache.cpu_seed_redundant_for_track(&server_id, track_id)? {
                if server_id.is_empty() {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (no server scope): {}",
                        track_id
                    );
                    return Ok(EnqueueSeedFromUrlOutcome::Skipped);
                }
                if !track_analysis_needs_work(app, &server_id, track_id)? {
                    crate::app_deprintln!(
                        "[analysis] backfill skip (analysis complete): {}",
                        track_id
                    );
                    return Ok(EnqueueSeedFromUrlOutcome::Skipped);
                }
                crate::app_deprintln!(
                    "[analysis] backfill enqueue (analysis pending) track_id={}",
                    track_id
                );
            }
        }
    }
    let tid_log = track_id.to_string();
    let resolved = analysis_backfill_resolve_priority(app, &server_id, track_id, explicit_priority);
    let shared = analysis_backfill_shared(app);
    let kind = {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.enqueue_with_force(
            server_id,
            track_id.to_string(),
            url.to_string(),
            resolved,
            force,
        )
    };
    match kind {
        AnalysisBackfillEnqueueKind::NewLow
        | AnalysisBackfillEnqueueKind::NewMiddle
        | AnalysisBackfillEnqueueKind::NewHigh => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill enqueued: track_id={} priority={resolved:?}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Enqueued)
        }
        AnalysisBackfillEnqueueKind::ReorderedHigher => {
            shared.ping_worker();
            crate::app_deprintln!(
                "[analysis] backfill bumped tier track_id={} priority={resolved:?}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Enqueued)
        }
        AnalysisBackfillEnqueueKind::DuplicateSkipped
        | AnalysisBackfillEnqueueKind::RunningSkipped => {
            Ok(EnqueueSeedFromUrlOutcome::AlreadyReserved)
        }
        AnalysisBackfillEnqueueKind::RetryDeferred => {
            crate::app_deprintln!(
                "[analysis] backfill retry deferred after transient failure: track_id={}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Skipped)
        }
        AnalysisBackfillEnqueueKind::TerminalSkipped => {
            crate::app_deprintln!(
                "[analysis] backfill deferred during terminal-failure cooldown: track_id={}",
                tid_log,
            );
            Ok(EnqueueSeedFromUrlOutcome::Skipped)
        }
    }
}

use psysonic_core::track_enrichment::TrackEnrichmentOutcome;
use tauri::Manager;

use crate::analysis_cache;
use crate::analysis_perf::emit_analysis_track_perf;

use super::super::cpu_seed::submit_analysis_cpu_seed;
use super::super::trusted_revision::{
    activate_trusted_enrichment, activate_trusted_identity, begin_trusted_revision,
};
use super::super::types::{
    AnalysisBackfillPriority, EnqueueTrackAnalysisOutcome, TrustedAnalysisRevision,
};
use super::{
    analysis_backfill_resolve_priority, analysis_emits_ui_events, enqueue_track_analysis,
    run_track_enrichment_from_owned_bytes,
};

pub async fn enqueue_track_analysis_from_file(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    file_path: &std::path::Path,
    priority: AnalysisBackfillPriority,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    let format_hint = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty());
    enqueue_track_analysis(
        app,
        server_id,
        track_id,
        &bytes,
        format_hint.as_deref(),
        priority,
    )
    .await
}

/// Library-tier offline pin: reuse waveform/LUFS cached under the playback index key,
/// plan enrichment under the library UUID, and skip work when both scopes are complete.
pub async fn enqueue_offline_library_analysis_from_file(
    app: &tauri::AppHandle,
    server_index_key: &str,
    library_server_id: &str,
    track_id: &str,
    file_path: &std::path::Path,
    explicit_priority: Option<AnalysisBackfillPriority>,
    verified_original: bool,
) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    use crate::track_analysis_plan::plan_track_analysis_offline_library;

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut prefix = vec![0u8; 16384];
    let n = file.read(&mut prefix).await.map_err(|e| e.to_string())?;
    prefix.truncate(n);
    if prefix.is_empty() {
        return Ok(());
    }
    let content_hash = analysis_cache::md5_first_16kb(&prefix);
    let trusted_revision = verified_original.then(|| TrustedAnalysisRevision {
        md5_16kb: content_hash.clone(),
        generation: begin_trusted_revision(server_index_key, track_id, &content_hash),
        analysis_bytes_transcoded: false,
        content_hash_server_id: Some(library_server_id.to_string()),
    });
    let plan = plan_track_analysis_offline_library(
        app,
        &[server_index_key, library_server_id],
        library_server_id,
        track_id,
        &content_hash,
    );
    if !plan.any() {
        crate::app_deprintln!(
            "[analysis] offline library seed skip (complete) track_id={} index={} library={}",
            track_id,
            server_index_key,
            library_server_id,
        );
        if let Some(trusted) = trusted_revision.as_ref() {
            activate_trusted_identity(
                app,
                server_index_key,
                trusted
                    .content_hash_server_id
                    .as_deref()
                    .unwrap_or(server_index_key),
                track_id,
                &trusted.md5_16kb,
                trusted.generation,
            );
        }
        return Ok(());
    }
    let bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| e.to_string())?;
    let format_hint = file_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty());
    let priority = explicit_priority.unwrap_or_else(|| {
        analysis_backfill_resolve_priority(app, server_index_key, track_id, None)
    });
    enqueue_track_analysis_offline_library_with_plan(OfflineLibraryAnalysisEnqueue {
        app,
        cache_server_id: server_index_key,
        enrichment_server_id: library_server_id,
        track_id,
        bytes: &bytes,
        format_hint: format_hint.as_deref(),
        priority,
        plan,
        fetch_ms: 0,
        trusted_revision,
    })
    .await?;
    Ok(())
}

struct OfflineLibraryAnalysisEnqueue<'a> {
    app: &'a tauri::AppHandle,
    cache_server_id: &'a str,
    enrichment_server_id: &'a str,
    track_id: &'a str,
    bytes: &'a [u8],
    format_hint: Option<&'a str>,
    priority: AnalysisBackfillPriority,
    plan: psysonic_core::track_analysis::TrackAnalysisPlan,
    fetch_ms: u64,
    trusted_revision: Option<TrustedAnalysisRevision>,
}

async fn enqueue_track_analysis_offline_library_with_plan(
    args: OfflineLibraryAnalysisEnqueue<'_>,
) -> Result<EnqueueTrackAnalysisOutcome, String> {
    if args.bytes.is_empty() || !args.plan.any() {
        return Ok(EnqueueTrackAnalysisOutcome::Complete);
    }
    let content_hash = analysis_cache::md5_first_16kb(args.bytes);
    if args.plan.needs_full_cpu_seed() {
        crate::app_deprintln!(
            "[analysis] queue full seed track_id={} hash={} need_waveform={} need_loudness={} need_enrichment={}",
            args.track_id,
            content_hash,
            args.plan.need_waveform,
            args.plan.need_loudness,
            args.plan.enrichment.any()
        );
        submit_analysis_cpu_seed(
            args.app.clone(),
            args.cache_server_id.to_string(),
            args.track_id.to_string(),
            args.bytes.to_vec(),
            args.format_hint.map(str::to_string),
            args.trusted_revision,
            args.priority,
            args.fetch_ms,
            None,
        )
        .await?;
        return Ok(EnqueueTrackAnalysisOutcome::QueuedFullSeed);
    }
    if args.plan.needs_enrichment_only() {
        crate::app_deprintln!(
            "[analysis] enrichment-only track_id={} hash={}",
            args.track_id,
            content_hash
        );
        let bpm_started = std::time::Instant::now();
        let trusted_guard = args
            .trusted_revision
            .as_ref()
            .map(|trusted| (args.cache_server_id.to_string(), trusted.generation));
        let outcome = run_track_enrichment_from_owned_bytes(
            args.app,
            args.enrichment_server_id,
            args.track_id,
            args.bytes.to_vec(),
            Some(content_hash.clone()),
            trusted_guard,
            analysis_emits_ui_events(args.priority),
        )
        .await;
        if matches!(outcome, TrackEnrichmentOutcome::Failed) {
            if let Some(cache) = args.app.try_state::<analysis_cache::AnalysisCache>() {
                let key = analysis_cache::TrackKey {
                    server_id: args.cache_server_id.to_string(),
                    track_id: args.track_id.to_string(),
                    md5_16kb: content_hash.clone(),
                };
                let _ = cache.touch_track_status(&key, "failed");
            }
            return Err("track enrichment failed".to_string());
        }
        if let Some(trusted) = args.trusted_revision.as_ref() {
            activate_trusted_enrichment(
                args.app,
                args.cache_server_id,
                trusted
                    .content_hash_server_id
                    .as_deref()
                    .unwrap_or(args.cache_server_id),
                args.track_id,
                &trusted.md5_16kb,
                trusted.generation,
                outcome,
            );
        }
        let bpm_ms = bpm_started.elapsed().as_millis() as u64;
        emit_analysis_track_perf(args.app, args.track_id, args.fetch_ms, 0, bpm_ms);
        return Ok(EnqueueTrackAnalysisOutcome::RanEnrichmentOnly);
    }
    Ok(EnqueueTrackAnalysisOutcome::Complete)
}

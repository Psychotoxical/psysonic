use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::analysis_cache;
use crate::analysis_perf::emit_analysis_track_perf;

use super::backfill_queue::ANALYSIS_BACKFILL;
use super::enqueue::analysis_emits_ui_events;
use super::trusted_revision::activate_trusted_identity;
use super::types::{
    clamp_pipeline_parallelism, AnalysisBackfillPriority, AnalysisPipelineQueueStatsDto,
    AnalysisTierCounts, TrustedAnalysisRevision, WaveformUpdatedPayload,
    ANALYSIS_PIPELINE_PARALLELISM_DEFAULT,
};

mod queue;
pub(super) use queue::*;

/// Last requested worker count (applied when lazy-init queues and on live updates).
pub(super) static REQUESTED_PIPELINE_PARALLELISM: AtomicUsize =
    AtomicUsize::new(ANALYSIS_PIPELINE_PARALLELISM_DEFAULT);

pub(super) fn requested_pipeline_parallelism() -> usize {
    clamp_pipeline_parallelism(REQUESTED_PIPELINE_PARALLELISM.load(Ordering::Relaxed))
}

pub fn analysis_set_pipeline_parallelism(workers: usize) {
    let workers = clamp_pipeline_parallelism(workers);
    REQUESTED_PIPELINE_PARALLELISM.store(workers, Ordering::Relaxed);
    if let Some(shared) = ANALYSIS_BACKFILL.get() {
        shared.max_parallel.store(workers, Ordering::Relaxed);
        shared.ping_worker();
    }
    if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        shared.max_parallel.store(workers, Ordering::Relaxed);
        shared.ping_worker();
    }
}

pub fn analysis_backfill_queue_stats() -> (usize, usize, Option<String>) {
    if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let in_progress_count = st.in_progress.len();
        let first_in_progress = st.in_progress.keys().next().cloned();
        (st.queued_len(), in_progress_count, first_in_progress)
    } else {
        (0, 0, None)
    }
}

pub fn clear_analysis_backfill_failure_state(server_id: &str, track_ids: &[String]) {
    let Some(shared) = ANALYSIS_BACKFILL.get() else {
        return;
    };
    let mut state = shared
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    state.clear_failure_state(server_id, track_ids);
}

pub fn analysis_track_in_cpu_pipeline(server_id: &str, track_id: &str) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() {
        return false;
    }
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return false;
    };
    // The cpu-seed maps are keyed by (server, track, revision) — match ANY
    // revision of this (server, track) pair.
    let prefix = format!("{}\u{1f}", seed_key(server_id, tid));
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    if st.running.keys().any(|k| k.starts_with(&prefix)) {
        return true;
    }
    for tier in [
        AnalysisBackfillPriority::High,
        AnalysisBackfillPriority::Middle,
        AnalysisBackfillPriority::Low,
    ] {
        if st
            .tier_deque(tier)
            .iter()
            .any(|j| j.server_id == server_id && j.track_id == tid)
        {
            return true;
        }
    }
    false
}

pub fn analysis_revision_in_cpu_pipeline(server_id: &str, track_id: &str, revision: &str) -> bool {
    let tid = track_id.trim();
    if tid.is_empty() || revision.is_empty() {
        return false;
    }
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return false;
    };
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    st.contains_revision(server_id, tid, revision)
}

pub fn analysis_pipeline_queue_stats() -> AnalysisPipelineQueueStatsDto {
    let pipeline_workers = ANALYSIS_BACKFILL
        .get()
        .map(|shared| shared.max_parallel())
        .or_else(|| ANALYSIS_CPU_SEED.get().map(|shared| shared.max_parallel()))
        .unwrap_or(ANALYSIS_PIPELINE_PARALLELISM_DEFAULT) as u32;

    let (http_tiers, http_active_tiers) = if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        (st.queued_tier_counts(), st.in_progress_tier_counts())
    } else {
        (AnalysisTierCounts::default(), AnalysisTierCounts::default())
    };

    let (cpu_tiers, cpu_active_tiers) = if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        (st.queued_tier_counts(), st.running_tier_counts())
    } else {
        (AnalysisTierCounts::default(), AnalysisTierCounts::default())
    };

    AnalysisPipelineQueueStatsDto {
        pipeline_workers,
        http_queued: http_tiers.total(),
        http_queued_high: http_tiers.high,
        http_queued_middle: http_tiers.middle,
        http_queued_low: http_tiers.low,
        http_download_active: http_active_tiers.total(),
        http_download_active_high: http_active_tiers.high,
        http_download_active_middle: http_active_tiers.middle,
        http_download_active_low: http_active_tiers.low,
        cpu_queued: cpu_tiers.total(),
        cpu_queued_high: cpu_tiers.high,
        cpu_queued_middle: cpu_tiers.middle,
        cpu_queued_low: cpu_tiers.low,
        cpu_decode_active: cpu_active_tiers.total(),
        cpu_decode_active_high: cpu_active_tiers.high,
        cpu_decode_active_middle: cpu_active_tiers.middle,
        cpu_decode_active_low: cpu_active_tiers.low,
    }
}
pub(super) fn emit_analysis_queue_snapshot_line() {
    let http = if let Some(arc) = ANALYSIS_BACKFILL.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        format!(
            "http_backfill={{queued:{} tiers=({},{},{}) download_active:{}}}",
            st.queued_len(),
            st.high.len(),
            st.middle.len(),
            st.low.len(),
            st.in_progress.len(),
        )
    } else {
        "http_backfill={{not_started}}".to_string()
    };

    let cpu = if let Some(arc) = ANALYSIS_CPU_SEED.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        let queued_jobs = st.queued_len();
        let decoding_count = st.running.len();
        let tiers = st.queued_tier_counts();
        format!(
            "cpu_seed={{queued_jobs:{} tiers=({},{},{}) decoding_active:{}}}",
            queued_jobs, tiers.high, tiers.middle, tiers.low, decoding_count,
        )
    } else {
        "cpu_seed={{not_started}}".to_string()
    };

    crate::app_deprintln!(
        "[analysis] queue_snapshot interval_s=60 note=queues_in_memory_cleared_on_app_restart | {http} | {cpu}"
    );
}

pub async fn analysis_queue_snapshot_loop() {
    emit_analysis_queue_snapshot_line();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        emit_analysis_queue_snapshot_line();
    }
}

async fn analysis_cpu_seed_worker_loop(
    app: tauri::AppHandle,
    shared: Arc<AnalysisCpuSeedShared>,
    mut wake_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    loop {
        if wake_rx.recv().await.is_none() {
            break;
        }
        spawn_cpu_seed_slots(&app, &shared).await;
    }
}

async fn spawn_cpu_seed_slots(app: &tauri::AppHandle, shared: &Arc<AnalysisCpuSeedShared>) {
    loop {
        let max = shared.max_parallel();
        let job_bundle = {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            if st.running.len() >= max {
                None
            } else {
                st.try_pop_next().map(|j| {
                    let followers = Arc::new(Mutex::new(Vec::new()));
                    let job_priority = j.priority;
                    let run_key = seed_revision_key(&j.server_id, &j.track_id, &j.revision);
                    st.running.insert(run_key.clone(), followers.clone());
                    st.running_tiers.insert(run_key, job_priority);
                    let worker_slot = st.running.len();
                    (j, worker_slot)
                })
            }
        };
        let Some((job, worker_slot)) = job_bundle else {
            break;
        };
        let tid_log = job.track_id.clone();
        let run_key_log = seed_revision_key(&job.server_id, &job.track_id, &job.revision);
        let fetch_ms = job.fetch_ms;
        crate::app_deprintln!(
            "[analysis] cpu-seed worker={}/{}: start track_id={}",
            worker_slot,
            max,
            tid_log
        );
        let app_for_decode = app.clone();
        let app_for_events = app.clone();
        let shared = shared.clone();
        let notify_ui = analysis_emits_ui_events(job.priority);
        tauri::async_runtime::spawn(async move {
            let sid = job.server_id.clone();
            let sid_for_event = sid.clone();
            let tid = job.track_id.clone();
            let tid_for_decode = tid.clone();
            let bytes = job.bytes;
            let format_hint = job.format_hint;
            let trusted_for_activation = job.trusted_revision.clone();
            let analysis_bytes_transcoded = job
                .trusted_revision
                .as_ref()
                .is_some_and(|trusted| trusted.analysis_bytes_transcoded);
            let trusted_md5_16kb = job
                .trusted_revision
                .as_ref()
                .map(|trusted| trusted.md5_16kb.clone());
            let trusted_generation = job
                .trusted_revision
                .as_ref()
                .map(|trusted| trusted.generation);
            let seed_result = tokio::task::spawn_blocking(move || {
                if analysis_bytes_transcoded {
                    let trusted = trusted_md5_16kb.as_deref().ok_or_else(|| {
                        "trusted analysis transcode missing original fingerprint".to_string()
                    })?;
                    analysis_cache::seed_transcoded_bytes_execute(
                        &app_for_decode,
                        &sid,
                        &tid_for_decode,
                        &bytes,
                        format_hint.as_deref(),
                        trusted,
                        trusted_generation.ok_or_else(|| {
                            "trusted analysis transcode missing generation".to_string()
                        })?,
                        notify_ui,
                    )
                } else {
                    analysis_cache::seed_from_bytes_execute(
                        &app_for_decode,
                        &sid,
                        &tid_for_decode,
                        &bytes,
                        format_hint.as_deref(),
                        trusted_md5_16kb.as_deref(),
                        trusted_generation,
                        notify_ui,
                    )
                }
            })
            .await
            .unwrap_or_else(|e| Err(format!("cpu-seed spawn_blocking: {e}")));

            if let (Some(trusted), Ok((outcome, _))) =
                (trusted_for_activation.as_ref(), seed_result.as_ref())
            {
                if matches!(
                    outcome,
                    analysis_cache::SeedFromBytesOutcome::Upserted
                        | analysis_cache::SeedFromBytesOutcome::SkippedWaveformCacheHit
                ) {
                    activate_trusted_identity(
                        &app_for_events,
                        &sid_for_event,
                        trusted
                            .content_hash_server_id
                            .as_deref()
                            .unwrap_or(&sid_for_event),
                        &tid,
                        &trusted.md5_16kb,
                        trusted.generation,
                    );
                }
            }

            let mut extra = {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.finish_running(&run_key_log)
            };
            for tx in job.waiters {
                let _ = tx.send(seed_result.clone());
            }
            for tx in extra.drain(..) {
                let _ = tx.send(seed_result.clone());
            }
            // Decode slot freed → wake HTTP backfill in case it was idling on
            // the `cpu_seed_pipeline_cap` backpressure check.
            if let Some(http) = ANALYSIS_BACKFILL.get() {
                http.ping_worker();
            }

            match &seed_result {
                Ok((outcome, timings)) => {
                    let ok = *outcome == analysis_cache::SeedFromBytesOutcome::Upserted;
                    emit_analysis_track_perf(
                        &app_for_events,
                        &tid_log,
                        fetch_ms,
                        timings.seed_ms,
                        timings.bpm_ms,
                    );
                    crate::app_deprintln!(
                        "[analysis] cpu-seed worker={}/{}: done track_id={} upserted={}",
                        worker_slot,
                        max,
                        tid_log,
                        ok
                    );
                    if ok && notify_ui {
                        let _ = app_for_events.emit(
                            "analysis:waveform-updated",
                            WaveformUpdatedPayload {
                                track_id: tid_log.clone(),
                                server_index_key: sid_for_event,
                                is_partial: false,
                            },
                        );
                    }
                }
                Err(e) => {
                    crate::app_eprintln!(
                        "[analysis] cpu-seed worker={}/{}: failed track_id={}: {e}",
                        worker_slot,
                        max,
                        tid_log
                    );
                }
            }
            shared.ping_worker();
        });
    }
}

/// Prune queued items in both analysis queues (HTTP backfill + CPU seed) whose
/// track ids are not in `keep_track_ids`. Items that are *currently running* are
/// untouched; only queued items are removed. Pruned CPU-seed waiters get an Err
/// indicating the prune.
///
/// Returns `(http_removed, cpu_removed_jobs, cpu_removed_waiters)`. Either
/// queue may not have been initialized yet — those slots return 0.
pub fn prune_analysis_queues(
    keep_track_ids: &HashSet<&str>,
    server_id: Option<&str>,
) -> Result<(usize, usize, usize), String> {
    let http_removed = if let Some(shared) = ANALYSIS_BACKFILL.get() {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis backfill lock poisoned".to_string())?;
        st.prune_queued_not_in(keep_track_ids, server_id)
    } else {
        0
    };

    let (cpu_removed_jobs, cpu_removed_waiters) = if let Some(shared) = ANALYSIS_CPU_SEED.get() {
        let mut st = shared
            .state
            .lock()
            .map_err(|_| "analysis cpu-seed lock poisoned".to_string())?;
        st.prune_queued_not_in(keep_track_ids, server_id)
    } else {
        (0, 0)
    };

    Ok((http_removed, cpu_removed_jobs, cpu_removed_waiters))
}

/// Submit full-buffer analysis; serializes with other producers. Priority mirrors
/// HTTP backfill tier ordering (high → middle → low).
///
/// Emits `analysis:waveform-updated` when analysis **wrote** new waveform data (`Upserted`).
/// Cache-hit skips (`SkippedWaveformCacheHit`) omit the event so the frontend does not
/// re-run loudness refresh / waveform IPC for rows that were already current.
#[allow(clippy::too_many_arguments)]
pub(super) async fn submit_analysis_cpu_seed(
    app: tauri::AppHandle,
    server_id: String,
    track_id: String,
    bytes: Vec<u8>,
    format_hint: Option<String>,
    trusted_revision: Option<TrustedAnalysisRevision>,
    priority: AnalysisBackfillPriority,
    fetch_ms: u64,
    cpu_admitted: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<analysis_cache::SeedFromBytesOutcome, String> {
    let shared = analysis_cpu_seed_shared(&app);
    let rx = {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let (kind, rx) = st.enqueue(
            server_id,
            track_id.clone(),
            bytes,
            format_hint,
            trusted_revision,
            priority,
            fetch_ms,
        );
        crate::app_deprintln!("[analysis] cpu-seed submit: kind={kind:?} priority={priority:?}");
        drop(st);
        shared.ping_worker();
        if let Some(admitted) = cpu_admitted {
            let _ = admitted.send(());
        }
        rx
    };
    let (outcome, _timings) = match rx.await {
        Ok(res) => res?,
        Err(_) => return Err("cpu-seed: result channel dropped".to_string()),
    };
    Ok(outcome)
}

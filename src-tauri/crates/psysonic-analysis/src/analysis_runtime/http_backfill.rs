use std::borrow::Cow;
use std::sync::Arc;

use super::backfill_queue::{AnalysisBackfillFinish, AnalysisBackfillShared};
use super::cpu_seed::{seed_key, ANALYSIS_CPU_SEED};
use super::enqueue::{analysis_backfill_resolve_priority, enqueue_track_analysis_with_fetch};
use super::types::EnqueueTrackAnalysisOutcome;

mod download;
pub(super) use download::*;

async fn process_analysis_backfill_job(
    app: &tauri::AppHandle,
    server_id: &str,
    track_id: &str,
    url: &str,
    cpu_admitted: tokio::sync::oneshot::Sender<()>,
) -> Result<bool, AnalysisBackfillJobError> {
    let download = analysis_backfill_download(
        app,
        server_id,
        track_id,
        url,
        ANALYSIS_BACKFILL_DOWNLOAD_MAX_BYTES,
    )
    .await?;
    let priority = analysis_backfill_resolve_priority(app, server_id, track_id, None);
    let AnalysisBackfillDownload {
        bytes,
        fetch_ms,
        format_hint,
        trusted_revision,
        trusted_fetch_permit,
    } = download;
    let outcome = enqueue_track_analysis_with_fetch(
        app,
        server_id,
        track_id,
        Cow::Owned(bytes),
        format_hint.as_deref(),
        trusted_revision,
        priority,
        fetch_ms,
        Some(cpu_admitted),
    )
    .await
    .map_err(AnalysisBackfillJobError::Retryable);
    drop(trusted_fetch_permit);
    let outcome = outcome?;
    Ok(!matches!(outcome, EnqueueTrackAnalysisOutcome::Complete))
}

fn release_backfill_reservation(
    shared: &AnalysisBackfillShared,
    server_id: &str,
    track_id: &str,
    finish: AnalysisBackfillFinish,
) {
    {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.finish_job(&seed_key(server_id, track_id), finish);
    }
    shared.ping_worker();
}

fn mark_backfill_cpu_admitted(shared: &AnalysisBackfillShared, server_id: &str, track_id: &str) {
    {
        let mut state = shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.mark_cpu_admitted(&seed_key(server_id, track_id));
    }
    shared.ping_worker();
}

pub(super) async fn analysis_backfill_worker_loop(
    app: tauri::AppHandle,
    shared: Arc<AnalysisBackfillShared>,
    mut wake_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    loop {
        if wake_rx.recv().await.is_none() {
            break;
        }
        spawn_backfill_slots(&app, &shared).await;
    }
}

/// Queued + currently-decoding CPU-seed jobs. Each retains the full track
/// byte buffer, so this counter approximates pipeline memory pressure.
fn cpu_seed_pipeline_load() -> usize {
    let Some(shared) = ANALYSIS_CPU_SEED.get() else {
        return 0;
    };
    let st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    st.queued_len() + st.running.len()
}

/// Soft cap on in-flight CPU-seed jobs (queued + running). When reached, the
/// HTTP backfill worker idles to keep decoded `Vec<u8>` buffers from piling up
/// faster than Symphonia + R128 can drain them. Floor of 2 covers `workers=1`.
pub(super) fn cpu_seed_pipeline_cap(max_parallel: usize) -> usize {
    max_parallel.saturating_mul(2).max(2)
}

/// Decide whether the HTTP backfill worker should idle right now. Active HTTP
/// downloads reserve their prospective CPU-buffer slots before another job is
/// popped. High-tier work gets one slot beyond the ordinary cap.
pub(super) fn should_idle_for_cpu_backpressure(
    cpu_load: usize,
    http_active: usize,
    cpu_cap: usize,
    high_pending: bool,
) -> bool {
    let admission_cap = cpu_cap.saturating_add(usize::from(high_pending));
    cpu_load.saturating_add(http_active) >= admission_cap
}

async fn spawn_backfill_slots(app: &tauri::AppHandle, shared: &Arc<AnalysisBackfillShared>) {
    loop {
        let max = shared.max_parallel();
        // Backpressure against the CPU-seed pipeline: downloaded track bytes
        // (Vec<u8>, tens of MB for FLAC) sit in `AnalysisCpuSeedJob.bytes` until
        // Symphonia decode + R128 finish — much slower than HTTP. Without a cap,
        // aggressive library backfill on large libraries grows RAM unbounded.
        // High-tier (now-playing) jobs get one reserved slot beyond the normal
        // cap, but cannot grow an unbounded backlog during rapid track skips.
        let cpu_load = cpu_seed_pipeline_load();
        let cpu_cap = cpu_seed_pipeline_cap(max);
        let job_bundle = {
            let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
            st.try_pop_next_with_cpu_backpressure(max, cpu_load, cpu_cap)
                .map(|job| {
                    let worker_slot = st.in_progress.len();
                    (job, worker_slot)
                })
        };
        let Some(((track_id, url, server_id), worker_slot)) = job_bundle else {
            if cpu_load >= cpu_cap {
                crate::app_deprintln!(
                    "[analysis] backfill idle: cpu_seed pipeline_load={} cap={} (waiting for decode catch-up)",
                    cpu_load,
                    cpu_cap
                );
            }
            break;
        };
        crate::app_deprintln!(
            "[analysis] backfill worker={}/{}: start track_id={}",
            worker_slot,
            max,
            track_id
        );
        let app = app.clone();
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            // Keep the HTTP reservation through capability/provenance checks,
            // the full raw fetch, and CPU queue admission. Releasing it earlier
            // allows a duplicate full download before the CPU queue sees the job.
            let (cpu_admitted_tx, cpu_admitted_rx) = tokio::sync::oneshot::channel();
            let process =
                process_analysis_backfill_job(&app, &server_id, &track_id, &url, cpu_admitted_tx);
            tokio::pin!(process);
            let result = tokio::select! {
                biased;
                result = &mut process => result,
                Ok(()) = cpu_admitted_rx => {
                    mark_backfill_cpu_admitted(&shared, &server_id, &track_id);
                    process.await
                }
            };
            release_backfill_reservation(
                &shared,
                &server_id,
                &track_id,
                match &result {
                    Ok(_) => AnalysisBackfillFinish::Success,
                    Err(error) if error.is_superseded() => AnalysisBackfillFinish::Success,
                    Err(error) if error.is_retryable() => AnalysisBackfillFinish::RetryableFailure,
                    Err(_) => AnalysisBackfillFinish::TerminalFailure,
                },
            );

            match &result {
                Ok(has_loudness) => crate::app_deprintln!(
                    "[analysis] backfill worker={}/{}: ready track_id={} has_loudness={}",
                    worker_slot,
                    max,
                    track_id,
                    has_loudness
                ),
                Err(error) if error.is_superseded() => crate::app_deprintln!(
                    "[analysis] backfill worker={}/{}: skipped stale track_id={}",
                    worker_slot,
                    max,
                    track_id,
                ),
                Err(e) => crate::app_eprintln!(
                    "[analysis] backfill worker={}/{}: failed track_id={}: {}",
                    worker_slot,
                    max,
                    track_id,
                    e
                ),
            }
        });
    }
}

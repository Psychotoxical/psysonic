//! Native library analysis backfill coordinator (advanced strategy).
//!
//! Replaces the webview `while` loop: top-up HTTP/CPU seed backlog without
//! blocking the UI on `library_analysis_backfill_batch` IPC.
//!
//! The coordinator task **parks** on a `Notify` until Advanced analytics is
//! configured or library sync goes idle — no idle 2 s polling while disabled.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use psysonic_analysis::analysis_runtime::{
    analysis_pipeline_queue_stats, analysis_set_pipeline_parallelism, enqueue_seed_from_url,
    AnalysisBackfillPriority,
};
use psysonic_integration::subsonic::build_stream_view_url;
use psysonic_library::analysis_backfill::{
    collect_analysis_backfill_batch, collect_analysis_progress, AnalysisBackfillScanPhase,
    LibraryAnalysisBackfillBatchDto,
};
use psysonic_library::analysis_backfill_policy::{
    library_backfill_needs_top_up, library_backfill_top_up_limit, PipelineBacklogCounts,
};
use psysonic_library::library_readiness::library_server_is_ready;
use psysonic_library::payload::LibrarySyncProgressPayload;
use psysonic_library::repos::TrackRepository;
use psysonic_library::LibraryRuntime;
use serde::Deserialize;
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{Mutex, Notify};

const TOP_UP_POLL_MS: u64 = 500;
const STEADY_POLL_MS: u64 = 2000;
const READY_POLL_MS: u64 = 5000;
const EXHAUSTED_PAUSE_MS: u64 = 15_000;
const EXHAUSTED_PENDING_RESCAN_MS: u64 = 2000;
const COMPLETED_RECHECK_MS: u64 = 300_000;
const EXHAUSTED_DONE_STREAK: u32 = 2;
const SYNC_WAIT_MS: u64 = 5000;

#[derive(Clone)]
pub struct LibraryAnalysisBackfillSession {
    pub server_index_key: String,
    pub library_server_id: String,
    pub server_url: String,
    pub username: String,
    pub password: String,
    pub workers: u32,
}

pub struct LibraryAnalysisBackfillWorker {
    pub enabled: AtomicBool,
    /// Wakes the coordinator task (configure, sync-idle, disable→enable).
    wake: Notify,
    session: Mutex<Option<LibraryAnalysisBackfillSession>>,
    cursor: Mutex<Option<String>>,
    scan_phase: Mutex<AnalysisBackfillScanPhase>,
    completed_total: Mutex<Option<i64>>,
    exhausted_streak: Mutex<u32>,
}

impl LibraryAnalysisBackfillWorker {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            wake: Notify::new(),
            session: Mutex::new(None),
            cursor: Mutex::new(None),
            scan_phase: Mutex::new(AnalysisBackfillScanPhase::Candidates),
            completed_total: Mutex::new(None),
            exhausted_streak: Mutex::new(0),
        }
    }

    fn ping_coordinator(&self) {
        self.wake.notify_waiters();
    }

    pub async fn set_session(&self, enabled: bool, session: Option<LibraryAnalysisBackfillSession>) {
        self.enabled.store(enabled, Ordering::Relaxed);
        *self.session.lock().await = session;
        if !enabled {
            *self.cursor.lock().await = None;
            *self.scan_phase.lock().await = AnalysisBackfillScanPhase::Candidates;
            *self.completed_total.lock().await = None;
            *self.exhausted_streak.lock().await = 0;
        }
        self.ping_coordinator();
    }
}

async fn session_still_focused(
    worker: &LibraryAnalysisBackfillWorker,
    expected: &LibraryAnalysisBackfillSession,
) -> bool {
    if !worker.enabled.load(Ordering::Relaxed) {
        return false;
    }
    worker
        .session
        .lock()
        .await
        .as_ref()
        .is_some_and(|s| s.server_index_key == expected.server_index_key)
}

fn sync_blocks_backfill(store: &psysonic_library::store::LibraryStore, server_id: &str) -> bool {
    use psysonic_library::repos::sync_state::SyncStateRepository;
    let repo = SyncStateRepository::new(store);
    match repo.get_sync_phase(server_id, "") {
        Ok(Some(phase)) => phase == "initial_sync" || phase == "probing",
        _ => false,
    }
}

fn session_matches_server(session: &LibraryAnalysisBackfillSession, server_id: &str) -> bool {
    server_id == session.server_index_key || server_id == session.library_server_id
}

enum CoordinatorStep {
    Sleep(Duration),
    /// Park until configure or sync-idle wakes the task (no idle polling).
    Park,
}

async fn coordinator_sleep(worker: &LibraryAnalysisBackfillWorker, duration: Duration) {
    if duration.is_zero() {
        return;
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => {}
        _ = worker.wake.notified() => {}
    }
}

async fn run_coordinator_forever(app: AppHandle, worker: Arc<LibraryAnalysisBackfillWorker>) {
    loop {
        while !worker.enabled.load(Ordering::Relaxed) {
            worker.wake.notified().await;
        }

        loop {
            if !worker.enabled.load(Ordering::Relaxed) {
                break;
            }
            match coordinator_tick(&app, worker.as_ref()).await {
                CoordinatorStep::Park => break,
                CoordinatorStep::Sleep(duration) => {
                    coordinator_sleep(worker.as_ref(), duration).await;
                }
            }
        }
    }
}

async fn coordinator_tick(
    app: &AppHandle,
    worker: &LibraryAnalysisBackfillWorker,
) -> CoordinatorStep {
    if !worker.enabled.load(Ordering::Relaxed) {
        return CoordinatorStep::Park;
    }

    let session = worker.session.lock().await.clone();
    let Some(session) = session else {
        return CoordinatorStep::Park;
    };

    if !session_still_focused(worker, &session).await {
        return CoordinatorStep::Park;
    }

    analysis_set_pipeline_parallelism(session.workers as usize);

    let runtime = match app.try_state::<LibraryRuntime>() {
        Some(r) => r,
        None => return CoordinatorStep::Sleep(Duration::from_millis(READY_POLL_MS)),
    };

    if let Some(done_total) = *worker.completed_total.lock().await {
        let store = runtime.store.clone();
        let lib_id = session.library_server_id.clone();
        let still_same = tauri::async_runtime::spawn_blocking(move || {
            TrackRepository::new(&store)
                .count_live_tracks(&lib_id)
                .map(|n| n == done_total)
        })
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false);
        if still_same {
            return CoordinatorStep::Sleep(Duration::from_millis(COMPLETED_RECHECK_MS));
        }
        *worker.completed_total.lock().await = None;
        *worker.cursor.lock().await = None;
        *worker.scan_phase.lock().await = AnalysisBackfillScanPhase::Candidates;
        *worker.exhausted_streak.lock().await = 0;
    }

    while sync_blocks_backfill(&runtime.store, &session.library_server_id) {
        if !worker.enabled.load(Ordering::Relaxed) {
            return CoordinatorStep::Park;
        }
        coordinator_sleep(worker, Duration::from_millis(SYNC_WAIT_MS)).await;
    }

    let store = runtime.store.clone();
    let lib_id = session.library_server_id.clone();
    let ready = tauri::async_runtime::spawn_blocking(move || library_server_is_ready(&store, &lib_id))
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false);
    if !ready {
        return CoordinatorStep::Sleep(Duration::from_millis(READY_POLL_MS));
    }

    let stats = analysis_pipeline_queue_stats();
    let counts = PipelineBacklogCounts {
        http_queued: stats.http_queued as u32,
        http_download_active: stats.http_download_active as u32,
        cpu_queued: stats.cpu_queued as u32,
        cpu_decode_active: stats.cpu_decode_active as u32,
    };

    if !library_backfill_needs_top_up(counts, session.workers) {
        return CoordinatorStep::Sleep(Duration::from_millis(STEADY_POLL_MS));
    }

    let fetch_limit = library_backfill_top_up_limit(counts, session.workers);
    if fetch_limit == 0 {
        return CoordinatorStep::Sleep(Duration::from_millis(TOP_UP_POLL_MS));
    }

    let cursor = worker.cursor.lock().await.clone();
    let phase = *worker.scan_phase.lock().await;
    let app_for_batch = app.clone();
    let lib_id = session.library_server_id.clone();
    let batch: Option<(LibraryAnalysisBackfillBatchDto, AnalysisBackfillScanPhase)> =
        tauri::async_runtime::spawn_blocking(move || {
            let runtime = app_for_batch
                .try_state::<LibraryRuntime>()
                .ok_or_else(|| "LibraryRuntime not available".to_string())?;
            collect_analysis_backfill_batch(
                &app_for_batch,
                &runtime,
                lib_id.trim(),
                phase,
                cursor.as_deref().filter(|s| !s.is_empty()),
                Some(fetch_limit),
            )
        })
        .await
        .ok()
        .and_then(|r| r.ok());

    let Some((batch, next_phase)) = batch else {
        return CoordinatorStep::Sleep(Duration::from_millis(TOP_UP_POLL_MS));
    };

    *worker.cursor.lock().await = batch.next_cursor.clone();
    *worker.scan_phase.lock().await = next_phase;

    let enqueued_count = batch.track_ids.len();
    let track_ids = batch.track_ids.clone();
    let index_key = session.server_index_key.clone();
    let server_url = session.server_url.clone();
    let username = session.username.clone();
    let password = session.password.clone();
    let app_for_enqueue = app.clone();

    let _ = tauri::async_runtime::spawn_blocking(move || {
        for track_id in &track_ids {
            let url = build_stream_view_url(&server_url, &username, &password, track_id);
            let _ = enqueue_seed_from_url(
                &app_for_enqueue,
                track_id,
                &url,
                Some(index_key.as_str()),
                Some(AnalysisBackfillPriority::Low),
                false,
            );
        }
    })
    .await;

    if enqueued_count > 0 {
        *worker.exhausted_streak.lock().await = 0;
    }

    if batch.exhausted {
        let app_for_progress = app.clone();
        let lib_id = session.library_server_id.clone();
        let progress = tauri::async_runtime::spawn_blocking(move || {
            let runtime = app_for_progress
                .try_state::<LibraryRuntime>()
                .ok_or_else(|| "LibraryRuntime not available".to_string())?;
            collect_analysis_progress(&app_for_progress, &runtime, lib_id.trim())
        })
        .await
        .ok()
        .and_then(|r| r.ok());

        let pending = progress.as_ref().map(|p| p.pending_tracks).unwrap_or(-1);
        if pending <= 0 && enqueued_count == 0 {
            let mut streak = worker.exhausted_streak.lock().await;
            *streak += 1;
            if *streak >= EXHAUSTED_DONE_STREAK {
                if let Some(p) = progress {
                    *worker.completed_total.lock().await = Some(p.total_tracks);
                }
                *worker.cursor.lock().await = None;
                *worker.scan_phase.lock().await = AnalysisBackfillScanPhase::Candidates;
                return CoordinatorStep::Sleep(Duration::from_millis(COMPLETED_RECHECK_MS));
            }
        } else {
            *worker.exhausted_streak.lock().await = 0;
        }
        if pending > 0 {
            *worker.cursor.lock().await = None;
            *worker.scan_phase.lock().await = AnalysisBackfillScanPhase::Candidates;
            return CoordinatorStep::Sleep(Duration::from_millis(EXHAUSTED_PENDING_RESCAN_MS));
        }
        *worker.cursor.lock().await = None;
        *worker.scan_phase.lock().await = AnalysisBackfillScanPhase::Candidates;
        return CoordinatorStep::Sleep(Duration::from_millis(EXHAUSTED_PAUSE_MS));
    }

    CoordinatorStep::Sleep(Duration::from_millis(TOP_UP_POLL_MS))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncIdlePayload {
    server_id: String,
    ok: bool,
}

fn on_sync_idle(app: &AppHandle, payload: SyncIdlePayload) {
    if !payload.ok {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker = match app.try_state::<Arc<LibraryAnalysisBackfillWorker>>() {
            Some(w) => w.inner().clone(),
            None => return,
        };
        if !worker.enabled.load(Ordering::Relaxed) {
            return;
        }
        let session = worker.session.lock().await.clone();
        let Some(session) = session else {
            return;
        };
        if !session_matches_server(&session, &payload.server_id) {
            return;
        }
        *worker.cursor.lock().await = None;
        *worker.scan_phase.lock().await = AnalysisBackfillScanPhase::Candidates;
        *worker.exhausted_streak.lock().await = 0;
        worker.ping_coordinator();
    });
}

pub fn setup_library_sync_idle_listener(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.listen(LibrarySyncProgressPayload::IDLE_EVENT_NAME, move |event| {
        let Ok(payload) = serde_json::from_str::<SyncIdlePayload>(event.payload()) else {
            return;
        };
        on_sync_idle(&app_handle, payload);
    });
}

pub fn spawn_coordinator(app: &AppHandle, worker: Arc<LibraryAnalysisBackfillWorker>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_coordinator_forever(app, worker).await;
    });
}

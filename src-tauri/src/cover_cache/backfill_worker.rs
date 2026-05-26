//! Library cover backfill — one background pass per wake (native, not webview timers).

use super::{state, CoverCacheEnsureArgs, CoverCacheState};
use psysonic_library::cover_backfill::{
    clear_cover_fetch_failures, collect_cover_backfill_batch, collect_cover_progress,
    LibraryCoverBackfillBatchDto, LIBRARY_COVER_CANONICAL_TIER,
};
use psysonic_library::payload::LibrarySyncProgressPayload;
use psysonic_library::repos::sync_state::SyncStateRepository;
use psysonic_library::LibraryRuntime;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::{Mutex, Semaphore};

use super::{count_cached_cover_ids, dir_usage_for_server};

/// Concurrent library downloads (encode runs on blocking pool; no webview tier events).
const LIBRARY_BACKFILL_PARALLEL: usize = 4;
const BATCH_SIZE: u32 = 24;
const PENDING_RESTART_THRESHOLD: i64 = 32;
const SYNC_WAIT_MS: u64 = 5000;
const PROGRESS_EVERY_BATCHES: u32 = 8;

#[derive(Clone)]
pub struct CoverBackfillSession {
    pub server_index_key: String,
    pub library_server_id: String,
    pub rest_base_url: String,
    pub username: String,
    pub password: String,
}

pub struct CoverBackfillWorker {
    pub enabled: AtomicBool,
    /// When true, the active pass yields so visible-route cover IPC is not starved.
    pub ui_priority_hold: AtomicBool,
    session: Mutex<Option<CoverBackfillSession>>,
    cursor: Mutex<String>,
    pass_running: AtomicBool,
    backfill_http: Arc<Semaphore>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverBackfillPulseDto {
    pub scheduled: u32,
    pub exhausted: bool,
    pub pending: i64,
    pub done: i64,
    pub total: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverBackfillRunDto {
    pub started: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncIdlePayload {
    server_id: String,
    ok: bool,
}

impl CoverBackfillWorker {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            ui_priority_hold: AtomicBool::new(false),
            session: Mutex::new(None),
            cursor: Mutex::new(String::new()),
            pass_running: AtomicBool::new(false),
            backfill_http: Arc::new(Semaphore::new(LIBRARY_BACKFILL_PARALLEL)),
        }
    }

    pub fn set_ui_priority_hold(&self, hold: bool) {
        self.ui_priority_hold.store(hold, Ordering::Relaxed);
    }

    pub async fn set_session(&self, enabled: bool, session: Option<CoverBackfillSession>) {
        self.enabled.store(enabled, Ordering::Relaxed);
        *self.session.lock().await = session;
        if !enabled {
            *self.cursor.lock().await = String::new();
        }
    }

    pub async fn reset_cursor(&self) {
        *self.cursor.lock().await = String::new();
    }
}

fn sync_allows_cover_backfill(store: &psysonic_library::store::LibraryStore, server_id: &str) -> bool {
    let repo = SyncStateRepository::new(store);
    match repo.get_sync_phase(server_id, "") {
        Ok(Some(phase)) => phase != "initial_sync" && phase != "probing",
        _ => true,
    }
}

fn session_matches_server(session: &CoverBackfillSession, server_id: &str) -> bool {
    server_id == session.server_index_key || server_id == session.library_server_id
}

/// Backfill runs only while this session is still the configured focus (active server).
async fn session_still_focused(worker: &CoverBackfillWorker, expected: &CoverBackfillSession) -> bool {
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

async fn progress_snapshot(
    store: &psysonic_library::store::LibraryStore,
    root: &std::path::Path,
    library_server_id: &str,
    server_index_key: &str,
) -> Result<(i64, i64, i64), String> {
    let cached = count_cached_cover_ids(root, server_index_key);
    let p = collect_cover_progress(store, library_server_id, root, server_index_key, cached)?;
    Ok((p.done, p.total_distinct, p.pending))
}

async fn emit_library_progress(
    app: &AppHandle,
    session: &CoverBackfillSession,
    done: i64,
    total: i64,
    pending: i64,
    root: &std::path::Path,
) {
    let (bytes, entry_count) = dir_usage_for_server(root, &session.server_index_key);
    let _ = app.emit(
        "cover:library-progress",
        serde_json::json!({
            "serverIndexKey": session.server_index_key,
            "done": done,
            "total": total,
            "pending": pending,
            "bytes": bytes,
            "entryCount": entry_count,
        }),
    );
}

async fn ensure_one(
    worker: &CoverBackfillWorker,
    st: Arc<tokio::sync::Mutex<CoverCacheState>>,
    http_sem: Arc<Semaphore>,
    app: AppHandle,
    session: CoverBackfillSession,
    cover_art_id: String,
) {
    if worker.ui_priority_hold.load(Ordering::Relaxed) {
        return;
    }
    let args = CoverCacheEnsureArgs {
        server_index_key: session.server_index_key,
        cover_art_id,
        tier: LIBRARY_COVER_CANONICAL_TIER,
        rest_base_url: session.rest_base_url,
        username: session.username,
        password: session.password,
        library_bulk: true,
    };
    let _ = CoverCacheState::ensure_inner(&st, &app, &args, Some(http_sem)).await;
}

async fn run_full_pass(app: AppHandle, worker: Arc<CoverBackfillWorker>) {
    if !worker.enabled.load(Ordering::Relaxed) {
        return;
    }
    let session = worker.session.lock().await.clone();
    let Some(session) = session else {
        return;
    };

    let runtime = match app.try_state::<LibraryRuntime>() {
        Some(r) => r,
        None => return,
    };

    while !sync_allows_cover_backfill(&runtime.store, &session.library_server_id) {
        if !worker.enabled.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(SYNC_WAIT_MS)).await;
    }

    let st = match state(&app) {
        Ok(s) => s,
        Err(_) => return,
    };
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let st_arc = st.clone();

    worker.reset_cursor().await;
    let http_sem = worker.backfill_http.clone();
    let mut batch_count = 0u32;

    loop {
        if !session_still_focused(&worker, &session).await {
            break;
        }

        if worker.ui_priority_hold.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }

        let cursor = worker.cursor.lock().await.clone();
        let cursor_opt = if cursor.is_empty() {
            None
        } else {
            Some(cursor)
        };
        let store = runtime.store.clone();
        let lib_id = session.library_server_id.clone();
        let index_key = session.server_index_key.clone();
        let root_for_batch = root.clone();

        let batch: Option<LibraryCoverBackfillBatchDto> =
            match tauri::async_runtime::spawn_blocking(move || {
                collect_cover_backfill_batch(
                    &store,
                    &lib_id,
                    &root_for_batch,
                    &index_key,
                    cursor_opt.as_deref(),
                    Some(BATCH_SIZE),
                )
            })
            .await
            {
                Ok(Ok(b)) => Some(b),
                _ => None,
            };

        let Some(batch) = batch else {
            break;
        };

        batch_count += 1;
        if !session_still_focused(&worker, &session).await {
            break;
        }
        let ids = batch.cover_ids.clone();
        let mut paused_for_ui_priority = false;
        let mut set = tokio::task::JoinSet::new();
        for id in ids {
            if worker.ui_priority_hold.load(Ordering::Relaxed) {
                paused_for_ui_priority = true;
                break;
            }
            let st = st_arc.clone();
            let http_sem = http_sem.clone();
            let app = app.clone();
            let session = session.clone();
            let worker_arc = worker.clone();
            set.spawn(async move {
                ensure_one(worker_arc.as_ref(), st, http_sem, app, session, id).await;
            });
        }
        while set.join_next().await.is_some() {}
        if paused_for_ui_priority || worker.ui_priority_hold.load(Ordering::Relaxed) {
            continue;
        }

        if batch_count.is_multiple_of(PROGRESS_EVERY_BATCHES) {
            if let Ok((done, total, pending)) = progress_snapshot(
                &runtime.store,
                &root,
                &session.library_server_id,
                &session.server_index_key,
            )
            .await
            {
                emit_library_progress(&app, &session, done, total, pending, &root).await;
            }
        }

        if batch.exhausted {
            worker.cursor.lock().await.clear();
            if let Ok((done, total, pending)) = progress_snapshot(
                &runtime.store,
                &root,
                &session.library_server_id,
                &session.server_index_key,
            )
            .await
            {
                if pending > PENDING_RESTART_THRESHOLD {
                    let root3 = root.clone();
                    let index_key3 = session.server_index_key.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        clear_cover_fetch_failures(&root3, &index_key3)
                    })
                    .await;
                }
                emit_library_progress(&app, &session, done, total, pending, &root).await;
            }
            break;
        }

        if let Some(next) = batch.next_cursor {
            *worker.cursor.lock().await = next;
        }
    }
}

/// Start one full-catalog pass on the Tokio runtime (survives inactive webview).
pub async fn try_schedule_full_pass(app: &AppHandle) -> bool {
    let worker = match app.try_state::<Arc<CoverBackfillWorker>>() {
        Some(w) => w.inner().clone(),
        None => return false,
    };
    if !worker.enabled.load(Ordering::Relaxed) {
        return false;
    }
    if worker
        .pass_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return false;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_full_pass(app, worker.clone()).await;
        worker.pass_running.store(false, Ordering::SeqCst);
    });
    true
}

fn on_sync_idle(app: &AppHandle, payload: SyncIdlePayload) {
    if !payload.ok {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker = match app.try_state::<Arc<CoverBackfillWorker>>() {
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
        let _ = try_schedule_full_pass(&app).await;
    });
}

/// Listen for library sync completion in native code (not throttled with the webview).
pub fn setup_library_sync_idle_listener(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.listen(LibrarySyncProgressPayload::IDLE_EVENT_NAME, move |event| {
        let Ok(payload) = serde_json::from_str::<SyncIdlePayload>(event.payload()) else {
            return;
        };
        on_sync_idle(&app_handle, payload);
    });
}

/// Legacy single-step API (optional diagnostics).
pub async fn pulse_backfill(app: &AppHandle, _worker: &Arc<CoverBackfillWorker>) -> CoverBackfillPulseDto {
    if try_schedule_full_pass(app).await {
        return CoverBackfillPulseDto {
            scheduled: 0,
            exhausted: false,
            pending: 0,
            done: 0,
            total: 0,
            status: "active".into(),
        };
    }
    CoverBackfillPulseDto {
        scheduled: 0,
        exhausted: true,
        pending: 0,
        done: 0,
        total: 0,
        status: "disabled".into(),
    }
}

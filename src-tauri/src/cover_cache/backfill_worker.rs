//! Library cover backfill — one background pass per wake (native, not webview timers).

use super::{state, CoverCacheEnsureArgs, CoverCacheState};
use psysonic_library::cover_backfill::{
    clear_cover_fetch_failures, collect_cover_progress, diff_missing_against_snapshot,
    fetch_all_catalog_rows, snapshot_cover_disk, LIBRARY_COVER_CANONICAL_TIER,
};
use psysonic_library::payload::LibrarySyncProgressPayload;
use psysonic_library::repos::sync_state::SyncStateRepository;
use psysonic_library::LibraryRuntime;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::sync::{Mutex, Semaphore};

use super::{count_cached_cover_ids, dir_usage_for_server};

/// Default concurrent library downloads + encodes. Runtime-tunable via the
/// perf probe (`set_parallel`); the constant is only the startup value.
const LIBRARY_BACKFILL_PARALLEL_DEFAULT: usize = 2;
/// Bounds for the runtime knob — keep it sane so a stray value cannot DoS the
/// host or starve the audio path.
pub const LIBRARY_BACKFILL_PARALLEL_MIN: usize = 1;
pub const LIBRARY_BACKFILL_PARALLEL_MAX: usize = 16;
/// Raw catalog rows diffed per streaming chunk. Small enough that downloads
/// start almost immediately after the one-shot enumeration, large enough to
/// amortize the per-chunk `spawn_blocking` hop.
const SCAN_CHUNK_ROWS: usize = 512;
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

/// Catalog snapshot captured when a full pass ends with nothing left pending.
///
/// While the live signature still matches, a `library:sync-idle` must NOT
/// re-trigger a whole-catalog rescan — this mirrors the analysis coordinator's
/// `completed_total` gate (`library_analysis_backfill/worker.rs`). A real
/// catalog change (track add/remove shifts `total`) or a cover-cache clear
/// (drops `done`) changes the signature and re-arms the next pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CoverIdleSignature {
    total: i64,
    done: i64,
}

pub struct CoverBackfillWorker {
    pub enabled: AtomicBool,
    /// When true, the active pass yields so visible-route cover IPC is not starved.
    pub ui_priority_hold: AtomicBool,
    session: Mutex<Option<CoverBackfillSession>>,
    cursor: Mutex<String>,
    pass_running: AtomicBool,
    backfill_http: Arc<Semaphore>,
    /// Live download/encode concurrency for backfill passes. Mirrors the
    /// `backfill_http` permit count and gates per-batch `ensure_one` tasks.
    parallel: AtomicUsize,
    /// Set when a pass found nothing pending; suppresses idle-driven rescans
    /// until the catalog signature changes. `None` means "re-armed".
    settled: Mutex<Option<CoverIdleSignature>>,
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
            backfill_http: Arc::new(Semaphore::new(LIBRARY_BACKFILL_PARALLEL_DEFAULT)),
            parallel: AtomicUsize::new(LIBRARY_BACKFILL_PARALLEL_DEFAULT),
            settled: Mutex::new(None),
        }
    }

    pub fn set_ui_priority_hold(&self, hold: bool) {
        self.ui_priority_hold.store(hold, Ordering::Relaxed);
    }

    /// Current backfill download/encode concurrency.
    pub fn parallel(&self) -> usize {
        self.parallel.load(Ordering::Relaxed).max(LIBRARY_BACKFILL_PARALLEL_MIN)
    }

    /// Retune backfill concurrency at runtime. Resizes the shared HTTP permit
    /// pool to match (next batch picks up the new per-batch slot count). Returns
    /// the clamped value actually applied.
    pub fn set_parallel(&self, threads: usize) -> usize {
        let next = threads.clamp(LIBRARY_BACKFILL_PARALLEL_MIN, LIBRARY_BACKFILL_PARALLEL_MAX);
        let prev = self.parallel.swap(next, Ordering::SeqCst);
        if next > prev {
            self.backfill_http.add_permits(next - prev);
        } else if next < prev {
            // Shrinking: drain surplus permits as they free up so in-flight
            // fetches finish but no new ones start beyond the new cap.
            let sem = self.backfill_http.clone();
            let surplus = prev - next;
            tauri::async_runtime::spawn(async move {
                for _ in 0..surplus {
                    if let Ok(permit) = sem.acquire().await {
                        permit.forget();
                    }
                }
            });
        }
        next
    }

    pub async fn set_session(&self, enabled: bool, session: Option<CoverBackfillSession>) {
        self.enabled.store(enabled, Ordering::Relaxed);
        *self.session.lock().await = session;
        // Server switch or enable/disable invalidates any settled state: re-arm
        // so the next idle event runs a real pass for the new focus.
        *self.settled.lock().await = None;
        if !enabled {
            *self.cursor.lock().await = String::new();
        }
    }

    pub async fn reset_cursor(&self) {
        *self.cursor.lock().await = String::new();
    }

    /// Semaphore-backed library backfill HTTP slots (perf probe).
    pub fn pipeline_http_stats(&self) -> (u32, u32, bool) {
        let max = self.parallel() as u32;
        let active = max.saturating_sub(self.backfill_http.available_permits() as u32);
        let pass_running = self.pass_running.load(Ordering::Relaxed);
        (max, active, pass_running)
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
    item: psysonic_library::cover_backfill::CoverBackfillItem,
) {
    if worker.ui_priority_hold.load(Ordering::Relaxed) {
        return;
    }
    let args = CoverCacheEnsureArgs {
        server_index_key: session.server_index_key,
        cache_kind: item.cache_kind,
        cache_entity_id: item.cache_entity_id,
        cover_art_id: item.fetch_cover_art_id,
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

    // Two snapshots, taken ONCE per pass: the DB catalog (single GROUP BY) and
    // the on-disk cover bucket (one directory walk). The delta = catalog minus
    // disk, streamed in chunks below. No per-row `stat` on the filesystem and no
    // re-scan loop — pure set math against the captured disk snapshot.
    let (raw_rows, snapshot) = {
        let store = runtime.store.clone();
        let lib_id = session.library_server_id.clone();
        let root_for_scan = root.clone();
        let index_key = session.server_index_key.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            let rows = fetch_all_catalog_rows(&store, &lib_id)?;
            let snap = snapshot_cover_disk(&root_for_scan, &index_key);
            Ok::<_, String>((rows, snap))
        })
        .await
        {
            Ok(Ok(pair)) => pair,
            _ => (Vec::new(), Default::default()),
        }
    };
    let snapshot = Arc::new(snapshot);

    // Producer/consumer: a fixed pool of consumer tasks pulls misses off a
    // bounded channel and downloads them continuously, while the producer scans
    // the catalog in chunks and feeds misses in. This keeps the pool saturated
    // even when misses are sparse across chunks — no per-chunk drain barrier.
    // True concurrency stays governed by the resizable `http_sem` / encode
    // semaphores inside `ensure_one`, so the threads slider still applies live.
    let (tx, rx) =
        tokio::sync::mpsc::channel::<psysonic_library::cover_backfill::CoverBackfillItem>(256);
    let rx = Arc::new(Mutex::new(rx));
    let mut consumers = tokio::task::JoinSet::new();
    for _ in 0..LIBRARY_BACKFILL_PARALLEL_MAX {
        let rx = rx.clone();
        let st = st_arc.clone();
        let http_sem = http_sem.clone();
        let app = app.clone();
        let session = session.clone();
        let worker_arc = worker.clone();
        consumers.spawn(async move {
            loop {
                // Bail the moment the strategy flips to lazy / focus changes, so a
                // switch to "lazy" abandons the buffered backlog instead of
                // draining the whole channel (mirrors the producer's check).
                if !session_still_focused(&worker_arc, &session).await {
                    break;
                }
                let item = {
                    let mut guard = rx.lock().await;
                    guard.recv().await
                };
                let Some(item) = item else { break };
                ensure_one(
                    worker_arc.as_ref(),
                    st.clone(),
                    http_sem.clone(),
                    app.clone(),
                    session.clone(),
                    item,
                )
                .await;
            }
        });
    }

    let mut rows_iter = raw_rows.into_iter();
    let mut chunk_count = 0u32;
    let mut completed = false;
    loop {
        if !session_still_focused(&worker, &session).await {
            break;
        }
        if worker.ui_priority_hold.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }

        let scan_chunk: Vec<_> = rows_iter.by_ref().take(SCAN_CHUNK_ROWS).collect();
        if scan_chunk.is_empty() {
            completed = true;
            break;
        }
        chunk_count += 1;

        // Diff this chunk against the captured snapshot off-thread (in-memory set
        // math + DB expand only for rows not already cached) → misses to download.
        let missing: Vec<_> = {
            let store = runtime.store.clone();
            let lib_id = session.library_server_id.clone();
            let snapshot = snapshot.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                diff_missing_against_snapshot(&store, &lib_id, &snapshot, scan_chunk)
            })
            .await
            {
                Ok(Ok(missing)) => missing,
                _ => Vec::new(),
            }
        };

        // Focus-aware feed: never park indefinitely on a full channel, or a
        // switch to lazy (which stops the consumers) would deadlock the producer
        // here. `try_send` + a short retry lets us re-check focus and bail.
        let mut feed_closed = false;
        'feed: for mut item in missing {
            loop {
                match tx.try_send(item) {
                    Ok(()) => break,
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                        feed_closed = true;
                        break 'feed;
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Full(returned)) => {
                        if !session_still_focused(&worker, &session).await {
                            feed_closed = true;
                            break 'feed;
                        }
                        item = returned;
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                }
            }
        }
        if feed_closed {
            break;
        }

        if chunk_count.is_multiple_of(PROGRESS_EVERY_BATCHES) {
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
    }

    // Close the channel so consumers drain the remaining backlog and exit.
    drop(tx);
    while consumers.join_next().await.is_some() {}

    // Only settle the idle gate on a natural finish (worklist drained), never on
    // a session-switch break — that belongs to the previous focus.
    if completed {
        worker.cursor.lock().await.clear();
        match progress_snapshot(
            &runtime.store,
            &root,
            &session.library_server_id,
            &session.server_index_key,
        )
        .await
        {
            Ok((done, total, pending)) => {
                if pending > PENDING_RESTART_THRESHOLD {
                    let root3 = root.clone();
                    let index_key3 = session.server_index_key.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        clear_cover_fetch_failures(&root3, &index_key3)
                    })
                    .await;
                }
                *worker.settled.lock().await = if pending <= 0 {
                    Some(CoverIdleSignature { total, done })
                } else {
                    None
                };
                emit_library_progress(&app, &session, done, total, pending, &root).await;
            }
            Err(_) => {
                *worker.settled.lock().await = None;
            }
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

/// Cheap catalog signature for the idle gate: one `COUNT(DISTINCT)` over the
/// cover catalog plus the on-disk cached count — never the full per-entity
/// disk walk that a real pass performs.
async fn current_cover_signature(
    app: &AppHandle,
    session: &CoverBackfillSession,
) -> Option<CoverIdleSignature> {
    let runtime = app.try_state::<LibraryRuntime>()?;
    let st = state(app).ok()?;
    let root = {
        let guard = st.lock().await;
        guard.root.clone()
    };
    let store = runtime.store.clone();
    let lib_id = session.library_server_id.clone();
    let index_key = session.server_index_key.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cached = count_cached_cover_ids(&root, &index_key);
        let p = collect_cover_progress(&store, &lib_id, &root, &index_key, cached).ok()?;
        Some(CoverIdleSignature {
            total: p.total_distinct,
            done: p.done,
        })
    })
    .await
    .ok()
    .flatten()
}

/// True when the previous pass settled with nothing pending and the catalog
/// still matches that signature — so an idle event need not rescan.
async fn cover_idle_gate_should_skip(app: &AppHandle, worker: &CoverBackfillWorker, session: &CoverBackfillSession) -> bool {
    let Some(settled) = *worker.settled.lock().await else {
        return false;
    };
    match current_cover_signature(app, session).await {
        Some(current) => current == settled,
        None => false,
    }
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
        // Skip the whole-catalog rescan when a prior pass already settled and
        // nothing in the catalog changed since (mirrors the analysis gate).
        if cover_idle_gate_should_skip(&app, &worker, &session).await {
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

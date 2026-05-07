// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod analysis_cache;
pub mod cli;
mod discord;
pub(crate) mod logging;
mod lib_commands;
#[cfg(target_os = "windows")]
mod taskbar_win;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use lib_commands::*;
// MouseButtonState is only matched on non-Windows targets — on Windows the
// tray uses DoubleClick which doesn't carry a button_state.
#[cfg(not(target_os = "windows"))]
use tauri::tray::MouseButtonState;

/// Tracks which user-configured shortcuts are currently registered (shortcut_str → action).
/// Prevents on_shortcut() accumulating duplicate handlers across JS reloads (HMR / StrictMode).
type ShortcutMap = Mutex<HashMap<String, String>>;

/// Maximum number of offline track downloads that can run concurrently.
/// The frontend queues more tasks than this; Rust is the real throttle.
const MAX_DL_CONCURRENCY: usize = 4;

fn default_subsonic_wire_user_agent() -> String {
    format!("psysonic/{}", env!("CARGO_PKG_VERSION"))
}

fn runtime_subsonic_wire_user_agent() -> &'static RwLock<String> {
    static UA: OnceLock<RwLock<String>> = OnceLock::new();
    UA.get_or_init(|| RwLock::new(default_subsonic_wire_user_agent()))
}

/// Unified outbound User-Agent for all Rust-side HTTP requests.
/// It is initialized with `psysonic/<version>` and then overridden from
/// the main WebView `navigator.userAgent` at app startup.
pub(crate) fn subsonic_wire_user_agent() -> String {
    runtime_subsonic_wire_user_agent()
        .read()
        .map(|ua| ua.clone())
        .unwrap_or_else(|_| default_subsonic_wire_user_agent())
}

/// Shared semaphore that caps simultaneous `download_track_offline` executions.
type DownloadSemaphore = Arc<tokio::sync::Semaphore>;

/// Per-job cancellation flags for `sync_batch_to_device`.
/// Each running sync registers an `Arc<AtomicBool>` here; `cancel_device_sync` flips it.
fn sync_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisBackfillEnqueueKind {
    /// New job at the tail of the queue.
    NewBack,
    /// New job for the currently playing track (head).
    NewFront,
    /// Same track was already waiting; moved to head with the latest URL.
    ReorderedFront,
    /// Low-priority duplicate while the track is already queued or running.
    DuplicateSkipped,
    /// High-priority request but that track is already being downloaded+seeded.
    RunningSkipped,
}

#[derive(Default)]
struct AnalysisBackfillQueueState {
    deque: VecDeque<(String, String)>,
    /// Set while this `track_id` is inside `analysis_backfill_download_and_seed` (not in deque).
    in_progress: Option<String>,
}

impl AnalysisBackfillQueueState {
    fn is_reserved(&self, tid: &str) -> bool {
        self.in_progress.as_deref() == Some(tid)
            || self.deque.iter().any(|(t, _)| t.as_str() == tid)
    }

    fn try_pop_next(&mut self) -> Option<(String, String)> {
        let (tid, url) = self.deque.pop_front()?;
        self.in_progress = Some(tid.clone());
        Some((tid, url))
    }

    fn finish_job(&mut self, tid: &str) {
        if self.in_progress.as_deref() == Some(tid) {
            self.in_progress = None;
        }
    }

    fn enqueue(
        &mut self,
        tid: String,
        url: String,
        high_priority: bool,
    ) -> AnalysisBackfillEnqueueKind {
        let tref = tid.as_str();
        if self.is_reserved(tref) {
            if !high_priority {
                return AnalysisBackfillEnqueueKind::DuplicateSkipped;
            }
            if self.in_progress.as_deref() == Some(tref) {
                return AnalysisBackfillEnqueueKind::RunningSkipped;
            }
            self.deque.retain(|(t, _)| t != &tid);
            self.deque.push_front((tid, url));
            return AnalysisBackfillEnqueueKind::ReorderedFront;
        }
        if high_priority {
            self.deque.push_front((tid, url));
            AnalysisBackfillEnqueueKind::NewFront
        } else {
            self.deque.push_back((tid, url));
            AnalysisBackfillEnqueueKind::NewBack
        }
    }

    fn prune_queued_not_in(&mut self, keep_track_ids: &HashSet<&str>) -> usize {
        let before = self.deque.len();
        self.deque
            .retain(|(track_id, _)| keep_track_ids.contains(track_id.as_str()));
        before.saturating_sub(self.deque.len())
    }
}

struct AnalysisBackfillShared {
    state: Mutex<AnalysisBackfillQueueState>,
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

impl AnalysisBackfillShared {
    fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
    }
}

static ANALYSIS_BACKFILL: OnceLock<Arc<AnalysisBackfillShared>> = OnceLock::new();

/// Lazily spawns the single backfill worker (first caller supplies `AppHandle`).
fn analysis_backfill_shared(app: &tauri::AppHandle) -> Arc<AnalysisBackfillShared> {
    ANALYSIS_BACKFILL
        .get_or_init(|| {
            let (wake_tx, wake_rx) = tokio::sync::mpsc::unbounded_channel();
            let shared = Arc::new(AnalysisBackfillShared {
                state: Mutex::new(AnalysisBackfillQueueState::default()),
                wake_tx,
            });
            let app = app.clone();
            let sh = shared.clone();
            tauri::async_runtime::spawn(analysis_backfill_worker_loop(app, sh, wake_rx));
            shared
        })
        .clone()
}

async fn analysis_backfill_download_and_seed(
    app: &tauri::AppHandle,
    track_id: &str,
    url: &str,
) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty response".to_string());
    }
    enqueue_analysis_seed(app, track_id, &bytes).await
}

async fn analysis_backfill_worker_loop(
    app: tauri::AppHandle,
    shared: Arc<AnalysisBackfillShared>,
    mut wake_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    loop {
        if wake_rx.recv().await.is_none() {
            break;
        }
        while let Some((track_id, url)) = {
            let mut st = shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            st.try_pop_next()
        } {
            crate::app_deprintln!("[analysis] backfill worker: start track_id={}", track_id);
            let result = analysis_backfill_download_and_seed(&app, &track_id, &url).await;
            match &result {
                Ok(has_loudness) => crate::app_deprintln!(
                    "[analysis] backfill ready: {} (has_loudness={})",
                    track_id,
                    has_loudness
                ),
                Err(e) => crate::app_eprintln!("[analysis] backfill failed for {}: {}", track_id, e),
            }
            let mut st = shared
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            st.finish_job(&track_id);
        }
    }
}

fn analysis_backfill_is_current_track(app: &tauri::AppHandle, track_id: &str) -> bool {
    app.try_state::<crate::audio::AudioEngine>()
        .is_some_and(|e| crate::audio::analysis_track_id_is_current_playback(&e, track_id))
}

// ─── Full-track waveform + loudness: single CPU worker (mirrors HTTP backfill queue) ─
// One `spawn_blocking` decode at a time; current playback is high-priority (front + reorder).
// Same `track_id` queued again merges waiters onto one job; while decode runs, same-id
// submitters attach to `running` followers so they all get the same outcome.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AnalysisCpuSeedEnqueueKind {
    NewBack,
    NewFront,
    ReorderedFront,
    RunningFollower,
    MergedQueued,
}

struct AnalysisCpuSeedJob {
    track_id: String,
    bytes: Vec<u8>,
    waiters: Vec<tokio::sync::oneshot::Sender<Result<analysis_cache::SeedFromBytesOutcome, String>>>,
}

struct AnalysisCpuSeedQueueState {
    deque: VecDeque<AnalysisCpuSeedJob>,
    /// Decode in progress — same-id callers wait here for the same outcome.
    running: Option<(
        String,
        Arc<Mutex<Vec<tokio::sync::oneshot::Sender<Result<analysis_cache::SeedFromBytesOutcome, String>>>>>,
    )>,
}

impl AnalysisCpuSeedQueueState {
    fn enqueue(
        &mut self,
        track_id: String,
        bytes: Vec<u8>,
        high_priority: bool,
    ) -> (
        AnalysisCpuSeedEnqueueKind,
        tokio::sync::oneshot::Receiver<Result<analysis_cache::SeedFromBytesOutcome, String>>,
    ) {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        let tid = track_id.as_str();

        if let Some((rtid, followers)) = &self.running {
            if rtid == tid {
                followers
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(done_tx);
                return (AnalysisCpuSeedEnqueueKind::RunningFollower, done_rx);
            }
        }

        if let Some(pos) = self.deque.iter().position(|j| j.track_id == track_id) {
            let mut job = self.deque.remove(pos).unwrap();
            job.bytes = bytes;
            job.waiters.push(done_tx);
            let kind = if high_priority {
                self.deque.push_front(job);
                AnalysisCpuSeedEnqueueKind::ReorderedFront
            } else {
                self.deque.push_back(job);
                AnalysisCpuSeedEnqueueKind::MergedQueued
            };
            return (kind, done_rx);
        }

        let job = AnalysisCpuSeedJob {
            track_id: track_id.clone(),
            bytes,
            waiters: vec![done_tx],
        };
        let kind = if high_priority {
            self.deque.push_front(job);
            AnalysisCpuSeedEnqueueKind::NewFront
        } else {
            self.deque.push_back(job);
            AnalysisCpuSeedEnqueueKind::NewBack
        };
        (kind, done_rx)
    }

    fn prune_queued_not_in(&mut self, keep_track_ids: &HashSet<&str>) -> (usize, usize) {
        let mut kept = VecDeque::with_capacity(self.deque.len());
        let mut removed_jobs = 0usize;
        let mut removed_waiters = 0usize;
        while let Some(job) = self.deque.pop_front() {
            if keep_track_ids.contains(job.track_id.as_str()) {
                kept.push_back(job);
                continue;
            }
            removed_jobs += 1;
            removed_waiters += job.waiters.len();
            for tx in job.waiters {
                let _ = tx.send(Err(
                    "cpu-seed pruned: track no longer in playback queue".to_string(),
                ));
            }
        }
        self.deque = kept;
        (removed_jobs, removed_waiters)
    }
}

struct AnalysisCpuSeedShared {
    state: Mutex<AnalysisCpuSeedQueueState>,
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

impl Default for AnalysisCpuSeedQueueState {
    fn default() -> Self {
        Self {
            deque: VecDeque::new(),
            running: None,
        }
    }
}

impl AnalysisCpuSeedShared {
    fn ping_worker(&self) {
        let _ = self.wake_tx.send(());
    }
}

static ANALYSIS_CPU_SEED: OnceLock<Arc<AnalysisCpuSeedShared>> = OnceLock::new();

fn analysis_cpu_seed_shared(app: &tauri::AppHandle) -> Arc<AnalysisCpuSeedShared> {
    ANALYSIS_CPU_SEED
        .get_or_init(|| {
            let (wake_tx, wake_rx) = tokio::sync::mpsc::unbounded_channel();
            let shared = Arc::new(AnalysisCpuSeedShared {
                state: Mutex::new(AnalysisCpuSeedQueueState::default()),
                wake_tx,
            });
            let app = app.clone();
            let sh = shared.clone();
            tauri::async_runtime::spawn(analysis_cpu_seed_worker_loop(app, sh, wake_rx));
            shared
        })
        .clone()
}

/// HTTP backfill + CPU seed queue sizes (debug log only — `app_deprintln!`).
fn emit_analysis_queue_snapshot_line() {
    let http = if let Some(arc) = ANALYSIS_BACKFILL.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        format!(
            "http_backfill={{queued:{} download_active:{:?}}}",
            st.deque.len(),
            st.in_progress.as_deref()
        )
    } else {
        "http_backfill={{not_started}}".to_string()
    };

    let cpu = if let Some(arc) = ANALYSIS_CPU_SEED.get() {
        let st = arc.state.lock().unwrap_or_else(|e| e.into_inner());
        let queued_jobs = st.deque.len();
        let pending_in_queued_jobs: usize = st.deque.iter().map(|j| j.waiters.len()).sum();
        let (decoding_tid, decoding_extra_waiters) = match &st.running {
            Some((tid, fl)) => (
                Some(tid.as_str()),
                fl.lock().map(|g| g.len()).unwrap_or(0),
            ),
            None => (None, 0usize),
        };
        format!(
            "cpu_seed={{queued_jobs:{} pending_channels_in_queue:{} decoding_tid:{:?} extra_waiters_same_id:{}}}",
            queued_jobs,
            pending_in_queued_jobs,
            decoding_tid,
            decoding_extra_waiters
        )
    } else {
        "cpu_seed={{not_started}}".to_string()
    };

    crate::app_deprintln!(
        "[analysis] queue_snapshot interval_s=60 note=queues_in_memory_cleared_on_app_restart | {http} | {cpu}"
    );
}

async fn analysis_queue_snapshot_loop() {
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
        loop {
            let (job, followers) = {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                let Some(j) = st.deque.pop_front() else {
                    break;
                };
                let fl = Arc::new(Mutex::new(Vec::new()));
                st.running = Some((j.track_id.clone(), fl.clone()));
                (j, fl)
            };
            let tid_log = job.track_id.clone();
            let app2 = app.clone();
            let tid = job.track_id.clone();
            let bytes = job.bytes;
            let outcome = tokio::task::spawn_blocking(move || {
                analysis_cache::seed_from_bytes_execute(&app2, &tid, &bytes)
            })
            .await
            .unwrap_or_else(|e| Err(format!("cpu-seed spawn_blocking: {e}")));

            let mut extra = followers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .drain(..)
                .collect::<Vec<_>>();
            for tx in job.waiters {
                let _ = tx.send(outcome.clone());
            }
            for tx in extra.drain(..) {
                let _ = tx.send(outcome.clone());
            }

            {
                let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                st.running = None;
            }
            let ok = outcome.as_ref().map(|o| *o == analysis_cache::SeedFromBytesOutcome::Upserted).unwrap_or(false);
            crate::app_deprintln!(
                "[analysis] cpu-seed worker: done track_id={} upserted={}",
                tid_log,
                ok
            );
        }
    }
}

/// Submit full-buffer analysis; serializes with other producers. `high_priority` mirrors
/// HTTP backfill head insertion for the currently playing track.
///
/// Emits `analysis:waveform-updated` when analysis **wrote** new waveform data (`Upserted`).
/// Cache-hit skips (`SkippedWaveformCacheHit`) omit the event so the frontend does not
/// re-run loudness refresh / waveform IPC for rows that were already current.
pub(crate) async fn submit_analysis_cpu_seed(
    app: tauri::AppHandle,
    track_id: String,
    bytes: Vec<u8>,
    high_priority: bool,
) -> Result<analysis_cache::SeedFromBytesOutcome, String> {
    let shared = analysis_cpu_seed_shared(&app);
    let rx = {
        let mut st = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        let (kind, rx) = st.enqueue(track_id.clone(), bytes, high_priority);
        crate::app_deprintln!("[analysis] cpu-seed submit: kind={kind:?} high_priority={high_priority}");
        drop(st);
        shared.ping_worker();
        rx
    };
    let outcome = match rx.await {
        Ok(res) => res?,
        Err(_) => return Err("cpu-seed: result channel dropped".to_string()),
    };
    if matches!(outcome, analysis_cache::SeedFromBytesOutcome::Upserted) {
        let _ = app.emit(
            "analysis:waveform-updated",
            WaveformUpdatedPayload {
                track_id: track_id.clone(),
                is_partial: false,
            },
        );
    }
    Ok(outcome)
}

/// Holds the live system-tray icon handle.  `None` means the tray is currently hidden/removed.
/// Dropping the inner `TrayIcon` fully removes it from the OS notification area on all platforms.
type TrayState = Mutex<Option<TrayIcon>>;

/// Cached tray tooltip text. Updated by `set_tray_tooltip` and re-applied when the
/// icon is rebuilt (e.g. after the user toggles the tray off and on again).
/// Empty string means "use the default `Psysonic` tooltip".
type TrayTooltip = Mutex<String>;

#[derive(Default)]
struct TrayPlaybackState(Mutex<String>);

fn tray_state_icon(state: &str) -> &'static str {
    match state {
        "play" => "▶",
        "pause" => "⏸",
        _ => "⏹",
    }
}

/// Handles to all updatable tray menu items, kept around so `set_tray_menu_labels`
/// (i18n refresh) and `set_tray_tooltip` (track change) can re-text them without
/// rebuilding the whole tray icon. The `now_playing` slot is `Some` on Linux
/// only — it surfaces the current track as a disabled menu entry because
/// AppIndicator has no hover tooltip API.
struct TrayMenuItems {
    play_pause: tauri::menu::MenuItem<tauri::Wry>,
    next: tauri::menu::MenuItem<tauri::Wry>,
    previous: tauri::menu::MenuItem<tauri::Wry>,
    show_hide: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    now_playing: Option<tauri::menu::MenuItem<tauri::Wry>>,
}

type TrayMenuItemsState = Mutex<Option<TrayMenuItems>>;

/// Cached translations for the tray menu. Defaults to English so the menu has
/// readable labels before the frontend has had a chance to run `set_tray_menu_labels`.
#[derive(Clone)]
struct TrayMenuLabels {
    play_pause: String,
    next: String,
    previous: String,
    show_hide: String,
    quit: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    nothing_playing: String,
}

impl Default for TrayMenuLabels {
    fn default() -> Self {
        Self {
            play_pause: "Play / Pause".into(),
            next: "Next Track".into(),
            previous: "Previous Track".into(),
            show_hide: "Show / Hide".into(),
            quit: "Exit Psysonic".into(),
            nothing_playing: "Nothing playing".into(),
        }
    }
}

type TrayMenuLabelsState = Mutex<TrayMenuLabels>;

/// Shared handle to OS media controls (MPRIS2 on Linux, Now Playing on macOS, SMTC on Windows).
/// `None` if souvlaki failed to initialize (e.g. no D-Bus session on Linux).
type MprisControls = Mutex<Option<souvlaki::MediaControls>>;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformCachePayload {
    bins: Vec<u8>,
    bin_count: i64,
    is_partial: bool,
    known_until_sec: f64,
    duration_sec: f64,
    updated_at: i64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WaveformUpdatedPayload {
    track_id: String,
    is_partial: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoudnessCachePayload {
    integrated_lufs: f64,
    true_peak: f64,
    recommended_gain_db: f64,
    target_lufs: f64,
    updated_at: i64,
}

pub fn run() {
    // Linux: second `psysonic --player …` forwards over D-Bus before heavy startup.
    #[cfg(target_os = "linux")]
    {
        let argv: Vec<String> = std::env::args().collect();
        if crate::cli::parse_cli_command(&argv).is_some() {
            match crate::cli::linux_try_forward_player_cli_secondary(&argv) {
                Ok(crate::cli::LinuxPlayerForwardResult::Forwarded) => std::process::exit(0),
                Ok(crate::cli::LinuxPlayerForwardResult::ContinueStartup) => {}
                Err(msg) => {
                    crate::app_eprintln!("NOT OK: {msg}");
                    std::process::exit(1);
                }
            }
        }
    }

    let (audio_engine, _audio_thread) = audio::create_engine();

    tauri::Builder::default()
        .manage(audio_engine)
        .manage(ShortcutMap::default())
        .manage(discord::DiscordState::new())
        .manage(Arc::new(tokio::sync::Semaphore::new(MAX_DL_CONCURRENCY)) as DownloadSemaphore)
        .manage(TrayState::default())
        .manage(TrayTooltip::default())
        .manage(TrayPlaybackState::default())
        .manage(TrayMenuItemsState::default())
        .manage(TrayMenuLabelsState::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["mini"])
                .build()
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !crate::cli::handle_cli_on_primary_instance(app, &argv) {
                let window = app.get_webview_window("main").expect("no main window");
                // The window may have been hidden via the close-to-tray path,
                // which injects PAUSE_RENDERING_JS (sets `__psyHidden=true`,
                // pauses CSS animations). Tray-icon restore mirrors this with
                // RESUME_RENDERING_JS — second-launch restore must do the same,
                // otherwise the webview comes back with rendering still paused
                // and navigation looks blank (issue #497).
                let _ = window.eval(RESUME_RENDERING_JS);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))

        .setup(|app| {
            // ── Analysis cache (SQLite) ───────────────────────────────────
            {
                let cache = analysis_cache::AnalysisCache::init(&app.handle())
                    .map_err(|e| format!("analysis cache init failed: {e}"))?;
                app.manage(cache);
            }

            // Periodic analysis queue sizes (debug logging mode only).
            tauri::async_runtime::spawn(analysis_queue_snapshot_loop());

            // ── Custom title bar on Linux ─────────────────────────────────
            // Remove OS window decorations on all Linux so the React TitleBar
            // can take over.  The frontend checks is_tiling_wm() to decide
            // whether to actually render the TitleBar (hidden on tiling WMs).
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                }
            }

            // ── System tray ───────────────────────────────────────────────
            // Always build on startup when possible; the frontend calls toggle_tray_icon(false)
            // immediately after load if the user has disabled the tray icon.
            // May be skipped if Ayatana/AppIndicator libraries are missing (no panic).
            {
                if let Some(tray) = try_build_tray_icon(app.handle()) {
                    *app.state::<TrayState>().lock().unwrap() = Some(tray);
                }
            }

            // ── MPRIS2 / OS media controls via souvlaki ──────────────────
            {
                use souvlaki::{MediaControlEvent, MediaControls, PlatformConfig};

                // Collect pre-conditions and the platform-specific HWND.
                // Returns None early (with a log) on any unrecoverable condition
                // so app.manage() always executes exactly once at the bottom.
                let maybe_controls: Option<MediaControls> = (|| {
                    // Linux: requires a live D-Bus session.
                    #[cfg(target_os = "linux")]
                    {
                        let dbus_ok = std::env::var("DBUS_SESSION_BUS_ADDRESS")
                            .map(|v| !v.is_empty())
                            .unwrap_or(false);
                        if !dbus_ok {
                            crate::app_eprintln!("[Psysonic] No D-Bus session — MPRIS media controls disabled");
                            return None;
                        }
                    }

                    // Windows: souvlaki SMTC must hook into the existing Win32
                    // message loop rather than spinning up its own. Pass the
                    // main window's HWND so it can do so. If we can't get one,
                    // skip init (no crash, just no media overlay).
                    #[cfg(target_os = "windows")]
                    let hwnd = {
                        use tauri::Manager;
                        let h = app.get_webview_window("main")
                            .and_then(|w| w.hwnd().ok())
                            .map(|h| h.0 as *mut std::ffi::c_void);
                        if h.is_none() {
                            crate::app_eprintln!("[Psysonic] Could not get HWND — Windows media controls disabled");
                            return None;
                        }
                        h
                    };
                    #[cfg(not(target_os = "windows"))]
                    let hwnd: Option<*mut std::ffi::c_void> = None;

                    let config = PlatformConfig {
                        dbus_name: "psysonic",
                        display_name: "Psysonic",
                        hwnd,
                    };

                    match MediaControls::new(config) {
                        Ok(mut controls) => {
                            let app_handle = app.handle().clone();
                            if let Err(e) = controls.attach(move |event: MediaControlEvent| {
                                match event {
                                    MediaControlEvent::Toggle
                                    | MediaControlEvent::Play
                                    | MediaControlEvent::Pause => {
                                        let _ = app_handle.emit("media:play-pause", ());
                                    }
                                    MediaControlEvent::Next => {
                                        let _ = app_handle.emit("media:next", ());
                                    }
                                    MediaControlEvent::Previous => {
                                        let _ = app_handle.emit("media:prev", ());
                                    }
                                    MediaControlEvent::Seek(direction) => {
                                        use souvlaki::SeekDirection;
                                        let delta: f64 = match direction {
                                            SeekDirection::Forward  =>  5.0,
                                            SeekDirection::Backward => -5.0,
                                        };
                                        let _ = app_handle.emit("media:seek-relative", delta);
                                    }
                                    MediaControlEvent::SetPosition(pos) => {
                                        let secs = pos.0.as_secs_f64();
                                        let _ = app_handle.emit("media:seek-absolute", secs);
                                    }
                                    _ => {}
                                }
                            }) {
                                crate::app_eprintln!("[Psysonic] Failed to attach media controls: {e:?}");
                            }
                            Some(controls)
                        }
                        Err(e) => {
                            crate::app_eprintln!("[Psysonic] Could not create media controls: {e:?}");
                            None
                        }
                    }
                })();

                app.manage(MprisControls::new(maybe_controls));
            }

            // ── Windows Taskbar Thumbnail Toolbar ────────────────────────
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        taskbar_win::init(app.handle(), hwnd.0 as isize);
                    }
                }
            }

            // ── Audio device-change watcher ───────────────────────────────
            {
                use tauri::Manager;
                let engine = app.state::<audio::AudioEngine>();
                audio::start_device_watcher(&engine, app.handle().clone());
            }

            // ── Reopen output after system sleep/resume (WASAPI / PipeWire etc.)
            audio::register_post_sleep_audio_recovery(app.handle().clone());

            // ── Pre-create mini player window (Windows) ──────────────────
            // Creating the second WebView2 webview lazily from an invoke
            // handler on Windows reliably stalls the Tauri event loop —
            // the mini shows a blank white window, neither main nor mini
            // can be closed, and the user has to kill the process via
            // Task Manager. Building it at startup (hidden) avoids the
            // runtime-creation code path entirely; later `open_mini_player`
            // calls are pure show/hide.
            #[cfg(target_os = "windows")]
            {
                if let Err(e) = build_mini_player_window(app.handle(), false) {
                    crate::app_eprintln!("[psysonic] Failed to pre-create mini window: {e}");
                }
            }

            // Cold start with `--player …`: defer emit so the webview can register listeners.
            crate::cli::spawn_deferred_cli_argv_handler(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Persist mini player position whenever the user drags it.
            if window.label() == "mini" {
                if let tauri::WindowEvent::Moved(pos) = event {
                    persist_mini_pos_throttled(window.app_handle(), pos.x, pos.y);
                }
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();

                    #[cfg(target_os = "macos")]
                    {
                        // On macOS the red close button quits the app entirely.
                        // Route through JS so playback position + Orbit state get
                        // flushed; exit_app on the way back stops the audio engine.
                        let _ = window.emit("app:force-quit", ());
                    }

                    #[cfg(not(target_os = "macos"))]
                    {
                        // Pause rendering before JS decides whether to hide to tray or exit.
                        if let Some(w) = window.app_handle().get_webview_window("main") {
                            let _ = w.eval(PAUSE_RENDERING_JS);
                        }
                        // Let JS decide: minimize to tray or exit, based on user setting.
                        let _ = window.emit("window:close-requested", ());
                    }
                } else if window.label() == "mini" {
                    // Native close on the mini: hide instead of destroying so
                    // state is preserved, and restore the main window.
                    api.prevent_close();
                    if let Some(w) = window.app_handle().get_webview_window("mini") {
                        let _ = w.eval(PAUSE_RENDERING_JS);
                    }
                    let _ = window.hide();
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        let _ = main.unminimize();
                        let _ = main.show();
                        let _ = main.set_focus();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            calculate_sync_payload,
            exit_app,
            cli_publish_player_snapshot,
            cli_publish_library_list,
            cli_publish_server_list,
            cli_publish_search_results,
            set_window_decorations,
            set_linux_webkit_smooth_scrolling,
            set_logging_mode,
            export_runtime_logs,
            frontend_debug_log,
            performance_cpu_snapshot,
            set_subsonic_wire_user_agent,
            no_compositing_mode,
            is_tiling_wm_cmd,
            open_mini_player,
            preload_mini_player,
            close_mini_player,
            set_mini_player_always_on_top,
            resize_mini_player,
            show_main_window,
            pause_rendering,
            resume_rendering,
            register_global_shortcut,
            unregister_global_shortcut,
            mpris_set_metadata,
            mpris_set_playback,
            audio::commands::audio_play,
            audio::commands::audio_pause,
            audio::commands::audio_resume,
            audio::commands::audio_stop,
            audio::commands::audio_seek,
            audio::commands::audio_set_volume,
            audio::commands::audio_update_replay_gain,
            audio::commands::audio_set_eq,
            audio::commands::autoeq_entries,
            audio::commands::autoeq_fetch_profile,
            audio::commands::audio_preload,
            audio::commands::audio_play_radio,
            audio::preview::audio_preview_play,
            audio::preview::audio_preview_stop,
            audio::preview::audio_preview_stop_silent,
            audio::commands::audio_set_crossfade,
            audio::commands::audio_set_gapless,
            audio::commands::audio_set_normalization,
            audio::commands::audio_list_devices,
            audio::commands::audio_canonicalize_selected_device,
            audio::commands::audio_default_output_device_name,
            audio::commands::audio_set_device,
            audio::commands::audio_chain_preload,
            discord::discord_update_presence,
            discord::discord_clear_presence,
            lastfm_request,
            upload_playlist_cover,
            upload_radio_cover,
            upload_artist_image,
            delete_radio_cover,
            navidrome_login,
            nd_list_users,
            nd_create_user,
            nd_update_user,
            nd_delete_user,
            nd_list_libraries,
            nd_list_songs,
            nd_list_artists_by_role,
            nd_list_albums_by_artist_role,
            nd_set_user_libraries,
            nd_list_playlists,
            nd_create_playlist,
            nd_update_playlist,
            nd_get_playlist,
            nd_delete_playlist,
            search_radio_browser,
            get_top_radio_stations,
            fetch_url_bytes,
            fetch_json_url,
            fetch_icy_metadata,
            resolve_stream_url,
            analysis_get_waveform,
            analysis_get_waveform_for_track,
            analysis_get_loudness_for_track,
            analysis_delete_loudness_for_track,
            analysis_delete_all_waveforms,
            analysis_enqueue_seed_from_url,
            analysis_prune_pending_to_track_ids,
            download_track_offline,
            delete_offline_track,
            get_offline_cache_size,
            download_track_hot_cache,
            promote_stream_cache_to_hot_cache,
            get_hot_cache_size,
            delete_hot_cache_track,
            purge_hot_cache,
            sync_track_to_device,
            sync_batch_to_device,
            cancel_device_sync,
            compute_sync_paths,
            list_device_dir_files,
            delete_device_file,
            delete_device_files,
            get_removable_drives,
            write_device_manifest,
            read_device_manifest,
            write_playlist_m3u8,
            rename_device_files,
            toggle_tray_icon,
            set_tray_tooltip,
            set_tray_menu_labels,
            check_dir_accessible,
            download_zip,
            check_arch_linux,
            download_update,
            open_folder,
            get_embedded_lyrics,
            fetch_netease_lyrics,
            fetch_bandsintown_events,
            #[cfg(target_os = "windows")]
            taskbar_win::update_taskbar_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Psysonic");
}

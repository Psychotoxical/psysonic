//! `LibraryRuntime` — Tauri State shared by every library command.
//!
//! PR-5a held only the store. PR-5b extends with the per-server sync
//! session map (credentials live in process memory only — same trust
//! boundary as today's WebView-held passwords), the current playback
//! hint, an `Option<SyncSupervisor>` for in-flight start/cancel, and
//! a long-lived cancellation flag for the background-scheduler task
//! the top crate spawns in `setup()`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{
    Mutex as AsyncMutex, Notify, OwnedMutexGuard, OwnedRwLockReadGuard, OwnedRwLockWriteGuard,
    RwLock,
};

use crate::analysis_backfill::LibraryAnalysisProgressDto;
use crate::store::LibraryStore;
use crate::sync::bandwidth::PlaybackHint;

const CURRENT_JOB_CANCEL_GRACE: Duration = Duration::from_millis(500);
const CURRENT_JOB_ABORT_COMPLETION_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct AnalysisProgressCacheEntry {
    pub value: LibraryAnalysisProgressDto,
    pub updated_at: Instant,
    pub in_flight: bool,
}

/// Per-server credentials cache for the sync runner. Lives only in
/// `LibraryRuntime` process memory; `library_sync_clear_session`
/// removes it on logout / index disable / purge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncSession {
    pub server_id: String,
    pub base_url: String,
    pub username: String,
    pub password: String,
    /// Navidrome native API bearer cached from the `/auth/login`
    /// response at bind time. `None` when the server isn't Navidrome
    /// or the optional Navidrome auth failed (Subsonic-only path).
    pub navidrome_token: Option<String>,
    pub library_scope: Option<String>,
}

/// Currently-running initial / delta / manual integrity job
/// metadata. Holding the `SyncSupervisor` in the mutex (as the
/// PR-5 kickoff sketch suggested) would block `library_sync_cancel`
/// behind whoever's running the supervisor's join — instead we keep
/// just the cancel handle + identity, and the job-orchestrator task
/// owns the supervisor / receiver / join.
#[derive(Debug, Clone)]
pub struct CurrentJob {
    pub job_id: String,
    pub server_id: String,
    /// `"initial_sync"` or `"delta_sync"`.
    pub kind: String,
    pub cancel: Arc<AtomicBool>,
    /// Production runner task cancellation. Synthetic tests may omit it.
    pub abort_handle: Option<tokio::task::AbortHandle>,
    /// Signaled when this job's runner task finishes (success, error, or cancel).
    pub done: Arc<Notify>,
}

/// Exclusive access to sync-capable database mutation.
///
/// The lifecycle guard prevents a new foreground job from being installed,
/// while the scheduler guard waits for active ticks and blocks new ones.
#[must_use]
pub struct SyncDrainBarrier {
    _lifecycle: OwnedMutexGuard<()>,
    _scheduler: OwnedRwLockWriteGuard<()>,
}

pub struct LibraryRuntime {
    pub store: Arc<LibraryStore>,
    /// Per-`server_id` sync session. Mutex over a `HashMap` — single
    /// writer at a time is fine for the command surface; the
    /// background scheduler tick reads a snapshot.
    pub sync_sessions: Mutex<HashMap<String, SyncSession>>,
    pub playback_hint: Mutex<PlaybackHint>,
    /// Currently running initial / delta / manual integrity job, if
    /// any. `library_sync_start` populates, `library_sync_cancel`
    /// trips `cancel`; the orchestrator task clears the slot when
    /// the job's `join` returns.
    pub current_job: Mutex<Option<CurrentJob>>,
    /// Serializes foreground replacement, purge, and database swaps.
    sync_lifecycle: Arc<AsyncMutex<()>>,
    /// Scheduler ticks take shared access; destructive operations take exclusive
    /// access after draining the relevant foreground job.
    sync_activity: Arc<RwLock<()>>,
    /// Non-sync writers that prepare ID-bearing rows before taking SQLite's writer
    /// lock hold shared access. Canonical-ID migration takes exclusive access so a
    /// prepared legacy row cannot be committed after the remap transaction.
    identity_mutation: Arc<RwLock<()>>,
    /// Top-crate scheduler tick task watches this flag; set true on
    /// app shutdown / library index disabled.
    pub scheduler_cancel: Arc<AtomicBool>,
    /// Latest `library_live_search` epoch from the UI — stale commands
    /// skip FTS when a newer keystroke generation was registered.
    live_search_epoch: AtomicU64,
    /// Cached analysis progress snapshots keyed by server id.
    analysis_progress_cache: Mutex<HashMap<String, AnalysisProgressCacheEntry>>,
}

impl LibraryRuntime {
    pub fn new(store: Arc<LibraryStore>) -> Self {
        Self {
            store,
            sync_sessions: Mutex::new(HashMap::new()),
            playback_hint: Mutex::new(PlaybackHint::default()),
            current_job: Mutex::new(None),
            sync_lifecycle: Arc::new(AsyncMutex::new(())),
            sync_activity: Arc::new(RwLock::new(())),
            identity_mutation: Arc::new(RwLock::new(())),
            scheduler_cancel: Arc::new(AtomicBool::new(false)),
            live_search_epoch: AtomicU64::new(0),
            analysis_progress_cache: Mutex::new(HashMap::new()),
        }
    }

    /// UI bumps `epoch` on every debounced search start / cancel.
    pub fn register_live_search_epoch(&self, epoch: u64) {
        let _ = self.live_search_epoch.fetch_max(epoch, Ordering::SeqCst);
    }

    pub fn live_search_still_current(&self, epoch: u64) -> bool {
        self.live_search_epoch.load(Ordering::Acquire) == epoch
    }

    pub fn install_current_job(&self, job: CurrentJob) -> Result<(), String> {
        let mut slot = self
            .current_job
            .lock()
            .map_err(|_| "library current job lock poisoned".to_string())?;
        if let Some(current) = slot.as_ref() {
            return Err(format!("sync job `{}` is still running", current.job_id));
        }
        *slot = Some(job);
        Ok(())
    }

    pub fn current_job(&self) -> Option<CurrentJob> {
        self.current_job.lock().ok().and_then(|s| s.clone())
    }

    pub fn attach_current_job_abort_handle(
        &self,
        job_id: &str,
        abort_handle: tokio::task::AbortHandle,
    ) -> Result<(), String> {
        let mut slot = self
            .current_job
            .lock()
            .map_err(|_| "library current job lock poisoned".to_string())?;
        let Some(job) = slot.as_mut().filter(|job| job.job_id == job_id) else {
            return Err(format!("sync job `{job_id}` is no longer current"));
        };
        job.abort_handle = Some(abort_handle);
        Ok(())
    }

    pub fn clear_current_job_if_matches(&self, job_id: &str) {
        if let Ok(mut slot) = self.current_job.lock() {
            if slot.as_ref().is_some_and(|j| j.job_id == job_id) {
                *slot = None;
            }
        }
    }

    /// Clear the completed job before publishing the stored `Notify` permit.
    /// Waiters that wake are therefore guaranteed not to observe the old slot.
    pub fn complete_current_job(&self, job_id: &str, done: &Notify) {
        self.clear_current_job_if_matches(job_id);
        done.notify_one();
    }

    pub fn cancel_current_job(&self) -> bool {
        if let Ok(slot) = self.current_job.lock() {
            if let Some(job) = slot.as_ref() {
                job.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    /// Cancel and await a foreground job, then wait for all scheduler ticks and
    /// block new sync-capable activity until the returned guard is dropped.
    /// `job_id` and `server_id` are optional selectors checked while holding the
    /// lifecycle lock. Scheduler writes are excluded globally in every case.
    pub async fn cancel_and_drain_sync(
        &self,
        job_id: Option<&str>,
        server_id: Option<&str>,
    ) -> Result<SyncDrainBarrier, String> {
        self.cancel_and_drain_sync_with_timeouts(
            job_id,
            server_id,
            CURRENT_JOB_CANCEL_GRACE,
            CURRENT_JOB_ABORT_COMPLETION_TIMEOUT,
        )
        .await
    }

    async fn cancel_and_drain_sync_with_timeouts(
        &self,
        job_id: Option<&str>,
        server_id: Option<&str>,
        grace: Duration,
        abort_completion_timeout: Duration,
    ) -> Result<SyncDrainBarrier, String> {
        let lifecycle = Arc::clone(&self.sync_lifecycle).lock_owned().await;
        let current = self
            .current_job
            .lock()
            .map_err(|_| "library current job lock poisoned".to_string())?
            .clone();
        if let Some(job) = current.filter(|job| {
            job_id.is_none_or(|id| job.job_id == id)
                && server_id.is_none_or(|id| job.server_id == id)
        }) {
            let completion = job.done.notified();
            tokio::pin!(completion);
            job.cancel.store(true, Ordering::SeqCst);
            if tokio::time::timeout(grace, &mut completion).await.is_err() {
                if let Some(abort_handle) = job.abort_handle.as_ref() {
                    if !abort_handle.is_finished() {
                        abort_handle.abort();
                    }
                }
                if tokio::time::timeout(abort_completion_timeout, &mut completion)
                    .await
                    .is_err()
                {
                    return Err(format!(
                        "sync job `{}` did not stop after cancellation and abort",
                        job.job_id
                    ));
                }
            }
        }
        let scheduler = Arc::clone(&self.sync_activity).write_owned().await;
        Ok(SyncDrainBarrier {
            _lifecycle: lifecycle,
            _scheduler: scheduler,
        })
    }

    /// Shared scheduler access held for the full write-capable tick.
    pub async fn sync_activity_guard(&self) -> OwnedRwLockReadGuard<()> {
        Arc::clone(&self.sync_activity).read_owned().await
    }

    pub async fn identity_mutation_guard(&self) -> OwnedRwLockReadGuard<()> {
        Arc::clone(&self.identity_mutation).read_owned().await
    }

    pub async fn identity_migration_guard(&self) -> OwnedRwLockWriteGuard<()> {
        Arc::clone(&self.identity_mutation).write_owned().await
    }

    /// Snapshot all bound sessions — used by the scheduler tick task
    /// in the top crate so it doesn't hold the mutex across an `await`.
    pub fn snapshot_sessions(&self) -> Vec<SyncSession> {
        self.sync_sessions
            .lock()
            .map(|sessions| sessions.values().cloned().collect())
            .unwrap_or_default()
    }

    pub fn get_session(&self, server_id: &str) -> Option<SyncSession> {
        self.sync_sessions
            .lock()
            .ok()
            .and_then(|s| s.get(server_id).cloned())
    }

    pub fn set_session(&self, session: SyncSession) -> Result<(), String> {
        let mut sessions = self
            .sync_sessions
            .lock()
            .map_err(|_| "library sync session lock poisoned".to_string())?;
        sessions.insert(session.server_id.clone(), session);
        Ok(())
    }

    pub fn clear_session(&self, server_id: &str) {
        if let Ok(mut sessions) = self.sync_sessions.lock() {
            sessions.remove(server_id);
        }
    }

    pub fn current_playback_hint(&self) -> PlaybackHint {
        self.playback_hint.lock().map(|h| *h).unwrap_or_default()
    }

    pub fn set_playback_hint(&self, hint: PlaybackHint) {
        if let Ok(mut h) = self.playback_hint.lock() {
            *h = hint;
        }
    }

    pub fn analysis_progress_snapshot(
        &self,
        server_id: &str,
    ) -> Option<AnalysisProgressCacheEntry> {
        self.analysis_progress_cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(server_id).cloned())
    }

    pub fn mark_analysis_progress_in_flight(&self, server_id: &str) -> bool {
        if let Ok(mut cache) = self.analysis_progress_cache.lock() {
            match cache.get_mut(server_id) {
                Some(entry) => {
                    if entry.in_flight {
                        return false;
                    }
                    entry.in_flight = true;
                    return true;
                }
                None => {
                    cache.insert(
                        server_id.to_string(),
                        AnalysisProgressCacheEntry {
                            value: LibraryAnalysisProgressDto {
                                total_tracks: 0,
                                pending_tracks: 0,
                                done_tracks: 0,
                            },
                            updated_at: Instant::now() - Duration::from_secs(60),
                            in_flight: true,
                        },
                    );
                    return true;
                }
            }
        }
        false
    }

    pub fn set_analysis_progress(&self, server_id: &str, value: LibraryAnalysisProgressDto) {
        if let Ok(mut cache) = self.analysis_progress_cache.lock() {
            cache.insert(
                server_id.to_string(),
                AnalysisProgressCacheEntry {
                    value,
                    updated_at: Instant::now(),
                    in_flight: false,
                },
            );
        }
    }

    pub fn clear_analysis_progress_in_flight(&self, server_id: &str) {
        if let Ok(mut cache) = self.analysis_progress_cache.lock() {
            if let Some(entry) = cache.get_mut(server_id) {
                entry.in_flight = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session(server_id: &str) -> SyncSession {
        SyncSession {
            server_id: server_id.into(),
            base_url: "https://nas.example.com".into(),
            username: "u".into(),
            password: "p".into(),
            navidrome_token: None,
            library_scope: None,
        }
    }

    fn sample_job(server_id: &str, kind: &str) -> CurrentJob {
        CurrentJob {
            job_id: format!("{server_id}-{kind}"),
            server_id: server_id.into(),
            kind: kind.into(),
            cancel: Arc::new(AtomicBool::new(false)),
            abort_handle: None,
            done: Arc::new(Notify::new()),
        }
    }

    #[test]
    fn new_runtime_has_empty_sessions_and_idle_hint() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        assert!(rt.snapshot_sessions().is_empty());
        assert_eq!(rt.current_playback_hint(), PlaybackHint::Idle);
        assert!(!rt
            .scheduler_cancel
            .load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn set_and_get_session_roundtrip() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        rt.set_session(sample_session("s1")).unwrap();
        let got = rt.get_session("s1").unwrap();
        assert_eq!(got.base_url, "https://nas.example.com");
        assert_eq!(got.username, "u");
    }

    #[test]
    fn clear_session_removes_one_server_only() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        rt.set_session(sample_session("s1")).unwrap();
        rt.set_session(sample_session("s2")).unwrap();
        rt.clear_session("s1");
        assert!(rt.get_session("s1").is_none());
        assert!(rt.get_session("s2").is_some());
    }

    #[test]
    fn snapshot_returns_clones_so_lock_drops_after_call() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        rt.set_session(sample_session("s1")).unwrap();
        let snap = rt.snapshot_sessions();
        // Should be free to mutate after the snapshot.
        rt.set_session(sample_session("s2")).unwrap();
        assert_eq!(snap.len(), 1);
        assert_eq!(rt.snapshot_sessions().len(), 2);
    }

    #[test]
    fn playback_hint_default_is_idle_and_setter_updates() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        assert_eq!(rt.current_playback_hint(), PlaybackHint::Idle);
        rt.set_playback_hint(PlaybackHint::Playing);
        assert_eq!(rt.current_playback_hint(), PlaybackHint::Playing);
        rt.set_playback_hint(PlaybackHint::PrefetchActive);
        assert_eq!(rt.current_playback_hint(), PlaybackHint::PrefetchActive);
    }

    #[tokio::test]
    async fn job_done_notify_one_survives_early_signal_before_await() {
        let done = Arc::new(Notify::new());
        done.notify_one();
        tokio::time::timeout(std::time::Duration::from_millis(50), done.notified())
            .await
            .expect("notify_one must store a permit for a later waiter");
    }

    #[tokio::test]
    async fn job_done_notify_waiters_loses_early_signal_before_await() {
        let done = Arc::new(Notify::new());
        done.notify_waiters();
        let waited = tokio::time::timeout(std::time::Duration::from_millis(20), done.notified())
            .await
            .is_ok();
        assert!(
            !waited,
            "notify_waiters must not store a permit — resync drain uses notify_one instead"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_and_drain_replaces_any_foreground_job() {
        let runtime = Arc::new(LibraryRuntime::new(
            Arc::new(LibraryStore::open_in_memory()),
        ));
        let job = sample_job("old-server", "delta_sync");
        let cancel = Arc::clone(&job.cancel);
        let done = Arc::clone(&job.done);
        let job_id = job.job_id.clone();
        runtime.install_current_job(job).unwrap();

        let runtime_for_job = Arc::clone(&runtime);
        let task = tokio::spawn(async move {
            while !cancel.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            runtime_for_job.complete_current_job(&job_id, &done);
        });

        let barrier = tokio::time::timeout(
            Duration::from_secs(1),
            runtime.cancel_and_drain_sync(None, None),
        )
        .await
        .expect("drain timed out")
        .expect("drain failed");
        assert!(runtime.current_job().is_none());
        drop(barrier);
        task.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_and_drain_aborts_never_responding_runner_within_bound() {
        let runtime = Arc::new(LibraryRuntime::new(
            Arc::new(LibraryStore::open_in_memory()),
        ));
        let job = sample_job("s1", "delta_sync");
        let cancel = Arc::clone(&job.cancel);
        let done = Arc::clone(&job.done);
        let job_id = job.job_id.clone();
        runtime.install_current_job(job).unwrap();

        let runner = tokio::spawn(std::future::pending::<()>());
        runtime
            .attach_current_job_abort_handle(&job_id, runner.abort_handle())
            .unwrap();
        let runtime_for_completion = Arc::clone(&runtime);
        let completion = tokio::spawn(async move {
            let _ = runner.await;
            runtime_for_completion.complete_current_job(&job_id, &done);
        });

        let barrier = tokio::time::timeout(
            Duration::from_millis(250),
            runtime.cancel_and_drain_sync_with_timeouts(
                None,
                None,
                Duration::from_millis(10),
                Duration::from_millis(100),
            ),
        )
        .await
        .expect("bounded drain hung")
        .expect("abortable runner did not drain");
        assert!(cancel.load(Ordering::SeqCst));
        assert!(runtime.current_job().is_none());
        drop(barrier);
        completion.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_and_drain_fails_bounded_when_synthetic_job_cannot_abort() {
        let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
        let job = sample_job("s1", "delta_sync");
        let cancel = Arc::clone(&job.cancel);
        runtime.install_current_job(job).unwrap();

        let result = tokio::time::timeout(
            Duration::from_millis(250),
            runtime.cancel_and_drain_sync_with_timeouts(
                None,
                None,
                Duration::from_millis(10),
                Duration::from_millis(20),
            ),
        )
        .await
        .expect("bounded drain hung");
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("non-abortable synthetic job unexpectedly drained"),
        };
        assert!(error.contains("did not stop"));
        assert!(cancel.load(Ordering::SeqCst));
        assert!(runtime.current_job().is_some());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn exclusive_barrier_waits_for_scheduler_activity() {
        let runtime = Arc::new(LibraryRuntime::new(
            Arc::new(LibraryStore::open_in_memory()),
        ));
        let scheduler = runtime.sync_activity_guard().await;
        let acquired = Arc::new(AtomicBool::new(false));
        let acquired_for_task = Arc::clone(&acquired);
        let runtime_for_task = Arc::clone(&runtime);
        let task = tokio::spawn(async move {
            let barrier = runtime_for_task
                .cancel_and_drain_sync(None, None)
                .await
                .unwrap();
            acquired_for_task.store(true, Ordering::SeqCst);
            barrier
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!acquired.load(Ordering::SeqCst));
        drop(scheduler);

        let barrier = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("barrier stayed blocked")
            .unwrap();
        assert!(acquired.load(Ordering::SeqCst));
        drop(barrier);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn identity_migration_waits_for_prepared_non_sync_writer() {
        let runtime = Arc::new(LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory())));
        let writer = runtime.identity_mutation_guard().await;
        let acquired = Arc::new(AtomicBool::new(false));
        let acquired_for_task = Arc::clone(&acquired);
        let runtime_for_task = Arc::clone(&runtime);
        let task = tokio::spawn(async move {
            let guard = runtime_for_task.identity_migration_guard().await;
            acquired_for_task.store(true, Ordering::SeqCst);
            guard
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!acquired.load(Ordering::SeqCst));
        drop(writer);

        let migration = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("identity migration stayed blocked")
            .unwrap();
        assert!(acquired.load(Ordering::SeqCst));
        drop(migration);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stale_job_selector_does_not_cancel_replacement() {
        let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
        let job = sample_job("s1", "delta_sync");
        let cancel = Arc::clone(&job.cancel);
        let done = Arc::clone(&job.done);
        let job_id = job.job_id.clone();
        runtime.install_current_job(job).unwrap();

        let barrier = runtime
            .cancel_and_drain_sync(Some("already-finished"), None)
            .await
            .unwrap();
        assert!(!cancel.load(Ordering::SeqCst));
        assert_eq!(runtime.current_job().unwrap().job_id, job_id);
        drop(barrier);

        runtime.complete_current_job(&job_id, &done);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn database_swap_drains_http_waiting_job_before_switching_files() {
        use std::time::{SystemTime, UNIX_EPOCH};
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/in-flight"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(200))
                    .set_body_string("ok"),
            )
            .mount(&server)
            .await;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "psysonic-library-drain-swap-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let active_path = root.join("library.sqlite");
        let import_path = root.join("library-import.sqlite");

        let store = Arc::new(LibraryStore::open_path_for_test(&active_path).unwrap());
        store
            .with_conn("test.seed-active", |conn| {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                     VALUES ('s1', 'before', 'Before', '', 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        {
            let imported = LibraryStore::open_path_for_test(&import_path).unwrap();
            imported
                .with_conn("test.seed-import", |conn| {
                    conn.execute(
                        "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                         VALUES ('s1', 'imported', 'Imported', '', 1, '{}')",
                        [],
                    )?;
                    Ok(())
                })
                .unwrap();
            imported
                .checkpoint_wal("test.seed-import.checkpoint")
                .unwrap();
        }

        let runtime = Arc::new(LibraryRuntime::new(store));
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(Notify::new());
        let job_id = "http-writer".to_string();
        runtime
            .install_current_job(CurrentJob {
                job_id: job_id.clone(),
                server_id: "s1".into(),
                kind: "initial_sync".into(),
                cancel: Arc::clone(&cancel),
                abort_handle: None,
                done: Arc::clone(&done),
            })
            .unwrap();

        let runtime_for_job = Arc::clone(&runtime);
        let request_url = format!("{}/in-flight", server.uri());
        let writer = tokio::spawn(async move {
            reqwest::get(request_url)
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            runtime_for_job
                .store
                .with_conn("test.late-write", |conn| {
                    conn.execute(
                        "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                         VALUES ('s1', 'late', 'Late', '', 1, '{}')",
                        [],
                    )?;
                    Ok(())
                })
                .unwrap();
            runtime_for_job.complete_current_job(&job_id, &done);
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if server
                    .received_requests()
                    .await
                    .expect("requests captured")
                    .is_empty()
                {
                    tokio::task::yield_now().await;
                } else {
                    break;
                }
            }
        })
        .await
        .expect("HTTP request did not start");

        let barrier = runtime.cancel_and_drain_sync(None, None).await.unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        runtime
            .store
            .swap_database_file(&active_path, &import_path)
            .unwrap()
            .expect("active database backup");
        drop(barrier);
        writer.await.unwrap();

        let ids = runtime
            .store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare("SELECT id FROM track ORDER BY id")?;
                let ids = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(ids)
            })
            .unwrap();
        assert_eq!(ids, vec!["imported"]);

        drop(runtime);
        std::fs::remove_dir_all(root).unwrap();
    }
}

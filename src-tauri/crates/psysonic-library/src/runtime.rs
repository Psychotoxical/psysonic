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
#[path = "runtime/tests.rs"]
mod tests;

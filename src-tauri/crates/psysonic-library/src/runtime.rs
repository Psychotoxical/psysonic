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

use tokio::sync::Notify;

use crate::store::LibraryStore;
use crate::sync::bandwidth::PlaybackHint;

/// Per-server credentials cache for the sync runner. Lives only in
/// `LibraryRuntime` process memory; `library_sync_clear_session`
/// removes it on logout / index disable / purge.
#[derive(Debug, Clone)]
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
    /// Signaled when this job's runner task finishes (success, error, or cancel).
    pub done: Arc<Notify>,
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
    /// Top-crate scheduler tick task watches this flag; set true on
    /// app shutdown / library index disabled.
    pub scheduler_cancel: Arc<AtomicBool>,
    /// Latest `library_live_search` epoch from the UI — stale commands
    /// skip FTS when a newer keystroke generation was registered.
    live_search_epoch: AtomicU64,
}

impl LibraryRuntime {
    pub fn new(store: Arc<LibraryStore>) -> Self {
        Self {
            store,
            sync_sessions: Mutex::new(HashMap::new()),
            playback_hint: Mutex::new(PlaybackHint::default()),
            current_job: Mutex::new(None),
            scheduler_cancel: Arc::new(AtomicBool::new(false)),
            live_search_epoch: AtomicU64::new(0),
        }
    }

    /// UI bumps `epoch` on every debounced search start / cancel.
    pub fn register_live_search_epoch(&self, epoch: u64) {
        let _ = self.live_search_epoch.fetch_max(epoch, Ordering::SeqCst);
    }

    pub fn live_search_still_current(&self, epoch: u64) -> bool {
        self.live_search_epoch.load(Ordering::Acquire) == epoch
    }

    pub fn set_current_job(&self, job: CurrentJob) {
        if let Ok(mut slot) = self.current_job.lock() {
            // Best-effort cancel any in-flight job before we replace.
            if let Some(prev) = slot.as_ref() {
                prev.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            *slot = Some(job);
        }
    }

    pub fn current_job(&self) -> Option<CurrentJob> {
        self.current_job.lock().ok().and_then(|s| s.clone())
    }

    pub fn clear_current_job_if_matches(&self, job_id: &str) {
        if let Ok(mut slot) = self.current_job.lock() {
            if slot.as_ref().is_some_and(|j| j.job_id == job_id) {
                *slot = None;
            }
        }
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

    pub fn set_session(&self, session: SyncSession) {
        if let Ok(mut sessions) = self.sync_sessions.lock() {
            sessions.insert(session.server_id.clone(), session);
        }
    }

    pub fn clear_session(&self, server_id: &str) {
        if let Ok(mut sessions) = self.sync_sessions.lock() {
            sessions.remove(server_id);
        }
    }

    pub fn current_playback_hint(&self) -> PlaybackHint {
        self.playback_hint
            .lock()
            .map(|h| *h)
            .unwrap_or_default()
    }

    pub fn set_playback_hint(&self, hint: PlaybackHint) {
        if let Ok(mut h) = self.playback_hint.lock() {
            *h = hint;
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
        rt.set_session(sample_session("s1"));
        let got = rt.get_session("s1").unwrap();
        assert_eq!(got.base_url, "https://nas.example.com");
        assert_eq!(got.username, "u");
    }

    #[test]
    fn clear_session_removes_one_server_only() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        rt.set_session(sample_session("s1"));
        rt.set_session(sample_session("s2"));
        rt.clear_session("s1");
        assert!(rt.get_session("s1").is_none());
        assert!(rt.get_session("s2").is_some());
    }

    #[test]
    fn snapshot_returns_clones_so_lock_drops_after_call() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = LibraryRuntime::new(store);
        rt.set_session(sample_session("s1"));
        let snap = rt.snapshot_sessions();
        // Should be free to mutate after the snapshot.
        rt.set_session(sample_session("s2"));
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
}

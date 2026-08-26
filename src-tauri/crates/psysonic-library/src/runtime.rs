//! `LibraryRuntime` — Tauri State shared by every library command.
//!
//! PR-5a held only the store. PR-5b extends with the per-server sync
//! session map (credentials live in process memory only — same trust
//! boundary as today's WebView-held passwords), the current playback
//! hint, an `Option<SyncSupervisor>` for in-flight start/cancel, and
//! a long-lived cancellation flag for the background-scheduler task
//! the top crate spawns in `setup()`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
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

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type,
)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationPhase {
    Pending,
    Native,
    Analysis,
    Cover,
    Frontend,
    Cleanup,
    Sync,
    Retryable,
    Blocked,
    Legacy,
    NotApplicable,
    Ready,
}

impl MigrationPhase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Legacy | Self::NotApplicable | Self::Ready)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MigrationServerSnapshotDto {
    pub server_id: String,
    pub phase: MigrationPhase,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum MigrationGenerationSnapshotDto {
    Inactive { last_generation: u64 },
    Active {
        generation: u64,
        servers: Vec<MigrationServerSnapshotDto>,
    },
}

#[derive(Debug, Clone)]
struct MigrationServerState {
    phase: MigrationPhase,
    error: Option<String>,
}

#[derive(Debug)]
struct ActiveMigrationGeneration {
    generation: u64,
    servers: BTreeMap<String, MigrationServerState>,
}

#[derive(Debug)]
enum MigrationGenerationState {
    Inactive { last_generation: u64 },
    Active(ActiveMigrationGeneration),
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
    /// Long-lived global writer block for a connection migration generation.
    migration_generation: Mutex<MigrationGenerationState>,
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
            migration_generation: Mutex::new(MigrationGenerationState::Inactive {
                last_generation: 0,
            }),
        }
    }

    /// UI bumps `epoch` on every debounced search start / cancel.
    pub fn register_live_search_epoch(&self, epoch: u64) {
        let _ = self.live_search_epoch.fetch_max(epoch, Ordering::SeqCst);
    }

    pub fn live_search_still_current(&self, epoch: u64) -> bool {
        self.live_search_epoch.load(Ordering::Acquire) == epoch
    }

    /// Gate non-SQL native writers (cover/offline filesystem work) on the same
    /// migration generation that protects the library and analysis databases.
    pub fn ensure_external_write_allowed(&self) -> Result<(), String> {
        self.store.ensure_write_generation_allowed()
    }

    /// Start or extend the one active connection migration generation.
    pub async fn begin_migration_generation<I, S>(&self, server_ids: I) -> Result<u64, String>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut admitted = BTreeSet::new();
        for server_id in server_ids {
            let server_id = server_id.into();
            if server_id.trim().is_empty() {
                return Err("migration server id must not be empty".to_string());
            }
            admitted.insert(server_id);
        }

        let (generation, created) = {
            let mut state = self
                .migration_generation
                .lock()
                .map_err(|_| "library migration generation lock poisoned".to_string())?;
            match &mut *state {
                MigrationGenerationState::Active(active) => {
                    for server_id in admitted {
                        match active.servers.entry(server_id) {
                            std::collections::btree_map::Entry::Vacant(entry) => {
                                entry.insert(MigrationServerState {
                                    phase: MigrationPhase::Pending,
                                    error: None,
                                });
                            }
                            std::collections::btree_map::Entry::Occupied(mut entry)
                                if entry.get().phase.is_terminal() =>
                            {
                                entry.insert(MigrationServerState {
                                    phase: MigrationPhase::Pending,
                                    error: None,
                                });
                            }
                            std::collections::btree_map::Entry::Occupied(_) => {}
                        }
                    }
                    (active.generation, false)
                }
                MigrationGenerationState::Inactive { last_generation } => {
                    if admitted.is_empty() {
                        return Err(
                            "cannot begin a migration generation without an admitted server"
                                .to_string(),
                        );
                    }
                    let generation = last_generation.checked_add(1).ok_or_else(|| {
                        "library migration generation counter exhausted".to_string()
                    })?;
                    let servers = admitted
                        .into_iter()
                        .map(|server_id| {
                            (
                                server_id,
                                MigrationServerState {
                                    phase: MigrationPhase::Pending,
                                    error: None,
                                },
                            )
                        })
                        .collect();
                    *state = MigrationGenerationState::Active(ActiveMigrationGeneration {
                        generation,
                        servers,
                    });
                    (generation, true)
                }
            }
        };

        if !created {
            return Ok(generation);
        }

        let activation = async {
            let barrier = self.cancel_and_drain_sync(None, None).await?;
            self.store.activate_migration_write_generation(generation)?;
            drop(barrier);
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = activation {
            let _ = self.store.deactivate_migration_write_generation(generation);
            if let Ok(mut state) = self.migration_generation.lock() {
                if matches!(
                    &*state,
                    MigrationGenerationState::Active(active) if active.generation == generation
                ) {
                    *state = MigrationGenerationState::Inactive {
                        last_generation: generation,
                    };
                }
            }
            return Err(error);
        }
        Ok(generation)
    }

    pub fn inspect_migration_generation(
        &self,
    ) -> Result<MigrationGenerationSnapshotDto, String> {
        let state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        Ok(match &*state {
            MigrationGenerationState::Inactive { last_generation } => {
                MigrationGenerationSnapshotDto::Inactive {
                    last_generation: *last_generation,
                }
            }
            MigrationGenerationState::Active(active) => {
                MigrationGenerationSnapshotDto::Active {
                    generation: active.generation,
                    servers: active
                        .servers
                        .iter()
                        .map(|(server_id, server)| MigrationServerSnapshotDto {
                            server_id: server_id.clone(),
                            phase: server.phase,
                            error: server.error.clone(),
                        })
                        .collect(),
                }
            }
        })
    }

    pub fn ensure_ordinary_sync_activity_allowed(&self) -> Result<(), String> {
        let state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        match &*state {
            MigrationGenerationState::Inactive { .. } => Ok(()),
            MigrationGenerationState::Active(active) => Err(format!(
                "library migration generation {} blocks ordinary sync activity",
                active.generation
            )),
        }
    }

    pub fn ensure_migration_server_allowed(
        &self,
        generation: u64,
        server_id: &str,
    ) -> Result<(), String> {
        let state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let MigrationGenerationState::Active(active) = &*state else {
            return Err("no active library migration generation".to_string());
        };
        if active.generation != generation {
            return Err(format!(
                "stale library migration generation {generation}; active generation is {}",
                active.generation
            ));
        }
        let server = active.servers.get(server_id).ok_or_else(|| {
            format!(
                "server `{server_id}` is not admitted to library migration generation {generation}"
            )
        })?;
        if server.phase == MigrationPhase::Blocked || server.phase.is_terminal() {
            return Err(format!(
                "server `{server_id}` cannot perform migration work in phase {:?}",
                server.phase
            ));
        }
        Ok(())
    }

    pub fn ensure_migration_full_sync_allowed(
        &self,
        generation: u64,
        server_id: &str,
    ) -> Result<(), String> {
        self.ensure_migration_server_allowed(generation, server_id)?;
        let state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let MigrationGenerationState::Active(active) = &*state else {
            return Err("no active library migration generation".to_string());
        };
        let server = active.servers.get(server_id).expect("admission checked above");
        if server.phase != MigrationPhase::Sync {
            return Err(format!(
                "server `{server_id}` is in migration phase {:?}, not sync",
                server.phase
            ));
        }
        Ok(())
    }

    pub fn ensure_migration_phase(
        &self,
        generation: u64,
        server_id: &str,
        expected: MigrationPhase,
    ) -> Result<(), String> {
        self.ensure_migration_server_allowed(generation, server_id)?;
        let state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let MigrationGenerationState::Active(active) = &*state else {
            return Err("no active library migration generation".to_string());
        };
        let server = active.servers.get(server_id).expect("admission checked above");
        if server.phase != expected {
            return Err(format!(
                "server `{server_id}` is in migration phase {:?}, not {expected:?}",
                server.phase
            ));
        }
        Ok(())
    }

    pub fn update_migration_phase(
        &self,
        generation: u64,
        server_id: &str,
        phase: MigrationPhase,
    ) -> Result<(), String> {
        if phase == MigrationPhase::Blocked || phase.is_terminal() {
            return Err(format!(
                "migration phase {phase:?} requires abort_migration_server or finish_migration_server"
            ));
        }
        let mut state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let active = active_migration_generation_mut(&mut state, generation)?;
        let server = admitted_migration_server_mut(active, server_id)?;
        if server.phase == MigrationPhase::Blocked || server.phase.is_terminal() {
            return Err(format!(
                "server `{server_id}` cannot advance from migration phase {:?}",
                server.phase
            ));
        }
        server.phase = phase;
        server.error = None;
        Ok(())
    }

    pub fn finish_migration_server(
        &self,
        generation: u64,
        server_id: &str,
        phase: MigrationPhase,
    ) -> Result<(), String> {
        if !phase.is_terminal() {
            return Err(format!("migration phase {phase:?} is not terminal"));
        }
        let mut state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let active = active_migration_generation_mut(&mut state, generation)?;
        let server = admitted_migration_server_mut(active, server_id)?;
        if server.phase == MigrationPhase::Blocked {
            return Err(format!(
                "server `{server_id}` is blocked and must be retried before it can finish"
            ));
        }
        if server.phase.is_terminal() && server.phase != phase {
            return Err(format!(
                "server `{server_id}` already finished migration in phase {:?}",
                server.phase
            ));
        }
        server.phase = phase;
        server.error = None;
        Ok(())
    }

    pub fn abort_migration_server(
        &self,
        generation: u64,
        server_id: &str,
        error: impl Into<String>,
    ) -> Result<(), String> {
        let error = error.into();
        if error.trim().is_empty() {
            return Err("migration abort error must not be empty".to_string());
        }
        let mut state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let active = active_migration_generation_mut(&mut state, generation)?;
        let server = admitted_migration_server_mut(active, server_id)?;
        if server.phase.is_terminal() {
            return Err(format!(
                "server `{server_id}` already finished migration in phase {:?}",
                server.phase
            ));
        }
        server.phase = MigrationPhase::Blocked;
        server.error = Some(error);
        Ok(())
    }

    pub fn retry_migration_server(
        &self,
        generation: u64,
        server_id: &str,
    ) -> Result<(), String> {
        let mut state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let active = active_migration_generation_mut(&mut state, generation)?;
        let server = admitted_migration_server_mut(active, server_id)?;
        if server.phase != MigrationPhase::Blocked {
            return Err(format!(
                "server `{server_id}` is in migration phase {:?}, not blocked",
                server.phase
            ));
        }
        server.phase = MigrationPhase::Pending;
        server.error = None;
        Ok(())
    }

    pub fn release_migration_generation(&self, generation: u64) -> Result<(), String> {
        let mut state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let active = active_migration_generation_mut(&mut state, generation)?;
        let unfinished = active
            .servers
            .iter()
            .filter(|(_, server)| !server.phase.is_terminal())
            .map(|(server_id, server)| format!("{server_id} ({:?})", server.phase))
            .collect::<Vec<_>>();
        if !unfinished.is_empty() {
            return Err(format!(
                "library migration generation {generation} cannot release; unfinished servers: {}",
                unfinished.join(", ")
            ));
        }
        self.store
            .deactivate_migration_write_generation(generation)?;
        *state = MigrationGenerationState::Inactive {
            last_generation: generation,
        };
        Ok(())
    }

    /// Undo a generation whose external writer barriers failed to activate.
    /// This is valid only before any admitted server leaves `Pending`.
    pub fn rollback_migration_generation_start(&self, generation: u64) -> Result<(), String> {
        let mut state = self
            .migration_generation
            .lock()
            .map_err(|_| "library migration generation lock poisoned".to_string())?;
        let active = active_migration_generation_mut(&mut state, generation)?;
        if active
            .servers
            .values()
            .any(|server| server.phase != MigrationPhase::Pending)
        {
            return Err(format!(
                "library migration generation {generation} already started durable work"
            ));
        }
        self.store
            .deactivate_migration_write_generation(generation)?;
        *state = MigrationGenerationState::Inactive {
            last_generation: generation,
        };
        Ok(())
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

fn active_migration_generation_mut(
    state: &mut MigrationGenerationState,
    generation: u64,
) -> Result<&mut ActiveMigrationGeneration, String> {
    let MigrationGenerationState::Active(active) = state else {
        return Err("no active library migration generation".to_string());
    };
    if active.generation != generation {
        return Err(format!(
            "stale library migration generation {generation}; active generation is {}",
            active.generation
        ));
    }
    Ok(active)
}

fn admitted_migration_server_mut<'a>(
    active: &'a mut ActiveMigrationGeneration,
    server_id: &str,
) -> Result<&'a mut MigrationServerState, String> {
    let generation = active.generation;
    active.servers.get_mut(server_id).ok_or_else(|| {
        format!("server `{server_id}` is not admitted to library migration generation {generation}")
    })
}

#[cfg(test)]
#[path = "runtime/tests.rs"]
mod tests;

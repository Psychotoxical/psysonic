//! C8 — background scheduler (spec §6.2).
//!
//! Tick-based: the top crate (PR-5) drives the actual timer; PR-3d2
//! ships the logic that decides "is it time?", picks the budget +
//! tombstone trigger, runs the DeltaSyncRunner, and writes back the
//! adaptive interval.
//!
//! Owns no tokio task itself — keeps testability high and lets the
//! caller decide spawn behaviour (Supervisor or inline).

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_integration::subsonic::SubsonicClient;

use super::bandwidth::{ParallelismBudget, PlaybackHint};
use super::budget::{PassKind, RequestBudget};
use super::capability::{CapabilityFlags, NavidromeProbeCredentials};
use super::census::{AlbumCensusRunner, CensusReport};
use super::delta::{DeltaSyncReport, DeltaSyncRunner};
use super::error::SyncError;
use super::poll_stats::{census_is_due, CENSUS_DEFERRED_RETRY_MS, CENSUS_INTERVAL_MS};
use super::poll_stats::{next_interval_ms, PollStats};
use super::progress::{NoopProgress, Progress};
use super::tombstone::should_auto_reconcile_scope;
use crate::repos::SyncStateRepository;
use crate::store::LibraryStore;

mod state;

/// Default Mode B threshold per §6.7 (5 % gap before auto reconcile).
pub const DEFAULT_TOMBSTONE_THRESHOLD_PCT: u32 = 5;

/// Time one census may take inside a tick. Comfortably below the caller's tick
/// timeout so an unresponsive server cannot turn a healthy delta pass into a
/// recorded scheduler failure.
pub const CENSUS_RUN_BUDGET: std::time::Duration = std::time::Duration::from_secs(45);
const ERROR_RETRY_INTERVAL_MS: i64 = 30_000;
const MAX_PERSISTED_ERROR_CHARS: usize = 1_000;

fn census_needs_early_retry(report: &CensusReport) -> bool {
    report.changed_index() && (report.budget_exhausted || report.deferred > 0)
}

/// Outcome of one scheduler tick — what happened plus the resolved
/// `next_poll_at` so the caller can re-schedule its timer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulerTickReport {
    pub skipped_not_due: bool,
    pub skipped_bulk_paused: bool,
    /// Delta/tombstone pass deferred while initial sync or capability probe
    /// holds `sync_phase`, IS-3 bulk ingest is active, or a foreground sync
    /// job (`LibraryRuntime::current_job`) is running for this server.
    pub skipped_sync_pass_active: bool,
    pub delta: Option<DeltaSyncReport>,
    /// The census changed the index this tick. Separate from the delta report
    /// because the census exists precisely for the case the delta reports
    /// nothing — without this the surfaces would keep showing an album whose
    /// tracks were just retired.
    pub census_changed_index: bool,
    pub next_poll_at_ms: i64,
}

impl SchedulerTickReport {
    /// A delta completed far enough to validate the server watermark or apply
    /// data. Deferred scans and all scheduler short-circuits are not success
    /// signals for error clearing or frontend refresh events.
    pub fn completed_delta(&self) -> bool {
        self.delta
            .as_ref()
            .is_some_and(|delta| !delta.deferred_scanning)
    }
}

pub struct BackgroundScheduler<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    navidrome: Option<NavidromeProbeCredentials>,
    http_registry: Option<Arc<ServerHttpRegistry>>,
    server_id: String,
    library_scope: String,
    capability_flags: CapabilityFlags,
    playback_hint: PlaybackHint,
    cancel: Option<Arc<AtomicBool>>,
    progress: Arc<dyn Progress + Send + Sync>,
    tombstone_threshold_pct: u32,
    sleep_enabled: bool,
    /// When true, a user-triggered sync job (delta / verify / full resync)
    /// already owns this server — skip the background delta pass.
    foreground_sync_job_active: bool,
}

impl<'a> BackgroundScheduler<'a> {
    pub fn new(
        store: &'a LibraryStore,
        subsonic: &'a SubsonicClient,
        server_id: impl Into<String>,
        library_scope: impl Into<String>,
        capability_flags: CapabilityFlags,
    ) -> Self {
        Self {
            store,
            subsonic,
            navidrome: None,
            http_registry: None,
            server_id: server_id.into(),
            library_scope: library_scope.into(),
            capability_flags,
            playback_hint: PlaybackHint::Idle,
            cancel: None,
            progress: Arc::new(NoopProgress),
            tombstone_threshold_pct: DEFAULT_TOMBSTONE_THRESHOLD_PCT,
            sleep_enabled: true,
            foreground_sync_job_active: false,
        }
    }

    pub fn with_navidrome_credentials(mut self, creds: NavidromeProbeCredentials) -> Self {
        self.navidrome = Some(creds);
        self
    }

    pub fn with_http_registry(mut self, registry: Option<Arc<ServerHttpRegistry>>) -> Self {
        self.http_registry = registry;
        self
    }

    pub fn with_playback_hint(mut self, hint: PlaybackHint) -> Self {
        self.playback_hint = hint;
        self
    }

    pub fn with_cancellation(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_progress(mut self, progress: Arc<dyn Progress + Send + Sync>) -> Self {
        self.progress = progress;
        self
    }

    pub fn with_tombstone_threshold_pct(mut self, pct: u32) -> Self {
        self.tombstone_threshold_pct = pct;
        self
    }

    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    pub fn with_foreground_sync_job_active(mut self, active: bool) -> Self {
        self.foreground_sync_job_active = active;
        self
    }

    /// `true` when `next_poll_at` has passed (or no value yet). Caller
    /// short-circuits its timer when this returns `false`.
    pub fn is_due(&self, now_ms: i64) -> Result<bool, SyncError> {
        let sync_state = SyncStateRepository::new(self.store);
        let next = sync_state
            .get_next_poll_at(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        Ok(next.map(|n| now_ms >= n).unwrap_or(true))
    }

    /// Resolve the parallelism budget for the current playback state.
    /// Bulk-paused state means the scheduler skips the tick entirely
    /// and just re-schedules.
    pub fn parallelism_budget(&self) -> ParallelismBudget {
        ParallelismBudget::resolve(self.playback_hint)
    }

    /// Run one tick — runs a delta sync if due and bulk isn't paused
    /// by the playback signal, then writes the new `next_poll_at`.
    pub async fn tick(&self, now_ms: i64) -> Result<SchedulerTickReport, SyncError> {
        let result = self.tick_inner(now_ms).await;
        self.finish_tick(now_ms, result)
    }

    /// Bound a complete server tick so one unresponsive endpoint cannot hold a
    /// scheduler concurrency slot indefinitely.
    pub async fn tick_with_timeout(
        &self,
        now_ms: i64,
        timeout: Duration,
    ) -> Result<SchedulerTickReport, SyncError> {
        let result = match tokio::time::timeout(timeout, self.tick_inner(now_ms)).await {
            Ok(result) => result,
            Err(_) => Err(SyncError::Transport(format!(
                "background scheduler timed out after {} ms",
                timeout.as_millis()
            ))),
        };
        self.finish_tick(now_ms, result)
    }

    async fn tick_inner(&self, now_ms: i64) -> Result<SchedulerTickReport, SyncError> {
        let sync_state = SyncStateRepository::new(self.store);
        sync_state
            .ensure(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;

        let mut report = SchedulerTickReport {
            skipped_not_due: false,
            skipped_bulk_paused: false,
            skipped_sync_pass_active: false,
            delta: None,
            census_changed_index: false,
            next_poll_at_ms: now_ms,
        };

        if self.sync_pass_active(&sync_state)? {
            report.skipped_sync_pass_active = true;
            report.next_poll_at_ms = now_ms + 30_000;
            sync_state
                .set_next_poll_at(&self.server_id, &self.library_scope, report.next_poll_at_ms)
                .map_err(SyncError::Storage)?;
            crate::app_eprintln!(
                "[library-sync] scheduler tick skipped: sync pass active (phase={:?}, bulk={})",
                sync_state
                    .get_sync_phase(&self.server_id, &self.library_scope)
                    .ok()
                    .flatten(),
                self.store.bulk_ingest_active()
            );
            return Ok(report);
        }

        if !self.is_due(now_ms)? {
            report.skipped_not_due = true;
            let stats = self.load_poll_stats(&sync_state)?;
            report.next_poll_at_ms = now_ms + next_interval_ms(&stats) as i64;
            return Ok(report);
        }

        let parallelism = self.parallelism_budget();
        if parallelism.bulk_paused() {
            // §6.2.4 PrefetchActive — skip this tick entirely, re-poll
            // soon so we can catch the prefetch finishing.
            report.skipped_bulk_paused = true;
            report.next_poll_at_ms = now_ms + 30_000; // ~30s short retry
            sync_state
                .set_next_poll_at(&self.server_id, &self.library_scope, report.next_poll_at_ms)
                .map_err(SyncError::Storage)?;
            return Ok(report);
        }

        // Decide budget + tombstone trigger.
        let mut tombstone_budget: u32 = 0;
        if let (Some(local), Some(server)) = (
            sync_state
                .get_local_track_count(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?,
            sync_state
                .get_server_track_count(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?,
        ) {
            let (local_u, server_u) = (local.max(0) as u32, server.max(0) as u32);
            if should_auto_reconcile_scope(
                &self.library_scope,
                local_u,
                server_u,
                self.tombstone_threshold_pct,
            ) {
                tombstone_budget = RequestBudget::DELTA_MISMATCH_CAP;
            }
        }
        let _pass_budget = if tombstone_budget > 0 {
            RequestBudget::for_pass(PassKind::DeltaMismatch)
        } else {
            RequestBudget::for_pass(PassKind::DeltaLight)
        };
        // PR-3d2 doesn't enforce pass_budget against the runner yet —
        // delta runner is already small (1 probe + ≤8 album-list
        // pages); the budget value is recorded so PR-5 can surface it
        // in Settings. Wire actual cap in the runner when DS-7
        // starred delta or other request-heavy paths land.

        // Run the delta pass.
        let mut runner = DeltaSyncRunner::new(
            self.store,
            self.subsonic,
            &self.server_id,
            &self.library_scope,
            self.capability_flags,
        )
        .with_progress(Arc::clone(&self.progress))
        .with_http_registry(self.http_registry.clone());
        if let Some(creds) = &self.navidrome {
            runner = runner.with_navidrome_credentials(creds.clone());
        }
        if let Some(flag) = &self.cancel {
            runner = runner.with_cancellation(Arc::clone(flag));
        }
        if !self.sleep_enabled {
            runner = runner.with_sleep_disabled();
        }
        if tombstone_budget > 0 {
            runner = runner.with_tombstone_budget(tombstone_budget);
        }
        let delta_report = runner.run().await?;

        // `deferred_scanning` means the server explicitly told us its catalogue
        // is in flux. Album enumeration and NotFound probes are least reliable
        // in that window, so do not let the tagging or census paths reinterpret
        // transient scan state as missing local data.
        if delta_report.deferred_scanning {
            report.next_poll_at_ms = now_ms.saturating_add(ERROR_RETRY_INTERVAL_MS);
            sync_state
                .set_next_poll_at(&self.server_id, &self.library_scope, report.next_poll_at_ms)
                .map_err(SyncError::Storage)?;
            report.delta = Some(delta_report);
            return Ok(report);
        }

        // Tag empty `library_id` rows after background delta — new bulk-ingested
        // tracks arrive without folder metadata until this pass runs.
        super::library_tag::run_tag_pass_best_effort(
            self.store,
            self.subsonic,
            &self.server_id,
            self.cancel.clone(),
            Arc::clone(&self.progress),
            true,
        )
        .await;

        // Update poll_stats: nothing measured per-request yet in
        // PR-3d2 (PR-5 will plumb byte/duration via a custom HTTP
        // wrapper). For now the tier signal updates from artist_count
        // when the next probe lands; we just persist the artist_count
        // we know from the local DB so the tier classifier has data.
        let mut stats = self.load_poll_stats(&sync_state)?;
        let mut census_changed_index = false;
        let mut census_left_work = false;
        // The census reconciles what the delta structurally cannot see: a
        // deletion never appears in a changed-list, and a row missed once sits
        // below the watermark forever. It is server-wide by construction —
        // `getAlbumList2` covers every library — so a scoped scheduler must not
        // run it, or it would read the other libraries' albums as gaps.
        // The readiness gate has to be *here*, not only inside the run: the slot
        // below is reserved before the run starts, so a tick during the initial
        // sync would burn the schedule on a pass that immediately bails, and the
        // first real census — the one meant to close whatever the ingest left —
        // would not happen until a full interval later.
        let index_is_ready = sync_state
            .get_sync_phase(&self.server_id, "")
            .map_err(SyncError::Storage)?
            .as_deref()
            == Some("ready");
        if self.library_scope.is_empty() && index_is_ready && census_is_due(&stats, now_ms) {
            // Persist the next slot *before* running. A process exit or the
            // scheduler's outer timeout must not leave every following tick
            // finding the same census immediately due.
            stats.next_census_at_ms = Some(now_ms.saturating_add(CENSUS_INTERVAL_MS));
            sync_state
                .set_poll_stats_json(
                    &self.server_id,
                    &self.library_scope,
                    &serde_json::to_value(stats).unwrap_or_default(),
                )
                .map_err(SyncError::Storage)?;

            let mut census = AlbumCensusRunner::new(self.store, self.subsonic, &self.server_id)
                .with_capability_flags(self.capability_flags)
                .with_budget(parallelism)
                .with_deadline(Instant::now() + CENSUS_RUN_BUDGET);
            if let Some(flag) = &self.cancel {
                census = census.with_cancellation(Arc::clone(flag));
            }
            if !self.sleep_enabled {
                census = census.with_sleep_disabled();
            }
            // The runner observes its own deadline and returns a partial report
            // before the scheduler's outer timeout. This preserves the exact
            // refresh signal for work already committed instead of guessing
            // that every timeout changed the index.
            match census.run().await {
                Ok(census_report) => {
                    if census_report.changed_index()
                        || census_report.removal_refused
                        || census_report.budget_exhausted
                    {
                        crate::app_eprintln!(
                            "[library-sync] census: server_albums={} local_albums={} \
                             removed={} filled={} stale={} deferred={} refused={} budget_exhausted={} \
                             enumeration_incomplete={}",
                            census_report.server_albums,
                            census_report.local_albums,
                            census_report.albums_removed,
                            census_report.gaps_filled,
                            census_report.stale_projections_dropped,
                            census_report.deferred,
                            census_report.removal_refused,
                            census_report.budget_exhausted,
                            census_report.enumeration_incomplete,
                        );
                    }
                    census_changed_index = census_report.changed_index();
                    // Work left over by the per-run cap comes back sooner than a
                    // full interval, but not immediately: a candidate that can
                    // never resolve would otherwise turn every tick into a full
                    // enumeration for as long as the app runs.
                    // Come back sooner only when the run both left work behind
                    // AND got something done. A backlog that cannot be resolved
                    // — albums the enumeration keeps listing but the server will
                    // not hand over — would otherwise re-walk the whole
                    // catalogue every minute for as long as the app is open.
                    if census_needs_early_retry(&census_report) {
                        census_left_work = true;
                        stats.next_census_at_ms =
                            Some(now_ms.saturating_add(CENSUS_DEFERRED_RETRY_MS));
                    }
                }
                // Cancellation means the session is going away — every other
                // cancellable step in this tick propagates it, and writing
                // sync_state for a torn-down session is exactly what that
                // convention prevents.
                Err(SyncError::Cancelled) => return Err(SyncError::Cancelled),
                Err(error) => {
                    // Any other failure is simply no answer this round; the
                    // delta pass it rode along with has already done its work,
                    // and the slot was reserved before the run started.
                    crate::app_eprintln!("[library-sync] census failed: {error}");
                }
            }
        }

        // After the census, not before it. Retiring an album changes the live
        // count more than any delta does, and `local_track_count` is one of the
        // two inputs to the auto-tombstone threshold — stamping it ahead of the
        // census leaves that threshold reading a number the same tick already
        // invalidated.
        // Delta already re-stamps after a tombstone pass. Avoid issuing the
        // same count query again when a tick both ingested and retired rows.
        if (delta_report.changed_count > 0 && delta_report.tombstones_deleted == 0)
            || census_changed_index
        {
            if let Ok(local) = self.count_local_tracks() {
                sync_state
                    .set_local_track_count(&self.server_id, &self.library_scope, local)
                    .map_err(SyncError::Storage)?;
            }
        }

        stats.reclassify();
        sync_state
            .set_library_tier(
                &self.server_id,
                &self.library_scope,
                stats.library_tier.as_tag(),
            )
            .map_err(SyncError::Storage)?;
        sync_state
            .set_poll_stats_json(
                &self.server_id,
                &self.library_scope,
                &serde_json::to_value(stats).unwrap_or_default(),
            )
            .map_err(SyncError::Storage)?;

        report.next_poll_at_ms = now_ms + next_interval_ms(&stats) as i64;
        // The census only runs inside a tick, so its own schedule can never be
        // finer than the poll interval — on a large library that is tens of
        // minutes, which would leave the deferred-work retry with no effect at
        // all. When the census left work behind, pull the next tick forward to
        // meet it.
        if census_left_work {
            if let Some(due) = stats.next_census_at_ms {
                report.next_poll_at_ms = report.next_poll_at_ms.min(due);
            }
        }
        sync_state
            .set_next_poll_at(&self.server_id, &self.library_scope, report.next_poll_at_ms)
            .map_err(SyncError::Storage)?;

        report.census_changed_index = census_changed_index;
        report.delta = Some(delta_report);
        Ok(report)
    }
}

#[cfg(test)]
mod tests;

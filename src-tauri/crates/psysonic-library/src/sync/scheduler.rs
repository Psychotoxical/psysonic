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

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_integration::subsonic::SubsonicClient;

use super::bandwidth::{ParallelismBudget, PlaybackHint};
use super::budget::{PassKind, RequestBudget};
use super::capability::{CapabilityFlags, NavidromeProbeCredentials};
use super::delta::{DeltaSyncReport, DeltaSyncRunner};
use super::error::SyncError;
use super::poll_stats::{next_interval_ms, PollStats};
use super::progress::{NoopProgress, Progress};
use super::tombstone::should_auto_reconcile;
use crate::repos::SyncStateRepository;
use crate::store::LibraryStore;

/// Default Mode B threshold per §6.7 (5 % gap before auto reconcile).
pub const DEFAULT_TOMBSTONE_THRESHOLD_PCT: u32 = 5;

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
    pub next_poll_at_ms: i64,
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
        let sync_state = SyncStateRepository::new(self.store);
        sync_state
            .ensure(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;

        let mut report = SchedulerTickReport {
            skipped_not_due: false,
            skipped_bulk_paused: false,
            skipped_sync_pass_active: false,
            delta: None,
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
            if should_auto_reconcile(local_u, server_u, self.tombstone_threshold_pct) {
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
        if delta_report.changed_count > 0 {
            // Re-stamp the local count snapshot so the next tick's
            // threshold check has fresh data.
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
        sync_state
            .set_next_poll_at(&self.server_id, &self.library_scope, report.next_poll_at_ms)
            .map_err(SyncError::Storage)?;

        report.delta = Some(delta_report);
        Ok(report)
    }

    fn load_poll_stats(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<PollStats, SyncError> {
        let raw = sync_state
            .get_poll_stats_json(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        match raw {
            None => Ok(PollStats::default()),
            Some(v) => serde_json::from_value(v).map_err(|e| SyncError::Storage(e.to_string())),
        }
    }

    /// True while initial sync, capability probe, IS-3 bulk ingest, or a
    /// foreground sync job for this server is in flight — background delta
    /// must not compete for HTTP budget or tombstone probes.
    fn sync_pass_active(&self, sync_state: &SyncStateRepository<'_>) -> Result<bool, SyncError> {
        if self.foreground_sync_job_active {
            return Ok(true);
        }
        if self.store.bulk_ingest_active() {
            return Ok(true);
        }
        let phase = sync_state
            .get_sync_phase(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        Ok(matches!(
            phase.as_deref(),
            Some("initial_sync") | Some("probing")
        ))
    }

    fn count_local_tracks(&self) -> Result<i64, SyncError> {
        self.store
            .with_conn("scheduler.count_local_tracks", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                    rusqlite::params![self.server_id],
                    |row| row.get(0),
                )
            })
            .map_err(SyncError::Storage)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use wiremock::matchers::{method as wm_method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_subsonic(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    fn flags(bits: u32) -> CapabilityFlags {
        CapabilityFlags::new(bits)
    }

    async fn empty_probe_and_albumlist(server: &MockServer, last_modified: i64) {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": {
                        "lastModified": last_modified,
                        "ignoredArticles": "",
                        "index": []
                    }
                }
            })))
            .mount(server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [] }
                }
            })))
            .mount(server)
            .await;
    }

    // ── is_due ────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn is_due_returns_true_when_no_schedule_yet() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let sched = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        );
        assert!(sched.is_due(0).unwrap());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn is_due_false_when_next_poll_in_future() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_next_poll_at("s1", "", 5_000_000).unwrap();

        let subsonic = test_subsonic(&server.uri());
        let sched = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        );
        assert!(!sched.is_due(1_000_000).unwrap());
        assert!(sched.is_due(5_000_001).unwrap());
    }

    // ── tick skips when not due ──────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_skips_while_initial_sync_phase_active() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_sync_phase("s1", "", "initial_sync")
            .unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(0)
        .await
        .unwrap();

        assert!(report.skipped_sync_pass_active);
        assert!(report.delta.is_none());
        assert_eq!(report.next_poll_at_ms, 30_000);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_skips_when_foreground_sync_job_active() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .with_foreground_sync_job_active(true)
        .tick(0)
        .await
        .unwrap();

        assert!(report.skipped_sync_pass_active);
        assert!(report.delta.is_none());
        assert_eq!(report.next_poll_at_ms, 30_000);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_skips_when_not_due_and_reports_next_poll() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_next_poll_at("s1", "", 1_000_000_000).unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(500)
        .await
        .unwrap();

        assert!(report.skipped_not_due);
        assert!(report.delta.is_none());
        assert!(report.next_poll_at_ms > 500);
    }

    // ── tick pauses when PrefetchActive ──────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_pauses_when_playback_hint_is_prefetch_active() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();

        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_playback_hint(PlaybackHint::PrefetchActive)
        .with_sleep_disabled()
        .tick(0)
        .await
        .unwrap();

        assert!(report.skipped_bulk_paused);
        assert!(report.delta.is_none());
        // Re-scheduled soon (≤ 60s after now) so we catch the
        // prefetch finishing.
        assert!(report.next_poll_at_ms > 0);
        assert!(report.next_poll_at_ms <= 60_000);
    }

    // ── tick runs delta and stamps next_poll_at ──────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_runs_delta_and_persists_next_poll_at() {
        let server = MockServer::start().await;
        empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(1_000)
        .await
        .unwrap();

        assert!(!report.skipped_not_due);
        assert!(!report.skipped_bulk_paused);
        assert!(report.delta.is_some());
        let next = SyncStateRepository::new(&store)
            .get_next_poll_at("s1", "")
            .unwrap()
            .unwrap();
        assert_eq!(next, report.next_poll_at_ms);
        assert!(next > 1_000);
    }

    // ── auto-tombstone trigger ──────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_auto_tombstones_when_count_gap_exceeds_threshold() {
        let server = MockServer::start().await;
        empty_probe_and_albumlist(&server, 1_716_840_000_000).await;
        // Tombstone probe — empty store has nothing to probe, so we
        // only need to know the runner *would* have called getSong if
        // there were rows. For this test it's enough that no panic
        // occurs and the delta report's tombstone counters are zero.

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        // 110 local vs 100 server → 10 % gap, threshold 5 % default.
        sync_state.set_local_track_count("s1", "", 110).unwrap();
        sync_state.set_server_track_count("s1", "", 100).unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(0)
        .await
        .unwrap();

        let delta = report.delta.expect("delta ran");
        // Tombstone budget was set (200), but no local tracks exist →
        // nothing to probe, both counters stay at 0. The important
        // signal is that the runner accepted the trigger.
        assert_eq!(delta.tombstones_checked, 0);
        assert_eq!(delta.tombstones_deleted, 0);
    }

    // ── PollStats persistence round trip ────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn poll_stats_persist_round_trip_through_tick() {
        let server = MockServer::start().await;
        empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(0)
        .await
        .unwrap();

        let stored = SyncStateRepository::new(&store)
            .get_poll_stats_json("s1", "")
            .unwrap()
            .unwrap();
        // tier is recorded — runner reclassifies even with no
        // observations yet, so this is "unknown" on a fresh store.
        let stats: PollStats = serde_json::from_value(stored).unwrap();
        assert_eq!(stats.library_tier.as_tag(), "unknown");
    }
}

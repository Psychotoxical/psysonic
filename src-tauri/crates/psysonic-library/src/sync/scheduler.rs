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
use super::delta::{DeltaSyncReport, DeltaSyncRunner};
use super::error::SyncError;
use super::poll_stats::{next_interval_ms, PollStats};
use super::progress::{NoopProgress, Progress};
use super::census::{AlbumCensusRunner, CensusReport};
use super::poll_stats::{census_is_due, CENSUS_DEFERRED_RETRY_MS, CENSUS_INTERVAL_MS};
use super::tombstone::should_auto_reconcile_scope;
use crate::repos::SyncStateRepository;
use crate::store::LibraryStore;

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

    fn finish_tick(
        &self,
        now_ms: i64,
        result: Result<SchedulerTickReport, SyncError>,
    ) -> Result<SchedulerTickReport, SyncError> {
        match result {
            Ok(report) => {
                if report.completed_delta() {
                    if let Err(storage_err) = self.clear_tick_error() {
                        let err = SyncError::Storage(storage_err);
                        self.record_tick_error(now_ms, &err);
                        return Err(err);
                    }
                }
                Ok(report)
            }
            Err(err) => {
                self.record_tick_error(now_ms, &err);
                Err(err)
            }
        }
    }

    fn clear_tick_error(&self) -> Result<(), String> {
        self.store.with_conn("scheduler.clear_error", |conn| {
            conn.execute(
                "UPDATE sync_state SET last_error = NULL \
                 WHERE server_id = ?1 AND library_scope = ?2",
                rusqlite::params![self.server_id, self.library_scope],
            )?;
            Ok(())
        })
    }

    fn record_tick_error(&self, now_ms: i64, err: &SyncError) {
        let rendered = err.to_string();
        let persisted: String = rendered.chars().take(MAX_PERSISTED_ERROR_CHARS).collect();
        crate::app_eprintln!(
            "[library-sync] scheduler tick failed server_id={} scope={}: {}",
            self.server_id,
            self.library_scope,
            rendered
        );
        let next_poll_at = now_ms.saturating_add(ERROR_RETRY_INTERVAL_MS);
        if let Err(storage_err) = self.store.with_conn("scheduler.record_error", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, last_error, next_poll_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   last_error = excluded.last_error, \
                   next_poll_at = excluded.next_poll_at",
                rusqlite::params![self.server_id, self.library_scope, persisted, next_poll_at],
            )?;
            Ok(())
        }) {
            crate::app_eprintln!(
                "[library-sync] scheduler error persistence failed server_id={} scope={}: {}",
                self.server_id,
                self.library_scope,
                storage_err
            );
        }
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
        crate::repos::TrackRepository::new(self.store)
            .count_live_tracks_in_scope(&self.server_id, &self.library_scope)
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

    // ── census ────────────────────────────────────────────────────────

    /// One album in the index, with the projection row the census reads.
    fn seed_album(store: &LibraryStore, server_id: &str, album_id: &str, track_id: &str) {
        store
            .with_conn_mut("test.seed_album", |conn| {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, album_id, duration_sec, \
                     deleted, synced_at, raw_json) \
                     VALUES (?1, ?2, 'Title', 'Album', ?3, 100, 0, 1, '{}')",
                    rusqlite::params![server_id, track_id, album_id],
                )?;
                conn.execute(
                    "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES (?1, '', ?2, 'Album', 1, 100, 1, ?3)",
                    rusqlite::params![server_id, album_id, track_id],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn live_rows(store: &LibraryStore, album_id: &str) -> i64 {
        store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE album_id = ?1 AND deleted = 0",
                    rusqlite::params![album_id],
                    |r| r.get(0),
                )
            })
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_tick_censuses_and_schedules_the_next_one() {
        let server = MockServer::start().await;
        // Only the artists probe from the shared helper — its album-list mock
        // answers every `getAlbumList2` with an empty page and would shadow the
        // enumeration this test is about.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": { "lastModified": 1_716_840_000_000_i64, "ignoredArticles": "", "index": [] }
                }
            })))
            .mount(&server)
            .await;
        // The enumeration lists ten of the eleven albums the index holds, and
        // the missing one answers "gone" when asked directly.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(wiremock::matchers::query_param("id", "al-gone"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Album not found" }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        for index in 0..10 {
            seed_album(&store, "s1", &format!("al-{index}"), &format!("t-{index}"));
        }
        seed_album(&store, "s1", "al-gone", "t-gone");
        let listed: Vec<_> = (0..10)
            .map(|i| json!({ "id": format!("al-{i}"), "name": "Album", "songCount": 1, "duration": 100 }))
            .collect();
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(wiremock::matchers::query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": listed } }
            })))
            .mount(&server)
            .await;
        // The delta crawls the same list, so every other album id needs a valid
        // answer. Mounted after the `al-gone` mock, which therefore keeps
        // winning for that one id.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": { "id": "al-other", "name": "Album", "songCount": 0, "song": [] }
                }
            })))
            .mount(&server)
            .await;
        // Everything after the first page — and whatever else asks for an album
        // list this tick — gets an empty one. Mounted second on purpose: the
        // first matching mock answers.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
            })))
            .mount(&server)
            .await;

        let subsonic = test_subsonic(&server.uri());
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        // The census only runs for a server whose catalogue is in.
        sync_state.set_sync_phase("s1", "", "ready").unwrap();

        BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(1_000_000)
        .await
        .unwrap();

        assert_eq!(live_rows(&store, "al-gone"), 0, "the census removed it");
        assert_eq!(live_rows(&store, "al-0"), 1, "the rest is untouched");
        // Retiring an album moves the live count more than any delta does, and
        // that count is one of the two inputs to the auto-tombstone threshold.
        // Left unstamped, the next tick reads a surplus that no longer exists
        // and burns a full mismatch pass chasing it.
        assert_eq!(
            sync_state.get_local_track_count("s1", "").unwrap(),
            Some(10),
            "the census must leave the live count matching what it retired"
        );

        let stats = sync_state
            .get_poll_stats_json("s1", "")
            .unwrap()
            .map(|value| serde_json::from_value::<PollStats>(value).unwrap_or_default())
            .unwrap_or_default();
        assert_eq!(
            stats.next_census_at_ms,
            Some(1_000_000 + CENSUS_INTERVAL_MS),
            "a clean run waits a full interval"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_active_server_scan_skips_tagging_and_census() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "scanStatus": { "scanning": true, "count": 10 }
                }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
            })))
            .expect(0)
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        seed_album(&store, "s1", "al-local", "t-local");
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_sync_phase("s1", "", "ready").unwrap();
        sync_state.set_library_tier("s1", "", "huge").unwrap();

        let subsonic = test_subsonic(&server.uri());
        let report = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_sleep_disabled()
        .tick(1_000_000)
        .await
        .unwrap();

        assert!(report.delta.as_ref().is_some_and(|delta| delta.deferred_scanning));
        assert!(!report.census_changed_index);
        assert_eq!(live_rows(&store, "al-local"), 1);
        assert_eq!(report.next_poll_at_ms, 1_030_000);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_scoped_scheduler_never_censuses() {
        // Deliberately the same fixture as the test above, minus the scope: the
        // enumeration answers, the server-wide row is `ready`, `al-gone` reports
        // itself gone. Everything the census needs is in place, so the *only*
        // thing that can hold it back is the scope guard — remove that guard and
        // this test fails. An earlier version seeded neither the ready phase nor
        // a non-empty album list, which meant it passed for two unrelated
        // reasons and could not have caught the guard's removal.
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": { "lastModified": 1_716_840_000_000_i64, "ignoredArticles": "", "index": [] }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(wiremock::matchers::query_param("id", "al-gone"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Album not found" }
                }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        for index in 0..10 {
            seed_album(&store, "s1", &format!("al-{index}"), &format!("t-{index}"));
        }
        seed_album(&store, "s1", "al-gone", "t-gone");
        let listed: Vec<_> = (0..10)
            .map(|index| json!({ "id": format!("al-{index}"), "name": "Album", "songCount": 1 }))
            .collect();
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(wiremock::matchers::query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": listed } }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": { "id": "al-other", "name": "Album", "songCount": 0, "song": [] }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
            })))
            .mount(&server)
            .await;

        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "lib-a").unwrap();
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_sync_phase("s1", "", "ready").unwrap();

        let subsonic = test_subsonic(&server.uri());
        BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "lib-a",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(1_000_000)
        .await
        .unwrap();

        // `getAlbumList2` is server-wide, so a scoped run would read every
        // other library's albums as gaps and this library's as absent.
        assert_eq!(live_rows(&store, "al-gone"), 1);
    }

    /// The schedule is reserved before the run starts, so the readiness gate has
    /// to sit next to the reservation and not only inside the run. Otherwise a
    /// tick taken while the catalogue is still coming in books the next slot for
    /// a pass that immediately bails, and the first census that could actually
    /// close the ingest's gaps is a whole interval late.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_tick_before_the_catalogue_is_in_does_not_burn_the_census_slot() {
        let server = MockServer::start().await;
        empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        // Not `initial_sync` — that would short-circuit the whole tick as a
        // sync pass in flight. `idle` is the phase a server sits in before its
        // first successful sync, and the census must not count it as ready.
        sync_state.set_sync_phase("s1", "", "idle").unwrap();

        let subsonic = test_subsonic(&server.uri());
        BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(1_000_000)
        .await
        .unwrap();

        let stats = sync_state
            .get_poll_stats_json("s1", "")
            .unwrap()
            .map(|value| serde_json::from_value::<PollStats>(value).unwrap_or_default())
            .unwrap_or_default();
        assert_eq!(
            stats.next_census_at_ms, None,
            "the slot stays unclaimed, so the first census runs as soon as the index is ready"
        );
    }

    #[test]
    fn only_a_census_that_made_progress_gets_the_early_retry() {
        let enumeration_timeout = CensusReport {
            budget_exhausted: true,
            enumeration_incomplete: true,
            ..CensusReport::default()
        };
        assert!(!census_needs_early_retry(&enumeration_timeout));

        let probe_timeout = CensusReport {
            budget_exhausted: true,
            deferred: 1,
            ..CensusReport::default()
        };
        assert!(!census_needs_early_retry(&probe_timeout));

        let partial_progress = CensusReport {
            gaps_filled: 1,
            budget_exhausted: true,
            deferred: 1,
            ..CensusReport::default()
        };
        assert!(census_needs_early_retry(&partial_progress));
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
        sync_state.set_sync_phase("s1", "", "initial_sync").unwrap();

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
    async fn tick_skips_while_global_bulk_ingest_is_active() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        store.set_bulk_ingest_active(true);

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
    async fn tick_skips_when_not_due_and_reports_next_poll() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_next_poll_at("s1", "", 1_000_000_000)
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
        .tick(500)
        .await
        .unwrap();

        assert!(report.skipped_not_due);
        assert!(report.delta.is_none());
        assert!(report.next_poll_at_ms > 500);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn skipped_tick_preserves_previous_scheduler_error() {
        let server = MockServer::start().await;
        let store = LibraryStore::open_in_memory();
        store
            .with_conn("test.seed_skipped_scheduler_error", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, last_error, next_poll_at) \
                     VALUES ('s1', '', 'old failure', 1000000)",
                    [],
                )?;
                Ok(())
            })
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
        .tick(500)
        .await
        .unwrap();
        assert!(report.skipped_not_due);

        let last_error: Option<String> = store
            .with_conn("test.skipped_scheduler_error", |conn| {
                conn.query_row(
                    "SELECT last_error FROM sync_state WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(last_error.as_deref(), Some("old failure"));
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

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_failure_is_persisted_and_retried_soon() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let err = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick(1_000)
        .await
        .unwrap_err();
        assert!(matches!(err, SyncError::Transport(_)));

        let (last_error, next_poll_at): (Option<String>, Option<i64>) = store
            .with_conn("test.scheduler_error", |conn| {
                conn.query_row(
                    "SELECT last_error, next_poll_at FROM sync_state \
                     WHERE server_id = 's1' AND library_scope = ''",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .unwrap();
        assert!(last_error.is_some_and(|message| message.contains("503")));
        assert_eq!(next_poll_at, Some(31_000));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tick_timeout_is_persisted_without_waiting_for_server() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(1)))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let err = BackgroundScheduler::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_sleep_disabled()
        .tick_with_timeout(2_000, Duration::from_millis(20))
        .await
        .unwrap_err();
        assert!(err.to_string().contains("timed out"));

        let last_error: Option<String> = store
            .with_conn("test.scheduler_timeout", |conn| {
                conn.query_row(
                    "SELECT last_error FROM sync_state WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert!(last_error.is_some_and(|message| message.contains("timed out")));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn successful_tick_clears_previous_scheduler_error() {
        let server = MockServer::start().await;
        empty_probe_and_albumlist(&server, 1_716_840_000_000).await;

        let store = LibraryStore::open_in_memory();
        store
            .with_conn("test.seed_scheduler_error", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, last_error) \
                     VALUES ('s1', '', 'old failure')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
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

        let last_error: Option<String> = store
            .with_conn("test.scheduler_error_cleared", |conn| {
                conn.query_row(
                    "SELECT last_error FROM sync_state WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(last_error, None);
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

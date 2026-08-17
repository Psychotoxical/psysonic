//! C3 — `DeltaSyncRunner` (spec §6.4 DS-0 … DS-9). Drives a targeted
//! re-fetch when the server reports new content since the last
//! successful sync. Compared to `InitialSyncRunner`:
//!
//! - Cheap probe first (DS-0 / DS-2) — short-circuits to zero further
//!   requests on the happy path.
//! - Strategy choice from `capability_flags`: N1-delta when Navidrome
//!   native bulk is available, otherwise S2-delta via
//!   `getAlbumList2 type=newest + recent`. S1 (`search3` empty query)
//!   doesn't carry a delta semantic so it's not used here.
//! - No artist/album index pass — DS-9 only re-stamps watermarks +
//!   `last_delta_sync_at`. Browse acceleration tables stay in sync
//!   incrementally via the initial pass and a future PR-3d hook.
//!
//! DS-5 canonical matcher and DS-7 starred delta are explicitly out
//! of scope for PR-3c (Phase H / follow-up).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_integration::subsonic::SubsonicClient;

use super::backoff::{jitter_salt, with_jitter, Backoff};
use super::capability::{CapabilityFlags, NavidromeProbeCredentials};
use super::error::SyncError;
use super::progress::{NoopProgress, Progress, ProgressEvent};
use super::strategy::IngestStrategy;
use super::tombstone::TombstoneReconciler;
use crate::repos::{SyncStateRepository, TrackRepository, TrackRow};
use crate::store::LibraryStore;

mod ingest;

/// Default batch size for delta pages — same as initial sync; servers
/// already tolerate 500-row pages at scale.
const DEFAULT_BATCH_SIZE: u32 = 500;

/// Maximum attempts per page before propagating. Same as initial sync.
const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

/// How many `getAlbumList2 type=newest + recent` pages the S2-delta
/// loop walks before stopping. 2× DEFAULT_BATCH_SIZE = 1000 most-recent
/// albums per type per pass — enough overlap on small/medium libs to
/// catch every change between polls.
const S2_DELTA_MAX_PAGES_PER_TYPE: u32 = 4;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeltaSyncReport {
    pub strategy: Option<String>,
    /// `true` when DS-2 short-circuited — server watermark matched
    /// local; no tracks were touched.
    pub up_to_date: bool,
    /// `true` when DS-3 saw an active scan and deferred. Caller
    /// re-runs the delta on the next tick.
    pub deferred_scanning: bool,
    /// Track upserts performed during DS-4.
    pub changed_count: u32,
    pub remapped_count: u32,
    /// Tombstone chunk stats from DS-8 — `0` when the runner wasn't
    /// configured with `with_tombstone_budget`.
    pub tombstones_checked: u32,
    pub tombstones_deleted: u32,
}

pub struct DeltaSyncRunner<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    navidrome: Option<NavidromeProbeCredentials>,
    http_registry: Option<Arc<ServerHttpRegistry>>,
    server_id: String,
    library_scope: String,
    capability_flags: CapabilityFlags,
    cancel: Option<Arc<std::sync::atomic::AtomicBool>>,
    batch_size: u32,
    sleep_enabled: bool,
    /// DS-8 budget. `None` skips the tombstone chunk entirely; `Some(n)`
    /// drives `TombstoneReconciler::reconcile_chunk(n)` after DS-4.
    tombstone_budget: Option<u32>,
    full_tombstone_pass: bool,
    progress: Arc<dyn Progress + Send + Sync>,
}

impl<'a> DeltaSyncRunner<'a> {
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
            cancel: None,
            batch_size: DEFAULT_BATCH_SIZE,
            sleep_enabled: true,
            tombstone_budget: None,
            full_tombstone_pass: false,
            progress: Arc::new(NoopProgress),
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

    pub fn with_cancellation(mut self, flag: Arc<std::sync::atomic::AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_batch_size(mut self, n: u32) -> Self {
        if n > 0 {
            self.batch_size = n;
        }
        self
    }

    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    /// DS-8 — run a `TombstoneReconciler::reconcile_chunk(budget)`
    /// pass after DS-4 ingest. Caller (PR-3d scheduler) decides
    /// budget based on §6.7 threshold detection and per-tick limits.
    pub fn with_tombstone_budget(mut self, budget: u32) -> Self {
        self.tombstone_budget = Some(budget);
        self
    }

    /// Manual Verify mode: bypass watermark/delta short-circuits and inspect
    /// every live row in one stable, internally chunked pass.
    pub fn with_full_tombstone_pass(mut self) -> Self {
        self.full_tombstone_pass = true;
        self
    }

    pub fn with_progress(mut self, progress: Arc<dyn Progress + Send + Sync>) -> Self {
        self.progress = progress;
        self
    }

    /// DS-0 … DS-9. Returns a report describing what happened — caller
    /// (PR-3d background scheduler) decides whether to re-tick on
    /// `deferred_scanning`.
    pub async fn run(&self) -> Result<DeltaSyncReport, SyncError> {
        let sync_state = SyncStateRepository::new(self.store);
        sync_state
            .ensure(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;

        let mut report = DeltaSyncReport::default();

        if self.full_tombstone_pass {
            let mut reconciler =
                TombstoneReconciler::new(self.store, self.subsonic, &self.server_id)
                    .with_library_scope(&self.library_scope);
            if !self.sleep_enabled {
                reconciler = reconciler.with_sleep_disabled();
            }
            if let Some(flag) = &self.cancel {
                reconciler = reconciler.with_cancellation(Arc::clone(flag));
            }
            let stats = reconciler
                .reconcile_full_pass(super::budget::RequestBudget::VERIFY_CHUNK_SIZE)
                .await?;
            report.tombstones_checked = stats.checked;
            report.tombstones_deleted = stats.deleted;
            self.restamp_local_track_count(&sync_state, stats.deleted)?;
            self.progress.emit(ProgressEvent::Tombstoned {
                deleted_count: stats.deleted,
                checked_count: stats.checked,
            });
            self.progress.emit(ProgressEvent::Completed {
                kind: "verify_integrity".into(),
            });
            return Ok(report);
        }

        // DS-0 / DS-1 / DS-2 / DS-3 — poll + watermark compare.
        let probe = self.poll_for_change(&sync_state).await?;
        report.deferred_scanning = probe.deferred_scanning;
        if probe.deferred_scanning {
            return Ok(report);
        }
        if probe.up_to_date {
            report.up_to_date = true;
            self.stamp_last_delta(&sync_state)?;
            return Ok(report);
        }

        // DS-4 — targeted ingest. Strategy choice matches initial sync
        // but S1 is skipped: `search3` doesn't carry a delta semantic.
        let strategy = self.delta_strategy();
        report.strategy = Some(strategy.as_tag().to_string());
        self.progress.emit(ProgressEvent::PhaseChanged {
            phase: format!("delta:{}", strategy.as_tag()),
        });
        match strategy {
            IngestStrategy::N1 => self.run_n1_delta(&mut report).await?,
            IngestStrategy::S2 => self.run_s2_delta(&mut report).await?,
            IngestStrategy::S1 | IngestStrategy::S3 => {
                return Err(SyncError::StrategyUnsupported {
                    strategy: strategy.as_tag(),
                })
            }
        }

        // DS-8 — optional tombstone chunk (PR-3d wiring). Runs after
        // ingest so newly-arrived rows are already in `track` before
        // we probe `getSong` for stale ids.
        if let Some(budget) = self.tombstone_budget {
            if budget > 0 {
                let mut reconciler =
                    TombstoneReconciler::new(self.store, self.subsonic, &self.server_id)
                        .with_library_scope(&self.library_scope);
                if !self.sleep_enabled {
                    reconciler = reconciler.with_sleep_disabled();
                }
                if let Some(flag) = &self.cancel {
                    reconciler = reconciler.with_cancellation(Arc::clone(flag));
                }
                let stats = reconciler.reconcile_chunk(budget).await?;
                report.tombstones_checked = stats.checked;
                report.tombstones_deleted = stats.deleted;
                self.restamp_local_track_count(&sync_state, stats.deleted)?;
                self.progress.emit(ProgressEvent::Tombstoned {
                    deleted_count: stats.deleted,
                    checked_count: stats.checked,
                });
            }
        }

        // DS-9 — stamp watermarks + refresh artist browse index when applicable.
        if let Some(ms) = probe.next_artists_watermark {
            let scope = self.library_scope_opt();
            if let Ok(index) = self.subsonic.get_artists(scope).await {
                let confirmed = super::artist_index::apply_artist_index(
                    self.store,
                    &self.server_id,
                    &self.library_scope,
                    &index,
                )?;
                // Only prune after a real `getArtists` confirmation. The DS-8
                // tombstone pass above has already soft-deleted server-removed
                // tracks, so a renamed-away artist now has no live track.
                if confirmed > 0 {
                    super::artist_index::prune_orphan_artists_after_confirmed_pass(
                        self.store,
                        &self.server_id,
                    );
                }
            }
            // Advance the watermark to the probed value regardless of the index
            // refresh result — a failed/empty `getArtists` must not force a full
            // refetch on every delta. Wins over the index's own last-modified.
            sync_state
                .set_artists_last_modified_ms(&self.server_id, &self.library_scope, ms)
                .map_err(SyncError::Storage)?;
        }
        if let Some(iso) = probe.next_last_scan_iso.as_deref() {
            sync_state
                .set_server_last_scan_iso(&self.server_id, &self.library_scope, Some(iso))
                .map_err(SyncError::Storage)?;
        }
        self.stamp_last_delta(&sync_state)?;

        self.progress.emit(ProgressEvent::Completed {
            kind: "delta_sync".into(),
        });
        Ok(report)
    }

    // ── helpers ────────────────────────────────────────────────────────

    fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
    }

    fn unstable_track_ids(&self) -> bool {
        self.capability_flags
            .contains(CapabilityFlags::UNSTABLE_TRACK_IDS)
    }

    fn library_scope_opt(&self) -> Option<&str> {
        if self.library_scope.is_empty() {
            None
        } else {
            Some(self.library_scope.as_str())
        }
    }

    async fn sleep(&self, d: Duration) {
        if self.sleep_enabled && !d.is_zero() {
            tokio::time::sleep(d).await;
        }
    }

    fn write_batch(&self, rows: &[TrackRow]) -> Result<(u32, u32), SyncError> {
        let stats = TrackRepository::new(self.store)
            .upsert_batch_with_remap(rows, self.unstable_track_ids())
            .map_err(SyncError::Storage)?;
        Ok((rows.len() as u32, stats.remapped.len() as u32))
    }

    fn delta_strategy(&self) -> IngestStrategy {
        if self.library_scope.is_empty()
            && self
                .capability_flags
                .contains(CapabilityFlags::NAVIDROME_NATIVE_BULK)
        {
            IngestStrategy::N1
        } else {
            // S1 has no delta semantic — fall through to album-crawl.
            IngestStrategy::S2
        }
    }

    fn stamp_last_delta(&self, sync_state: &SyncStateRepository<'_>) -> Result<(), SyncError> {
        sync_state
            .set_last_delta_sync_at(&self.server_id, &self.library_scope, now_unix_ms())
            .map_err(SyncError::Storage)
    }

    /// Refresh the stored live-row count after a pass retired rows.
    ///
    /// `local_track_count` is one of the two inputs to the auto-tombstone
    /// threshold, and nothing on the tombstone path used to write it: the
    /// scheduler only re-stamps when a delta reported *changes*, and retiring
    /// rows is not a change in that sense. So the one operation that alters the
    /// live count the most left the threshold reading a number from before it
    /// ran — too high by exactly the number of rows removed.
    fn restamp_local_track_count(
        &self,
        sync_state: &SyncStateRepository<'_>,
        deleted: u32,
    ) -> Result<(), SyncError> {
        if deleted == 0 {
            return Ok(());
        }
        // The repository's own counter, not a second copy of the same query: it
        // reads on a read connection, so counting does not queue behind the
        // ingest that is very likely still writing when a pass ends.
        let live = crate::repos::TrackRepository::new(self.store)
            .count_live_tracks_in_scope(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        sync_state
            .set_local_track_count(&self.server_id, &self.library_scope, live)
            .map_err(SyncError::Storage)
    }

    fn local_track_updated_watermark(&self) -> Result<Option<i64>, SyncError> {
        self.store
            .with_conn("delta.local_track_watermark", |c| {
                if self.library_scope.is_empty() {
                    c.query_row(
                        "SELECT MAX(server_updated_at) FROM track \
                         WHERE server_id = ?1 AND deleted = 0",
                        rusqlite::params![self.server_id],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                } else {
                    c.query_row(
                        "SELECT MAX(server_updated_at) FROM track \
                         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0",
                        rusqlite::params![self.server_id, self.library_scope],
                        |row| row.get::<_, Option<i64>>(0),
                    )
                }
            })
            .map_err(SyncError::Storage)
    }

    // ── DS-0 / DS-1 / DS-2 / DS-3 — poll + watermark compare ───────────

    async fn poll_for_change(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<DeltaPollOutcome, SyncError> {
        let tier = sync_state
            .get_library_tier(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?
            .unwrap_or_else(|| "unknown".to_string());

        let mut outcome = DeltaPollOutcome::default();

        let use_scan_status = tier == "huge"
            && self
                .capability_flags
                .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE);

        if use_scan_status {
            let scan = self.subsonic.get_scan_status().await?;
            // DS-3 — defer when a scan is in flight on the server.
            if scan.scanning {
                outcome.deferred_scanning = true;
                return Ok(outcome);
            }
            // DS-2 — watermark match → short-circuit.
            let stored = sync_state
                .get_server_last_scan_iso(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?;
            if let (Some(stored), Some(live)) = (stored.as_deref(), scan.last_scan.as_deref()) {
                if stored == live {
                    outcome.up_to_date = true;
                    return Ok(outcome);
                }
            }
            outcome.next_last_scan_iso = scan.last_scan;
        } else {
            // Small/medium tier (or unknown): `getArtists` carries
            // `lastModified` which is the watermark.
            let scope = self.library_scope_opt();
            let artists = self.subsonic.get_artists(scope).await?;
            let stored = sync_state
                .get_artists_last_modified_ms(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?;
            if let (Some(stored), Some(live)) = (stored, artists.last_modified_ms) {
                if stored == live {
                    outcome.up_to_date = true;
                    return Ok(outcome);
                }
            }
            outcome.next_artists_watermark = artists.last_modified_ms;
        }

        Ok(outcome)
    }
}

#[derive(Debug, Default)]
struct DeltaPollOutcome {
    deferred_scanning: bool,
    up_to_date: bool,
    next_last_scan_iso: Option<String>,
    next_artists_watermark: Option<i64>,
}

use super::now_unix_ms;

async fn retry_with_backoff<'a, F, FFut, T, E>(
    runner: &DeltaSyncRunner<'a>,
    mut build: F,
    map_err: impl Fn(E) -> SyncError,
) -> Result<T, SyncError>
where
    F: FnMut() -> FFut,
    FFut: std::future::Future<Output = Result<T, E>>,
{
    let mut backoff = Backoff::default();
    let mut attempt = 0u32;
    loop {
        runner.check_cancellation()?;
        attempt += 1;
        match build().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let mapped = map_err(e);
                if !is_retryable(&mapped) || attempt >= MAX_ATTEMPTS_PER_BATCH {
                    return Err(mapped);
                }
                let delay = backoff.next_delay();
                let jittered = with_jitter(delay, jitter_salt(attempt));
                runner.sleep(jittered).await;
            }
        }
    }
}

fn is_retryable(e: &SyncError) -> bool {
    matches!(e, SyncError::Transport(_) | SyncError::Navidrome(_))
}

#[cfg(test)]
mod tests;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_integration::subsonic::SubsonicClient;

use super::bulk_ingest::BulkIngestGuard;
use super::common::{DEFAULT_BATCH_SIZE, N1_DEEP_OFFSET_SAFE};
use super::final_passes::resync_sweep_is_safe;
use crate::repos::{SyncStateRepository, TrackRepository};
use crate::store::LibraryStore;
use crate::sync::artist_index;
use crate::sync::bandwidth::{ParallelismBudget, PlaybackHint};
use crate::sync::capability::{CapabilityFlags, NavidromeProbeCredentials};
use crate::sync::cursor::{CursorPhase, InitialSyncCursor};
use crate::sync::error::SyncError;
use crate::sync::now_unix_ms;
use crate::sync::poll_stats::{ResyncSweepSkip, ResyncSweepSkipReason};
use crate::sync::progress::{NoopProgress, Progress, ProgressEvent};
use crate::sync::strategy::IngestStrategy;

/// Summary returned from `InitialSyncRunner::run`. Caller emits a
/// completion event with these numbers (PR-3d).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitialSyncReport {
    pub strategy: Option<String>,
    pub ingested_count: u32,
    pub remapped_count: u32,
}

pub(super) struct IngestPageCtx<'a> {
    pub(super) cursor: &'a mut InitialSyncCursor,
    pub(super) report: &'a mut InitialSyncReport,
    pub(super) sync_state: &'a SyncStateRepository<'a>,
    pub(super) batch_count: &'a mut u32,
    pub(super) force_persist: bool,
}

pub struct InitialSyncRunner<'a> {
    pub(super) store: &'a LibraryStore,
    pub(super) subsonic: &'a SubsonicClient,
    pub(super) navidrome: Option<NavidromeProbeCredentials>,
    pub(super) http_registry: Option<Arc<ServerHttpRegistry>>,
    pub(super) server_id: String,
    pub(super) library_scope: String,
    pub(super) capability_flags: CapabilityFlags,
    pub(super) cancel: Option<Arc<AtomicBool>>,
    pub(super) batch_size: u32,
    pub(super) n1_deep_offset_safe: u32,
    pub(super) sleep_enabled: bool,
    pub(super) progress: Arc<dyn Progress + Send + Sync>,
    pub(super) parallelism: ParallelismBudget,
}

impl<'a> InitialSyncRunner<'a> {
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
            n1_deep_offset_safe: N1_DEEP_OFFSET_SAFE,
            sleep_enabled: true,
            progress: Arc::new(NoopProgress),
            parallelism: ParallelismBudget::resolve(PlaybackHint::Idle),
        }
    }

    pub fn with_progress(mut self, progress: Arc<dyn Progress + Send + Sync>) -> Self {
        self.progress = progress;
        self
    }

    pub fn with_navidrome_credentials(mut self, creds: NavidromeProbeCredentials) -> Self {
        self.navidrome = Some(creds);
        self
    }

    pub fn with_http_registry(mut self, registry: Option<Arc<ServerHttpRegistry>>) -> Self {
        self.http_registry = registry;
        self
    }

    pub fn with_cancellation(mut self, flag: Arc<AtomicBool>) -> Self {
        self.cancel = Some(flag);
        self
    }

    pub fn with_batch_size(mut self, n: u32) -> Self {
        if n > 0 {
            self.batch_size = n;
        }
        self
    }

    /// Override the N1 deep-offset wall line. Tests pin this low so the
    /// N1→S1 fallback can be exercised without 50k rows of fixture data;
    /// production uses the `N1_DEEP_OFFSET_SAFE` default.
    pub fn with_n1_deep_offset_safe(mut self, n: u32) -> Self {
        self.n1_deep_offset_safe = n;
        self
    }

    /// Disable real sleep between backoff attempts. Tests pin this so
    /// `503 → success on retry` exercises the retry loop in
    /// milliseconds instead of seconds. Production code leaves it on.
    pub fn with_sleep_disabled(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    /// C11 — bulk crawl parallelism from the runtime playback hint.
    pub fn with_parallelism_budget(mut self, budget: ParallelismBudget) -> Self {
        self.parallelism = budget;
        self
    }

    pub(super) fn parallelism_budget(&self) -> ParallelismBudget {
        self.parallelism
    }

    /// IS-1 → IS-6. Resumes from `sync_state.initial_sync_cursor_json`
    /// when a cursor is already persisted; otherwise picks a strategy
    /// from `capability_flags` and starts fresh.
    pub async fn run(&self) -> Result<InitialSyncReport, SyncError> {
        let sync_state = SyncStateRepository::new(self.store);
        sync_state
            .ensure(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;

        // IS-1 — phase=initial_sync.
        sync_state
            .set_sync_phase(&self.server_id, &self.library_scope, "initial_sync")
            .map_err(SyncError::Storage)?;
        self.progress.emit(ProgressEvent::PhaseChanged {
            phase: "initial_sync".into(),
        });

        let mut cursor = self.load_or_init_cursor(&sync_state)?;
        self.ensure_resync_generation(&mut cursor, &sync_state)?;
        let mut report = InitialSyncReport {
            strategy: Some(cursor.strategy.clone()),
            ingested_count: cursor.ingested_count,
            remapped_count: 0,
        };
        let strategy = IngestStrategy::from_tag(&cursor.strategy).ok_or_else(|| {
            SyncError::CursorIncompatible {
                expected: "n1|s1|s2|s3",
                actual: cursor.strategy.clone(),
            }
        })?;

        // IS-3 — bulk ingest per strategy.
        if cursor.phase == CursorPhase::Ingest {
            let bulk = BulkIngestGuard::begin(self.store)?;
            crate::app_eprintln!(
                "[library-sync] IS-3 bulk ingest: FTS/indexes suspended, sync=OFF"
            );

            let ingest_result = async {
                match strategy {
                    IngestStrategy::N1 => {
                        self.run_n1(&mut cursor, &mut report, &sync_state).await?
                    }
                    IngestStrategy::S1 => {
                        self.run_s1(&mut cursor, &mut report, &sync_state).await?
                    }
                    IngestStrategy::S2 => {
                        self.run_s2(&mut cursor, &mut report, &sync_state).await?
                    }
                    IngestStrategy::S3 => {
                        return Err(SyncError::StrategyUnsupported { strategy: "s3" });
                    }
                }
                self.link_canonical_after_bulk_ingest()
            }
            .await;
            let finish_result = bulk.finish();
            match (ingest_result, finish_result) {
                (Ok(()), Ok(())) => {}
                (Err(error), Ok(())) => return Err(error),
                (Ok(()), Err(cleanup)) => return Err(SyncError::Storage(cleanup)),
                (Err(error), Err(cleanup)) => {
                    return Err(SyncError::Storage(format!(
                        "{error}; bulk ingest finalization also failed: {cleanup}"
                    )));
                }
            }
            cursor.phase = CursorPhase::ArtistPass;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-4 — optional artist/album index pass via `getArtists`. Remember
        // whether it was a real, confirmed pass so IS-7 can prune orphans only
        // when authoritative (on a cursor-resume that skips this phase we stay
        // conservative and let the next sync clean up).
        let mut artists_confirmed = false;
        if cursor.phase == CursorPhase::ArtistPass {
            artists_confirmed = self.run_artist_pass(&sync_state).await?;
            cursor.phase = CursorPhase::Watermarks;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-5 — watermarks (server_last_scan_iso, server_track_count,
        // artists_last_modified_ms) so DS-0 polls can short-circuit.
        let mut fresh_server_track_count = None;
        if cursor.phase == CursorPhase::Watermarks {
            fresh_server_track_count = self.run_watermark_pass(&sync_state).await?;
            cursor.phase = CursorPhase::Done;
            self.persist_cursor(&sync_state, &cursor)?;
        }
        // A process may stop after persisting `Done` but before IS-7. Re-probe
        // instead of falling back to the older bind-time count: only a fresh,
        // non-scanning response may authorize the destructive sweep.
        if cursor.phase == CursorPhase::Done
            && cursor.resync_gen.is_some()
            && fresh_server_track_count.is_none()
        {
            fresh_server_track_count = self.run_watermark_pass(&sync_state).await?;
        }

        // IS-6 — phase=ready, optional IS-7 orphan sweep, clear cursor, stamp watermarks.
        let finished_at = now_unix_ms();
        if let Some(gen) = cursor.resync_gen {
            let tracks = TrackRepository::new(self.store);
            let stamped = tracks
                .count_resync_generation(&self.server_id, &self.library_scope, gen)
                .map_err(SyncError::Storage)?;
            // `getScanStatus.count` is server-wide, so it cannot authorise a
            // scoped sweep. Without a scope-visible count the safe result is to
            // keep unconfirmed rows and let direct verification retire them.
            let server_count = self
                .library_scope
                .is_empty()
                .then_some(fresh_server_track_count)
                .flatten();
            let swept = if resync_sweep_is_safe(stamped, server_count) {
                self.persist_resync_sweep_skip(&sync_state, None)?;
                tracks
                    .sweep_resync_orphans(&self.server_id, &self.library_scope, gen)
                    .map_err(SyncError::Storage)?
            } else {
                let reason = if server_count.is_some() {
                    ResyncSweepSkipReason::IncompleteIngest
                } else {
                    ResyncSweepSkipReason::MissingExpectedCount
                };
                self.persist_resync_sweep_skip(
                    &sync_state,
                    Some(ResyncSweepSkip {
                        at_ms: finished_at,
                        stamped_tracks: stamped,
                        expected_tracks: server_count,
                        reason,
                    }),
                )?;
                crate::app_eprintln!(
                    "[library-sync] IS-7 sweep skipped for `{}`: the ingest re-stamped {} rows \
                     against a server count of {:?}. Sweeping would soft-delete the shortfall, \
                     so the index keeps rows this run did not confirm.",
                    self.server_id,
                    stamped,
                    server_count
                );
                0
            };
            if swept > 0 {
                self.progress.emit(ProgressEvent::Tombstoned {
                    deleted_count: swept,
                    checked_count: swept,
                });
            }
            // Prune orphaned artist browse rows once, here — after the sweep has
            // soft-deleted the very tracks a renamed-away artist used to keep
            // alive (servers that mint fresh track ids on rename). Doing it only
            // post-sweep (instead of also in IS-4) avoids the double O(N) scan
            // per full sync; the delta path prunes in DS-9 where there is no
            // sweep. Gated on a confirmed `getArtists` pass so an empty/partial
            // body can't mass-prune album-artist-only rows (see B1).
            if artists_confirmed {
                artist_index::prune_orphan_artists_after_confirmed_pass(
                    self.store,
                    &self.server_id,
                );
            }
        }
        let local_count = TrackRepository::new(self.store)
            .count_live_tracks_in_scope(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        sync_state
            .complete_initial_sync(
                &self.server_id,
                &self.library_scope,
                local_count,
                finished_at,
            )
            .map_err(SyncError::Storage)?;
        self.progress.emit(ProgressEvent::Completed {
            kind: "initial_sync".into(),
        });

        Ok(report)
    }
}

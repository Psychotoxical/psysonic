//! `InitialSyncRunner` — spec §6.3 IS-1 … IS-7. PR-3b lands the runner,
//! cursor persistence, and the N1/S1/S2 ingest loops. S3 (file-tree)
//! is enumerated but returns `StrategyUnsupported`. IS-4 artist pass +
//! IS-5 watermarks run after the bulk loop completes.
//!
//! The runner is pure Rust — no Tauri events, no background task
//! lifecycle. PR-3d wires it into a `tokio::task::spawn` shell with
//! progress emit + the cancellation token; PR-3b only ships the
//! library-side function the shell will call.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use psysonic_integration::navidrome::queries::nd_list_songs_internal;
use psysonic_integration::subsonic::SubsonicClient;
use serde_json::Value;

use super::backoff::{jitter_salt, with_jitter, Backoff};
use super::bandwidth::ParallelismBudget;
use super::capability::{CapabilityFlags, NavidromeProbeCredentials};
use super::cursor::{CursorPhase, InitialSyncCursor, StrategyState};
use super::error::SyncError;
use super::ingest_parallel::{
    check_cancel_flag, fetch_albums_parallel, linear_prefetch_depth, retry_fetch,
    sleep_request_gap, wait_while_bulk_paused, LinearPrefetchQueue, ParallelAlbumFetchOpts,
};
use super::mapping::{
    merge_album_open_subsonic_track_raw, navidrome_song_to_track_row, subsonic_song_to_track_row,
};
use super::progress::{IngestBatchMetrics, NoopProgress, Progress, ProgressEvent};
use super::strategy::IngestStrategy;
use crate::bulk_ingest::{restore_track_secondary_indexes, suspend_track_secondary_indexes};
use crate::dto::track_index_nonempty;
use crate::repos::{RemapStats, SyncStateRepository, TrackRepository, TrackRow};
use crate::store::LibraryStore;
use crate::store::WriteOpTiming;
use crate::track_fts::{
    rebuild_track_fts_from_content, restore_track_fts_triggers, suspend_track_fts_triggers,
};

/// Bulk ingest batch size per spec §6.3 (`batch=500`).
const DEFAULT_BATCH_SIZE: u32 = 500;

/// Persist initial-sync cursor every N ingest batches (not every batch).
/// S2 already persists once per album-list page; N1/S1 match ~prefetch depth.
const CURSOR_PERSIST_EVERY_BATCHES: u32 = 4;

/// Maximum attempts per batch before `SyncError::Transport` propagates.
/// Caller (Settings „retry" / PR-3d scheduler) can wrap and retry the
/// whole run if needed.
const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

/// Suspends FTS + secondary indexes for IS-3; restores on drop.
struct BulkIngestGuard<'a> {
    store: &'a LibraryStore,
}

impl Drop for BulkIngestGuard<'_> {
    fn drop(&mut self) {
        self.store.set_bulk_ingest_active(false);
        let start = std::time::Instant::now();
        match self.store.with_conn_mut("bulk.finalize", |conn| {
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conn.pragma_update(None, "wal_autocheckpoint", 1000)?;
            restore_track_secondary_indexes(conn)?;
            let _: (i32, i32, i32) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            rebuild_track_fts_from_content(conn)?;
            restore_track_fts_triggers(conn)
        }) {
            Ok(()) => crate::app_eprintln!(
                "[library-sync] bulk ingest finalized in {}ms (indexes + WAL + FTS)",
                start.elapsed().as_millis()
            ),
            Err(e) => {
                crate::app_eprintln!("[library-sync] bulk ingest finalize failed: {e}")
            }
        }
    }
}

/// N1 deep-offset safety line (R7-15 Q1/Q5). A `GET /api/song` HTTP 500 at
/// or beyond this offset is treated as Navidrome's server-side deep-offset
/// wall (observed past ~50k), not a transient error: the run learns
/// `n1_bulk_unreliable` and falls back to S1 rather than retrying smaller
/// windows that cannot recover.
const N1_DEEP_OFFSET_SAFE: u32 = 50_000;

/// Summary returned from `InitialSyncRunner::run`. Caller emits a
/// completion event with these numbers (PR-3d).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitialSyncReport {
    pub strategy: Option<String>,
    pub ingested_count: u32,
    pub remapped_count: u32,
}

struct IngestPageCtx<'a> {
    cursor: &'a mut InitialSyncCursor,
    report: &'a mut InitialSyncReport,
    sync_state: &'a SyncStateRepository<'a>,
    batch_count: &'a mut u32,
    force_persist: bool,
}

pub struct InitialSyncRunner<'a> {
    store: &'a LibraryStore,
    subsonic: &'a SubsonicClient,
    navidrome: Option<NavidromeProbeCredentials>,
    server_id: String,
    library_scope: String,
    capability_flags: CapabilityFlags,
    cancel: Option<Arc<AtomicBool>>,
    batch_size: u32,
    n1_deep_offset_safe: u32,
    sleep_enabled: bool,
    progress: Arc<dyn Progress + Send + Sync>,
    parallelism: ParallelismBudget,
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
            server_id: server_id.into(),
            library_scope: library_scope.into(),
            capability_flags,
            cancel: None,
            batch_size: DEFAULT_BATCH_SIZE,
            n1_deep_offset_safe: N1_DEEP_OFFSET_SAFE,
            sleep_enabled: true,
            progress: Arc::new(NoopProgress),
            parallelism: ParallelismBudget::resolve(super::bandwidth::PlaybackHint::Idle),
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

    fn parallelism_budget(&self) -> ParallelismBudget {
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
            self.store.set_bulk_ingest_active(true);
            self.store
                .with_conn_mut("bulk.begin", |conn| {
                    suspend_track_fts_triggers(conn)?;
                    suspend_track_secondary_indexes(conn)?;
                    conn.pragma_update(None, "synchronous", "OFF")?;
                    conn.pragma_update(None, "wal_autocheckpoint", 0)?;
                    conn.pragma_update(None, "cache_size", -128_000)?;
                    Ok(())
                })
                .map_err(SyncError::Storage)?;
            crate::app_eprintln!(
                "[library-sync] IS-3 bulk ingest: FTS/indexes suspended, sync=OFF"
            );
            let _bulk = BulkIngestGuard { store: self.store };

            match strategy {
                IngestStrategy::N1 => self.run_n1(&mut cursor, &mut report, &sync_state).await?,
                IngestStrategy::S1 => self.run_s1(&mut cursor, &mut report, &sync_state).await?,
                IngestStrategy::S2 => self.run_s2(&mut cursor, &mut report, &sync_state).await?,
                IngestStrategy::S3 => {
                    return Err(SyncError::StrategyUnsupported { strategy: "s3" })
                }
            }
            self.link_canonical_after_bulk_ingest()?;
            cursor.phase = CursorPhase::ArtistPass;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-4 — optional artist/album index pass via `getArtists`.
        if cursor.phase == CursorPhase::ArtistPass {
            self.run_artist_pass(&sync_state).await?;
            cursor.phase = CursorPhase::Watermarks;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-5 — watermarks (server_last_scan_iso, server_track_count,
        // artists_last_modified_ms) so DS-0 polls can short-circuit.
        if cursor.phase == CursorPhase::Watermarks {
            self.run_watermark_pass(&sync_state).await?;
            cursor.phase = CursorPhase::Done;
            self.persist_cursor(&sync_state, &cursor)?;
        }

        // IS-6 — phase=ready, optional IS-7 orphan sweep, clear cursor, stamp watermarks.
        let finished_at = now_unix_ms();
        if let Some(gen) = cursor.resync_gen {
            let swept = TrackRepository::new(self.store)
                .sweep_resync_orphans(&self.server_id, gen)
                .map_err(SyncError::Storage)?;
            if swept > 0 {
                self.progress.emit(ProgressEvent::Tombstoned {
                    deleted_count: swept,
                    checked_count: swept,
                });
            }
        }
        let local_count = crate::dto::count_local_tracks(self.store, &self.server_id)
            .map_err(SyncError::Storage)?;
        sync_state
            .set_local_track_count(&self.server_id, &self.library_scope, local_count)
            .map_err(SyncError::Storage)?;
        sync_state
            .set_last_full_sync_at(&self.server_id, &self.library_scope, finished_at)
            .map_err(SyncError::Storage)?;
        sync_state
            .set_sync_phase(&self.server_id, &self.library_scope, "ready")
            .map_err(SyncError::Storage)?;
        sync_state
            .set_initial_sync_cursor(
                &self.server_id,
                &self.library_scope,
                &Value::Object(serde_json::Map::new()),
            )
            .map_err(SyncError::Storage)?;
        self.progress.emit(ProgressEvent::Completed {
            kind: "initial_sync".into(),
        });

        Ok(report)
    }

    // ── cursor / persistence ───────────────────────────────────────────

    fn load_or_init_cursor(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<InitialSyncCursor, SyncError> {
        let raw = sync_state
            .get_initial_sync_cursor(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        // R7-15 Q4: pick with the large-library policy, not just the cap
        // flags. `server_track_count` (probe `getScanStatus` count or a prior
        // watermark) and the learned `n1_bulk_unreliable` flag steer large
        // catalogs onto S1 instead of N1's deep-offset wall.
        let server_track_count = sync_state
            .get_server_track_count(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        let n1_bulk_unreliable = sync_state
            .get_n1_bulk_unreliable(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?
            .unwrap_or(false);
        let selected_strategy = IngestStrategy::select_initial_strategy(
            self.capability_flags,
            server_track_count,
            n1_bulk_unreliable,
        );
        if let Some(raw) = raw {
            if !is_empty_cursor(&raw) {
                match serde_json::from_value::<InitialSyncCursor>(raw) {
                    Ok(parsed) => {
                        let has_progress = parsed.ingested_count > 0
                            || parsed.phase != CursorPhase::Ingest;
                        // R7-15 Q3: freeze the in-flight strategy on resume.
                        // Once a run has made progress, a re-probe that now
                        // picks a different strategy (the Navidrome bearer
                        // flapped, or the large-library gate resolves
                        // differently) must NOT reset the cursor — that
                        // restarts ingest from offset 0 on every launch, which
                        // is exactly why large syncs never completed. Resume
                        // under the cursor's own strategy and ignore the
                        // probe's pick. Exception: a cursor still on N1 after
                        // the server was learned `n1_bulk_unreliable` is
                        // known-broken — fall through and re-select (the
                        // mid-run N1→S1 fallback normally rewrites such a
                        // cursor in place, preserving progress).
                        let frozen_strategy_known_broken = n1_bulk_unreliable
                            && parsed.strategy == IngestStrategy::N1.as_tag();
                        if has_progress && !frozen_strategy_known_broken {
                            return Ok(parsed);
                        }
                        // No resumable progress (offset 0) or a known-broken
                        // N1 cursor: adopting the freshly-selected strategy
                        // costs nothing, so take it. Re-ingest is idempotent
                        // (upsert) and the tombstone pass reconciles leftovers.
                        if parsed.strategy == selected_strategy.as_tag() {
                            return Ok(parsed);
                        }
                        crate::app_eprintln!(
                            "[library-sync] re-selecting initial-sync strategy for server \
                             `{}`: was `{}` (no resumable progress), now `{}`",
                            self.server_id,
                            parsed.strategy,
                            selected_strategy.as_tag()
                        );
                    }
                    Err(e) => {
                        // A corrupt/unreadable cursor can't drive resume; reset
                        // rather than hard-error (which would brick every future
                        // sync with no UI recovery path).
                        crate::app_eprintln!(
                            "[library-sync] resetting unreadable initial-sync cursor for \
                             server `{}` ({e}); starting fresh",
                            self.server_id
                        );
                    }
                }
            }
        }
        let scope = if self.library_scope.is_empty() {
            None
        } else {
            Some(self.library_scope.clone())
        };
        let fresh = InitialSyncCursor::fresh(selected_strategy, scope);
        self.persist_cursor(sync_state, &fresh)?;
        Ok(fresh)
    }

    fn persist_cursor(
        &self,
        sync_state: &SyncStateRepository<'_>,
        cursor: &InitialSyncCursor,
    ) -> Result<(), SyncError> {
        let value = serde_json::to_value(cursor)
            .map_err(|e| SyncError::Storage(format!("serialize cursor: {e}")))?;
        sync_state
            .set_initial_sync_cursor_and_local_track_count(
                &self.server_id,
                &self.library_scope,
                &value,
                i64::from(cursor.ingested_count),
            )
            .map_err(SyncError::Storage)
    }

    fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
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

    fn ensure_resync_generation(
        &self,
        cursor: &mut InitialSyncCursor,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        if cursor.resync_gen.is_some() {
            return Ok(());
        }
        let is_resync = sync_state
            .has_last_full_sync_at(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?
            || track_index_nonempty(self.store, &self.server_id).map_err(SyncError::Storage)?;
        if !is_resync {
            return Ok(());
        }
        let gen = TrackRepository::new(self.store)
            .next_resync_gen(&self.server_id)
            .map_err(SyncError::Storage)?;
        cursor.resync_gen = Some(gen);
        self.persist_cursor(sync_state, cursor)?;
        Ok(())
    }

    fn write_batch_timed(
        &self,
        rows: &[TrackRow],
        resync_gen: Option<i64>,
    ) -> Result<WriteOpTiming, SyncError> {
        TrackRepository::new(self.store)
            .upsert_batch_initial_ingest_timed(rows, resync_gen)
            .map_err(SyncError::Storage)
    }

    fn write_batch_logged(
        &self,
        rows: &[TrackRow],
        label: &str,
        offset: u32,
        resync_gen: Option<i64>,
    ) -> Result<(RemapStats, WriteOpTiming), SyncError> {
        let timing = self.write_batch_timed(rows, resync_gen)?;
        let total_ms = timing.total_ms();
        if total_ms >= 500 {
            crate::app_eprintln!(
                "[library-sync] {label} offset={offset} rows={} write_ms={total_ms} lock_wait_ms={} sql_exec_ms={} (slow batch)",
                rows.len(),
                timing.lock_wait_ms,
                timing.exec_ms,
            );
        } else {
            crate::app_eprintln!(
                "[library-sync] {label} offset={offset} rows={} write_ms={total_ms} lock_wait_ms={} sql_exec_ms={}",
                rows.len(),
                timing.lock_wait_ms,
                timing.exec_ms,
            );
        }
        Ok((RemapStats::default(), timing))
    }

    fn link_canonical_after_bulk_ingest(&self) -> Result<(), SyncError> {
        let start = std::time::Instant::now();
        let linked = crate::canonical::link_all_tracks_for_server(
            self.store,
            &self.server_id,
            now_unix_ms(),
        )
        .map_err(SyncError::Storage)?;
        crate::app_eprintln!(
            "[library-sync] canonical bulk link server `{}`: {linked} tracks in {}ms",
            self.server_id,
            start.elapsed().as_millis()
        );
        Ok(())
    }

    // ── N1 (Navidrome native /api/song) ────────────────────────────────

    async fn run_n1(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let creds = self.navidrome.as_ref().ok_or_else(|| SyncError::Transport(
            "n1 strategy selected but no Navidrome credentials supplied".into(),
        ))?;
        let mut offset = match cursor.strategy_state {
            StrategyState::LinearOffset { offset } => offset,
            ref other => {
                return Err(SyncError::Storage(format!(
                    "n1 expected linear-offset cursor, got {other:?}"
                )))
            }
        };

        let budget = self.parallelism_budget();
        let prefetch = linear_prefetch_depth(&budget);
        crate::app_eprintln!(
            "[library-sync] N1 ingest server `{}`: prefetch_depth={} max_concurrent={} batch_size={}",
            self.server_id,
            prefetch,
            budget.max_concurrent,
            self.batch_size
        );
        let mut batch_count: u32 = 0;
        if prefetch <= 1 {
            loop {
                wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation())
                    .await?;
                self.check_cancellation()?;
                sleep_request_gap(&budget, self.sleep_enabled).await;
                let array = match self.fetch_n1_page(creds, offset).await {
                    Err(e) if self.n1_hit_deep_offset_wall(&e, offset) => {
                        return self.fall_back_n1_to_s1(cursor, report, sync_state).await;
                    }
                    other => other?,
                };
                if array.is_empty() {
                    break;
                }
                offset = self
                    .ingest_n1_page(
                        &array,
                        offset,
                        &mut IngestPageCtx {
                            cursor,
                            report,
                            sync_state,
                            batch_count: &mut batch_count,
                            force_persist: (array.len() as u32) < self.batch_size,
                        },
                    )
                    .await?;
                if (array.len() as u32) < self.batch_size {
                    break;
                }
            }
            self.persist_cursor(sync_state, cursor)?;
            return Ok(());
        }

        let batch_size = self.batch_size;
        let cancel = self.cancel.clone();
        let sleep_enabled = self.sleep_enabled;
        let creds = creds.clone();
        let mut queue = LinearPrefetchQueue::new(&budget, batch_size, offset);

        loop {
            wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            self.check_cancellation()?;

            queue.pump(|| self.check_cancellation(), |off| {
                let creds = creds.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    retry_fetch(
                        sleep_enabled,
                        || check_cancel_flag(&cancel),
                        || async {
                            let end = off.saturating_add(batch_size);
                            let response = nd_list_songs_internal(
                                &creds.server_url,
                                &creds.bearer_token,
                                "id",
                                "ASC",
                                off,
                                end,
                            )
                            .await
                            .map_err(SyncError::Navidrome)?;
                            Ok(response.as_array().cloned().unwrap_or_default())
                        },
                        |e| e,
                    )
                    .await
                })
            })?;

            let array = match queue
                .take_at(offset, || self.check_cancellation())
                .await
            {
                Err(e) if self.n1_hit_deep_offset_wall(&e, offset) => {
                    return self.fall_back_n1_to_s1(cursor, report, sync_state).await;
                }
                Err(e) => return Err(e),
                Ok(Some(page)) => page,
                Ok(None) => {
                    sleep_request_gap(&budget, self.sleep_enabled).await;
                    match self.fetch_n1_page(&creds, offset).await {
                        Err(e) if self.n1_hit_deep_offset_wall(&e, offset) => {
                            return self.fall_back_n1_to_s1(cursor, report, sync_state).await;
                        }
                        other => other?,
                    }
                }
            };

            if array.is_empty() {
                break;
            }

            offset = self
                .ingest_n1_page(
                    &array,
                    offset,
                    &mut IngestPageCtx {
                        cursor,
                        report,
                        sync_state,
                        batch_count: &mut batch_count,
                        force_persist: (array.len() as u32) < self.batch_size,
                    },
                )
                .await?;

            if (array.len() as u32) < self.batch_size {
                queue.mark_exhausted();
                break;
            }
        }
        self.persist_cursor(sync_state, cursor)?;
        Ok(())
    }

    async fn fetch_n1_page(
        &self,
        creds: &NavidromeProbeCredentials,
        offset: u32,
    ) -> Result<Vec<Value>, SyncError> {
        let end = offset.saturating_add(self.batch_size);
        let response = match retry_with_backoff(
            self,
            || {
                nd_list_songs_internal(
                    &creds.server_url,
                    &creds.bearer_token,
                    "id",
                    "ASC",
                    offset,
                    end,
                )
            },
            SyncError::Navidrome,
        )
        .await
        {
            Ok(v) => v,
            Err(e) if self.n1_hit_deep_offset_wall(&e, offset) => {
                return Err(e);
            }
            Err(e) => return Err(e),
        };
        Ok(response.as_array().cloned().unwrap_or_default())
    }

    async fn ingest_n1_page(
        &self,
        array: &[Value],
        offset: u32,
        ctx: &mut IngestPageCtx<'_>,
    ) -> Result<u32, SyncError> {
        let synced_at = now_unix_ms();
        let rows: Vec<TrackRow> = array
            .iter()
            .filter_map(|v| {
                navidrome_song_to_track_row(
                    &self.server_id,
                    v,
                    synced_at,
                    self.library_scope_opt(),
                )
            })
            .collect();
        let (_stats, _timing) =
            self.write_batch_logged(&rows, "N1", offset, ctx.cursor.resync_gen)?;
        ctx.report.ingested_count = ctx.report.ingested_count.saturating_add(rows.len() as u32);

        let next_offset = offset.saturating_add(self.batch_size);
        ctx.cursor.strategy_state = StrategyState::LinearOffset {
            offset: next_offset,
        };
        ctx.cursor.ingested_count = ctx.report.ingested_count;
        *ctx.batch_count += 1;
        if ctx.force_persist || ctx.batch_count.is_multiple_of(CURSOR_PERSIST_EVERY_BATCHES) {
            self.persist_cursor(ctx.sync_state, ctx.cursor)?;
        }
        self.progress.emit(ProgressEvent::IngestPage {
            ingested_total: ctx.report.ingested_count,
            batch_count: *ctx.batch_count,
            metrics: None,
        });
        Ok(next_offset)
    }

    /// True when an N1 error is the deep-offset wall: a persistent HTTP 500
    /// at or beyond the safety line (R7-15 Q5). A 500 at a shallow offset is
    /// a different failure and propagates as an error instead.
    fn n1_hit_deep_offset_wall(&self, e: &SyncError, offset: u32) -> bool {
        offset >= self.n1_deep_offset_safe && e.navidrome_http_status() == Some(500)
    }

    /// R7-15 Q5 — one-way N1→S1 fallback. Learn `n1_bulk_unreliable` for this
    /// server, then restart ingest on S1. N1 (`id ASC`) and S1 (`search3`
    /// default order) don't share an offset space, so resuming from the N1
    /// offset would skip songs — restart S1 from 0. Re-ingest is idempotent
    /// (PK upsert); the duplicate work over rows N1 already wrote is
    /// acceptable for v1. The cursor is rewritten in place, never zeroed away.
    async fn fall_back_n1_to_s1(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        crate::app_eprintln!(
            "[library-sync] N1 hit the deep-offset wall for server `{}`; flagging \
             n1_bulk_unreliable and falling back to S1",
            self.server_id
        );
        sync_state
            .set_n1_bulk_unreliable(&self.server_id, &self.library_scope, true)
            .map_err(SyncError::Storage)?;
        let scope = if self.library_scope.is_empty() {
            None
        } else {
            Some(self.library_scope.clone())
        };
        *cursor = InitialSyncCursor::fresh(IngestStrategy::S1, scope);
        report.ingested_count = 0;
        report.strategy = Some(cursor.strategy.clone());
        self.persist_cursor(sync_state, cursor)?;
        self.run_s1(cursor, report, sync_state).await
    }

    // ── S1 (Subsonic search3 empty query) ──────────────────────────────

    async fn run_s1(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let mut offset = match cursor.strategy_state {
            StrategyState::LinearOffset { offset } => offset,
            ref other => {
                return Err(SyncError::Storage(format!(
                    "s1 expected linear-offset cursor, got {other:?}"
                )))
            }
        };

        let budget = self.parallelism_budget();
        let prefetch = linear_prefetch_depth(&budget);
        crate::app_eprintln!(
            "[library-sync] S1 ingest server `{}`: prefetch_depth={} max_concurrent={} batch_size={}",
            self.server_id,
            prefetch,
            budget.max_concurrent,
            self.batch_size
        );
        let mut batch_count: u32 = 0;
        if prefetch <= 1 {
            loop {
                wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation())
                    .await?;
                self.check_cancellation()?;
                sleep_request_gap(&budget, self.sleep_enabled).await;
                let fetch_start = std::time::Instant::now();
                let (result, raw_body) = match self.fetch_s1_page(offset).await {
                    Err(e) if is_fetch_failure(&e) => {
                        return self.fall_back_s1_to_s2(cursor, report, sync_state).await;
                    }
                    other => other?,
                };
                let fetch_ms = fetch_start.elapsed().as_millis() as u32;
                if result.song.is_empty() {
                    break;
                }
                offset = self
                    .ingest_s1_page(
                        &result,
                        &raw_body,
                        offset,
                        fetch_ms,
                        &mut IngestPageCtx {
                            cursor,
                            report,
                            sync_state,
                            batch_count: &mut batch_count,
                            force_persist: (result.song.len() as u32) < self.batch_size,
                        },
                    )
                    .await?;
                if (result.song.len() as u32) < self.batch_size {
                    break;
                }
            }
            self.persist_cursor(sync_state, cursor)?;
            return Ok(());
        }

        let batch_size = self.batch_size;
        let subsonic = self.subsonic.clone();
        let library_scope = self.library_scope.clone();
        let cancel = self.cancel.clone();
        let sleep_enabled = self.sleep_enabled;
        let mut queue = LinearPrefetchQueue::new(&budget, batch_size, offset);

        loop {
            wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            self.check_cancellation()?;

            queue.pump(|| self.check_cancellation(), |off| {
                let subsonic = subsonic.clone();
                let library_scope = library_scope.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    retry_fetch(
                        sleep_enabled,
                        || check_cancel_flag(&cancel),
                        || async {
                            let scope = if library_scope.is_empty() {
                                None
                            } else {
                                Some(library_scope.as_str())
                            };
                            subsonic
                                .search3_with_raw("", batch_size, off, scope)
                                .await
                                .map_err(SyncError::from)
                        },
                        |e| e,
                    )
                    .await
                })
            })?;

            let fetch_start = std::time::Instant::now();
            let (result, raw_body) = match queue
                .take_at(offset, || self.check_cancellation())
                .await
            {
                Err(e) if is_fetch_failure(&e) => {
                    return self.fall_back_s1_to_s2(cursor, report, sync_state).await;
                }
                Err(e) => return Err(e),
                Ok(Some(page)) => page,
                Ok(None) => {
                    sleep_request_gap(&budget, self.sleep_enabled).await;
                    match self.fetch_s1_page(offset).await {
                        Err(e) if is_fetch_failure(&e) => {
                            return self.fall_back_s1_to_s2(cursor, report, sync_state).await;
                        }
                        other => other?,
                    }
                }
            };
            let fetch_ms = fetch_start.elapsed().as_millis() as u32;

            if result.song.is_empty() {
                break;
            }

            offset = self
                .ingest_s1_page(
                    &result,
                    &raw_body,
                    offset,
                    fetch_ms,
                    &mut IngestPageCtx {
                        cursor,
                        report,
                        sync_state,
                        batch_count: &mut batch_count,
                        force_persist: (result.song.len() as u32) < self.batch_size,
                    },
                )
                .await?;

            if (result.song.len() as u32) < self.batch_size {
                queue.mark_exhausted();
                break;
            }
        }
        self.persist_cursor(sync_state, cursor)?;
        Ok(())
    }

    async fn fetch_s1_page(
        &self,
        offset: u32,
    ) -> Result<(psysonic_integration::subsonic::SearchResult, Value), SyncError> {
        let scope = self.library_scope_opt();
        retry_with_backoff(
            self,
            || self.subsonic.search3_with_raw("", self.batch_size, offset, scope),
            SyncError::from,
        )
        .await
    }

    async fn ingest_s1_page(
        &self,
        result: &psysonic_integration::subsonic::SearchResult,
        raw_body: &Value,
        offset: u32,
        fetch_ms: u32,
        ctx: &mut IngestPageCtx<'_>,
    ) -> Result<u32, SyncError> {
        let raw_songs = raw_body
            .get("song")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let synced_at = now_unix_ms();
        let mut rows: Vec<TrackRow> = Vec::with_capacity(result.song.len());
        for (i, song) in result.song.iter().enumerate() {
            let raw = raw_songs
                .get(i)
                .cloned()
                .unwrap_or_else(|| serde_json::to_value(song).unwrap_or(Value::Null));
            rows.push(subsonic_song_to_track_row(
                &self.server_id,
                song,
                &raw,
                synced_at,
                self.library_scope_opt(),
            ));
        }
        let row_count = rows.len() as u32;
        let (_stats, write_timing) =
            self.write_batch_logged(&rows, "S1", offset, ctx.cursor.resync_gen)?;
        ctx.report.ingested_count = ctx.report.ingested_count.saturating_add(row_count);

        let next_offset = offset.saturating_add(self.batch_size);
        ctx.cursor.strategy_state = StrategyState::LinearOffset {
            offset: next_offset,
        };
        ctx.cursor.ingested_count = ctx.report.ingested_count;
        *ctx.batch_count += 1;
        let persist_start = std::time::Instant::now();
        let did_persist =
            ctx.force_persist || ctx.batch_count.is_multiple_of(CURSOR_PERSIST_EVERY_BATCHES);
        if did_persist {
            self.persist_cursor(ctx.sync_state, ctx.cursor)?;
        }
        let persist_ms = if did_persist {
            persist_start.elapsed().as_millis() as u32
        } else {
            0
        };
        self.progress.emit(ProgressEvent::IngestPage {
            ingested_total: ctx.report.ingested_count,
            batch_count: *ctx.batch_count,
            metrics: Some(IngestBatchMetrics {
                offset,
                strategy: "s1".into(),
                fetch_ms,
                write_ms: write_timing.total_ms() as u32,
                lock_wait_ms: write_timing.lock_wait_ms as u32,
                sql_exec_ms: write_timing.exec_ms as u32,
                persist_ms,
                row_count,
                bulk_ingest_active: self.store.bulk_ingest_active(),
            }),
        });
        Ok(next_offset)
    }

    /// Q8 (R7-15) — fall back to the universal S2 album crawl when S1 fails
    /// persistently. S1 (`search3` order) and S2 (album-list order) don't
    /// share an offset space, so restart S2 from scratch; re-ingest is
    /// idempotent (PK upsert). The cursor is rewritten in place, never zeroed.
    /// No new artist-walk strategy is introduced (Q8 decision).
    async fn fall_back_s1_to_s2(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        crate::app_eprintln!(
            "[library-sync] S1 failed persistently for server `{}`; falling back to \
             S2 album crawl",
            self.server_id
        );
        let scope = if self.library_scope.is_empty() {
            None
        } else {
            Some(self.library_scope.clone())
        };
        *cursor = InitialSyncCursor::fresh(IngestStrategy::S2, scope);
        report.ingested_count = 0;
        report.strategy = Some(cursor.strategy.clone());
        self.persist_cursor(sync_state, cursor)?;
        self.run_s2(cursor, report, sync_state).await
    }

    // ── S2 (album crawl: getAlbumList2 + getAlbum) ─────────────────────

    async fn run_s2(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let (mut album_offset, resume_album_id) = match &cursor.strategy_state {
            StrategyState::AlbumCrawl { album_offset, current_album_id } => {
                (*album_offset, current_album_id.clone())
            }
            ref other => {
                return Err(SyncError::Storage(format!(
                    "s2 expected album-crawl cursor, got {other:?}"
                )))
            }
        };

        let budget = self.parallelism_budget();
        crate::app_eprintln!(
            "[library-sync] S2 ingest server `{}`: parallel_get_album={} batch_size={}",
            self.server_id,
            budget.max_concurrent,
            self.batch_size
        );
        let mut batch_count: u32 = 0;
        let mut resume_from = resume_album_id;

        loop {
            wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            self.check_cancellation()?;
            let scope = self.library_scope_opt();
            sleep_request_gap(&budget, self.sleep_enabled).await;
            let albums = retry_with_backoff(
                self,
                || {
                    self.subsonic.get_album_list2(
                        "alphabeticalByName",
                        self.batch_size,
                        album_offset,
                        scope,
                    )
                },
                SyncError::from,
            )
            .await?;
            if albums.is_empty() {
                break;
            }

            let mut album_ids: Vec<String> = Vec::with_capacity(albums.len());
            if let Some(ref resume_after) = resume_from {
                let mut past_resume = false;
                for album_summary in &albums {
                    if !past_resume {
                        if resume_after == &album_summary.id {
                            past_resume = true;
                        }
                        continue;
                    }
                    album_ids.push(album_summary.id.clone());
                }
            } else {
                for album_summary in &albums {
                    album_ids.push(album_summary.id.clone());
                }
            }
            resume_from = None;

            let fetched = fetch_albums_parallel(
                self.subsonic,
                &album_ids,
                ParallelAlbumFetchOpts {
                    budget,
                    sleep_enabled: self.sleep_enabled,
                    cancel: self.cancel.clone(),
                },
            )
            .await?;

            for (album, raw_album) in fetched {
                self.check_cancellation()?;
                let synced_at = now_unix_ms();
                let raw_songs = raw_album
                    .get("song")
                    .and_then(|s| s.as_array())
                    .cloned()
                    .unwrap_or_default();
                let mut rows: Vec<TrackRow> = Vec::with_capacity(album.song.len());
                for (i, song) in album.song.iter().enumerate() {
                    let mut raw = raw_songs
                        .get(i)
                        .cloned()
                        .unwrap_or_else(|| serde_json::to_value(song).unwrap_or(Value::Null));
                    merge_album_open_subsonic_track_raw(&raw_album, &mut raw);
                    rows.push(subsonic_song_to_track_row(
                        &self.server_id,
                        song,
                        &raw,
                        synced_at,
                        self.library_scope_opt(),
                    ));
                }
                if !rows.is_empty() {
                    let (_stats, _timing) =
                        self.write_batch_logged(&rows, "S2", album_offset, cursor.resync_gen)?;
                    report.ingested_count = report
                        .ingested_count
                        .saturating_add(rows.len() as u32);
                    batch_count += 1;
                    self.progress.emit(ProgressEvent::IngestPage {
                        ingested_total: report.ingested_count,
                        batch_count,
                        metrics: None,
                    });
                }
                cursor.strategy_state = StrategyState::AlbumCrawl {
                    album_offset,
                    current_album_id: Some(album.id.clone()),
                };
                cursor.ingested_count = report.ingested_count;
                self.persist_cursor(sync_state, cursor)?;
            }

            album_offset = album_offset.saturating_add(self.batch_size);
            cursor.strategy_state = StrategyState::AlbumCrawl {
                album_offset,
                current_album_id: None,
            };
            cursor.ingested_count = report.ingested_count;
            self.persist_cursor(sync_state, cursor)?;

            if (albums.len() as u32) < self.batch_size {
                break;
            }
        }
        Ok(())
    }

    // ── IS-4 artist pass (best-effort browse acceleration) ─────────────

    async fn run_artist_pass(
        &self,
        _sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let scope = self.library_scope_opt();
        let artists = retry_with_backoff(
            self,
            || self.subsonic.get_artists(scope),
            SyncError::from,
        )
        .await
        .ok();
        if let Some(index) = artists {
            super::artist_index::apply_artist_index(
                self.store,
                &self.server_id,
                &self.library_scope,
                &index,
            )?;
        }
        Ok(())
    }

    // ── IS-5 watermarks ────────────────────────────────────────────────

    async fn run_watermark_pass(
        &self,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        if self
            .capability_flags
            .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE)
        {
            if let Ok(s) = self.subsonic.get_scan_status().await {
                sync_state
                    .set_server_last_scan_iso(
                        &self.server_id,
                        &self.library_scope,
                        s.last_scan.as_deref(),
                    )
                    .map_err(SyncError::Storage)?;
            }
        }
        Ok(())
    }
}

fn is_empty_cursor(v: &Value) -> bool {
    matches!(v, Value::Object(o) if o.is_empty())
}

use super::now_unix_ms;

/// Wrap an async closure in §6.8 backoff. Retries on `SyncError::Transport`
/// up to `MAX_ATTEMPTS_PER_BATCH`, sleeping per the backoff schedule
/// (skipped when `sleep_enabled` is false — test path).
/// Cancellation is checked between attempts.
async fn retry_with_backoff<'a, F, FFut, T, E>(
    runner: &InitialSyncRunner<'a>,
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
    matches!(
        e,
        SyncError::Transport(_) | SyncError::Navidrome(_)
    )
}

/// A persistent fetch failure (network / HTTP / decode / API) that warrants
/// switching ingest strategy (Q8 S1→S2). Cancellation is user intent and
/// storage is a local problem a strategy switch can't fix — both propagate.
fn is_fetch_failure(e: &SyncError) -> bool {
    matches!(
        e,
        SyncError::Transport(_)
            | SyncError::Subsonic { .. }
            | SyncError::Navidrome(_)
            | SyncError::NotFound
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::capability::NavidromeProbeCredentials;
    use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::matchers::{header, method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn flags(bits: u32) -> CapabilityFlags {
        CapabilityFlags::new(bits)
    }

    fn test_subsonic(uri: &str) -> SubsonicClient {
        SubsonicClient::with_static_credentials(
            uri,
            SubsonicCredentials::with_static("user", "tok", "salt"),
            reqwest::Client::new(),
        )
    }

    async fn mount_search3_pages(server: &MockServer, total: u32, batch: u32) {
        // Two-page test fixture: first page returns `batch` songs,
        // second page returns the remainder, third page returns empty.
        for page in 0u32..=2 {
            let offset = page * batch;
            let body = if offset >= total {
                json!({ "subsonic-response": { "status": "ok", "searchResult3": {} } })
            } else {
                let remaining = (total - offset).min(batch);
                let songs: Vec<_> = (0..remaining)
                    .map(|i| json!({
                        "id": format!("tr_{:04}", offset + i),
                        "title": format!("Title {}", offset + i),
                        "duration": 200_i64 + (offset + i) as i64,
                    }))
                    .collect();
                json!({
                    "subsonic-response": {
                        "status": "ok",
                        "searchResult3": { "song": songs }
                    }
                })
            };
            Mock::given(wm_method("GET"))
                .and(wm_path("/rest/search3.view"))
                .and(query_param("songOffset", offset.to_string()))
                .respond_with(ResponseTemplate::new(200).set_body_json(body))
                .mount(server)
                .await;
        }
    }

    async fn mount_minimal_artists(server: &MockServer) {
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": {
                        "lastModified": 1_716_840_000_000_i64,
                        "ignoredArticles": "",
                        "index": []
                    }
                }
            })))
            .mount(server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "scanStatus": {
                        "scanning": false,
                        "count": 1234,
                        "lastScan": "2024-06-01T12:00:00Z"
                    }
                }
            })))
            .mount(server)
            .await;
    }

    // ── S1 happy path ──────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_ingest_drains_pages_and_persists_done_phase() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 7, /*batch*/ 4).await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let runner = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_batch_size(4)
        .with_sleep_disabled();

        let report = runner.run().await.unwrap();
        assert_eq!(report.ingested_count, 7);
        assert_eq!(report.remapped_count, 0);
        assert_eq!(report.strategy.as_deref(), Some("s1"));

        // sync_phase ended in "ready" and cursor cleared.
        let sync_state = SyncStateRepository::new(&store);
        assert_eq!(
            sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
            Some("ready")
        );
        let cur = sync_state.get_initial_sync_cursor("s1", "").unwrap();
        assert_eq!(cur, Some(json!({})));

        // Tracks landed in the store.
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 7);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn full_resync_sweeps_orphans_not_seen_in_ingest() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 3, /*batch*/ 10).await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_last_full_sync_at("s1", "", 1)
            .unwrap();

        store
            .with_conn_mut("misc", |c| {
                for id in ["tr_stale_a", "tr_stale_b"] {
                    c.execute(
                        "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, resync_gen) \
                         VALUES ('s1', ?1, 'stale', 'Al', 1, 0, 1, '{}', 1)",
                        rusqlite::params![id],
                    )?;
                }
                Ok(())
            })
            .unwrap();

        let subsonic = test_subsonic(&server.uri());
        InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        let live: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = 's1' AND deleted = 0",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(live, 3);

        let stale_deleted: i64 = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT COUNT(*) FROM track WHERE id IN ('tr_stale_a', 'tr_stale_b') AND deleted = 1",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(stale_deleted, 2);
    }

    // ── Per-batch progress is emitted during ingest ───────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn initial_sync_emits_per_batch_progress() {
        use crate::sync::progress::ChannelProgress;
        use std::time::Duration;

        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 7, /*batch*/ 4).await;
        mount_minimal_artists(&server).await;

        // ZERO interval so the throttle never drops a batch event in the test.
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let progress: Arc<dyn Progress + Send + Sync> =
            Arc::new(ChannelProgress::with_interval(tx, Duration::ZERO));

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_batch_size(4)
        .with_sleep_disabled()
        .with_progress(progress)
        .run()
        .await
        .unwrap();

        // Collect the per-batch ingest totals the runner emitted.
        let mut totals = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let ProgressEvent::IngestPage { ingested_total, .. } = ev {
                totals.push(ingested_total);
            }
        }
        assert!(!totals.is_empty(), "initial sync must emit per-batch IngestPage progress");
        assert_eq!(*totals.last().unwrap(), 7, "final progress total must reach the full count");
        assert!(
            totals.windows(2).all(|w| w[0] <= w[1]),
            "ingest totals must be non-decreasing"
        );
    }

    // ── S1 mid-cursor resume ──────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_resumes_from_persisted_cursor_after_kill() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 10, /*batch*/ 4).await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);

        // Seed the cursor as if a prior run completed page 0 (offset=4)
        // but was killed before page 1 landed.
        sync_state.ensure("s1", "").unwrap();
        let mid_cursor = json!({
            "strategy": "s1",
            "phase": "ingest",
            "library_scope": null,
            "ingested_count": 4,
            "strategy_state": { "kind": "linear_offset", "offset": 4 }
        });
        sync_state
            .set_initial_sync_cursor("s1", "", &mid_cursor)
            .unwrap();

        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(4)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        // Resumed at offset 4 — only 6 more rows ingested.
        assert_eq!(report.ingested_count, 4 + 6);
        // …but the store ends up with all 10.
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        // 6 — only the pages run by *this* invocation are persisted to
        // `track` here because the cursor said offset=4 but the prior
        // run never actually wrote rows in this fixture. The assertion
        // documents the resume semantics: cursor controls request
        // offset, not row count.
        assert_eq!(count, 6);
    }

    // ── Stale / unreadable cursor self-heals instead of bricking ──────

    #[test]
    fn cursor_with_progress_resumes_and_ignores_reselected_strategy() {
        // R7-15 Q3: a cursor that already made progress must resume under its
        // own strategy even when a re-probe would now pick a different one
        // (here: flags advertise N1 again, but the in-flight cursor is S1).
        // Freezing the strategy is what stops the flapping-induced restart
        // from offset 0 that kept large syncs from ever completing.
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_initial_sync_cursor(
                "s1",
                "",
                &json!({
                    "strategy": "s1",
                    "phase": "ingest",
                    "ingested_count": 42,
                    "strategy_state": { "kind": "linear_offset", "offset": 2000 }
                }),
            )
            .unwrap();

        let subsonic = test_subsonic("http://127.0.0.1:1");
        let runner = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(
                CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK,
            ),
        );
        let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
        assert_eq!(cursor.strategy, "s1", "in-flight strategy must be frozen on resume");
        assert_eq!(cursor.ingested_count, 42, "resume must preserve progress");
    }

    #[test]
    fn fresh_cursor_without_progress_adopts_reselected_strategy() {
        // No progress yet (offset 0): adopting the freshly-selected strategy
        // is free, so a cursor written under a now-unavailable strategy is
        // re-selected (not a hard error, not a needless resume).
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_initial_sync_cursor(
                "s1",
                "",
                &json!({
                    "strategy": "n1",
                    "phase": "ingest",
                    "ingested_count": 0,
                    "strategy_state": { "kind": "linear_offset", "offset": 0 }
                }),
            )
            .unwrap();

        let subsonic = test_subsonic("http://127.0.0.1:1");
        let runner = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        );
        let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
        assert_eq!(cursor.strategy, "s1", "no-progress cursor adopts the selected strategy");
        assert_eq!(cursor.ingested_count, 0);
    }

    #[test]
    fn n1_cursor_with_progress_reselects_when_flagged_unreliable() {
        // A cursor still on N1 after the server was learned `n1_bulk_unreliable`
        // is known-broken: the freeze does not apply, so it re-selects onto the
        // non-N1 strategy rather than resuming a wall-bound N1 loop. (The
        // mid-run N1→S1 fallback normally rewrites such a cursor in place,
        // preserving progress; this is the defensive fallback.)
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state.set_n1_bulk_unreliable("s1", "", true).unwrap();
        sync_state
            .set_initial_sync_cursor(
                "s1",
                "",
                &json!({
                    "strategy": "n1",
                    "phase": "ingest",
                    "ingested_count": 42,
                    "strategy_state": { "kind": "linear_offset", "offset": 500 }
                }),
            )
            .unwrap();

        let subsonic = test_subsonic("http://127.0.0.1:1");
        let runner = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(
                CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK,
            ),
        );
        let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
        assert_eq!(cursor.strategy, "s1", "known-broken N1 cursor must re-select to S1");
        assert_eq!(cursor.ingested_count, 0);
    }

    #[test]
    fn unreadable_cursor_is_reset_not_errored() {
        // A corrupt cursor (missing the required `strategy` field) must
        // also self-heal to a fresh cursor rather than error out.
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_initial_sync_cursor("s1", "", &json!({ "phase": "ingest", "ingested_count": 9 }))
            .unwrap();

        let subsonic = test_subsonic("http://127.0.0.1:1");
        let runner = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        );
        let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
        assert_eq!(cursor.strategy, "s1");
    }

    // ── Backoff retries on 503 then succeeds ──────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_retries_after_transient_503_then_succeeds() {
        let server = MockServer::start().await;
        // First request — 503. Wiremock `up_to_n_times` makes this
        // simple: 1 mock that only answers once with 503, then a
        // catch-all that returns the empty success envelope.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", "0"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "searchResult3": {} }
            })))
            .mount(&server)
            .await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();
        assert_eq!(report.ingested_count, 0, "all retries land before a song");
    }

    // ── Cancellation token aborts mid-run ─────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_flag_returns_cancelled_error() {
        let server = MockServer::start().await;
        mount_search3_pages(&server, /*total*/ 100, /*batch*/ 4).await;
        let cancel = Arc::new(AtomicBool::new(true)); // already tripped
        let store = LibraryStore::open_in_memory();

        let err = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(4)
        .with_cancellation(cancel)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap_err();
        assert!(matches!(err, SyncError::Cancelled));
    }

    // ── N1 happy path via wiremock ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn n1_ingest_paginates_navidrome_native_endpoint() {
        let server = MockServer::start().await;
        // Two pages of 2 songs each, then empty.
        for page in 0u32..=2 {
            let start = page * 2;
            let songs = if page < 2 {
                vec![
                    json!({"id": format!("tr_{start}"), "title": format!("t{start}"), "duration": 100}),
                    json!({"id": format!("tr_{}", start + 1), "title": format!("t{}", start + 1), "duration": 100}),
                ]
            } else {
                vec![]
            };
            Mock::given(wm_method("GET"))
                .and(wm_path("/api/song"))
                .and(query_param("_start", start.to_string()))
                .and(header("X-ND-Authorization", "Bearer nd-tok"))
                .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::Value::Array(songs)))
                .mount(&server)
                .await;
        }
        // Minimal Subsonic ping path for artist/watermark phases.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": { "lastModified": 0, "ignoredArticles": "", "index": [] }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "scanStatus": { "scanning": false } }
            })))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SCAN_STATUS_AVAILABLE),
        )
        .with_navidrome_credentials(nav)
        .with_batch_size(2)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();
        assert_eq!(report.ingested_count, 4);
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 4);

        let sync_state = SyncStateRepository::new(&store);
        assert_eq!(sync_state.get_local_track_count("s1", "").unwrap(), Some(4));
        assert_eq!(sync_state.get_sync_phase("s1", "").unwrap().as_deref(), Some("ready"));
        let full_sync: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT last_full_sync_at FROM sync_state WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(full_sync.is_some());
    }

    // ── N1 → S1 deep-offset fallback (R7-15 Q5) ───────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn n1_deep_offset_500_falls_back_to_s1_and_flags_server() {
        let server = MockServer::start().await;
        // N1 serves the first page, then 500s at the (test-lowered) wall.
        // Ids match the S1 fixture format so the re-ingest upserts rather
        // than duplicating the rows N1 already wrote.
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .and(query_param("_start", "0"))
            .and(header("X-ND-Authorization", "Bearer nd-tok"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": "tr_0000", "title": "t0", "duration": 100},
                {"id": "tr_0001", "title": "t1", "duration": 100}
            ])))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .and(query_param("_start", "2"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        // S1 restarts from offset 0 and ingests all 5 songs.
        mount_search3_pages(&server, /*total*/ 5, /*batch*/ 2).await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(
                CapabilityFlags::NAVIDROME_NATIVE_BULK
                    | CapabilityFlags::SUBSONIC_SEARCH3_BULK
                    | CapabilityFlags::SCAN_STATUS_AVAILABLE,
            ),
        )
        .with_navidrome_credentials(nav)
        .with_batch_size(2)
        .with_n1_deep_offset_safe(2)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.strategy.as_deref(), Some("s1"), "run must finish on S1");
        // 5 distinct songs — N1's two rows were re-upserted, not duplicated.
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 5);
        // Server learned the flag so future syncs skip N1.
        let sync_state = SyncStateRepository::new(&store);
        assert_eq!(sync_state.get_n1_bulk_unreliable("s1", "").unwrap(), Some(true));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn n1_shallow_500_propagates_without_fallback() {
        // A 500 below the wall line is a real error, not the deep-offset
        // trigger: it propagates and must NOT silently flag the server.
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let store = LibraryStore::open_in_memory();
        let nav = NavidromeProbeCredentials {
            server_url: server.uri(),
            bearer_token: "nd-tok".into(),
        };
        let err = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::NAVIDROME_NATIVE_BULK),
        )
        .with_navidrome_credentials(nav)
        .with_batch_size(2)
        .with_n1_deep_offset_safe(1000)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap_err();
        assert!(matches!(err, SyncError::Navidrome(ref m) if m.contains("500")));
        let sync_state = SyncStateRepository::new(&store);
        assert_eq!(sync_state.get_n1_bulk_unreliable("s1", "").unwrap(), Some(false));
    }

    // ── S1 → S2 persistent-failure fallback (R7-15 Q8) ────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_persistent_failure_falls_back_to_s2() {
        let server = MockServer::start().await;
        // S1 (search3) fails on every attempt → persistent after retries.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        // S2 album crawl works: one album page, then empty.
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [{ "id": "al_1", "name": "First" }] }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "albumList2": { "album": [] } }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", "al_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": {
                        "id": "al_1",
                        "name": "First",
                        "song": [{ "id": "tr_a", "title": "song", "duration": 240 }]
                    }
                }
            })))
            .mount(&server)
            .await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let report = InitialSyncRunner::new(
            &store,
            &test_subsonic(&server.uri()),
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(1)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.strategy.as_deref(), Some("s2"), "run must finish on S2");
        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1, "the S2 album crawl ingested the track");
    }

    // ── S3 explicitly unsupported in v1 ───────────────────────────────

    #[test]
    fn s3_cursor_self_heals_to_selected_strategy() {
        // S3 is never auto-selected, so a persisted s3 cursor (legacy /
        // corrupt) can never match the chosen strategy — it must reset to
        // the selected strategy rather than error.
        let store = LibraryStore::open_in_memory();
        let sync_state = SyncStateRepository::new(&store);
        sync_state.ensure("s1", "").unwrap();
        sync_state
            .set_initial_sync_cursor(
                "s1",
                "",
                &json!({
                    "strategy": "s3",
                    "phase": "ingest",
                    "ingested_count": 0,
                    "strategy_state": { "kind": "empty" }
                }),
            )
            .unwrap();

        let subsonic = test_subsonic("http://127.0.0.1:1");
        // Default flags ⇒ selector resolves to s2.
        let runner = InitialSyncRunner::new(&store, &subsonic, "s1", "", flags(0));
        let cursor = runner.load_or_init_cursor(&sync_state).unwrap();
        assert_eq!(cursor.strategy, "s2");
    }

    // ── S1 raw_json carries OpenSubsonic extensions verbatim ──────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s1_ingest_preserves_open_subsonic_fields_in_track_raw_json() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("songOffset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": {
                        "song": [
                            {
                                "id": "tr_1",
                                "title": "With Extensions",
                                "duration": 240,
                                "replayGain": { "trackGain": -1.2, "albumGain": -0.8 },
                                "contributors": [
                                    { "role": "producer", "artistId": "ar_9", "name": "Prod" }
                                ]
                            }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "searchResult3": {} }
            })))
            .mount(&server)
            .await;
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        InitialSyncRunner::new(
            &store,
            &subsonic,
            "s1",
            "",
            flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
        )
        .with_batch_size(10)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        // raw_json column must contain the OpenSubsonic-only fields,
        // not just the typed projection — ADR-7 fidelity.
        let raw: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT raw_json FROM track WHERE server_id='s1' AND id='tr_1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed.get("replayGain").is_some(), "raw json keeps replayGain");
        assert!(parsed.get("contributors").is_some(), "raw json keeps contributors");

        // Typed projection also picked up replayGain via the mapping
        // helper — both paths agree on the hot column.
        let (rg_t, rg_a): (Option<f64>, Option<f64>) = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT replay_gain_track_db, replay_gain_album_db \
                     FROM track WHERE server_id='s1' AND id='tr_1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(rg_t, Some(-1.2));
        assert_eq!(rg_a, Some(-0.8));
    }

    // ── S2 happy path: getAlbumList2 → getAlbum-per-id loop ───────────

    #[tokio::test(flavor = "multi_thread")]
    async fn s2_ingest_walks_albums_and_persists_songs() {
        let server = MockServer::start().await;
        // First album-list page: 2 albums, second page: 0 (loop ends).
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": {
                        "album": [
                            { "id": "al_1", "name": "First" },
                            { "id": "al_2", "name": "Second" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("offset", "2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": { "album": [] }
                }
            })))
            .mount(&server)
            .await;
        // Per-album song lists.
        for (album_id, song_id) in [("al_1", "tr_a"), ("al_2", "tr_b")] {
            Mock::given(wm_method("GET"))
                .and(wm_path("/rest/getAlbum.view"))
                .and(query_param("id", album_id))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "subsonic-response": {
                        "status": "ok",
                        "album": {
                            "id": album_id,
                            "name": album_id,
                            "song": [
                                { "id": song_id, "title": "song", "duration": 240 }
                            ]
                        }
                    }
                })))
                .mount(&server)
                .await;
        }
        mount_minimal_artists(&server).await;

        let store = LibraryStore::open_in_memory();
        let subsonic = test_subsonic(&server.uri());
        let report = InitialSyncRunner::new(
            &store,
            &subsonic,
            "s2",
            "",
            // Force selector to fall through to S2: clear N1 + S1 bits.
            flags(0),
        )
        .with_batch_size(2)
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

        assert_eq!(report.strategy.as_deref(), Some("s2"));
        assert_eq!(report.ingested_count, 2);

        let count: i64 = store
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 2);
    }

    // ── Remap path (§6.9) — exercised on delta / full upsert, not IS-3 bulk ─

    #[test]
    fn remap_fires_on_unstable_track_ids_batch_upsert() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[TrackRow {
            server_id: "s1".into(),
            id: "tr_old".into(),
            title: "Aurora".into(),
            title_sort: None,
            artist: Some("A".into()),
            artist_id: None,
            album: "An Album".into(),
            album_id: None,
            album_artist: None,
            duration_sec: 240,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: Some("/path/aurora.flac".into()),
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }])
        .unwrap();

        let stats = repo
            .upsert_batch_with_remap(
                &[TrackRow {
                    server_id: "s1".into(),
                    id: "tr_new".into(),
                    title: "Aurora".into(),
                    title_sort: None,
                    artist: Some("A".into()),
                    artist_id: None,
                    album: "An Album".into(),
                    album_id: None,
                    album_artist: None,
                    duration_sec: 240,
                    track_number: None,
                    disc_number: None,
                    year: None,
                    genre: None,
                    suffix: None,
                    bit_rate: None,
                    size_bytes: None,
                    cover_art_id: None,
                    starred_at: None,
                    user_rating: None,
                    play_count: None,
                    played_at: None,
                    server_path: Some("/path/aurora.flac".into()),
                    library_id: None,
                    isrc: None,
                    mbid_recording: None,
                    bpm: None,
                    replay_gain_track_db: None,
                    replay_gain_album_db: None,
                    content_hash: None,
                    server_updated_at: None,
                    server_created_at: None,
                    deleted: false,
                    synced_at: 2,
                    raw_json: "{}".into(),
                }],
                true,
            )
            .unwrap();
        assert_eq!(stats.remapped.len(), 1);

        let ids: Vec<String> = store
            .with_conn("misc", |c| {
                let mut s = c.prepare("SELECT id FROM track WHERE server_id='s1' ORDER BY id")?;
                let r: rusqlite::Result<Vec<String>> = s.query_map([], |r| r.get(0))?.collect();
                r
            })
            .unwrap();
        assert_eq!(ids, vec!["tr_new"]);
    }
}

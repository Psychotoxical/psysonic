use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;

use super::runner::InitialSyncRunner;
use crate::repos::{RemapStats, SyncStateRepository, TrackRepository, TrackRow};
use crate::store::WriteOpTiming;
use crate::sync::backoff::{jitter_salt, with_jitter, Backoff};
use crate::sync::cursor::{CursorPhase, InitialSyncCursor};
use crate::sync::error::SyncError;
use crate::sync::now_unix_ms;
use crate::sync::poll_stats::{PollStats, ResyncSweepSkip};
use crate::sync::strategy::IngestStrategy;

/// Bulk ingest batch size per spec §6.3 (`batch=500`).
pub(super) const DEFAULT_BATCH_SIZE: u32 = 500;

/// Persist initial-sync cursor every N ingest batches (not every batch).
/// S2 already persists once per album-list page; N1/S1 match ~prefetch depth.
pub(super) const CURSOR_PERSIST_EVERY_BATCHES: u32 = 4;

/// Maximum attempts per batch before `SyncError::Transport` propagates.
const MAX_ATTEMPTS_PER_BATCH: u32 = 5;

/// N1 deep-offset safety line (R7-15 Q1/Q5).
pub(super) const N1_DEEP_OFFSET_SAFE: u32 = 50_000;

impl InitialSyncRunner<'_> {
    // ── cursor / persistence ───────────────────────────────────────────

    pub(super) fn load_or_init_cursor(
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
            !self.library_scope.is_empty(),
        );
        if let Some(raw) = raw {
            if !is_empty_cursor(&raw) {
                match serde_json::from_value::<InitialSyncCursor>(raw) {
                    Ok(parsed) => {
                        let has_progress =
                            parsed.ingested_count > 0 || parsed.phase != CursorPhase::Ingest;
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
                        let frozen_strategy_known_broken = parsed.strategy
                            == IngestStrategy::N1.as_tag()
                            && (n1_bulk_unreliable || !self.library_scope.is_empty());
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

    pub(super) fn persist_cursor(
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

    pub(super) fn persist_resync_sweep_skip(
        &self,
        sync_state: &SyncStateRepository<'_>,
        diagnostic: Option<ResyncSweepSkip>,
    ) -> Result<(), SyncError> {
        let mut stats = sync_state
            .get_poll_stats_json(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?
            .and_then(|value| serde_json::from_value::<PollStats>(value).ok())
            .unwrap_or_default();
        stats.last_resync_sweep_skip = diagnostic;
        let value = serde_json::to_value(stats)
            .map_err(|error| SyncError::Storage(format!("serialize poll stats: {error}")))?;
        sync_state
            .set_poll_stats_json(&self.server_id, &self.library_scope, &value)
            .map_err(SyncError::Storage)
    }

    pub(super) fn check_cancellation(&self) -> Result<(), SyncError> {
        if let Some(flag) = &self.cancel {
            if flag.load(Ordering::SeqCst) {
                return Err(SyncError::Cancelled);
            }
        }
        Ok(())
    }

    pub(super) fn library_scope_opt(&self) -> Option<&str> {
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

    pub(super) fn ensure_resync_generation(
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
            || TrackRepository::new(self.store)
                .has_live_tracks_in_scope(&self.server_id, &self.library_scope)
                .map_err(SyncError::Storage)?;
        if !is_resync {
            return Ok(());
        }
        let gen = TrackRepository::new(self.store)
            .next_resync_gen(&self.server_id, &self.library_scope)
            .map_err(SyncError::Storage)?;
        cursor.resync_gen = Some(gen);
        self.persist_cursor(sync_state, cursor)?;
        Ok(())
    }

    fn write_batch_timed(
        &self,
        rows: &[TrackRow],
        resync_gen: Option<i64>,
        sparse_payload: bool,
    ) -> Result<WriteOpTiming, SyncError> {
        let tracks = TrackRepository::new(self.store);
        if sparse_payload {
            tracks
                .upsert_sparse_batch_initial_ingest_timed(rows, resync_gen)
                .map_err(SyncError::Storage)
        } else {
            tracks
                .upsert_batch_initial_ingest_timed(rows, resync_gen)
                .map_err(SyncError::Storage)
        }
    }

    pub(super) fn write_batch_logged(
        &self,
        rows: &[TrackRow],
        label: &str,
        offset: u32,
        resync_gen: Option<i64>,
        sparse_payload: bool,
    ) -> Result<(RemapStats, WriteOpTiming), SyncError> {
        let timing = self.write_batch_timed(rows, resync_gen, sparse_payload)?;
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

    pub(super) fn link_canonical_after_bulk_ingest(&self) -> Result<(), SyncError> {
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
}

fn is_empty_cursor(v: &Value) -> bool {
    matches!(v, Value::Object(o) if o.is_empty())
}

/// Wrap an async closure in §6.8 backoff. Retries on `SyncError::Transport`
/// up to `MAX_ATTEMPTS_PER_BATCH`, sleeping per the backoff schedule
/// (skipped when `sleep_enabled` is false — test path).
/// Cancellation is checked between attempts.
pub(super) async fn retry_with_backoff<'a, F, FFut, T, E>(
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
    matches!(e, SyncError::Transport(_) | SyncError::Navidrome(_))
}

/// A persistent fetch failure (network / HTTP / decode / API) that warrants
/// switching ingest strategy (Q8 S1→S2). Cancellation is user intent and
/// storage is a local problem a strategy switch can't fix — both propagate.
pub(super) fn is_fetch_failure(e: &SyncError) -> bool {
    matches!(
        e,
        SyncError::Transport(_)
            | SyncError::Subsonic { .. }
            | SyncError::Navidrome(_)
            | SyncError::NotFound
    )
}

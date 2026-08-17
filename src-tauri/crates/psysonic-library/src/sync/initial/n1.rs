use psysonic_integration::navidrome::queries::nd_list_songs_internal;
use serde_json::Value;

use super::common::{retry_with_backoff, CURSOR_PERSIST_EVERY_BATCHES};
use super::runner::{IngestPageCtx, InitialSyncReport, InitialSyncRunner};
use crate::repos::{SyncStateRepository, TrackRow};
use crate::sync::capability::NavidromeProbeCredentials;
use crate::sync::cursor::{InitialSyncCursor, StrategyState};
use crate::sync::error::SyncError;
use crate::sync::ingest_parallel::{
    check_cancel_flag, linear_prefetch_depth, retry_fetch, sleep_request_gap,
    wait_while_bulk_paused, LinearPrefetchQueue,
};
use crate::sync::mapping::navidrome_song_to_track_row;
use crate::sync::now_unix_ms;
use crate::sync::progress::ProgressEvent;
use crate::sync::strategy::IngestStrategy;

impl InitialSyncRunner<'_> {
    // ── N1 (Navidrome native /api/song) ────────────────────────────────

    pub(super) async fn run_n1(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let creds = self.navidrome.as_ref().ok_or_else(|| {
            SyncError::Transport(
                "n1 strategy selected but no Navidrome credentials supplied".into(),
            )
        })?;
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
        let http_registry = self.http_registry.clone();
        let server_id = self.server_id.clone();
        let mut queue = LinearPrefetchQueue::new(&budget, batch_size, offset);

        loop {
            wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation())
                .await?;
            self.check_cancellation()?;

            queue.pump(
                || self.check_cancellation(),
                |off| {
                    let creds = creds.clone();
                    let cancel = cancel.clone();
                    let http_registry = http_registry.clone();
                    let server_id = server_id.clone();
                    tokio::spawn(async move {
                        retry_fetch(
                            sleep_enabled,
                            || check_cancel_flag(&cancel),
                            || async {
                                let end = off.saturating_add(batch_size);
                                let response = nd_list_songs_internal(
                                    http_registry.as_deref(),
                                    Some(&server_id),
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
                },
            )?;

            let array = match queue.take_at(offset, || self.check_cancellation()).await {
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
                    self.http_registry.as_deref(),
                    Some(&self.server_id),
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
                navidrome_song_to_track_row(&self.server_id, v, synced_at, self.library_scope_opt())
            })
            .collect();
        let (_stats, _timing) =
            self.write_batch_logged(&rows, "N1", offset, ctx.cursor.resync_gen, false)?;
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
        let resync_gen = cursor.resync_gen;
        *cursor = InitialSyncCursor::fresh(IngestStrategy::S1, scope);
        cursor.resync_gen = resync_gen;
        report.ingested_count = 0;
        report.strategy = Some(cursor.strategy.clone());
        self.persist_cursor(sync_state, cursor)?;
        self.run_s1(cursor, report, sync_state).await
    }
}

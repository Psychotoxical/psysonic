use std::collections::HashSet;

use serde_json::Value;

use super::common::{is_fetch_failure, retry_with_backoff, CURSOR_PERSIST_EVERY_BATCHES};
use super::runner::{IngestPageCtx, InitialSyncReport, InitialSyncRunner};
use crate::repos::{SyncStateRepository, TrackRow};
use crate::sync::cursor::{InitialSyncCursor, StrategyState};
use crate::sync::error::SyncError;
use crate::sync::ingest_parallel::{
    check_cancel_flag, linear_prefetch_depth, retry_fetch, sleep_request_gap,
    wait_while_bulk_paused, LinearPrefetchQueue,
};
use crate::sync::mapping::{sparse_song_raw_fallback, subsonic_song_to_track_row};
use crate::sync::now_unix_ms;
use crate::sync::progress::{IngestBatchMetrics, ProgressEvent};
use crate::sync::strategy::IngestStrategy;

impl InitialSyncRunner<'_> {
    // ── S1 (Subsonic search3 empty query) ──────────────────────────────

    pub(super) async fn run_s1(
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
        // Learn the server's effective page size before creating a fixed-step
        // prefetch queue. Some Subsonic servers clamp `songCount`; treating a
        // clamped first page as EOF or advancing by the requested size skips a
        // contiguous range of songs.
        wait_while_bulk_paused(&budget, self.sleep_enabled, || self.check_cancellation()).await?;
        self.check_cancellation()?;
        sleep_request_gap(&budget, self.sleep_enabled).await;
        let fetch_start = std::time::Instant::now();
        let (first_result, first_raw_body) = match self.fetch_s1_page(offset).await {
            Err(e) if is_fetch_failure(&e) => {
                return self.fall_back_s1_to_s2(cursor, report, sync_state).await;
            }
            other => other?,
        };
        if first_result.song.is_empty() {
            self.persist_cursor(sync_state, cursor)?;
            return Ok(());
        }
        let first_page_size = first_result.song.len() as u32;
        let mut seen_song_ids: HashSet<String> = first_result
            .song
            .iter()
            .map(|song| song.id.clone())
            .collect();
        offset = self
            .ingest_s1_page(
                &first_result,
                &first_raw_body,
                offset,
                fetch_start.elapsed().as_millis() as u32,
                &mut IngestPageCtx {
                    cursor,
                    report,
                    sync_state,
                    batch_count: &mut batch_count,
                    force_persist: false,
                },
            )
            .await?;

        if prefetch <= 1 || first_page_size < self.batch_size {
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
                let mut page_advanced = false;
                for song in &result.song {
                    page_advanced |= seen_song_ids.insert(song.id.clone());
                }
                if !page_advanced {
                    return self.fall_back_s1_to_s2(cursor, report, sync_state).await;
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
                            force_persist: false,
                        },
                    )
                    .await?;
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

            queue.pump(
                || self.check_cancellation(),
                |off| {
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
                },
            )?;

            let fetch_start = std::time::Instant::now();
            let (result, raw_body) = match queue.take_at(offset, || self.check_cancellation()).await
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
            let mut page_advanced = false;
            for song in &result.song {
                page_advanced |= seen_song_ids.insert(song.id.clone());
            }
            if !page_advanced {
                return self.fall_back_s1_to_s2(cursor, report, sync_state).await;
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
            || {
                self.subsonic
                    .search3_with_raw("", self.batch_size, offset, scope)
            },
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
                .unwrap_or_else(|| sparse_song_raw_fallback(song));
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
            self.write_batch_logged(&rows, "S1", offset, ctx.cursor.resync_gen, true)?;
        ctx.report.ingested_count = ctx.report.ingested_count.saturating_add(row_count);

        let next_offset = offset.saturating_add(row_count);
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
        let resync_gen = cursor.resync_gen;
        *cursor = InitialSyncCursor::fresh(IngestStrategy::S2, scope);
        cursor.resync_gen = resync_gen;
        report.ingested_count = 0;
        report.strategy = Some(cursor.strategy.clone());
        self.persist_cursor(sync_state, cursor)?;
        self.run_s2(cursor, report, sync_state).await
    }
}

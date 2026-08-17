use std::collections::HashSet;

use super::common::retry_with_backoff;
use super::runner::{InitialSyncReport, InitialSyncRunner};
use crate::repos::{SyncStateRepository, TrackRow};
use crate::sync::cursor::{InitialSyncCursor, StrategyState};
use crate::sync::error::SyncError;
use crate::sync::ingest_parallel::{
    fetch_albums_parallel, next_album_list_offset, sleep_request_gap, wait_while_bulk_paused,
    ParallelAlbumFetchOpts,
};
use crate::sync::now_unix_ms;
use crate::sync::progress::ProgressEvent;
use crate::sync::{album_metadata, mapping};

impl InitialSyncRunner<'_> {
    // ── S2 (album crawl: getAlbumList2 + getAlbum) ─────────────────────

    pub(super) async fn run_s2(
        &self,
        cursor: &mut InitialSyncCursor,
        report: &mut InitialSyncReport,
        sync_state: &SyncStateRepository<'_>,
    ) -> Result<(), SyncError> {
        let (mut album_offset, resume_album_id) = match &cursor.strategy_state {
            StrategyState::AlbumCrawl {
                album_offset,
                current_album_id,
            } => (*album_offset, current_album_id.clone()),
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
        let mut seen_album_ids = HashSet::new();

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
            let mut page_advanced = false;
            for album in &albums {
                page_advanced |= seen_album_ids.insert(album.id.clone());
            }
            if !page_advanced {
                return Err(SyncError::Transport(format!(
                    "S2 album list did not advance at offset {album_offset}"
                )));
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
                album_metadata::upsert_album_from_get_album(
                    self.store,
                    &self.server_id,
                    &album,
                    &raw_album,
                    synced_at,
                )?;
                let rows: Vec<TrackRow> = mapping::album_track_rows(
                    &self.server_id,
                    &album,
                    &raw_album,
                    synced_at,
                    self.library_scope_opt(),
                );
                if !rows.is_empty() {
                    let (_stats, _timing) = self.write_batch_logged(
                        &rows,
                        "S2",
                        album_offset,
                        cursor.resync_gen,
                        false,
                    )?;
                    report.ingested_count = report.ingested_count.saturating_add(rows.len() as u32);
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

            album_offset =
                next_album_list_offset(album_offset, albums.len()).unwrap_or(album_offset);
            cursor.strategy_state = StrategyState::AlbumCrawl {
                album_offset,
                current_album_id: None,
            };
            cursor.ingested_count = report.ingested_count;
            self.persist_cursor(sync_state, cursor)?;
        }
        Ok(())
    }
}

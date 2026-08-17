use std::collections::HashSet;

use psysonic_integration::navidrome::queries::nd_list_songs_internal;

use super::{
    retry_with_backoff, DeltaSyncReport, DeltaSyncRunner, SyncError, S2_DELTA_MAX_PAGES_PER_TYPE,
};
use crate::repos::TrackRow;
use crate::sync::ingest_parallel::next_album_list_offset;
use crate::sync::mapping::navidrome_song_to_track_row;
use crate::sync::now_unix_ms;

impl DeltaSyncRunner<'_> {
    pub(super) async fn run_n1_delta(&self, report: &mut DeltaSyncReport) -> Result<(), SyncError> {
        let creds = self.navidrome.as_ref().ok_or_else(|| {
            SyncError::Transport("n1-delta selected but no Navidrome credentials supplied".into())
        })?;
        let watermark = self.local_track_updated_watermark()?;

        let mut offset: u32 = 0;
        loop {
            self.check_cancellation()?;
            let end = offset.saturating_add(self.batch_size);
            let response = retry_with_backoff(
                self,
                || {
                    nd_list_songs_internal(
                        self.http_registry.as_deref(),
                        Some(&self.server_id),
                        &creds.server_url,
                        &creds.bearer_token,
                        "updated_at",
                        "DESC",
                        offset,
                        end,
                    )
                },
                SyncError::Navidrome,
            )
            .await?;

            let array = response.as_array().cloned().unwrap_or_default();
            if array.is_empty() {
                break;
            }
            let synced_at = now_unix_ms();
            let mut rows: Vec<TrackRow> = Vec::with_capacity(array.len());
            let mut crossed_watermark = false;
            for value in &array {
                if let Some(row) = navidrome_song_to_track_row(
                    &self.server_id,
                    value,
                    synced_at,
                    self.library_scope_opt(),
                ) {
                    if let (Some(watermark), Some(server_updated)) =
                        (watermark, row.server_updated_at)
                    {
                        if server_updated < watermark {
                            crossed_watermark = true;
                            continue;
                        }
                    }
                    rows.push(row);
                }
            }
            if !rows.is_empty() {
                let (changed, remapped) = self.write_batch(&rows)?;
                report.changed_count = report.changed_count.saturating_add(changed);
                report.remapped_count = report.remapped_count.saturating_add(remapped);
            }
            if crossed_watermark || (array.len() as u32) < self.batch_size {
                break;
            }
            offset = end;
        }
        Ok(())
    }

    pub(super) async fn run_s2_delta(&self, report: &mut DeltaSyncReport) -> Result<(), SyncError> {
        let scope = self.library_scope_opt();
        let mut seen_albums: HashSet<String> = HashSet::new();
        for list_type in ["newest", "recent"] {
            let mut offset: u32 = 0;
            for _ in 0..S2_DELTA_MAX_PAGES_PER_TYPE {
                self.check_cancellation()?;
                let page = retry_with_backoff(
                    self,
                    || {
                        self.subsonic
                            .get_album_list2(list_type, self.batch_size, offset, scope)
                    },
                    SyncError::from,
                )
                .await?;
                if page.is_empty() {
                    break;
                }
                let page_len = page.len() as u32;
                for album_summary in page {
                    if !seen_albums.insert(album_summary.id.clone()) {
                        continue;
                    }
                    self.check_cancellation()?;
                    let (album, raw_album) = retry_with_backoff(
                        self,
                        || self.subsonic.get_album_with_raw(&album_summary.id),
                        SyncError::from,
                    )
                    .await?;
                    let synced_at = now_unix_ms();
                    crate::sync::album_metadata::upsert_album_from_get_album(
                        self.store,
                        &self.server_id,
                        &album,
                        &raw_album,
                        synced_at,
                    )?;
                    let rows = crate::sync::mapping::album_track_rows(
                        &self.server_id,
                        &album,
                        &raw_album,
                        synced_at,
                        self.library_scope_opt(),
                    );
                    if !rows.is_empty() {
                        let (changed, remapped) = self.write_batch(&rows)?;
                        report.changed_count = report.changed_count.saturating_add(changed);
                        report.remapped_count = report.remapped_count.saturating_add(remapped);
                    }
                }
                offset = next_album_list_offset(offset, page_len as usize).unwrap_or(offset);
            }
        }
        Ok(())
    }
}

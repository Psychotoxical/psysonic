//! Advanced analytics strategy — batch-select library tracks that still need
//! waveform / loudness / enrichment work (spec: Settings → Library).

use psysonic_core::ports::TrackAnalysisNeedsWorkQuery;
use tauri::{AppHandle, Manager};

use crate::repos::TrackRepository;
use crate::runtime::LibraryRuntime;

const SCAN_CHUNK: usize = 500;
const MAX_SCAN_IDS_PER_CALL: usize = 10_000;
const DEFAULT_BATCH: u32 = 20;
const MAX_BATCH: u32 = 50;
const PROGRESS_SCAN_CHUNK: usize = 1000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnalysisBackfillBatchDto {
    pub track_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub exhausted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAnalysisProgressDto {
    pub total_tracks: i64,
    pub pending_tracks: i64,
    pub done_tracks: i64,
}

enum ScanMode {
    Candidates,
    /// Tracks with hash + BPM that may still need waveform/LUFS/enrichment gaps.
    HashBpmGaps,
}

fn begin_hash_bpm_gap_scan() -> (ScanMode, Option<String>) {
    (ScanMode::HashBpmGaps, None)
}

pub fn collect_analysis_backfill_batch(
    app: &AppHandle,
    runtime: &LibraryRuntime,
    server_id: &str,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<LibraryAnalysisBackfillBatchDto, String> {
    let want = limit.unwrap_or(DEFAULT_BATCH).min(MAX_BATCH) as usize;
    let needs_work = app
        .try_state::<TrackAnalysisNeedsWorkQuery>()
        .ok_or_else(|| "TrackAnalysisNeedsWorkQuery not registered".to_string())?;

    let repo = TrackRepository::new(&runtime.store);
    let mut found = Vec::with_capacity(want);
    let mut after = cursor.map(str::to_string);
    let mut mode = ScanMode::Candidates;
    let mut scanned = 0usize;

    while found.len() < want && scanned < MAX_SCAN_IDS_PER_CALL {
        let page = match mode {
            ScanMode::Candidates => {
                repo.list_analysis_candidate_ids_after(server_id, after.as_deref(), SCAN_CHUNK)?
            }
            ScanMode::HashBpmGaps => {
                repo.list_analysis_hash_bpm_ids_after(server_id, after.as_deref(), SCAN_CHUNK)?
            }
        };

        if page.is_empty() {
            match mode {
                ScanMode::Candidates => {
                    (mode, after) = begin_hash_bpm_gap_scan();
                    continue;
                }
                ScanMode::HashBpmGaps => {
                    return Ok(LibraryAnalysisBackfillBatchDto {
                        track_ids: found,
                        next_cursor: after,
                        exhausted: true,
                    });
                }
            }
        }

        let page_len = page.len();
        for id in page {
            scanned += 1;
            after = Some(id.clone());
            if needs_work.needs_work(server_id, &id)? {
                found.push(id);
                if found.len() >= want {
                    break;
                }
            }
            if scanned >= MAX_SCAN_IDS_PER_CALL {
                break;
            }
        }

        if found.len() >= want || scanned >= MAX_SCAN_IDS_PER_CALL {
            break;
        }

        if page_len < SCAN_CHUNK {
            match mode {
                ScanMode::Candidates => {
                    (mode, after) = begin_hash_bpm_gap_scan();
                }
                ScanMode::HashBpmGaps => {
                    return Ok(LibraryAnalysisBackfillBatchDto {
                        track_ids: found,
                        next_cursor: after,
                        exhausted: true,
                    });
                }
            }
        }
    }

    Ok(LibraryAnalysisBackfillBatchDto {
        track_ids: found,
        next_cursor: after,
        exhausted: false,
    })
}

pub fn collect_analysis_progress(
    app: &AppHandle,
    runtime: &LibraryRuntime,
    server_id: &str,
) -> Result<LibraryAnalysisProgressDto, String> {
    let needs_work = app
        .try_state::<TrackAnalysisNeedsWorkQuery>()
        .ok_or_else(|| "TrackAnalysisNeedsWorkQuery not registered".to_string())?;

    let repo = TrackRepository::new(&runtime.store);
    let total = repo.count_live_tracks(server_id)?;
    if total <= 0 {
        return Ok(LibraryAnalysisProgressDto {
            total_tracks: 0,
            pending_tracks: 0,
            done_tracks: 0,
        });
    }

    let mut pending: i64 = 0;
    let mut after: Option<String> = None;
    loop {
        let page = repo.list_track_ids_after(
            server_id,
            after.as_deref(),
            PROGRESS_SCAN_CHUNK,
        )?;
        if page.is_empty() {
            break;
        }
        for id in page {
            after = Some(id.clone());
            if needs_work.needs_work(server_id, &id)? {
                pending += 1;
            }
        }
    }

    let done = total.saturating_sub(pending);
    Ok(LibraryAnalysisProgressDto {
        total_tracks: total,
        pending_tracks: pending,
        done_tracks: done,
    })
}

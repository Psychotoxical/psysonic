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

/// Persisted across native coordinator ticks (see `library_analysis_backfill` worker).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisBackfillScanPhase {
    #[default]
    Candidates,
    /// Tracks with hash + BPM that may still need waveform/LUFS/enrichment gaps.
    HashBpmGaps,
}

enum ScanMode {
    Candidates,
    HashBpmGaps,
}

impl From<AnalysisBackfillScanPhase> for ScanMode {
    fn from(p: AnalysisBackfillScanPhase) -> Self {
        match p {
            AnalysisBackfillScanPhase::Candidates => ScanMode::Candidates,
            AnalysisBackfillScanPhase::HashBpmGaps => ScanMode::HashBpmGaps,
        }
    }
}

impl From<ScanMode> for AnalysisBackfillScanPhase {
    fn from(m: ScanMode) -> Self {
        match m {
            ScanMode::Candidates => AnalysisBackfillScanPhase::Candidates,
            ScanMode::HashBpmGaps => AnalysisBackfillScanPhase::HashBpmGaps,
        }
    }
}

/// End of the cheap candidate SQL pass — start hash/BPM gap scan from the first id.
fn begin_hash_bpm_gap_scan_from_start() -> (ScanMode, Option<String>) {
    (ScanMode::HashBpmGaps, None)
}

/// Candidate page empty only because `id > cursor`; continue the id walk in hash/BPM phase.
fn begin_hash_bpm_gap_scan_from_cursor(cursor: String) -> (ScanMode, Option<String>) {
    (ScanMode::HashBpmGaps, Some(cursor))
}

fn advance_after_empty_candidate_page(after: Option<String>) -> (ScanMode, Option<String>) {
    match after {
        None => begin_hash_bpm_gap_scan_from_start(),
        Some(cursor) => begin_hash_bpm_gap_scan_from_cursor(cursor),
    }
}

pub fn collect_analysis_backfill_batch(
    app: &AppHandle,
    runtime: &LibraryRuntime,
    server_id: &str,
    phase: AnalysisBackfillScanPhase,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<(LibraryAnalysisBackfillBatchDto, AnalysisBackfillScanPhase), String> {
    let want = limit.unwrap_or(DEFAULT_BATCH).min(MAX_BATCH) as usize;
    let needs_work = app
        .try_state::<TrackAnalysisNeedsWorkQuery>()
        .ok_or_else(|| "TrackAnalysisNeedsWorkQuery not registered".to_string())?;

    let repo = TrackRepository::new(&runtime.store);
    let mut found = Vec::with_capacity(want);
    let mut after = cursor.map(str::to_string);
    let mut mode = ScanMode::from(phase);
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
                    (mode, after) = advance_after_empty_candidate_page(after);
                    continue;
                }
                ScanMode::HashBpmGaps => {
                    let dto = LibraryAnalysisBackfillBatchDto {
                        track_ids: found,
                        next_cursor: after,
                        exhausted: true,
                    };
                    return Ok((dto, AnalysisBackfillScanPhase::HashBpmGaps));
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
                    (mode, after) = begin_hash_bpm_gap_scan_from_start();
                }
                ScanMode::HashBpmGaps => {
                    let dto = LibraryAnalysisBackfillBatchDto {
                        track_ids: found,
                        next_cursor: after,
                        exhausted: true,
                    };
                    return Ok((dto, AnalysisBackfillScanPhase::HashBpmGaps));
                }
            }
        }
    }

    let dto = LibraryAnalysisBackfillBatchDto {
        track_ids: found,
        next_cursor: after,
        exhausted: false,
    };
    Ok((dto, ScanMode::into(mode)))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_candidate_page_with_cursor_keeps_id_walk() {
        let (mode, after) = advance_after_empty_candidate_page(Some("track-z".to_string()));
        assert!(matches!(mode, ScanMode::HashBpmGaps));
        assert_eq!(after.as_deref(), Some("track-z"));
    }

    #[test]
    fn empty_candidate_page_without_cursor_starts_gap_scan_at_beginning() {
        let (mode, after) = advance_after_empty_candidate_page(None);
        assert!(matches!(mode, ScanMode::HashBpmGaps));
        assert!(after.is_none());
    }

    #[test]
    fn finished_candidate_phase_resets_gap_scan_cursor() {
        let (mode, after) = begin_hash_bpm_gap_scan_from_start();
        assert!(matches!(mode, ScanMode::HashBpmGaps));
        assert!(after.is_none());
    }
}

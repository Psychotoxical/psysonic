use std::io::Read;
use std::path::PathBuf;

use tauri::AppHandle;

use psysonic_analysis::analysis_runtime::AnalysisBackfillPriority;

use crate::stream::AnalysisSeedHoldGuard;

use super::{
    dispatch_track_analysis_bytes, generation_guard_allows_analysis, max_bytes_for_dispatch,
    GenerationGuard, PreparedTrackAnalysisFile, TrackAnalysisDispatchOptions, TrackAnalysisOrigin,
};

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_track_analysis_file(
    app: AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: String,
    track_id: String,
    file_path: PathBuf,
    // URL the file's bytes came from when it is a SPILLED/CAPTURED HTTP
    // stream (None for genuine local library files). Spilled bytes carry the
    // same provenance requirements as the live stream they came from.
    stream_url: Option<String>,
    priority: AnalysisBackfillPriority,
    generation_guard: Option<GenerationGuard>,
    analysis_seed_hold: Option<AnalysisSeedHoldGuard>,
) {
    if track_id.trim().is_empty() {
        return;
    }
    if !generation_guard_allows_analysis(origin, generation_guard.as_ref()) {
        return;
    }
    let Some(prepared_file) = prepare_track_analysis_file(origin, &track_id, &file_path) else {
        return;
    };
    spawn_track_analysis_prepared_file(
        app,
        origin,
        server_id,
        track_id,
        prepared_file,
        stream_url,
        priority,
        generation_guard,
        analysis_seed_hold,
    );
}

pub(crate) fn prepare_track_analysis_file(
    origin: TrackAnalysisOrigin,
    track_id: &str,
    file_path: &std::path::Path,
) -> Option<PreparedTrackAnalysisFile> {
    let max = max_bytes_for_dispatch(origin);
    let file = match std::fs::File::open(file_path) {
        Ok(file) => file,
        Err(error) => {
            crate::app_eprintln!(
                "[analysis][dispatch] open file failed origin={origin:?} track_id={track_id}: {error}"
            );
            return None;
        }
    };
    let file_len = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            crate::app_eprintln!(
                "[analysis][dispatch] file metadata failed origin={origin:?} track_id={track_id}: {error}"
            );
            return None;
        }
    };
    if file_len > max as u64 {
        crate::app_deprintln!(
            "[analysis][dispatch] skip file origin={origin:?} track_id={track_id} bytes={file_len} max={max}"
        );
        return None;
    }
    Some(PreparedTrackAnalysisFile { file, file_len })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_track_analysis_prepared_file(
    app: AppHandle,
    origin: TrackAnalysisOrigin,
    server_id: String,
    track_id: String,
    prepared_file: PreparedTrackAnalysisFile,
    stream_url: Option<String>,
    priority: AnalysisBackfillPriority,
    generation_guard: Option<GenerationGuard>,
    analysis_seed_hold: Option<AnalysisSeedHoldGuard>,
) {
    let PreparedTrackAnalysisFile { file, file_len } = prepared_file;
    tokio::spawn(async move {
        let _analysis_seed_hold = analysis_seed_hold;
        if !generation_guard_allows_analysis(origin, generation_guard.as_ref()) {
            return;
        }
        let bytes = match tokio::task::spawn_blocking(move || {
            let mut file = file;
            let mut bytes = Vec::with_capacity(file_len as usize);
            file.read_to_end(&mut bytes)
                .map(|_| bytes)
                .map_err(|error| error.to_string())
        })
        .await
        {
            Ok(Ok(bytes)) if !bytes.is_empty() => bytes,
            Ok(Ok(_)) => return,
            Ok(Err(error)) => {
                crate::app_eprintln!(
                    "[analysis][dispatch] file read failed origin={origin:?} track_id={track_id}: {error}"
                );
                return;
            }
            Err(error) => {
                crate::app_eprintln!(
                    "[analysis][dispatch] file read task failed origin={origin:?} track_id={track_id}: {error}"
                );
                return;
            }
        };
        if !generation_guard_allows_analysis(origin, generation_guard.as_ref()) {
            return;
        }
        match dispatch_track_analysis_bytes(
            &app,
            origin,
            &server_id,
            &track_id,
            bytes,
            stream_url.as_deref(),
            TrackAnalysisDispatchOptions {
                priority,
                generation_guard: generation_guard.as_ref(),
            },
        )
        .await
        {
            Ok(_) => {}
            Err(e) => {
                crate::app_eprintln!(
                    "[analysis][dispatch] file failed origin={origin:?} track_id={track_id}: {e}"
                );
            }
        }
    });
}

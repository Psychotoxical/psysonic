use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, State};

use crate::analysis_dispatch::{
    prepare_track_analysis_file, PreparedTrackAnalysisFile, TrackAnalysisOrigin,
};
use crate::engine::AudioEngine;
use crate::helpers::{fetch_http_data, same_playback_target, write_stream_spill_file};
use crate::state::{PreloadedTrack, StreamCompletedSpill};
use crate::stream::{
    AnalysisSeedHoldGuard, StreamDownloadControl, TRACK_READ_TIMEOUT_SECS,
    TRACK_STREAM_PROMOTE_MAX_BYTES,
};

pub(super) struct FallbackBytes {
    pub(super) data: Vec<u8>,
    pub(super) consumed_spill_path: Option<PathBuf>,
}

pub(super) enum PublishedFallbackLocation {
    Memory,
    Spill {
        path: PathBuf,
        analysis_file: Option<PreparedTrackAnalysisFile>,
    },
    Uncached,
}

pub(super) enum FallbackPublication {
    Published(PublishedFallbackLocation),
    StaleSpill(PublishedFallbackLocation),
    Stale,
}

pub(super) enum FallbackAnalysisDispatch {
    Bytes,
    File(Option<PreparedTrackAnalysisFile>),
}

pub(super) struct FallbackAnalysisContext {
    pub(super) server_id: String,
    pub(super) track_id: String,
    pub(super) priority: psysonic_analysis::analysis_runtime::AnalysisBackfillPriority,
    pub(super) seed_hold: Option<AnalysisSeedHoldGuard>,
}

pub(super) fn fallback_analysis_dispatch(
    location: PublishedFallbackLocation,
) -> FallbackAnalysisDispatch {
    match location {
        PublishedFallbackLocation::Spill { analysis_file, .. } => {
            FallbackAnalysisDispatch::File(analysis_file)
        }
        PublishedFallbackLocation::Memory | PublishedFallbackLocation::Uncached => {
            FallbackAnalysisDispatch::Bytes
        }
    }
}

pub(super) fn stale_fallback_spill_should_unlink(
    candidate: &Path,
    source_spill_path: Option<&Path>,
) -> bool {
    source_spill_path != Some(candidate)
}

pub(super) struct AnalysisSelectionGuard {
    download_control: Option<Arc<StreamDownloadControl>>,
}

impl AnalysisSelectionGuard {
    pub(super) fn new(download_control: Option<Arc<StreamDownloadControl>>) -> Self {
        Self { download_control }
    }

    pub(super) fn select_fallback(&self) -> bool {
        self.download_control
            .as_ref()
            .is_some_and(|control| control.select_fallback_analysis())
    }
}

impl Drop for AnalysisSelectionGuard {
    fn drop(&mut self) {
        if let Some(download_control) = self.download_control.as_ref() {
            download_control.select_downloader_analysis();
        }
    }
}

pub(super) fn publish_validated_fallback_bytes(
    state: &AudioEngine,
    app: &AppHandle,
    url: &str,
    track_id: Option<&str>,
    gen: u64,
    data: &[u8],
    source_spill_path: Option<&Path>,
) -> FallbackPublication {
    let source_spill_path = source_spill_path.map(Path::to_path_buf);
    let candidate_spill = if data.len() > TRACK_STREAM_PROMOTE_MAX_BYTES {
        if let Some(path) = source_spill_path.clone() {
            Some(path)
        } else {
            let Some(track_id) = track_id.map(str::trim).filter(|id| !id.is_empty()) else {
                return if state.generation.load(Ordering::SeqCst) == gen {
                    FallbackPublication::Published(PublishedFallbackLocation::Uncached)
                } else {
                    FallbackPublication::Stale
                };
            };
            match write_stream_spill_file(app, &format!("{track_id}-fallback-{gen}"), data) {
                Ok(path) => Some(path),
                Err(e) => {
                    crate::app_eprintln!(
                        "[stream] validated fallback spill failed track_id={track_id}: {e}"
                    );
                    return if state.generation.load(Ordering::SeqCst) == gen {
                        FallbackPublication::Published(PublishedFallbackLocation::Uncached)
                    } else {
                        FallbackPublication::Stale
                    };
                }
            }
        }
    } else {
        None
    };
    let prepared_analysis_file = candidate_spill.as_ref().and_then(|path| {
        track_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .and_then(|track_id| {
                prepare_track_analysis_file(TrackAnalysisOrigin::StreamSpillFile, track_id, path)
            })
    });

    let mut cache = state.stream_completed_cache.lock().unwrap();
    let mut spill = state.stream_completed_spill.lock().unwrap();
    if state.generation.load(Ordering::SeqCst) != gen {
        drop(spill);
        drop(cache);
        if let Some(path) = candidate_spill {
            let analysis_path = path.clone();
            if stale_fallback_spill_should_unlink(&path, source_spill_path.as_deref()) {
                let _ = std::fs::remove_file(&path);
            }
            return FallbackPublication::StaleSpill(PublishedFallbackLocation::Spill {
                path: analysis_path,
                analysis_file: prepared_analysis_file,
            });
        }
        return FallbackPublication::Stale;
    }
    let old_spill = spill.take().map(|entry| entry.path);
    let location = if let Some(path) = candidate_spill {
        let analysis_path = path.clone();
        *cache = None;
        *spill = Some(StreamCompletedSpill {
            url: url.to_string(),
            path,
        });
        PublishedFallbackLocation::Spill {
            path: analysis_path,
            analysis_file: prepared_analysis_file,
        }
    } else {
        *cache = Some(PreloadedTrack {
            url: url.to_string(),
            data: data.to_vec(),
        });
        PublishedFallbackLocation::Memory
    };
    drop(spill);
    drop(cache);
    let retained_spill = match &location {
        PublishedFallbackLocation::Spill { path, .. } => Some(path),
        PublishedFallbackLocation::Memory | PublishedFallbackLocation::Uncached => None,
    };
    for path in old_spill.into_iter().chain(source_spill_path) {
        if retained_spill != Some(&path) {
            let _ = std::fs::remove_file(path);
        }
    }
    FallbackPublication::Published(location)
}

pub(super) fn is_stream_probe_failure_with_full_buffer_retry(
    err: &str,
    format_hint: Option<&str>,
) -> bool {
    let probe_failed = err.contains("format probe failed")
        || err.contains("format probe timed out")
        || err.contains("end of stream");
    let ranged_failure =
        err.contains("ranged-stream") && (probe_failed || err.contains("moov metadata"));
    let legacy_aiff_failure = err.contains("track-stream")
        && probe_failed
        && (crate::stream::container_hint_is_aiff(format_hint) || err.contains("aiff:"));
    ranged_failure || legacy_aiff_failure
}

async fn try_read_completed_stream_bytes(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
) -> Option<FallbackBytes> {
    let ram = {
        let guard = state.stream_completed_cache.lock().unwrap();
        if state.generation.load(Ordering::SeqCst) == gen
            && guard
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, url))
        {
            guard.as_ref().map(|p| p.data.clone())
        } else {
            None
        }
    };
    if let Some(data) = ram {
        return Some(FallbackBytes {
            data,
            consumed_spill_path: None,
        });
    }
    let spill_source = {
        let guard = state.stream_completed_spill.lock().unwrap();
        if state.generation.load(Ordering::SeqCst) == gen
            && guard
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, url))
        {
            guard.as_ref().and_then(|p| {
                std::fs::File::open(&p.path)
                    .ok()
                    .map(|file| (p.path.clone(), file))
            })
        } else {
            None
        }
    };
    if let Some((path, mut file)) = spill_source {
        let data = tokio::task::spawn_blocking(move || {
            let mut data = Vec::new();
            file.read_to_end(&mut data).map(|_| data)
        })
        .await
        .ok()?
        .ok()?;
        if !data.is_empty() {
            return Some(FallbackBytes {
                data,
                consumed_spill_path: Some(path),
            });
        }
    }
    None
}

async fn prefer_clean_http_bytes_for_fallback(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
    fallback: FallbackBytes,
    format_hint: Option<&str>,
    label: &str,
) -> Result<Option<FallbackBytes>, String> {
    let is_mp4 = crate::stream::container_hint_is_mp4(format_hint);
    if is_mp4 {
        crate::stream::log_isobmff_buffer_diagnostic(&fallback.data, format_hint, label);
        if !crate::stream::isobmff_buffer_looks_complete(&fallback.data)
            || crate::stream::mp4_suspect_zero_holes(&fallback.data)
        {
            crate::app_deprintln!(
                "[stream] ranged buffer looks incomplete or holey — refetching via sequential HTTP"
            );
            let Some(fresh) = fetch_http_data(url, state, gen, app).await? else {
                return Ok(None);
            };
            if !crate::stream::isobmff_buffer_looks_complete(&fresh) {
                crate::stream::log_isobmff_buffer_diagnostic(&fresh, format_hint, "http-refetch");
            }
            return Ok(Some(FallbackBytes {
                data: fresh,
                consumed_spill_path: fallback.consumed_spill_path,
            }));
        }
    }
    Ok(Some(fallback))
}

pub(super) async fn wait_or_fetch_bytes_for_stream_fallback(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
    format_hint: Option<&str>,
    download_control: &StreamDownloadControl,
) -> Result<Option<FallbackBytes>, String> {
    let deadline = Instant::now() + Duration::from_secs(TRACK_READ_TIMEOUT_SECS);
    loop {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None);
        }
        if let Some(data) = try_read_completed_stream_bytes(url, gen, state).await {
            crate::app_deprintln!(
                "[stream] full-buffer fallback: using completed download ({} KiB)",
                data.data.len() / 1024
            );
            return prefer_clean_http_bytes_for_fallback(
                url,
                gen,
                state,
                app,
                data,
                format_hint,
                "ranged-cache",
            )
            .await;
        }
        if download_control.ended_without_reusable_bytes() {
            crate::app_deprintln!(
                "[stream] full-buffer fallback: download ended without reusable bytes — HTTP fetch"
            );
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    crate::app_deprintln!(
        "[stream] full-buffer fallback: download still in progress after {}s — HTTP fetch",
        TRACK_READ_TIMEOUT_SECS
    );
    Ok(fetch_http_data(url, state, gen, app)
        .await?
        .map(|data| FallbackBytes {
            data,
            consumed_spill_path: None,
        }))
}

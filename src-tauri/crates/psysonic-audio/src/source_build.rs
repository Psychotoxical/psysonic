//! Source-building pipeline for `audio_play`: turn a resolved [`PlayInput`]
//! into a fully wrapped rodio source, including the ranged-stream probe
//! fallback (wait for / fetch a full download and retry from in-memory bytes
//! when a partial stream buffer can't be probed yet). Split out of
//! `play_input.rs` so source *selection* stays separate from source *building*.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, State};

use super::analysis_dispatch::{
    prepare_playback_analysis, prepare_track_analysis_file, spawn_track_analysis_bytes,
    spawn_track_analysis_prepared_file, PreparedTrackAnalysisFile, TrackAnalysisOrigin,
};
use super::decode::{build_source, build_streaming_source, BuiltSource, SizedDecoder};
use super::engine::AudioEngine;
use super::helpers::{
    fetch_http_data, resolve_playback_format_hint, same_playback_target,
    write_stream_spill_file,
};
use super::play_input::PlayInput;
use super::state::{PreloadedTrack, StreamCompletedSpill};
use super::stream::{
    AnalysisSeedHoldGuard, StreamDownloadControl, TRACK_READ_TIMEOUT_SECS,
    TRACK_STREAM_PROMOTE_MAX_BYTES,
};

/// Arguments forwarded from `audio_play` into the source-build pipeline.
/// Bundles the format-hint inputs, playback-shaping parameters and the shared
/// done flag so that `build_playback_source_with_probe_fallback` stays below
/// the `clippy::too_many_arguments` threshold.
pub(crate) struct BuildSourceArgs<'a> {
    pub url: &'a str,
    pub gen: u64,
    pub cache_id_for_tasks: Option<&'a str>,
    pub server_id: Option<&'a str>,
    pub url_format_hint: Option<&'a str>,
    pub stream_format_suffix: Option<&'a str>,
    pub done_flag: Arc<AtomicBool>,
    pub fade_in_dur: Duration,
    pub hi_res_enabled: bool,
    /// When > 0, resample decoded audio to this Hz (hi-res crossfade / AutoDJ blend).
    pub resample_target_hz: u32,
    pub duration_hint: f64,
}

/// Decoder/output-shaping inputs shared by [`build_source_from_play_input`].
struct PlaybackSourceShape {
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    hi_res_enabled: bool,
    resample_target_hz: u32,
    duration_hint: f64,
}

struct FallbackBytes {
    data: Vec<u8>,
    consumed_spill_path: Option<PathBuf>,
}

enum PublishedFallbackLocation {
    Memory,
    Spill {
        path: PathBuf,
        analysis_file: Option<PreparedTrackAnalysisFile>,
    },
    Uncached,
}

enum FallbackPublication {
    Published(PublishedFallbackLocation),
    StaleSpill(PublishedFallbackLocation),
    Stale,
}

enum FallbackAnalysisDispatch {
    Bytes,
    File(Option<PreparedTrackAnalysisFile>),
}

struct FallbackAnalysisContext {
    server_id: String,
    track_id: String,
    priority: psysonic_analysis::analysis_runtime::AnalysisBackfillPriority,
    seed_hold: Option<AnalysisSeedHoldGuard>,
}

fn fallback_analysis_dispatch(
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

fn stale_fallback_spill_should_unlink(candidate: &Path, source_spill_path: Option<&Path>) -> bool {
    source_spill_path != Some(candidate)
}

struct AnalysisSelectionGuard {
    download_control: Option<Arc<StreamDownloadControl>>,
}

impl AnalysisSelectionGuard {
    fn new(download_control: Option<Arc<StreamDownloadControl>>) -> Self {
        Self { download_control }
    }

    fn select_fallback(&self) -> bool {
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

/// Output of `build_source_from_play_input`: the wrapped rodio source plus
/// whether the chosen source path is seekable (only the Streaming variant
/// is not).
pub(crate) struct PlaybackSource {
    pub(crate) built: BuiltSource,
    pub(crate) is_seekable: bool,
}

fn play_media_format_hint(input: &PlayInput) -> Option<String> {
    match input {
        PlayInput::SeekableMedia { format_hint, .. } | PlayInput::Streaming { format_hint, .. } => {
            format_hint.clone()
        }
        PlayInput::Bytes(_) => None,
    }
}

fn play_input_download_control(input: &PlayInput) -> Option<Arc<StreamDownloadControl>> {
    match input {
        PlayInput::SeekableMedia {
            download_control, ..
        } => download_control.clone(),
        PlayInput::Streaming {
            download_control, ..
        } => Some(download_control.clone()),
        PlayInput::Bytes(_) => None,
    }
}

fn publish_validated_fallback_bytes(
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
                prepare_track_analysis_file(
                    TrackAnalysisOrigin::StreamSpillFile,
                    track_id,
                    path,
                )
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

/// A stream probe/decode failed in a way that may succeed after the background
/// download finishes (moov-at-end, demuxer EOF, or non-seekable AIFF chunks).
fn is_stream_probe_failure_with_full_buffer_retry(err: &str, format_hint: Option<&str>) -> bool {
    let probe_failed = err.contains("format probe failed")
        || err.contains("format probe timed out")
        || err.contains("end of stream");
    let ranged_failure = err.contains("ranged-stream")
        && (probe_failed || err.contains("moov metadata"));
    let legacy_aiff_failure = err.contains("track-stream")
        && probe_failed
        && (super::stream::container_hint_is_aiff(format_hint) || err.contains("aiff:"));
    ranged_failure || legacy_aiff_failure
}

/// Read a stable snapshot of completed download bytes while leaving the shared
/// replay entry in place until validated fallback bytes replace it.
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

/// Ranged assembly can be byte-complete but missing `moov` (holes) or non-audio HTTP body.
async fn prefer_clean_http_bytes_for_fallback(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
    fallback: FallbackBytes,
    format_hint: Option<&str>,
    label: &str,
) -> Result<Option<FallbackBytes>, String> {
    let is_mp4 = super::stream::container_hint_is_mp4(format_hint);
    if is_mp4 {
        super::stream::log_isobmff_buffer_diagnostic(&fallback.data, format_hint, label);
        if !super::stream::isobmff_buffer_looks_complete(&fallback.data)
            || super::stream::mp4_suspect_zero_holes(&fallback.data)
        {
            crate::app_deprintln!(
                "[stream] ranged buffer looks incomplete or holey — refetching via sequential HTTP"
            );
            let Some(fresh) = fetch_http_data(url, state, gen, app).await? else {
                return Ok(None);
            };
            if !super::stream::isobmff_buffer_looks_complete(&fresh) {
                super::stream::log_isobmff_buffer_diagnostic(&fresh, format_hint, "http-refetch");
            }
            return Ok(Some(FallbackBytes {
                data: fresh,
                consumed_spill_path: fallback.consumed_spill_path,
            }));
        }
    }
    Ok(Some(fallback))
}

/// Wait for the in-flight ranged download to finish, then HTTP-fetch if needed.
async fn wait_or_fetch_bytes_for_stream_fallback(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
    format_hint: Option<&str>,
    download_control: &StreamDownloadControl,
) -> Result<Option<FallbackBytes>, String> {
    use std::time::Instant;

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

fn is_in_memory_probe_failure(err: &str) -> bool {
    err.contains("format probe failed")
        || err.contains("could not open audio stream")
        || err.contains("no playable audio track")
}

/// Like [`build_source_from_play_input`], but on a retryable stream probe failure
/// waits for a full download (or fetches it) and retries from in-memory bytes.
pub(crate) async fn build_playback_source_with_probe_fallback(
    play_input: PlayInput,
    args: BuildSourceArgs<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<PlaybackSource, String> {
    let BuildSourceArgs {
        url,
        gen,
        cache_id_for_tasks,
        server_id,
        url_format_hint,
        stream_format_suffix,
        done_flag,
        fade_in_dur,
        hi_res_enabled,
        resample_target_hz,
        duration_hint,
    } = args;
    let media_hint = play_media_format_hint(&play_input);
    let download_control = play_input_download_control(&play_input);
    let analysis_selection = AnalysisSelectionGuard::new(download_control.clone());
    let effective_hint = resolve_playback_format_hint(
        url_format_hint,
        stream_format_suffix,
        media_hint.as_deref(),
        None,
    );
    if let Some(ref h) = effective_hint {
        crate::app_deprintln!("[stream] playback format hint: {h}");
    }

    let shape = PlaybackSourceShape {
        done_flag: done_flag.clone(),
        fade_in_dur,
        hi_res_enabled,
        resample_target_hz,
        duration_hint,
    };

    match build_source_from_play_input(play_input, state, effective_hint.as_deref(), &shape)
    .await
    {
        Ok(p) => Ok(p),
        Err(e)
            if is_stream_probe_failure_with_full_buffer_retry(
                &e,
                effective_hint.as_deref(),
            ) =>
        {
            crate::app_deprintln!(
                "[stream] stream probe failed — trying full-buffer fallback: {}",
                e
            );
            let Some(download_control) = download_control.as_ref() else {
                return Err(e);
            };
            let fallback = match wait_or_fetch_bytes_for_stream_fallback(
                url,
                gen,
                state,
                app,
                effective_hint.as_deref(),
                download_control,
            )
            .await?
            {
                Some(fallback) => fallback,
                None => return Err(e),
            };
            let FallbackBytes {
                data,
                consumed_spill_path,
            } = fallback;
            if state.generation.load(Ordering::SeqCst) != gen {
                return Err("ranged-stream: superseded during full-buffer fallback".into());
            }
            let bytes_hint = resolve_playback_format_hint(
                url_format_hint,
                stream_format_suffix,
                media_hint.as_deref(),
                Some(&data),
            );
            if bytes_hint.as_ref() != effective_hint.as_ref() {
                crate::app_deprintln!(
                    "[stream] full-buffer fallback: resolved hint {:?} (was {:?})",
                    bytes_hint,
                    effective_hint
                );
            }
            let prepare_fallback_analysis = || -> Result<Option<FallbackAnalysisContext>, String> {
                let Some(track_id) = cache_id_for_tasks
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    return Ok(None);
                };
                let seed_hold = AnalysisSeedHoldGuard::arm(
                    Some(&state.playback_analysis_seed_hold),
                    Some(track_id),
                    gen,
                    &state.generation,
                );
                if seed_hold.is_none() && state.generation.load(Ordering::SeqCst) != gen {
                    return Err("ranged-stream: superseded during analysis handoff".into());
                }
                let (server_id, priority) =
                    prepare_playback_analysis(app, state, server_id, track_id, None);
                Ok(Some(FallbackAnalysisContext {
                    server_id,
                    track_id: track_id.to_string(),
                    priority,
                    seed_hold,
                }))
            };
            let dispatch_fallback_analysis =
                |analysis_data: Vec<u8>,
                 location: PublishedFallbackLocation,
                 context: Option<FallbackAnalysisContext>| {
                    let Some(context) = context else {
                        return;
                    };
                    match fallback_analysis_dispatch(location) {
                        FallbackAnalysisDispatch::Bytes => spawn_track_analysis_bytes(
                            app.clone(),
                            TrackAnalysisOrigin::StreamDownloadComplete,
                            context.server_id,
                            context.track_id,
                            analysis_data,
                            Some(url.to_string()),
                            context.priority,
                            Some((gen, state.generation.clone())),
                            context.seed_hold,
                        ),
                        FallbackAnalysisDispatch::File(Some(prepared_file)) => {
                            spawn_track_analysis_prepared_file(
                                app.clone(),
                                TrackAnalysisOrigin::StreamSpillFile,
                                context.server_id,
                                context.track_id,
                                prepared_file,
                                Some(url.to_string()),
                                context.priority,
                                Some((gen, state.generation.clone())),
                                context.seed_hold,
                            )
                        }
                        FallbackAnalysisDispatch::File(None) => crate::app_eprintln!(
                            "[analysis][dispatch] fallback spill unavailable track_id={}",
                            context.track_id
                        ),
                    }
                };
            match build_source_from_play_input(
                PlayInput::Bytes(data.clone()),
                state,
                bytes_hint.as_deref(),
                &shape,
            )
            .await
            {
                Ok(p) => {
                    if state.generation.load(Ordering::SeqCst) != gen {
                        return Err(
                            "ranged-stream: superseded during full-buffer fallback".into()
                        );
                    }
                    let analysis_context = prepare_fallback_analysis()?;
                    download_control.mark_fallback_succeeded();
                    let publication = publish_validated_fallback_bytes(
                        state,
                        app,
                        url,
                        cache_id_for_tasks,
                        gen,
                        &data,
                        consumed_spill_path.as_deref(),
                    );
                    match publication {
                        FallbackPublication::Published(location) => {
                            if !analysis_selection.select_fallback() {
                                return Err(
                                    "ranged-stream: analysis source already selected".into()
                                );
                            }
                            dispatch_fallback_analysis(data, location, analysis_context);
                            Ok(p)
                        }
                        FallbackPublication::StaleSpill(location) => {
                            if analysis_selection.select_fallback() {
                                dispatch_fallback_analysis(data, location, analysis_context);
                            }
                            Err("ranged-stream: superseded during full-buffer fallback".into())
                        }
                        FallbackPublication::Stale => {
                            Err("ranged-stream: superseded during full-buffer fallback".into())
                        }
                    }
                }
                Err(pe) if is_in_memory_probe_failure(&pe) => {
                    if super::stream::container_hint_is_mp4(bytes_hint.as_deref()) {
                        super::stream::log_isobmff_buffer_diagnostic(
                            &data,
                            bytes_hint.as_deref(),
                            "ranged-cache-probe-fail",
                        );
                    }
                    crate::app_deprintln!(
                        "[stream] in-memory probe failed — sequential HTTP refetch: {}",
                        pe
                    );
                    let fresh = match fetch_http_data(url, state, gen, app).await? {
                        Some(d) => d,
                        None => return Err(pe),
                    };
                    let fresh_hint = resolve_playback_format_hint(
                        url_format_hint,
                        stream_format_suffix,
                        media_hint.as_deref(),
                        Some(&fresh),
                    );
                    if super::stream::container_hint_is_mp4(fresh_hint.as_deref()) {
                        super::stream::log_isobmff_buffer_diagnostic(
                            &fresh,
                            fresh_hint.as_deref(),
                            "http-refetch-after-probe-fail",
                        );
                    }
                    let result = build_source_from_play_input(
                        PlayInput::Bytes(fresh.clone()),
                        state,
                        fresh_hint.as_deref(),
                        &PlaybackSourceShape {
                            done_flag,
                            fade_in_dur,
                            hi_res_enabled,
                            resample_target_hz,
                            duration_hint,
                        },
                    )
                    .await;
                    if result.is_ok() {
                        if state.generation.load(Ordering::SeqCst) != gen {
                            return Err(
                                "ranged-stream: superseded during full-buffer fallback".into()
                            );
                        }
                        let analysis_context = prepare_fallback_analysis()?;
                        download_control.mark_fallback_succeeded();
                        let publication = publish_validated_fallback_bytes(
                            state,
                            app,
                            url,
                            cache_id_for_tasks,
                            gen,
                            &fresh,
                            None,
                        );
                        match publication {
                            FallbackPublication::Published(location) => {
                                if !analysis_selection.select_fallback() {
                                    return Err(
                                        "ranged-stream: analysis source already selected".into()
                                    );
                                }
                                dispatch_fallback_analysis(fresh, location, analysis_context);
                                if let Some(path) = consumed_spill_path {
                                    let _ = std::fs::remove_file(path);
                                }
                            }
                            FallbackPublication::StaleSpill(location) => {
                                if analysis_selection.select_fallback() {
                                    dispatch_fallback_analysis(fresh, location, analysis_context);
                                }
                                return Err(
                                    "ranged-stream: superseded during full-buffer fallback".into()
                                );
                            }
                            FallbackPublication::Stale => {
                                return Err(
                                    "ranged-stream: superseded during full-buffer fallback".into()
                                );
                            }
                        }
                    }
                    result
                }
                Err(pe) => Err(pe),
            }
        }
        Err(e) => Err(e),
    }
}

/// Dispatch [`PlayInput`] → fully wrapped rodio source. For Bytes the full
/// in-memory pipeline (incl. iTunSMPB scan); for SeekableMedia / Streaming
/// the streaming variant runs the decoder build on a blocking thread.
async fn build_source_from_play_input(
    play_input: PlayInput,
    state: &State<'_, AudioEngine>,
    format_hint: Option<&str>,
    shape: &PlaybackSourceShape,
) -> Result<PlaybackSource, String> {
    let PlaybackSourceShape {
        done_flag,
        fade_in_dur,
        hi_res_enabled,
        resample_target_hz,
        duration_hint,
    } = shape;
    // 0 = native rate; hi-res crossfade blend passes an explicit Hz.
    let target_rate: u32 = *resample_target_hz;
    // 0 = device unknown; the source is then left at its own channel count.
    let target_channels: u16 = crate::engine::output_device_channels(state);
    let mut is_seekable = true;
    let built = match play_input {
        PlayInput::Bytes(data) => build_source(
            data,
            *duration_hint,
            state.eq_gains.clone(),
            state.eq_enabled.clone(),
            state.eq_pre_gain.clone(),
            state.playback_rate.clone(),
            done_flag.clone(),
            *fade_in_dur,
            state.samples_played.clone(),
            target_rate,
            target_channels,
            format_hint,
            *hi_res_enabled,
        ),
        PlayInput::SeekableMedia {
            reader,
            format_hint: media_hint,
            tag,
            random_access,
            mp4_probe_gate,
            superseded,
            ..
        } => {
            if let Some(gate) = mp4_probe_gate.as_ref() {
                super::stream::wait_for_ranged_mp4_probe_ready(gate).await?;
                if gate.gen_arc.load(Ordering::SeqCst) != gate.gen {
                    return Err("ranged-stream: superseded before moov metadata ready".into());
                }
            }
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(
                    reader,
                    media_hint.as_deref(),
                    tag,
                    random_access,
                    superseded,
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            build_streaming_source(
                decoder,
                *duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                state.playback_rate.clone(),
                done_flag.clone(),
                *fade_in_dur,
                state.samples_played.clone(),
                target_rate,
                target_channels,
                None,
            )
        }
        PlayInput::Streaming {
            reader,
            format_hint: stream_hint,
            superseded,
            ..
        } => {
            is_seekable = false;
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(
                    Box::new(reader),
                    stream_hint.as_deref(),
                    "track-stream",
                    false,
                    superseded,
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            build_streaming_source(
                decoder,
                *duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                state.playback_rate.clone(),
                done_flag.clone(),
                *fade_in_dur,
                state.samples_played.clone(),
                target_rate,
                target_channels,
                Some(state.stream_playback_armed.clone()),
            )
        }
    }?;
    Ok(PlaybackSource { built, is_seekable })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        fallback_analysis_dispatch, is_stream_probe_failure_with_full_buffer_retry,
        FallbackAnalysisDispatch, PublishedFallbackLocation,
    };

    #[test]
    fn published_fallback_spill_routes_analysis_from_the_file() {
        let path = PathBuf::from("fallback-spill.flac");
        match fallback_analysis_dispatch(PublishedFallbackLocation::Spill {
            path,
            analysis_file: None,
        }) {
            FallbackAnalysisDispatch::File(_) => {}
            FallbackAnalysisDispatch::Bytes => panic!("spill analysis must use the file path"),
        }
    }

    #[test]
    fn in_memory_fallback_keeps_byte_analysis() {
        assert!(matches!(
            fallback_analysis_dispatch(PublishedFallbackLocation::Memory),
            FallbackAnalysisDispatch::Bytes
        ));
    }

    #[test]
    fn stale_reused_spill_keeps_the_shared_cache_path() {
        let path = PathBuf::from("shared-spill.flac");
        assert!(!super::stale_fallback_spill_should_unlink(
            &path,
            Some(&path)
        ));
        assert!(super::stale_fallback_spill_should_unlink(&path, None));
    }

    #[test]
    fn retries_ranged_probe_timeouts_from_full_buffer() {
        assert!(is_stream_probe_failure_with_full_buffer_retry(
            "ranged-stream: format probe timed out after 20s",
            Some("aiff"),
        ));
    }

    #[test]
    fn retries_legacy_aiff_probe_failures_from_full_buffer() {
        assert!(is_stream_probe_failure_with_full_buffer_retry(
            "track-stream: format probe failed: malformed stream: aiff: missing common element",
            None,
        ));
        assert!(is_stream_probe_failure_with_full_buffer_retry(
            "track-stream: format probe timed out after 20s",
            Some("aif"),
        ));
    }

    #[test]
    fn does_not_retry_unrelated_legacy_stream_failures() {
        assert!(!is_stream_probe_failure_with_full_buffer_retry(
            "track-stream: format probe failed: unsupported format",
            Some("mp3"),
        ));
    }
}

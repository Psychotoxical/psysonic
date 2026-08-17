//! Source-building pipeline for `audio_play`: turn a resolved [`PlayInput`]
//! into a fully wrapped rodio source, including the ranged-stream probe
//! fallback (wait for / fetch a full download and retry from in-memory bytes
//! when a partial stream buffer can't be probed yet). Split out of
//! `play_input.rs` so source *selection* stays separate from source *building*.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, State};

use super::analysis_dispatch::{
    prepare_playback_analysis, spawn_track_analysis_bytes, spawn_track_analysis_prepared_file,
    TrackAnalysisOrigin,
};
use super::decode::{build_source, build_streaming_source, BuiltSource, SizedDecoder};
use super::engine::AudioEngine;
use super::helpers::{fetch_http_data, resolve_playback_format_hint};
use super::play_input::PlayInput;
use super::stream::{AnalysisSeedHoldGuard, StreamDownloadControl};

mod fallback;

#[cfg(test)]
use fallback::stale_fallback_spill_should_unlink;
use fallback::{
    fallback_analysis_dispatch, is_stream_probe_failure_with_full_buffer_retry,
    publish_validated_fallback_bytes, wait_or_fetch_bytes_for_stream_fallback,
    AnalysisSelectionGuard, FallbackAnalysisContext, FallbackAnalysisDispatch, FallbackBytes,
    FallbackPublication, PublishedFallbackLocation,
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

    match build_source_from_play_input(play_input, state, effective_hint.as_deref(), &shape).await {
        Ok(p) => Ok(p),
        Err(e) if is_stream_probe_failure_with_full_buffer_retry(&e, effective_hint.as_deref()) => {
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
            let prepare_fallback_analysis =
                || -> Result<Option<FallbackAnalysisContext>, String> {
                    let Some(track_id) =
                        cache_id_for_tasks.map(str::trim).filter(|s| !s.is_empty())
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
                        return Err("ranged-stream: superseded during full-buffer fallback".into());
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
                                    "ranged-stream: superseded during full-buffer fallback".into(),
                                );
                            }
                            FallbackPublication::Stale => {
                                return Err(
                                    "ranged-stream: superseded during full-buffer fallback".into(),
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
mod tests;

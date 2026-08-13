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
    prepare_playback_analysis, spawn_track_analysis_bytes, TrackAnalysisOrigin,
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
    StreamDownloadControl, TRACK_READ_TIMEOUT_SECS, TRACK_STREAM_PROMOTE_MAX_BYTES,
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
    consumed_spill_path: Option<std::path::PathBuf>,
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
) -> bool {
    let candidate_spill = if data.len() > TRACK_STREAM_PROMOTE_MAX_BYTES {
        let Some(track_id) = track_id.map(str::trim).filter(|id| !id.is_empty()) else {
            return state.generation.load(Ordering::SeqCst) == gen;
        };
        match write_stream_spill_file(app, &format!("{track_id}-fallback-{gen}"), data) {
            Ok(path) => Some(path),
            Err(e) => {
                crate::app_eprintln!(
                    "[stream] validated fallback spill failed track_id={track_id}: {e}"
                );
                return state.generation.load(Ordering::SeqCst) == gen;
            }
        }
    } else {
        None
    };

    let mut cache = state.stream_completed_cache.lock().unwrap();
    let mut spill = state.stream_completed_spill.lock().unwrap();
    if state.generation.load(Ordering::SeqCst) != gen {
        drop(spill);
        drop(cache);
        if let Some(path) = candidate_spill {
            let _ = std::fs::remove_file(path);
        }
        return false;
    }
    let old_spill = spill.take().map(|entry| entry.path);
    if let Some(path) = candidate_spill {
        *cache = None;
        *spill = Some(StreamCompletedSpill {
            url: url.to_string(),
            path,
        });
    } else {
        *cache = Some(PreloadedTrack {
            url: url.to_string(),
            data: data.to_vec(),
        });
    }
    drop(spill);
    drop(cache);
    if let Some(path) = old_spill {
        let _ = std::fs::remove_file(path);
    }
    true
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

/// Take ownership of completed download bytes so they cannot be promoted while
/// fallback validation is in progress. Valid bytes are republished afterwards.
async fn try_take_completed_stream_bytes(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
) -> Option<FallbackBytes> {
    let ram = {
        let mut guard = state.stream_completed_cache.lock().unwrap();
        if state.generation.load(Ordering::SeqCst) == gen
            && guard
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, url))
        {
            guard.take().map(|p| p.data)
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
    let spill_path = {
        let mut guard = state.stream_completed_spill.lock().unwrap();
        if state.generation.load(Ordering::SeqCst) == gen
            && guard
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, url))
        {
            guard.take().map(|p| p.path)
        } else {
            None
        }
    };
    if let Some(path) = spill_path {
        let data = tokio::fs::read(&path).await.ok();
        let data = data?;
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
        if let Some(data) = try_take_completed_stream_bytes(url, gen, state).await {
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
            download_control.request_fallback_analysis();
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
            let dispatch_fallback_analysis = |analysis_data: Vec<u8>| -> bool {
                if !download_control.claim_fallback_analysis() {
                    return false;
                }
                if let Some(track_id) = cache_id_for_tasks
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let (sid, high) =
                        prepare_playback_analysis(app, state, server_id, track_id, None);
                    spawn_track_analysis_bytes(
                        app.clone(),
                        TrackAnalysisOrigin::StreamDownloadComplete,
                        sid,
                        track_id.to_string(),
                        analysis_data,
                        Some(url.to_string()),
                        high,
                        Some((gen, state.generation.clone())),
                    );
                }
                true
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
                    download_control.mark_fallback_succeeded();
                    if !publish_validated_fallback_bytes(
                        state,
                        app,
                        url,
                        cache_id_for_tasks,
                        gen,
                        &data,
                    ) {
                        return Err(
                            "ranged-stream: superseded during full-buffer fallback".into()
                        );
                    }
                    if dispatch_fallback_analysis(data) {
                        if let Some(path) = consumed_spill_path {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                    Ok(p)
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
                        download_control.mark_fallback_succeeded();
                        if !publish_validated_fallback_bytes(
                            state,
                            app,
                            url,
                            cache_id_for_tasks,
                            gen,
                            &fresh,
                        ) {
                            return Err(
                                "ranged-stream: superseded during full-buffer fallback".into()
                            );
                        }
                        if dispatch_fallback_analysis(fresh) {
                            if let Some(path) = consumed_spill_path {
                                let _ = std::fs::remove_file(path);
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
                Some(state.stream_playback_armed.clone()),
            )
        }
    }?;
    Ok(PlaybackSource { built, is_seekable })
}

#[cfg(test)]
mod tests {
    use super::is_stream_probe_failure_with_full_buffer_retry;

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

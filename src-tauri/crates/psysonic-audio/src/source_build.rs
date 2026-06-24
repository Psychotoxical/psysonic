//! Source-building pipeline for `audio_play`: turn a resolved [`PlayInput`]
//! into a fully wrapped rodio source, including the ranged-stream probe
//! fallback (wait for / fetch a full download and retry from in-memory bytes
//! when a partial ranged buffer can't be probed yet). Split out of
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
use super::helpers::{fetch_data, resolve_playback_format_hint, same_playback_target};
use super::play_input::PlayInput;
use super::stream::TRACK_READ_TIMEOUT_SECS;

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

/// Ranged HTTP probe/decode failed in a way that may succeed after the
/// background download finishes (moov-at-end, demuxer EOF during partial buffer).
fn is_ranged_stream_probe_failure(err: &str) -> bool {
    err.contains("ranged-stream")
        && (err.contains("format probe failed")
            || err.contains("moov metadata")
            || err.contains("end of stream"))
}

/// Completed ranged download or spill file for `url`, if ready.
async fn try_take_completed_stream_bytes(
    url: &str,
    state: &State<'_, AudioEngine>,
) -> Option<Vec<u8>> {
    if let Some(data) = super::helpers::take_stream_completed_for_url(state, url) {
        return Some(data);
    }
    let spill_path = {
        let guard = state.stream_completed_spill.lock().unwrap();
        guard
            .as_ref()
            .filter(|p| same_playback_target(&p.url, url))
            .map(|p| p.path.clone())
    };
    if let Some(path) = spill_path {
        let data = tokio::fs::read(&path).await.ok()?;
        if !data.is_empty() {
            return Some(data);
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
    ranged_data: Vec<u8>,
    format_hint: Option<&str>,
    label: &str,
) -> Result<Option<Vec<u8>>, String> {
    let is_mp4 = super::stream::container_hint_is_mp4(format_hint);
    if is_mp4 {
        super::stream::log_isobmff_buffer_diagnostic(&ranged_data, format_hint, label);
        if !super::stream::isobmff_buffer_looks_complete(&ranged_data)
            || super::stream::mp4_suspect_zero_holes(&ranged_data)
        {
            crate::app_deprintln!(
                "[stream] ranged buffer looks incomplete or holey — refetching via sequential HTTP"
            );
            if let Some(fresh) = fetch_data(url, state, gen, app).await? {
                if super::stream::isobmff_buffer_looks_complete(&fresh) {
                    return Ok(Some(fresh));
                }
                super::stream::log_isobmff_buffer_diagnostic(&fresh, format_hint, "http-refetch");
            }
        }
    }
    Ok(Some(ranged_data))
}

/// Wait for the in-flight ranged download to finish, then HTTP-fetch if needed.
async fn wait_or_fetch_bytes_for_stream_fallback(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
    format_hint: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    use std::time::Instant;

    let deadline = Instant::now() + Duration::from_secs(TRACK_READ_TIMEOUT_SECS);
    loop {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None);
        }
        if let Some(data) = try_take_completed_stream_bytes(url, state).await {
            crate::app_deprintln!(
                "[stream] full-buffer fallback: using completed download ({} KiB)",
                data.len() / 1024
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
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    crate::app_deprintln!(
        "[stream] full-buffer fallback: download still in progress after {}s — HTTP fetch",
        TRACK_READ_TIMEOUT_SECS
    );
    fetch_data(url, state, gen, app).await
}

fn is_in_memory_probe_failure(err: &str) -> bool {
    err.contains("format probe failed")
        || err.contains("could not open audio stream")
        || err.contains("no playable audio track")
}

/// Like [`build_source_from_play_input`], but on ranged-stream probe failure waits
/// for a full download (or fetches it) and retries from in-memory bytes.
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
        Err(e) if is_ranged_stream_probe_failure(&e) => {
            crate::app_deprintln!(
                "[stream] ranged-stream probe failed — trying full-buffer fallback: {}",
                e
            );
            let data = match wait_or_fetch_bytes_for_stream_fallback(
                url,
                gen,
                state,
                app,
                effective_hint.as_deref(),
            )
            .await?
            {
                Some(d) => d,
                None => return Err(e),
            };
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
                    data.clone(),
                    high,
                    Some((gen, state.generation.clone())),
                );
            }
            match build_source_from_play_input(
                PlayInput::Bytes(data.clone()),
                state,
                bytes_hint.as_deref(),
                &shape,
            )
            .await
            {
                Ok(p) => Ok(p),
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
                    let fresh = match fetch_data(url, state, gen, app).await? {
                        Some(d) => d,
                        None => return Err(pe),
                    };
                    if super::stream::container_hint_is_mp4(bytes_hint.as_deref()) {
                        super::stream::log_isobmff_buffer_diagnostic(
                            &fresh,
                            bytes_hint.as_deref(),
                            "http-refetch-after-probe-fail",
                        );
                    }
                    build_source_from_play_input(
                        PlayInput::Bytes(fresh),
                        state,
                        bytes_hint.as_deref(),
                        &PlaybackSourceShape {
                            done_flag,
                            fade_in_dur,
                            hi_res_enabled,
                            resample_target_hz,
                            duration_hint,
                        },
                    )
                    .await
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
        } => {
            if let Some(gate) = mp4_probe_gate.as_ref() {
                super::stream::wait_for_ranged_mp4_probe_ready(gate).await?;
                if gate.gen_arc.load(Ordering::SeqCst) != gate.gen {
                    return Err("ranged-stream: superseded before moov metadata ready".into());
                }
            }
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(reader, media_hint.as_deref(), tag, random_access)
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
        PlayInput::Streaming { reader, format_hint: stream_hint } => {
            is_seekable = false;
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(
                    Box::new(reader),
                    stream_hint.as_deref(),
                    "track-stream",
                    false,
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

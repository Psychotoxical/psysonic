//! Source-selection logic for `audio_play`: given a URL + various caches +
//! Subsonic hints, decide whether to play from in-memory bytes, a seekable
//! local file, a seekable RangedHttpSource, or a non-seekable streaming reader.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ringbuf::traits::Split;
use ringbuf::{HeapCons, HeapRb};
use symphonia::core::io::MediaSource;
use tauri::{AppHandle, Emitter, Manager, State};

use super::decode::{build_source, build_streaming_source, BuiltSource, SizedDecoder};
use super::engine::{audio_http_client, AudioEngine};
use super::helpers::{
    content_type_to_hint, fetch_data, format_hint_from_content_disposition,
    normalize_stream_suffix_for_hint, resolve_playback_format_hint, sniff_stream_format_extension,
    spawn_analysis_seed_from_in_memory_bytes, same_playback_target,
    STREAM_FORMAT_SNIFF_PROBE_BYTES,
};
use super::stream::{
    ranged_download_task, track_download_task, AudioStreamReader,
    LocalFileSource, RangedHttpSource, LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES,
    TRACK_READ_TIMEOUT_SECS, TRACK_STREAM_MAX_BUF_CAPACITY, TRACK_STREAM_MIN_BUF_CAPACITY,
};

/// What `audio_play` will hand to `build_source` / `build_streaming_source`.
pub(crate) enum PlayInput {
    Bytes(Vec<u8>),
    /// Seekable on-demand source — `RangedHttpSource` for HTTP streams,
    /// `LocalFileSource` for `psysonic-local://` files. Goes through
    /// `build_streaming_source` (no iTunSMPB scan, since we don't have the
    /// bytes in memory; chained-track gapless trim still applies via the
    /// re-played `Bytes` path on the next start).
    SeekableMedia {
        reader: Box<dyn MediaSource>,
        format_hint: Option<String>,
        tag: &'static str,
        /// When set, Symphonia probe waits for moov (tail or fast-start prefix).
        mp4_probe_gate: Option<super::stream::RangedMp4ProbeGate>,
    },
    Streaming {
        reader: AudioStreamReader,
        format_hint: Option<String>,
    },
}

/// Inputs `audio_play` has already computed before source selection.
pub(super) struct PlayInputContext<'a> {
    pub url: &'a str,
    pub gen: u64,
    pub duration_hint: f64,
    pub stream_format_suffix: Option<&'a str>,
    pub format_hint: Option<&'a str>,
    pub cache_id_for_tasks: Option<&'a str>,
    /// Playback server scope for the analysis-cache write key (empty/`None` →
    /// legacy `''`). Rides alongside `cache_id_for_tasks` into every seed path.
    pub server_id: Option<&'a str>,
    /// `Some(bytes)` when manual-skip onto a pre-chained track reuses bytes
    /// from the chained-info block.
    pub reuse_chained_bytes: Option<Vec<u8>>,
}

/// Resolves the play input for `audio_play` honouring (in priority order):
/// 1. Reused chained bytes — manual skip onto pre-chained track.
/// 2. `psysonic-local://` files — open as seekable LocalFileSource.
/// 3. Remote HTTP without preload/stream-cache hit — try ranged HTTP, fall
///    back to non-seekable AudioStreamReader.
/// 4. Preload/stream-cache hit — replay in-memory bytes via `fetch_data`.
///
/// Returns `Ok(None)` when the operation was superseded by a later
/// `audio_play` call (generation bump) — caller should bail out silently.
pub(super) async fn select_play_input(
    ctx: PlayInputContext<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<Option<PlayInput>, String> {
    if let Some(d) = ctx.reuse_chained_bytes {
        spawn_analysis_seed_from_in_memory_bytes(
            app,
            ctx.server_id,
            ctx.cache_id_for_tasks,
            ctx.gen,
            &state.generation,
            &d,
        );
        return Ok(Some(PlayInput::Bytes(d)));
    }

    let stream_cache_hit = {
        let streamed = state.stream_completed_cache.lock().unwrap();
        streamed
            .as_ref()
            .is_some_and(|p| same_playback_target(&p.url, ctx.url))
    };
    let preloaded_hit = {
        let preloaded = state.preloaded.lock().unwrap();
        preloaded
            .as_ref()
            .is_some_and(|p| same_playback_target(&p.url, ctx.url))
    };
    let is_local = ctx.url.starts_with("psysonic-local://");

    if is_local && !stream_cache_hit && !preloaded_hit {
        return Ok(Some(open_local_file_input(&ctx, state, app)?));
    }
    if !stream_cache_hit && !preloaded_hit && !is_local {
        return open_ranged_or_streaming_input(&ctx, state, app).await;
    }

    // Preloaded or stream-cache hit → replay in-memory bytes.
    let data = match fetch_data(ctx.url, state, ctx.gen, app).await? {
        Some(d) => d,
        None => return Ok(None), // superseded while downloading
    };
    spawn_analysis_seed_from_in_memory_bytes(
        app,
        ctx.server_id,
        ctx.cache_id_for_tasks,
        ctx.gen,
        &state.generation,
        &data,
    );
    Ok(Some(PlayInput::Bytes(data)))
}

/// `psysonic-local://<path>` → seekable `LocalFileSource`. Spawns a
/// background CPU-seed for the analysis cache when the file is small
/// enough (skipped if the cache already has a row for this track).
fn open_local_file_input(
    ctx: &PlayInputContext<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<PlayInput, String> {
    let path = ctx.url.strip_prefix("psysonic-local://").unwrap();
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let local_hint = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    crate::app_deprintln!(
        "[stream] LocalFileSource selected — size={} KB, hint={:?}",
        len / 1024,
        local_hint
    );
    if let Some(seed_id) = ctx.cache_id_for_tasks {
        let skip_cpu_seed = app
            .try_state::<psysonic_analysis::analysis_cache::AnalysisCache>()
            .map(|c| {
                c.cpu_seed_redundant_for_track(ctx.server_id.unwrap_or(""), seed_id)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !skip_cpu_seed {
            let path_owned = std::path::PathBuf::from(path);
            let app_seed = app.clone();
            let gen_seed = ctx.gen;
            let gen_arc_seed = state.generation.clone();
            let seed_id = seed_id.to_string();
            let seed_server = ctx.server_id.unwrap_or("").to_string();
            tokio::spawn(async move {
                if gen_arc_seed.load(Ordering::SeqCst) != gen_seed {
                    return;
                }
                let data = match tokio::fs::read(&path_owned).await {
                    Ok(d) => d,
                    Err(_) => return,
                };
                if gen_arc_seed.load(Ordering::SeqCst) != gen_seed {
                    return;
                }
                if data.is_empty() || data.len() > LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES {
                    crate::app_deprintln!(
                        "[stream] psysonic-local: skip analysis seed track_id={} bytes={} (over {} MiB cap)",
                        seed_id,
                        data.len(),
                        LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES / (1024 * 1024)
                    );
                    return;
                }
                crate::app_deprintln!(
                    "[stream] psysonic-local: file read complete track_id={} size_mib={:.2} — full-track analysis (cpu-seed queue)",
                    seed_id,
                    data.len() as f64 / (1024.0 * 1024.0)
                );
                let high = crate::engine::analysis_seed_high_priority_for_track(&app_seed, &seed_id);
                if let Err(e) =
                    psysonic_analysis::analysis_runtime::submit_analysis_cpu_seed(app_seed.clone(), seed_server.clone(), seed_id.clone(), data, high).await
                {
                    crate::app_eprintln!(
                        "[analysis] local-file seed failed for {}: {}",
                        seed_id,
                        e
                    );
                }
            });
        }
    }
    let reader = LocalFileSource { file, len };
    Ok(PlayInput::SeekableMedia {
        reader: Box::new(reader),
        format_hint: local_hint,
        tag: "local-file",
        mp4_probe_gate: None,
    })
}

/// Manual or auto-advance starts that aren't already cached: try ranged HTTP
/// (seekable) first, fall back to a non-seekable `AudioStreamReader` if the
/// server doesn't advertise byte-range support or a length.
async fn open_ranged_or_streaming_input(
    ctx: &PlayInputContext<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<Option<PlayInput>, String> {
    let response = audio_http_client(state).get(ctx.url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        if state.generation.load(Ordering::SeqCst) != ctx.gen {
            return Ok(None); // superseded
        }
        let status = response.status().as_u16();
        let msg = format!("HTTP {status}");
        app.emit("audio:error", &msg).ok();
        return Err(msg);
    }

    let mut stream_hint = content_type_to_hint(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    )
    .or_else(|| {
        response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(format_hint_from_content_disposition)
    })
    .or_else(|| normalize_stream_suffix_for_hint(ctx.stream_format_suffix))
    .or_else(|| ctx.format_hint.map(|s| s.to_string()));

    let supports_range = response.headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
    let total_size = response.content_length();

    if stream_hint.is_none() && supports_range {
        if let Some(total_u64) = total_size.filter(|&t| t > 0) {
            let last = total_u64
                .saturating_sub(1)
                .min((STREAM_FORMAT_SNIFF_PROBE_BYTES - 1) as u64);
            if let Ok(pr) = audio_http_client(state)
                .get(ctx.url)
                .header(reqwest::header::RANGE, format!("bytes=0-{last}"))
                .send()
                .await
            {
                let stat = pr.status();
                let ok = stat == reqwest::StatusCode::PARTIAL_CONTENT
                    || stat == reqwest::StatusCode::OK;
                if ok {
                    match pr.bytes().await {
                        Ok(bytes) if !bytes.is_empty() => {
                            stream_hint = sniff_stream_format_extension(&bytes).or(stream_hint);
                            if stream_hint.is_some() {
                                crate::app_deprintln!(
                                    "[stream] ranged: format sniff from {} B prefix → hint={:?}",
                                    bytes.len(),
                                    stream_hint
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if let (true, Some(total), true) = (supports_range, total_size, stream_hint.is_some()) {
        let total_usize = total as usize;
        crate::app_deprintln!(
            "[stream] RangedHttpSource selected — total={} KB, hint={:?}",
            total_usize / 1024,
            stream_hint
        );
        let buf = Arc::new(Mutex::new(vec![0u8; total_usize]));
        let downloaded_to = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        state.stream_playback_armed.store(false, Ordering::SeqCst);
        let playback_armed = state.stream_playback_armed.clone();
        let tail_ready = Arc::new(AtomicBool::new(false));
        let tail_filled_from = Arc::new(AtomicU64::new(0));
        let tail_prefetch =
            super::stream::mp4_needs_tail_prefetch(&[], stream_hint.as_deref());
        let mp4_probe_gate = tail_prefetch.then(|| super::stream::RangedMp4ProbeGate {
            tail_ready: tail_ready.clone(),
            buf: buf.clone(),
            downloaded_to: downloaded_to.clone(),
            gen_arc: state.generation.clone(),
            gen: ctx.gen,
            format_hint: stream_hint.clone(),
        });
        let loudness_hold_for_defer = (total_usize <= super::stream::TRACK_STREAM_PROMOTE_MAX_BYTES)
            .then_some(state.ranged_loudness_seed_hold.clone());
        tokio::spawn(ranged_download_task(
            ctx.gen,
            state.generation.clone(),
            audio_http_client(state),
            app.clone(),
            ctx.duration_hint,
            ctx.url.to_string(),
            response,
            buf.clone(),
            downloaded_to.clone(),
            done.clone(),
            state.stream_completed_cache.clone(),
            state.stream_completed_spill.clone(),
            state.normalization_engine.clone(),
            state.normalization_target_lufs.clone(),
            state.loudness_pre_analysis_attenuation_db.clone(),
            ctx.cache_id_for_tasks.map(|s| s.to_string()),
            ctx.server_id.map(|s| s.to_string()),
            loudness_hold_for_defer,
            playback_armed,
            stream_hint.clone(),
            tail_ready.clone(),
            tail_filled_from.clone(),
        ));
        let reader = RangedHttpSource {
            buf,
            downloaded_to,
            tail_ready,
            tail_filled_from,
            total_size: total,
            pos: 0,
            done,
            gen_arc: state.generation.clone(),
            gen: ctx.gen,
        };
        return Ok(Some(PlayInput::SeekableMedia {
            reader: Box::new(reader),
            format_hint: stream_hint,
            tag: "ranged-stream",
            mp4_probe_gate,
        }));
    }

    // Legacy non-seekable streaming reader fallback.
    crate::app_deprintln!(
        "[stream] legacy AudioStreamReader (non-seekable) — accept-ranges={}, content-length={:?}, hint={:?}",
        supports_range, total_size, stream_hint
    );
    let buffer_cap = total_size
        .map(|n| n as usize)
        .unwrap_or(TRACK_STREAM_MIN_BUF_CAPACITY)
        .clamp(TRACK_STREAM_MIN_BUF_CAPACITY, TRACK_STREAM_MAX_BUF_CAPACITY);
    let rb = HeapRb::<u8>::new(buffer_cap);
    let (prod, cons) = rb.split();
    let done = Arc::new(AtomicBool::new(false));
    state.stream_playback_armed.store(false, Ordering::SeqCst);
    let playback_armed = state.stream_playback_armed.clone();
    tokio::spawn(track_download_task(
        ctx.gen,
        state.generation.clone(),
        audio_http_client(state),
        app.clone(),
        ctx.url.to_string(),
        response,
        prod,
        done.clone(),
        state.stream_completed_cache.clone(),
        state.normalization_engine.clone(),
        state.normalization_target_lufs.clone(),
        state.loudness_pre_analysis_attenuation_db.clone(),
        ctx.cache_id_for_tasks.map(|s| s.to_string()),
        ctx.server_id.map(|s| s.to_string()),
        playback_armed,
    ));

    let (_new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapCons<u8>>();
    let reader = AudioStreamReader {
        read_timeout_secs: TRACK_READ_TIMEOUT_SECS,
        cons: Mutex::new(cons),
        new_cons_rx: Mutex::new(new_cons_rx),
        deadline: std::time::Instant::now()
            + Duration::from_secs(TRACK_READ_TIMEOUT_SECS),
        gen_arc: state.generation.clone(),
        gen: ctx.gen,
        source_tag: "track-stream",
        eof_when_empty: Some(done),
        pos: 0,
    };
    Ok(Some(PlayInput::Streaming {
        reader,
        format_hint: stream_hint,
    }))
}

/// Legacy `AudioStreamReader`: keep the sink paused until the download task arms
/// playback, then reset counters and emit `audio:playing` so the UI does not
/// extrapolate ahead of audible output.
pub(super) fn spawn_legacy_stream_start_when_armed(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    playback_armed: Arc<AtomicBool>,
    samples_played: Arc<AtomicU64>,
    current: Arc<Mutex<super::engine::AudioCurrent>>,
    app: AppHandle,
    duration_secs: f64,
) {
    tokio::spawn(async move {
        loop {
            if gen_arc.load(Ordering::SeqCst) != gen {
                return;
            }
            if playback_armed.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if gen_arc.load(Ordering::SeqCst) != gen {
            return;
        }
        samples_played.store(0, Ordering::Relaxed);
        let sink = current.lock().unwrap().sink.clone();
        if let Some(sink) = sink {
            {
                let mut cur = current.lock().unwrap();
                cur.play_started = Some(std::time::Instant::now());
                cur.paused_at = None;
                cur.seek_offset = 0.0;
            }
            sink.play();
            app.emit("audio:playing", duration_secs).ok();
            crate::app_deprintln!("[stream] legacy track-stream: playback started after buffer ready");
        }
    });
}

/// Pulled out of the format_hint extraction block in `audio_play` — strip the
/// query string first so Subsonic-style URLs (`stream.view?...&v=1.16.1&...`)
/// don't latch onto random query-param substrings; only accept short
/// alphanumeric tails that look like an actual audio extension.
pub(crate) fn url_format_hint(url: &str) -> Option<String> {
    url.split('?').next()
        .and_then(|path| path.rsplit('.').next())
        .filter(|ext| {
            (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "mp3" | "flac" | "ogg" | "oga" | "opus" | "m4a" | "mp4"
                    | "aac" | "wav" | "wave" | "ape" | "wv" | "webm" | "mka"
                )
        })
        .map(|s| s.to_lowercase())
}

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
    pub duration_hint: f64,
}

/// Output of `build_source_from_play_input`: the wrapped rodio source plus
/// whether the chosen source path is seekable (only the Streaming variant
/// is not).
pub(crate) struct PlaybackSource {
    pub(crate) built: BuiltSource,
    pub(crate) is_seekable: bool,
}

/// State + decisions audio_play computed before the sink swap.
pub(crate) struct SinkSwapInputs {
    pub(crate) sink: Arc<rodio::Player>,
    pub(crate) duration_secs: f64,
    pub(crate) volume: f32,
    pub(crate) gain_linear: f32,
    pub(crate) fadeout_trigger: Arc<AtomicBool>,
    pub(crate) fadeout_samples: Arc<std::sync::atomic::AtomicU64>,
    pub(crate) crossfade_enabled: bool,
    pub(crate) actual_fade_secs: f32,
}

/// Atomically swap the new sink into `state.current`, then handle the old
/// sink: trigger sample-level fade-out (crossfade enabled) or stop it
/// immediately (hard cut). The fade-out is handed off to a small spawned
/// task that drops the old sink ~`actual_fade_secs + 0.5 s` later.
pub(crate) fn swap_in_new_sink(state: &State<'_, AudioEngine>, inputs: SinkSwapInputs) {
    use std::time::Instant;

    let SinkSwapInputs {
        sink,
        duration_secs,
        volume,
        gain_linear,
        fadeout_trigger: new_fadeout_trigger,
        fadeout_samples: new_fadeout_samples,
        crossfade_enabled,
        actual_fade_secs,
    } = inputs;

    let (old_sink, old_fadeout_trigger, old_fadeout_samples) = {
        let mut cur = state.current.lock().unwrap();
        let old = cur.sink.take();
        let old_fo_trigger = cur.fadeout_trigger.take();
        let old_fo_samples = cur.fadeout_samples.take();
        cur.sink = Some(sink);
        cur.duration_secs = duration_secs;
        cur.seek_offset = 0.0;
        cur.play_started = Some(Instant::now());
        cur.paused_at = None;
        cur.replay_gain_linear = gain_linear;
        cur.base_volume = volume.clamp(0.0, 1.0);
        cur.fadeout_trigger = Some(new_fadeout_trigger);
        cur.fadeout_samples = Some(new_fadeout_samples);
        (old, old_fo_trigger, old_fo_samples)
    };

    if crossfade_enabled {
        if let Some(old) = old_sink {
            // Trigger sample-level fade-out on Track A via TriggeredFadeOut.
            // Calculate total fade samples from the measured actual_fade_secs.
            let rate = state.current_sample_rate.load(Ordering::Relaxed);
            let ch = state.current_channels.load(Ordering::Relaxed);
            let fade_total = (actual_fade_secs as f64 * rate as f64 * ch as f64) as u64;

            if let (Some(trigger), Some(samples)) = (old_fadeout_trigger, old_fadeout_samples) {
                samples.store(fade_total.max(1), Ordering::SeqCst);
                trigger.store(true, Ordering::SeqCst);
            }

            // Keep old sink alive until the fade completes + small margin,
            // then drop it. No volume stepping needed — the fade-out runs
            // at sample level inside the audio thread.
            *state.fading_out_sink.lock().unwrap() = Some(old);
            let fo_arc = state.fading_out_sink.clone();
            let cleanup_dur = Duration::from_secs_f32(actual_fade_secs + 0.5);
            tokio::spawn(async move {
                tokio::time::sleep(cleanup_dur).await;
                if let Some(s) = fo_arc.lock().unwrap().take() {
                    s.stop();
                }
            });
        }
    } else if let Some(old) = old_sink {
        old.stop();
    }
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
pub(super) async fn wait_or_fetch_bytes_for_stream_fallback(
    url: &str,
    gen: u64,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
    format_hint: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    use std::time::{Duration, Instant};

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

    match build_source_from_play_input(
        play_input,
        state,
        effective_hint.as_deref(),
        done_flag.clone(),
        fade_in_dur,
        hi_res_enabled,
        duration_hint,
    )
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
            spawn_analysis_seed_from_in_memory_bytes(
                app,
                server_id,
                cache_id_for_tasks,
                gen,
                &state.generation,
                &data,
            );
            match build_source_from_play_input(
                PlayInput::Bytes(data.clone()),
                state,
                bytes_hint.as_deref(),
                done_flag.clone(),
                fade_in_dur,
                hi_res_enabled,
                duration_hint,
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
                        done_flag,
                        fade_in_dur,
                        hi_res_enabled,
                        duration_hint,
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
pub(super) async fn build_source_from_play_input(
    play_input: PlayInput,
    state: &State<'_, AudioEngine>,
    format_hint: Option<&str>,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    hi_res_enabled: bool,
    duration_hint: f64,
) -> Result<PlaybackSource, String> {
    // Always 0 — no application-level resampling. Rodio handles conversion to
    // the output device rate internally; we let every track play at its native rate.
    let target_rate: u32 = 0;
    let mut is_seekable = true;
    let built = match play_input {
        PlayInput::Bytes(data) => build_source(
            data,
            duration_hint,
            state.eq_gains.clone(),
            state.eq_enabled.clone(),
            state.eq_pre_gain.clone(),
            done_flag,
            fade_in_dur,
            state.samples_played.clone(),
            target_rate,
            format_hint,
            hi_res_enabled,
        ),
        PlayInput::SeekableMedia {
            reader,
            format_hint: media_hint,
            tag,
            mp4_probe_gate,
        } => {
            if let Some(gate) = mp4_probe_gate.as_ref() {
                super::stream::wait_for_ranged_mp4_probe_ready(gate).await?;
                if gate.gen_arc.load(Ordering::SeqCst) != gate.gen {
                    return Err("ranged-stream: superseded before moov metadata ready".into());
                }
            }
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(reader, media_hint.as_deref(), tag)
            })
            .await
            .map_err(|e| e.to_string())??;
            build_streaming_source(
                decoder,
                duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                done_flag,
                fade_in_dur,
                state.samples_played.clone(),
                target_rate,
                None,
            )
        }
        PlayInput::Streaming { reader, format_hint: stream_hint } => {
            is_seekable = false;
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(Box::new(reader), stream_hint.as_deref(), "track-stream")
            })
            .await
            .map_err(|e| e.to_string())??;
            build_streaming_source(
                decoder,
                duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                done_flag,
                fade_in_dur,
                state.samples_played.clone(),
                target_rate,
                Some(state.stream_playback_armed.clone()),
            )
        }
    }?;
    Ok(PlaybackSource { built, is_seekable })
}

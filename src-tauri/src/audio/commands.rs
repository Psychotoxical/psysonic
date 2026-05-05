//! Tauri commands: play/pause/seek, gapless chain, radio, EQ, devices, normalization.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use ringbuf::{HeapCons, HeapRb};
use ringbuf::traits::Split;
use rodio::Player;
use rodio::Source;
use symphonia::core::io::MediaSource;
use tauri::{AppHandle, Emitter, Manager, State};

use super::decode::{build_source, build_streaming_source, SizedDecoder};
use super::dev_io::*;
use super::engine::{audio_http_client, AudioCurrent, AudioEngine};
use super::helpers::*;
use super::ipc::{maybe_emit_normalization_state, NormalizationStatePayload};
use super::preview::preview_clear_for_new_main_playback;
use super::sources::*;
use super::state::{ChainedInfo, PreloadedTrack};
use super::stream::{
    radio_download_task, ranged_download_task, track_download_task, AudioStreamReader,
    LocalFileSource, RangedHttpSource, RADIO_BUF_CAPACITY, RADIO_READ_TIMEOUT_SECS,
    TRACK_STREAM_MAX_BUF_CAPACITY, TRACK_STREAM_MIN_BUF_CAPACITY, LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES, RadioLiveState,
    RadioSharedFlags,
};

// ─── Commands ─────────────────────────────────────────────────────────────────

/// `analysis_track_id`: Subsonic `song.id` from the UI — ties waveform/loudness
/// cache to the track when playing `psysonic-local://` (hot/offline). Optional
/// for HTTP streams (`playback_identity` is used as fallback).
///
/// `stream_format_suffix`: Subsonic `song.suffix` (e.g. m4a); `stream.view` URLs have no
/// file extension, so this helps pick a Symphonia `format_hint` for ranged HTTP.
#[tauri::command]
pub async fn audio_play(
    url: String,
    volume: f32,
    duration_hint: f64,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    loudness_gain_db: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    manual: bool, // true = user-initiated skip → bypass crossfade, start immediately
    hi_res_enabled: bool, // false = safe 44.1 kHz mode; true = native rate (alpha)
    analysis_track_id: Option<String>,
    stream_format_suffix: Option<String>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let gapless = state.gapless_enabled.load(Ordering::Relaxed);

    // ── Ghost-command guard ───────────────────────────────────────────────────
    // After a gapless auto-advance, the frontend may fire a stale playTrack()
    // call via IPC. If we're within 500 ms of the last gapless switch AND the
    // requested URL matches the already-playing chained track, reject it.
    {
        let switch_ms = state.gapless_switch_at.load(Ordering::SeqCst);
        if switch_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now_ms.saturating_sub(switch_ms) < 500 {
                // Within the guard window — suppress this ghost command.
                return Ok(());
            }
        }
    }

    // Cancel any active preview before starting fresh main playback so the
    // two sinks don't end up mixed.
    preview_clear_for_new_main_playback(&state, &app);

    // ── Gapless pre-chain hit ─────────────────────────────────────────────────
    // audio_chain_preload already appended this URL to the Sink 30 s in
    // advance. The source is live in the queue — just return and let the
    // progress task handle the state transition when the previous source ends.
    //
    // Never for manual skips: the UI already jumped to this track in JS, but
    // the current source is still playing until the chain drains. User-initiated
    // play must clear the chain and start this URL immediately (standard path).
    if gapless && !manual {
        let already_chained = state.chained_info.lock().unwrap()
            .as_ref()
            .map(|c| same_playback_target(&c.url, &url))
            .unwrap_or(false);
        if already_chained {
            return Ok(());
        }
    }

    // ── Standard (new-sink) path ─────────────────────────────────────────────
    // Used for: manual skip, gapless OFF, first play, or gapless when the
    // proactive chain was not set up in time.

    // Bump generation first so the old progress task stops before we peel
    // chained_info (avoids a race where it sees current_done + empty chain).
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Manual skip onto the gapless-pre-chained track: reuse raw bytes (no HTTP;
    // preload cache was already consumed when the chain was built). Otherwise
    // clear any stale chain metadata.
    let reuse_chained_bytes: Option<Vec<u8>> = if gapless && manual {
        let mut ci = state.chained_info.lock().unwrap();
        if ci.as_ref().is_some_and(|c| same_playback_target(&c.url, &url)) {
            ci.take().map(|info| {
                Arc::try_unwrap(info.raw_bytes).unwrap_or_else(|a| (*a).clone())
            })
        } else {
            *ci = None;
            None
        }
    } else {
        *state.chained_info.lock().unwrap() = None;
        None
    };

    // Stop fading-out sink from previous crossfade.
    if let Some(old) = state.fading_out_sink.lock().unwrap().take() {
        old.stop();
    }

    // Pin the logical playback URL immediately so `audio_update_replay_gain` (e.g. from
    // a fast `refreshLoudness` after `playTrack`) resolves LUFS for **this** track, not
    // the previous URL still stored until the sink swap completes.
    *state.current_playback_url.lock().unwrap() = Some(url.clone());
    let logical_trim = analysis_track_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    *state.current_analysis_track_id.lock().unwrap() = logical_trim.clone();
    let cache_id_for_tasks = analysis_cache_track_id(logical_trim.as_deref(), &url);

    // Extract format hint from URL for better symphonia probing. Strip the
    // query string first so Subsonic-style URLs (`stream.view?...&v=1.16.1&...`)
    // don't latch onto random query-param substrings; only accept short
    // alphanumeric tails that look like an actual audio extension.
    let format_hint = url
        .split('?').next()
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
        .map(|s| s.to_lowercase());

    enum PlayInput {
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
        },
        Streaming {
            reader: AudioStreamReader,
            format_hint: Option<String>,
        },
    }

    // Data source selection:
    // 1) Reused chained bytes (manual skip onto pre-chained track)
    // 2) `psysonic-local://` (offline / hot cache hit) → LocalFileSource (instant)
    // 3) Manual uncached remote start:
    //    a) Server supports Range + Content-Length → seekable RangedHttpSource
    //    b) Server does not → legacy non-seekable AudioStreamReader fallback
    // 4) Preloaded/streamed-cache hit → in-memory bytes via fetch_data
    let play_input = if let Some(d) = reuse_chained_bytes {
        spawn_analysis_seed_from_in_memory_bytes(
            &app,
            cache_id_for_tasks.as_deref(),
            gen,
            &state.generation,
            &d,
        );
        PlayInput::Bytes(d)
    } else {
        let stream_cache_hit = {
            let streamed = state.stream_completed_cache.lock().unwrap();
            streamed
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, &url))
        };
        let preloaded_hit = {
            let preloaded = state.preloaded.lock().unwrap();
            preloaded
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, &url))
        };
        let is_local = url.starts_with("psysonic-local://");

        if is_local && !stream_cache_hit && !preloaded_hit {
            let path = url.strip_prefix("psysonic-local://").unwrap();
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
            if let Some(ref seed_id) = cache_id_for_tasks {
                let skip_cpu_seed = app
                    .try_state::<crate::analysis_cache::AnalysisCache>()
                    .map(|c| c.cpu_seed_redundant_for_track(seed_id).unwrap_or(false))
                    .unwrap_or(false);
                if !skip_cpu_seed {
                    let path_owned = std::path::PathBuf::from(path);
                    let app_seed = app.clone();
                    let gen_seed = gen;
                    let gen_arc_seed = state.generation.clone();
                    let seed_id = seed_id.clone();
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
                        let high = crate::audio::engine::analysis_seed_high_priority_for_track(&app_seed, &seed_id);
                        if let Err(e) =
                            crate::submit_analysis_cpu_seed(app_seed.clone(), seed_id.clone(), data, high).await
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
            PlayInput::SeekableMedia {
                reader: Box::new(reader),
                format_hint: local_hint,
                tag: "local-file",
            }
        } else if !stream_cache_hit && !preloaded_hit && !is_local {
            // `manual` must NOT gate this branch: natural track end calls `next(false)`,
            // so auto-advance must still use ranged HTTP when available. Gating used to
            // force every auto-start through `fetch_data` (full RAM buffer + extra fetch log)
            // instead of `RangedHttpSource`.
            let response = audio_http_client(&state).get(&url).send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                if state.generation.load(Ordering::SeqCst) != gen {
                    return Ok(()); // superseded
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
                    .and_then(|cd| format_hint_from_content_disposition(cd))
            })
            .or_else(|| normalize_stream_suffix_for_hint(stream_format_suffix.as_deref()))
            .or_else(|| format_hint.clone());

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
                    if let Ok(pr) = audio_http_client(&state)
                        .get(&url)
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

            // Guardrail: when format/container hint is unknown, some demuxers may
            // seek near EOF during probe. With a progressively downloaded ranged
            // source that can delay first audible samples until most/all bytes are
            // fetched. Prefer sequential streaming in that case for faster start.
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
                let loudness_hold_for_defer = (total_usize <= crate::audio::stream::TRACK_STREAM_PROMOTE_MAX_BYTES)
                    .then_some(state.ranged_loudness_seed_hold.clone());
                tokio::spawn(ranged_download_task(
                    gen,
                    state.generation.clone(),
                    audio_http_client(&state),
                    app.clone(),
                    duration_hint,
                    url.clone(),
                    response,
                    buf.clone(),
                    downloaded_to.clone(),
                    done.clone(),
                    state.stream_completed_cache.clone(),
                    state.normalization_engine.clone(),
                    state.normalization_target_lufs.clone(),
                    state.loudness_pre_analysis_attenuation_db.clone(),
                    cache_id_for_tasks.clone(),
                    loudness_hold_for_defer,
                ));
                let reader = RangedHttpSource {
                    buf,
                    downloaded_to,
                    total_size: total,
                    pos: 0,
                    done,
                    gen_arc: state.generation.clone(),
                    gen,
                };
                PlayInput::SeekableMedia {
                    reader: Box::new(reader),
                    format_hint: stream_hint,
                    tag: "ranged-stream",
                }
            } else {
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
                tokio::spawn(track_download_task(
                    gen,
                    state.generation.clone(),
                    audio_http_client(&state),
                    app.clone(),
                    url.clone(),
                    response,
                    prod,
                    done.clone(),
                    state.stream_completed_cache.clone(),
                    state.normalization_engine.clone(),
                    state.normalization_target_lufs.clone(),
                    state.loudness_pre_analysis_attenuation_db.clone(),
                    cache_id_for_tasks.clone(),
                ));

                let (_new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapCons<u8>>();
                let reader = AudioStreamReader {
                    cons: Mutex::new(cons),
                    new_cons_rx: Mutex::new(new_cons_rx),
                    deadline: std::time::Instant::now()
                        + Duration::from_secs(RADIO_READ_TIMEOUT_SECS),
                    gen_arc: state.generation.clone(),
                    gen,
                    source_tag: "track-stream",
                    eof_when_empty: Some(done),
                    pos: 0,
                };
                PlayInput::Streaming {
                    reader,
                    format_hint: stream_hint,
                }
            }
        } else {
            let data = fetch_data(&url, &state, gen, &app).await?;
            let data = match data {
                Some(d) => d,
                None => return Ok(()), // superseded while downloading
            };
            spawn_analysis_seed_from_in_memory_bytes(
                &app,
                cache_id_for_tasks.as_deref(),
                gen,
                &state.generation,
                &data,
            );
            PlayInput::Bytes(data)
        }
    };

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let target_lufs = f32::from_bits(state.normalization_target_lufs.load(Ordering::Relaxed));
    let cache_loudness = resolve_loudness_gain_from_cache(
        &app,
        &url,
        target_lufs,
        logical_trim.as_deref(),
    );
    let resolved_loudness_gain_db = cache_loudness;
    let norm_mode = state.normalization_engine.load(Ordering::Relaxed);
    let pre_analysis_db = loudness_pre_analysis_db_for_engine(&state);
    let startup_loudness_gain_db = if norm_mode == 2 {
        loudness_gain_db_after_resolve(
            cache_loudness,
            target_lufs,
            pre_analysis_db,
            false,
            loudness_gain_db,
        )
    } else {
        cache_loudness
    };
    let (gain_linear, effective_volume) = compute_gain(
        norm_mode,
        replay_gain_db,
        replay_gain_peak,
        startup_loudness_gain_db,
        pre_gain_db,
        fallback_db,
        volume,
    );
    let current_gain_db = loudness_ui_current_gain_db(gain_linear);
    crate::app_deprintln!(
        "[normalization] audio_play track_id={:?} engine={} replay_gain_db={:?} replay_gain_peak={:?} loudness_gain_db={:?} gain_linear={:.4} current_gain_db={:?} target_lufs={:.2} volume={:.3} effective_volume={:.3}",
        playback_identity(&url),
        normalization_engine_name(norm_mode),
        replay_gain_db,
        replay_gain_peak,
        resolved_loudness_gain_db,
        gain_linear,
        current_gain_db,
        target_lufs,
        volume,
        effective_volume
    );
    maybe_emit_normalization_state(
        &app,
        NormalizationStatePayload {
            engine: normalization_engine_name(norm_mode).to_string(),
            current_gain_db,
            target_lufs,
        },
    );

    // Manual skips (user-initiated) bypass crossfade — the track should start immediately.
    let crossfade_enabled = state.crossfade_enabled.load(Ordering::Relaxed) && !manual;
    let crossfade_secs_val = f32::from_bits(state.crossfade_secs.load(Ordering::Relaxed)).clamp(0.5, 12.0);

    // Measure how much audio Track A actually has left right now.
    // By the time audio_play is called, near_end_ticks (2×500ms) + IPC latency
    // have consumed ~500–800ms from Track A's tail — so its true remaining time
    // is always less than crossfade_secs_val.  Using the measured remaining time
    // for BOTH fade-out (Track A) and fade-in (Track B) keeps them in sync and
    // guarantees Track A reaches 0 exactly when its source exhausts.
    let actual_fade_secs: f32 = if crossfade_enabled {
        let cur = state.current.lock().unwrap();
        let remaining = (cur.duration_secs - cur.position()) as f32;
        remaining.clamp(0.1, crossfade_secs_val)
    } else {
        0.0
    };

    // Fade-in duration for Track B:
    //   crossfade → equal-power sin(t·π/2) over actual remaining time of Track A
    //   hard cut  → 5 ms micro-fade to suppress DC-offset click
    let fade_in_dur = if crossfade_enabled {
        Duration::from_secs_f32(actual_fade_secs)
    } else {
        Duration::from_millis(5)
    };

    // Build source: decode → trim → resample → EQ → fade-in → fade-out → notify → count.
    let done_flag = Arc::new(AtomicBool::new(false));
    // Reset sample counter for the new track.
    state.samples_played.store(0, Ordering::Relaxed);
    // Always 0 — no application-level resampling. Rodio handles conversion to
    // the output device rate internally; we let every track play at its native rate.
    let target_rate: u32 = 0;
    let mut new_is_seekable = true;
    let built = match play_input {
        PlayInput::Bytes(data) => build_source(
            data,
            duration_hint,
            state.eq_gains.clone(),
            state.eq_enabled.clone(),
            state.eq_pre_gain.clone(),
            done_flag.clone(),
            fade_in_dur,
            state.samples_played.clone(),
            target_rate,
            format_hint.as_deref(),
            hi_res_enabled,
        ),
        PlayInput::SeekableMedia { reader, format_hint, tag } => {
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(reader, format_hint.as_deref(), tag)
            })
            .await
            .map_err(|e| e.to_string())??;

            build_streaming_source(
                decoder,
                duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                done_flag.clone(),
                fade_in_dur,
                state.samples_played.clone(),
                target_rate,
            )
        }
        PlayInput::Streaming { reader, format_hint } => {
            new_is_seekable = false;
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(Box::new(reader), format_hint.as_deref(), "track-stream")
            })
            .await
            .map_err(|e| e.to_string())??;

            build_streaming_source(
                decoder,
                duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                done_flag.clone(),
                fade_in_dur,
                state.samples_played.clone(),
                target_rate,
            )
        }
    }.map_err(|e| { app.emit("audio:error", &e).ok(); e })?;
    state.current_is_seekable.store(new_is_seekable, Ordering::SeqCst);
    let source = built.source;
    let duration_secs = built.duration_secs;
    let output_rate = built.output_rate;
    let output_channels = built.output_channels;

    // Store the actual output rate/channels for position calculation.
    state.current_sample_rate.store(output_rate, Ordering::Relaxed);
    state.current_channels.store(output_channels as u32, Ordering::Relaxed);

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    // ── Stream rate management ────────────────────────────────────────────────
    // Hi-Res ON:  open device at file's native rate (bit-perfect, no resampler).
    // Hi-Res OFF: if the stream was previously opened at a hi-res rate (e.g. the
    //             toggle was just turned off mid-session), restore the device
    //             default rate so playback is no longer at 88.2/96 kHz etc.
    //             If already at the device default — skip entirely (no IPC, no
    //             PipeWire reconfigure, no scheduler cost).
    {
        let current_stream_rate = state.stream_sample_rate.load(Ordering::Relaxed);
        let target_rate = if hi_res_enabled {
            output_rate   // native file rate
        } else {
            state.device_default_rate  // restore device default
        };
        let needs_switch = target_rate > 0 && target_rate != current_stream_rate;
        if needs_switch {
            let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<Arc<rodio::MixerDeviceSink>>(0);
            let dev = state.selected_device.lock().unwrap().clone();
            if state.stream_reopen_tx.send((target_rate, hi_res_enabled, dev, reply_tx)).is_ok() {
                match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(new_handle) => {
                        *state.stream_handle.lock().unwrap() = new_handle;
                        state.stream_sample_rate.store(target_rate, Ordering::Relaxed);
                        // Give PipeWire time to reconfigure at the new rate before
                        // we open a Sink — only needed for large hi-res quanta.
                        if hi_res_enabled && target_rate > 48_000 {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                        }
                    }
                    Err(_) => {
                        crate::app_eprintln!("[psysonic] stream rate switch timed out, keeping {current_stream_rate} Hz");
                    }
                }
            }
        }

        // Re-check gen: a rapid skip during the settle sleep would have bumped it.
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(());
        }
    }

    let sink = Arc::new(Player::connect_new(state.stream_handle.lock().unwrap().mixer()));
    sink.set_volume(effective_volume);

    // ── Sink pre-fill for hi-res tracks ──────────────────────────────────────
    // At sample rates > 48 kHz the hardware quantum is larger and the first
    // period demands more decoded frames than at 44.1/48 kHz.
    // Strategy: pause the sink before appending so rodio's internal mixer
    // decodes into its ring buffer ahead of the hardware. After a short delay
    // we resume — the buffer is already full and the hardware gets its frames
    // without an underrun on the very first period.
    // Standard mode: no pre-fill needed — default 44.1/48 kHz quantum is small.
    let needs_prefill = hi_res_enabled && output_rate > 48_000;
    if needs_prefill {
        sink.pause();
    }

    // Gapless OFF: prepend a short silence so tracks are clearly separated.
    // Only when this is an auto-advance (near end), not on manual skip.
    //
    // Use a frame-aligned `SamplesBuffer` rather than `Zero + take_duration` —
    // the latter computes its sample count via integer-nanosecond division
    // (1_000_000_000 / (sr * ch)), which at common rates leaks an odd number
    // of samples (e.g. 44103 at 44.1 kHz / 2 ch / 500 ms = 22051.5 frames).
    // The half-frame leak shifts the next source's L/R parity in the device
    // stream and can manifest as a dead channel for the rest of the track
    // (reported by users for natural-end-without-gapless transitions only).
    if !gapless {
        let cur_pos = {
            let cur = state.current.lock().unwrap();
            cur.position()
        };
        let cur_dur = {
            let cur = state.current.lock().unwrap();
            cur.duration_secs
        };
        let is_auto_advance = cur_dur > 3.0 && cur_pos >= cur_dur - 3.0;
        if is_auto_advance {
            let ch = source.channels();
            let sr = source.sample_rate();
            // 500 ms in whole frames, then expand to interleaved samples.
            let frames = (sr.get() / 2) as usize;
            let total_samples = frames.saturating_mul(ch.get() as usize);
            let silence = rodio::buffer::SamplesBuffer::new(ch, sr, vec![0f32; total_samples]);
            sink.append(silence);
        }
    }

    sink.append(source);

    if needs_prefill {
        // 500 ms lets rodio decode several seconds of hi-res audio into its
        // internal buffer while the sink is paused. The hardware sees no gap
        // because the output is held — it only starts draining after sink.play().
        // 500 ms gives ~5 quanta of headroom at 8192-frame/88200 Hz quantum size,
        // absorbing scheduler jitter and PipeWire graph wake-up latency.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(()); // skipped during pre-fill — abort silently
        }
        sink.play();
    }

    // Atomically swap sinks — extract old sink + its fade-out trigger.
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
        cur.fadeout_trigger = Some(built.fadeout_trigger);
        cur.fadeout_samples = Some(built.fadeout_samples);
        (old, old_fo_trigger, old_fo_samples)
    };

    // Handle old sink: symmetric crossfade or immediate stop.
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

    app.emit("audio:playing", duration_secs).ok();

    // ── Progress + ended detection ────────────────────────────────────────────
    spawn_progress_task(
        gen,
        state.generation.clone(),
        state.current.clone(),
        state.chained_info.clone(),
        state.crossfade_enabled.clone(),
        state.crossfade_secs.clone(),
        done_flag,
        app,
        state.samples_played.clone(),
        state.current_sample_rate.clone(),
        state.current_channels.clone(),
        state.gapless_switch_at.clone(),
        state.current_playback_url.clone(),
    );

    Ok(())
}

/// Proactively appends the next track to the current Sink ~30 s before the
/// current track ends. Called from JS at the same trigger point as preload.
///
/// Because this runs well before the track boundary, the IPC round-trip is
/// irrelevant — by the time the current track actually ends, the next source
/// is already live in the Sink queue and rodio transitions at sample accuracy.
///
/// audio_play() checks chained_info.url on arrival: if it matches, it returns
/// immediately without touching the Sink (pure no-op on the audio path).
#[tauri::command]
pub async fn audio_chain_preload(
    url: String,
    volume: f32,
    duration_hint: f64,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    loudness_gain_db: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    hi_res_enabled: bool,
    analysis_track_id: Option<String>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    // Idempotent: already chained this track → nothing to do.
    {
        let chained = state.chained_info.lock().unwrap();
        if chained.as_ref().is_some_and(|c| same_playback_target(&c.url, &url)) {
            return Ok(());
        }
    }

    // Gapless must be enabled and a sink must exist.
    if !state.gapless_enabled.load(Ordering::Relaxed) {
        return Ok(());
    }

    let snapshot_gen = state.generation.load(Ordering::SeqCst);

    // Fetch bytes — use preload cache if available, otherwise HTTP.
    let data: Vec<u8> = {
        let cached = {
            let mut preloaded = state.preloaded.lock().unwrap();
            if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, &url)) {
                preloaded.take().map(|p| p.data)
            } else {
                None
            }
        };
        if let Some(d) = cached {
            d
        } else {
            if let Some(path) = url.strip_prefix("psysonic-local://") {
                tokio::fs::read(path).await.map_err(|e| e.to_string())?
            } else {
                let resp = audio_http_client(&state).get(&url).send().await
                    .map_err(|e| e.to_string())?;
                if !resp.status().is_success() {
                    return Ok(()); // silently fail — audio_play will retry
                }
                let hint = resp.content_length().unwrap_or(0) as usize;
                let mut stream = resp.bytes_stream();
                let mut buf = Vec::with_capacity(hint);
                while let Some(chunk) = stream.next().await {
                    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
                        return Ok(()); // superseded by manual skip — abort download
                    }
                    buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
                }
                buf
            }
        }
    };

    // Bail if the user skipped to a different track while we were downloading.
    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
        return Ok(());
    }

    let raw_bytes = Arc::new(data);

    let logical_trim = analysis_track_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Only `gain_linear` is needed — `effective_volume` is intentionally NOT
    // applied to the Sink here. `audio_chain_preload` runs ~30 s before the
    // current track ends, and `Sink::set_volume` affects the WHOLE Sink (incl.
    // the still-playing current source). Volume for the chained track is
    // applied at the gapless transition in `spawn_progress_task`, not here.
    let target_lufs = f32::from_bits(state.normalization_target_lufs.load(Ordering::Relaxed));
    let norm_mode = state.normalization_engine.load(Ordering::Relaxed);
    let pre_analysis_db = loudness_pre_analysis_db_for_engine(&state);
    let chain_loudness_db = if norm_mode == 2 {
        loudness_gain_db_or_startup(
            &app,
            &url,
            target_lufs,
            logical_trim.as_deref(),
            pre_analysis_db,
            false,
            loudness_gain_db,
        )
    } else {
        resolve_loudness_gain_from_cache(&app, &url, target_lufs, logical_trim.as_deref())
    };
    let (gain_linear, _effective_volume) = compute_gain(
        norm_mode,
        replay_gain_db,
        replay_gain_peak,
        chain_loudness_db,
        pre_gain_db,
        fallback_db,
        volume,
    );

    let done_next = Arc::new(AtomicBool::new(false));
    // Use a dedicated counter for the chained source — it will be swapped into
    // samples_played when the chained track becomes active.
    let chain_counter = Arc::new(AtomicU64::new(0));
    // Always 0 — no application-level resampling (same as audio_play).
    let target_rate: u32 = 0;
    let format_hint = url.rsplit('.').next()
        .and_then(|ext| ext.split('?').next())
        .map(|s| s.to_lowercase());
    let built = build_source(
        (*raw_bytes).clone(),
        duration_hint,
        state.eq_gains.clone(),
        state.eq_enabled.clone(),
        state.eq_pre_gain.clone(),
        done_next.clone(),
        Duration::ZERO, // gapless: no fade-in — sample-accurate boundary, no click
        chain_counter.clone(),
        target_rate,
        format_hint.as_deref(),
        hi_res_enabled,
    ).map_err(|e| e.to_string())?;
    let source = built.source;
    let duration_secs = built.duration_secs;

    // Final gen check — reject if a manual skip happened during decode.
    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
        return Ok(());
    }

    // In hi-res mode: if the next track's native rate differs from the current
    // output stream, we cannot chain gaplessly — audio_play will do a hard cut
    // with a stream re-open. Store raw bytes to avoid re-downloading.
    // In safe mode (44.1 kHz locked): the stream rate is always 44100, so the
    // chain proceeds and rodio resamples internally — no bail needed.
    let next_rate = if hi_res_enabled { built.output_rate } else { 44_100 };
    let stream_rate = state.stream_sample_rate.load(Ordering::Relaxed);
    if hi_res_enabled && stream_rate > 0 && next_rate != stream_rate {
        crate::app_eprintln!(
            "[psysonic] gapless chain skipped: next track rate {} Hz ≠ stream {} Hz",
            next_rate, stream_rate
        );
        *state.preloaded.lock().unwrap() = Some(PreloadedTrack {
            url,
            data: Arc::try_unwrap(raw_bytes).unwrap_or_else(|a| (*a).clone()),
        });
        return Ok(());
    }

    // Append to the existing Sink. The audio hardware stream never stalls.
    // Note: `set_volume` is deliberately NOT called here (see comment above).
    {
        let cur = state.current.lock().unwrap();
        match &cur.sink {
            Some(sink) => {
                sink.append(source);
            }
            None => return Ok(()), // playback stopped — bail
        }
    }

    *state.chained_info.lock().unwrap() = Some(ChainedInfo {
        url,
        raw_bytes,
        duration_secs,
        replay_gain_linear: gain_linear,
        base_volume: volume.clamp(0.0, 1.0),
        source_done: done_next,
        sample_counter: chain_counter,
    });

    Ok(())
}

/// Spawns the per-generation progress + ended-detection task.
///
/// The task owns a local `done: Arc<AtomicBool>` reference that starts as
/// the current track's done flag. When the progress task detects that the
/// done flag is set AND `chained_info` has data, it swaps `done` to the
/// chained source's flag and transitions state — all without creating a new
/// task or changing the generation counter.
///
/// Key changes from the previous implementation:
///   • 100 ms tick (was 500 ms) — halves worst-case event latency
///   • Position from atomic sample counter (no wall-clock drift)
///   • Immediate `audio:track_switched` event at decoder boundary
///   • `audio:ended` only fires when no chained successor exists
fn spawn_progress_task(
    gen: u64,
    gen_counter: Arc<AtomicU64>,
    current_arc: Arc<Mutex<AudioCurrent>>,
    chained_arc: Arc<Mutex<Option<ChainedInfo>>>,
    crossfade_enabled_arc: Arc<AtomicBool>,
    crossfade_secs_arc: Arc<AtomicU32>,
    initial_done: Arc<AtomicBool>,
    app: AppHandle,
    samples_played: Arc<AtomicU64>,
    sample_rate_arc: Arc<AtomicU32>,
    channels_arc: Arc<AtomicU32>,
    gapless_switch_at: Arc<AtomicU64>,
    current_playback_url: Arc<Mutex<Option<String>>>,
) {
    // Keep progress aligned with audible output (ALSA/PipeWire/Pulse queue) on
    // Linux; mirrors the quantum policy used for stream open/reopen plus a small
    // scheduler/mixer cushion so the UI doesn't run ahead. Other platforms have
    // their own latency reporting paths and don't need the compensation here.
    #[cfg(target_os = "linux")]
    fn estimated_output_latency_secs(sample_rate_hz: f64) -> f64 {
        let rate = sample_rate_hz.max(1.0);
        let frames = if rate > 48_000.0 { 8192.0 } else { 4096.0 };
        (frames / rate) + 0.012
    }
    #[cfg(not(target_os = "linux"))]
    fn estimated_output_latency_secs(_sample_rate_hz: f64) -> f64 {
        0.0
    }

    // Keep near-end detection at 100 ms, but throttle progress IPC to webview.
    const PROGRESS_EMIT_MIN_MS: u64 = 1500;
    const PROGRESS_EMIT_MIN_DELTA_SECS: f64 = 0.9;

    tokio::spawn(async move {
        let mut near_end_ticks: u32 = 0;
        // Local done-flag reference; swapped on gapless transition.
        let mut current_done = initial_done;
        // Local sample counter; swapped to chained source's counter on transition.
        let mut samples_played = samples_played;
        let mut last_progress_emit_at = Instant::now() - Duration::from_millis(PROGRESS_EMIT_MIN_MS);
        let mut last_progress_emit_pos = -1.0f64;
        let mut last_progress_emit_paused = false;

        loop {
            // 100 ms tick keeps near-end detection timely for crossfade/gapless
            // handoff while frontend still interpolates smoothly via rAF.
            tokio::time::sleep(Duration::from_millis(100)).await;

            if gen_counter.load(Ordering::SeqCst) != gen {
                break;
            }

            // ── Gapless transition detection ─────────────────────────────────
            // If the current source is exhausted AND we have a chained track
            // ready, transition seamlessly: swap tracking state, emit
            // audio:track_switched for the new track, and continue the loop.
            if current_done.load(Ordering::SeqCst) {
                // Radio (dur == 0): stream exhausted / connection dropped → stop.
                let cur_dur = current_arc.lock().unwrap().duration_secs;
                if cur_dur <= 0.0 {
                    crate::app_eprintln!("[radio] current_done fired → emitting audio:ended (dur=0)");
                    gen_counter.fetch_add(1, Ordering::SeqCst);
                    app.emit("audio:ended", ()).ok();
                    break;
                }

                let chained = chained_arc.lock().unwrap().take();
                if let Some(info) = chained {
                    // Swap to the chained source's done flag.
                    current_done = info.source_done;

                    // Swap to the chained source's sample counter.
                    // The chained CountingSource increments its own Arc,
                    // so we must rebind our local reference to it —
                    // a one-time value copy would go stale immediately.
                    samples_played = info.sample_counter;

                    // Update tracking state and apply the chained track's
                    // effective volume. Deferred from `audio_chain_preload`
                    // (which runs ~30 s before the current track ends) to
                    // avoid changing loudness of the still-playing current
                    // track. `Sink::set_volume` affects the whole Sink, so it
                    // must only be called at the boundary, not at preload.
                    {
                        let mut cur = current_arc.lock().unwrap();
                        let prev_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
                        cur.replay_gain_linear = info.replay_gain_linear;
                        cur.base_volume = info.base_volume;
                        cur.duration_secs = info.duration_secs;
                        cur.seek_offset = 0.0;
                        cur.play_started = Some(Instant::now());
                        if let Some(sink) = &cur.sink {
                            let effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
                            ramp_sink_volume(Arc::clone(sink), prev_effective, effective);
                        }
                    }

                    *current_playback_url.lock().unwrap() = Some(info.url.clone());

                    // Record the gapless switch timestamp for ghost-command guard.
                    let switch_ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    gapless_switch_at.store(switch_ts, Ordering::SeqCst);

                    // Emit the new track_switched event — this is immediate,
                    // not delayed by 500 ms like the old audio:playing was.
                    app.emit("audio:track_switched", info.duration_secs).ok();
                    near_end_ticks = 0;
                    continue;
                }
                // Current source exhausted but no chain queued — the Sink is
                // likely draining; audio:ended will fire on the next tick via
                // the near-end logic below.
            }

            // ── Position from atomic sample counter ──────────────────────────
            let rate = sample_rate_arc.load(Ordering::Relaxed) as f64;
            let ch = channels_arc.load(Ordering::Relaxed) as f64;
            let samples = samples_played.load(Ordering::Relaxed) as f64;
            let divisor = (rate * ch).max(1.0);

            // Read playback snapshot under a single lock to minimize contention
            // with seek/play/pause commands that also touch `current`.
            let (dur, paused_at) = {
                let cur = current_arc.lock().unwrap();
                (cur.duration_secs, cur.paused_at)
            };
            let is_paused = paused_at.is_some();

            let pos_raw = if let Some(p) = paused_at {
                p
            } else {
                (samples / divisor).min(dur.max(0.001))
            };
            let progress_latency = if is_paused {
                0.0
            } else {
                estimated_output_latency_secs(rate)
            };
            let pos = (pos_raw - progress_latency).max(0.0);

            let now = Instant::now();
            let should_emit_progress = if is_paused != last_progress_emit_paused {
                true
            } else if now.duration_since(last_progress_emit_at) >= Duration::from_millis(PROGRESS_EMIT_MIN_MS) {
                true
            } else {
                (pos - last_progress_emit_pos).abs() >= PROGRESS_EMIT_MIN_DELTA_SECS
            };
            if should_emit_progress {
                app.emit("audio:progress", ProgressPayload { current_time: pos, duration: dur }).ok();
                last_progress_emit_at = now;
                last_progress_emit_pos = pos;
                last_progress_emit_paused = is_paused;
            }

            if is_paused {
                continue;
            }

            let cf_enabled = crossfade_enabled_arc.load(Ordering::Relaxed);
            let cf_secs = f32::from_bits(crossfade_secs_arc.load(Ordering::Relaxed)).clamp(0.5, 12.0) as f64;
            let end_threshold = if cf_enabled { cf_secs.max(1.0) } else { 1.0 };

            if dur > end_threshold && pos_raw >= dur - end_threshold {
                near_end_ticks += 1;
                // At 100 ms ticks, 10 ticks ≈ 1 s — equivalent to the old 2×500ms.
                if near_end_ticks >= 10 {
                    // If a gapless chain is pending, the source hasn't
                    // exhausted yet — duration_hint (integer seconds from
                    // Subsonic) is shorter than the actual audio content.
                    // Don't emit audio:ended; let the gapless transition
                    // handle it when current_done fires.
                    let has_chain = chained_arc.lock().unwrap().is_some();
                    if has_chain {
                        continue;
                    }
                    gen_counter.fetch_add(1, Ordering::SeqCst);
                    app.emit("audio:ended", ()).ok();
                    break;
                }
            } else {
                near_end_ticks = 0;
            }
        }
    });
}

#[tauri::command]
pub fn audio_pause(state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if !sink.is_paused() {
            let pos = cur.position();
            sink.pause();
            cur.paused_at    = Some(pos);
            cur.play_started = None;
        }
    }
    // Notify the download task so it can start measuring the hard-pause stall timer.
    if let Some(rs) = state.radio_state.lock().unwrap().as_ref() {
        rs.flags.is_paused.store(true, Ordering::Release);
    }
}

/// Resume playback.
///
/// **Warm resume** (`is_hard_paused = false`): download task is still running,
/// buffer has buffered audio.  `sink.play()` suffices.
///
/// **Cold resume** (`is_hard_paused = true`): TCP was dropped.  A fresh 4 MB
/// ring buffer is created, its consumer is sent to `AudioStreamReader` (which
/// swaps it in on the next `read()`), and a new download task is spawned.
#[tauri::command]
pub async fn audio_resume(state: State<'_, AudioEngine>, app: AppHandle) -> Result<(), String> {
    // If a preview is running, cancel it first — otherwise sink.play() on the
    // main sink would mix on top of the preview sink.
    preview_clear_for_new_main_playback(&state, &app);

    // Detect radio hard-disconnect.
    let reconnect_info = {
        let guard = state.radio_state.lock().unwrap();
        guard
            .as_ref()
            .filter(|rs| rs.flags.is_hard_paused.load(Ordering::Acquire))
            .map(|rs| (rs.url.clone(), rs.gen, rs.flags.clone()))
    };

    if let Some((url, gen, flags)) = reconnect_info {
        let rb = HeapRb::<u8>::new(RADIO_BUF_CAPACITY);
        let (new_prod, new_cons) = rb.split();

        // Send new consumer to AudioStreamReader (non-blocking; unbounded channel).
        let ok = flags.new_cons_tx.lock().unwrap().send(new_cons).is_ok();

        if ok {
            let new_task = tokio::spawn(radio_download_task(
                gen,
                state.generation.clone(),
                None, // task performs its own fresh GET
                audio_http_client(&state),
                url,
                new_prod,
                flags.clone(),
                app,
            ));
            if let Some(rs) = state.radio_state.lock().unwrap().as_mut() {
                let old = std::mem::replace(&mut rs.task, new_task);
                old.abort(); // ensure any lingering old task is gone
                rs.flags.is_hard_paused.store(false, Ordering::Release);
                rs.flags.is_paused.store(false, Ordering::Release);
            }
        } else {
            crate::app_eprintln!("[radio] resume: AudioStreamReader gone — skipping reconnect");
        }
    }

    // Resume the rodio Sink (works for both warm and cold resume).
    {
        let mut cur = state.current.lock().unwrap();
        if let Some(sink) = &cur.sink {
            if sink.is_paused() {
                let pos = cur.paused_at.unwrap_or(cur.seek_offset);
                sink.play();
                cur.seek_offset  = pos;
                cur.play_started = Some(Instant::now());
                cur.paused_at    = None;
            }
        }
    }
    if let Some(rs) = state.radio_state.lock().unwrap().as_ref() {
        rs.flags.is_paused.store(false, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn audio_stop(state: State<'_, AudioEngine>, app: AppHandle) {
    preview_clear_for_new_main_playback(&state, &app);
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.current_playback_url.lock().unwrap() = None;
    *state.current_analysis_track_id.lock().unwrap() = None;
    *state.chained_info.lock().unwrap() = None;
    // Keep `stream_completed_cache`: natural track end often calls `audio_stop` when the
    // queue is exhausted; clearing here dropped the full ranged buffer and forced a
    // re-download on replay. The slot is only consumed on `take`/overwrite for another URL.
    // Drop RadioLiveState → triggers Drop → task.abort() → TCP released.
    drop(state.radio_state.lock().unwrap().take());
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() { sink.stop(); }
    cur.duration_secs = 0.0;
    cur.seek_offset   = 0.0;
    cur.play_started  = None;
    cur.paused_at     = None;
}

#[tauri::command]
pub fn audio_seek(seconds: f64, state: State<'_, AudioEngine>) -> Result<(), String> {
    const AUDIO_SEEK_TIMEOUT_MS: u64 = 700;
    const AUDIO_SEEK_LOCK_TIMEOUT_MS: u64 = 40;
    // Ghost-command guard: reject seeks within 500 ms of a gapless auto-advance.
    {
        let switch_ms = state.gapless_switch_at.load(Ordering::SeqCst);
        if switch_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now_ms.saturating_sub(switch_ms) < 500 {
                return Ok(());
            }
        }
    }

    // Reject seek up-front for non-seekable streaming sources so the frontend's
    // restart-fallback engages instead of rolling the dice on the format reader
    // (which can consume the ring buffer to EOF for forward seeks → next song).
    if !state.current_is_seekable.load(Ordering::SeqCst) {
        crate::app_deprintln!("[seek] rejected → not-seekable source (legacy stream)");
        return Err("source is not seekable".into());
    }
    crate::app_deprintln!("[seek] target={:.2}s", seconds);

    let lock_current_with_timeout = |timeout_ms: u64| {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            match state.current.try_lock() {
                Ok(guard) => break Ok(guard),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        break Err("audio seek busy".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(TryLockError::Poisoned(_)) => {
                    break Err("audio state lock poisoned".to_string());
                }
            }
        }
    };

    // Seeking back invalidates any pending gapless chain.
    let cur_pos = {
        let cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
        cur.position()
    };
    if seconds < cur_pos - 1.0 {
        *state.chained_info.lock().unwrap() = None;
    }

    let seek_seconds = seconds.max(0.0);
    let seek_duration = Duration::from_secs_f64(seek_seconds);
    let seek_generation = state.generation.load(Ordering::SeqCst);
    let sink = {
        let cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
        match cur.sink.as_ref() {
            Some(sink) => Arc::clone(sink),
            None => return Ok(()),
        }
    };

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = sink.try_seek(seek_duration).map_err(|e| e.to_string());
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_millis(AUDIO_SEEK_TIMEOUT_MS)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err("audio seek timeout".into());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err("audio seek worker disconnected".into());
        }
    }

    // If playback switched while seek was in flight, skip timestamp updates.
    if state.generation.load(Ordering::SeqCst) != seek_generation {
        return Ok(());
    }

    let mut cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
    if cur.sink.is_none() { return Ok(()); }

    if cur.paused_at.is_some() {
        cur.paused_at = Some(seek_seconds);
    } else {
        cur.seek_offset = seek_seconds;
        cur.play_started = Some(Instant::now());
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(volume: f32, state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    let prev_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        let next_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
        ramp_sink_volume(Arc::clone(sink), prev_effective, next_effective);
    }
}

#[tauri::command]
pub fn audio_update_replay_gain(
    volume: f32,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    loudness_gain_db: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) {
    let norm_mode = state.normalization_engine.load(Ordering::Relaxed);
    let target_lufs = f32::from_bits(state.normalization_target_lufs.load(Ordering::Relaxed));
    let pre_analysis_db = loudness_pre_analysis_db_for_engine(&state);
    let url_for_loudness = if norm_mode == 2 {
        state.current_playback_url.lock().unwrap().clone()
    } else {
        None
    };
    let logical_for_loudness = state
        .current_analysis_track_id
        .lock()
        .ok()
        .and_then(|g| (*g).clone())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // If `current_playback_url` is not pinned yet, still honour JS `loudness_gain_db`
    // for the uncached path (`effective_loudness_db` / UI gain follow from `compute_gain`).
    let cache_loudness = url_for_loudness.as_deref().and_then(|u| {
        resolve_loudness_gain_from_cache_impl(
            &app,
            u,
            target_lufs,
            logical_for_loudness.as_deref(),
            ResolveLoudnessCacheOpts {
                touch_waveform: false,
                log_soft_misses: false,
            },
        )
    });
    let effective_loudness_db = if norm_mode == 2 {
        match url_for_loudness.as_deref() {
            Some(_u) => loudness_gain_db_after_resolve(
                cache_loudness,
                target_lufs,
                pre_analysis_db,
                true,
                loudness_gain_db,
            ),
            None => {
                loudness_gain_db.or(Some(loudness_gain_placeholder_until_cache(
                    target_lufs,
                    pre_analysis_db,
                )))
            }
        }
    } else {
        loudness_gain_db
    };
    let (gain_linear, effective) = compute_gain(
        norm_mode,
        replay_gain_db,
        replay_gain_peak,
        effective_loudness_db,
        pre_gain_db,
        fallback_db,
        volume,
    );
    let current_gain_db = loudness_ui_current_gain_db(gain_linear);
    crate::app_deprintln!(
        "[normalization] audio_update_replay_gain engine={} replay_gain_db={:?} replay_gain_peak={:?} loudness_gain_db={:?} gain_linear={:.4} current_gain_db={:?} target_lufs={:.2} volume={:.3} effective={:.3}",
        normalization_engine_name(norm_mode),
        replay_gain_db,
        replay_gain_peak,
        loudness_gain_db,
        gain_linear,
        current_gain_db,
        target_lufs,
        volume,
        effective
    );
    let mut cur = state.current.lock().unwrap();
    let prev_effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    cur.replay_gain_linear = gain_linear;
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        ramp_sink_volume(Arc::clone(sink), prev_effective, effective);
    }
    drop(cur);
    maybe_emit_normalization_state(
        &app,
        NormalizationStatePayload {
            engine: normalization_engine_name(norm_mode).to_string(),
            current_gain_db,
            target_lufs,
        },
    );
}

/// Proxy: fetches https://autoeq.app/entries via Rust to bypass WebView CORS restrictions.
#[tauri::command]
pub async fn autoeq_entries(state: State<'_, AudioEngine>) -> Result<String, String> {
    audio_http_client(&state)
        .get("https://autoeq.app/entries")
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())
}

/// Fetches the AutoEQ FixedBandEQ profile for a specific headphone from GitHub raw content.
///
/// Directory layout in the AutoEQ repo:
///   results/{source}/{form}/{name}/{name} FixedBandEQ.txt           (most sources)
///   results/{source}/{rig} {form}/{name}/{name} FixedBandEQ.txt     (crinacle — rig-prefixed dir)
///
/// We try the rig-prefixed path first (when rig is present), then fall back to form-only.
#[tauri::command]
pub async fn autoeq_fetch_profile(
    name: String,
    source: String,
    rig: Option<String>,
    form: String,
    state: State<'_, AudioEngine>,
) -> Result<String, String> {
    let base = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results";
    let filename = format!("{} FixedBandEQ.txt", name);

    let candidates: Vec<String> = if let Some(ref r) = rig {
        vec![
            format!("{}/{}/{} {}/{}/{}", base, source, r, form, name, filename),
            format!("{}/{}/{}/{}/{}", base, source, form, name, filename),
        ]
    } else {
        vec![format!("{}/{}/{}/{}/{}", base, source, form, name, filename)]
    };

    for url in &candidates {
        let resp = audio_http_client(&state).get(url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return resp.text().await.map_err(|e| e.to_string());
        }
    }

    Err(format!("FixedBandEQ profile not found for '{}'", name))
}

#[tauri::command]
pub fn audio_set_eq(gains: [f32; 10], enabled: bool, pre_gain: f32, state: State<'_, AudioEngine>) {
    state.eq_enabled.store(enabled, Ordering::Relaxed);
    state.eq_pre_gain.store(pre_gain.clamp(-30.0, 6.0).to_bits(), Ordering::Relaxed);
    for (i, &gain) in gains.iter().enumerate() {
        state.eq_gains[i].store(gain.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn audio_preload(
    url: String,
    duration_hint: f64,
    analysis_track_id: Option<String>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    {
        let preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, &url)) {
            let _ = app.emit("audio:preload-ready", url.clone());
            return Ok(());
        }
    }
    // Throttle: wait 8 s before starting the background download so it does not
    // compete with the decode + sink-feed work of the just-started current track.
    // If the user skips during the wait the generation counter changes and we abort.
    let gen_snapshot = state.generation.load(Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(8)).await;
    if state.generation.load(Ordering::Relaxed) != gen_snapshot {
        return Ok(());
    }
    let data: Vec<u8> = if let Some(path) = url.strip_prefix("psysonic-local://") {
        tokio::fs::read(path).await.map_err(|e| e.to_string())?
    } else {
        let response = audio_http_client(&state).get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Ok(());
        }
        response.bytes().await.map_err(|e| e.to_string())?.into()
    };
    let _ = duration_hint; // kept in API for compatibility
    let logical_trim = analysis_track_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(track_id) = analysis_cache_track_id(logical_trim.as_deref(), &url) {
        crate::app_deprintln!(
            "[stream] audio_preload: bytes ready track_id={} size_mib={:.2} — invoking full-track analysis",
            track_id,
            data.len() as f64 / (1024.0 * 1024.0)
        );
        let high = crate::audio::engine::analysis_track_id_is_current_playback(&state, &track_id);
        if let Err(e) = crate::submit_analysis_cpu_seed(app.clone(), track_id.clone(), data.clone(), high).await {
            crate::app_eprintln!("[analysis] preload seed failed for {}: {}", track_id, e);
        }
    }
    let url_for_emit = url.clone();
    *state.preloaded.lock().unwrap() = Some(PreloadedTrack { url, data });
    let _ = app.emit("audio:preload-ready", url_for_emit);
    Ok(())
}

/// Play a live internet radio stream.
///
/// Sends `Icy-MetaData: 1` to request inline ICY metadata.
/// Emits `audio:playing` with `duration = 0.0` (sentinel for live stream)
/// and `radio:metadata` whenever the StreamTitle changes.
#[tauri::command]
pub async fn audio_play_radio(
    url: String,
    volume: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Cancel any active preview so it doesn't keep playing alongside radio.
    preview_clear_for_new_main_playback(&state, &app);

    // Abort any previous radio task before stopping the sink.
    drop(state.radio_state.lock().unwrap().take());

    *state.chained_info.lock().unwrap() = None;
    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.sink.take() { old.stop(); }
    }
    if let Some(old) = state.fading_out_sink.lock().unwrap().take() { old.stop(); }

    // ── Open initial HTTP connection ──────────────────────────────────────────
    let response = audio_http_client(&state)
        .get(&url)
        .header("Icy-MetaData", "1")
        .send()
        .await
        .map_err(|e| {
            let m = format!("radio: connection failed: {e}");
            app.emit("audio:error", &m).ok();
            m
        })?;

    if !response.status().is_success() {
        let m = format!("radio: HTTP {}", response.status());
        app.emit("audio:error", &m).ok();
        return Err(m);
    }

    let fmt_hint = content_type_to_hint(
        response.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );

    // ── Build 4 MB lock-free SPSC ring buffer ─────────────────────────────────
    let rb = HeapRb::<u8>::new(RADIO_BUF_CAPACITY);
    let (prod, cons) = rb.split();

    let (new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapCons<u8>>();
    let flags = Arc::new(RadioSharedFlags {
        is_paused:      AtomicBool::new(false),
        is_hard_paused: AtomicBool::new(false),
        new_cons_tx:    Mutex::new(new_cons_tx),
    });

    // ── Spawn download task ───────────────────────────────────────────────────
    let task = tokio::spawn(radio_download_task(
        gen,
        state.generation.clone(),
        Some(response),
        audio_http_client(&state),
        url.clone(),
        prod,
        flags.clone(),
        app.clone(),
    ));

    *state.radio_state.lock().unwrap() = Some(RadioLiveState {
        url:  url.clone(),
        gen,
        task,
        flags: flags.clone(),
    });

    // ── Build Symphonia decoder in a blocking thread ──────────────────────────
    let reader = AudioStreamReader {
        cons: Mutex::new(cons),
        new_cons_rx: Mutex::new(new_cons_rx),
        deadline: std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS),
        gen_arc:  state.generation.clone(),
        gen,
        source_tag: "radio",
        eof_when_empty: None,
        pos: 0,
    };

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let hint_clone = fmt_hint.clone();
    let decoder = tokio::task::spawn_blocking(move || {
        SizedDecoder::new_streaming(Box::new(reader), hint_clone.as_deref(), "radio")
    })
    .await
    .map_err(|e| e.to_string())??;

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let sample_rate     = decoder.sample_rate();
    let channels        = decoder.channels();
    let done_flag       = Arc::new(AtomicBool::new(false));
    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));
    state.samples_played.store(0, Ordering::Relaxed);

    // Radio: no gapless trim, no ReplayGain, 5 ms fade-in to suppress click.
    let dyn_src   = DynSource::new(decoder);
    let eq_src    = EqSource::new(dyn_src, state.eq_gains.clone(),
                                  state.eq_enabled.clone(), state.eq_pre_gain.clone());
    let fade_in   = EqualPowerFadeIn::new(eq_src, Duration::from_millis(5));
    let fade_out  = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag.clone());
    let counting  = CountingSource::new(notifying, state.samples_played.clone());
    let boosted   = PriorityBoostSource::new(counting);

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let sink = Arc::new(Player::connect_new(state.stream_handle.lock().unwrap().mixer()));
    sink.set_volume((volume.clamp(0.0, 1.0) * MASTER_HEADROOM).clamp(0.0, 1.0));
    sink.append(boosted);

    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.sink.take() { old.stop(); }
        cur.sink              = Some(sink);
        cur.duration_secs     = 0.0; // sentinel: live stream
        cur.seek_offset       = 0.0;
        cur.play_started      = Some(Instant::now());
        cur.paused_at         = None;
        cur.replay_gain_linear = 1.0;
        cur.base_volume       = volume.clamp(0.0, 1.0);
        cur.fadeout_trigger   = Some(fadeout_trigger);
        cur.fadeout_samples   = Some(fadeout_samples);
    }

    *state.current_playback_url.lock().unwrap() = Some(url.clone());

    state.current_sample_rate.store(sample_rate.get(), Ordering::Relaxed);
    state.current_channels.store(channels.get() as u32, Ordering::Relaxed);

    app.emit("audio:playing", 0.0f64).ok();

    spawn_progress_task(
        gen,
        state.generation.clone(),
        state.current.clone(),
        state.chained_info.clone(),
        state.crossfade_enabled.clone(),
        state.crossfade_secs.clone(),
        done_flag,
        app,
        state.samples_played.clone(),
        state.current_sample_rate.clone(),
        state.current_channels.clone(),
        state.gapless_switch_at.clone(),
        state.current_playback_url.clone(),
    );

    Ok(())
}

/// If the pinned id is missing from cpal's list but another listed id is the same
/// physical sink (e.g. suffix drift), rewrite `selected_device` to the listed form.
#[tauri::command]
pub fn audio_canonicalize_selected_device(state: State<'_, AudioEngine>) -> Option<String> {
    let pinned = state.selected_device.lock().unwrap().clone()?;
    if pinned.is_empty() {
        return None;
    }
    let list = enumerate_output_device_names();
    if list.iter().any(|d| d == &pinned) {
        return None;
    }
    let canon = list
        .iter()
        .find(|d| output_devices_logically_same(d, &pinned))?
        .clone();
    *state.selected_device.lock().unwrap() = Some(canon.clone());
    Some(canon)
}

/// Same device list as [`audio_list_devices`] without the Tauri `State` wrapper (CLI / single-instance).
pub fn audio_list_devices_for_engine(engine: &AudioEngine) -> Vec<String> {
    let mut list = enumerate_output_device_names();
    if let Some(ref name) = *engine.selected_device.lock().unwrap() {
        if !name.is_empty() && !output_enumeration_includes_pinned(&list, name) {
            list.push(name.clone());
        }
    }
    list
}

/// Returns the names of all available audio output devices on the current host.
/// On Linux, ALSA probes unavailable backends (JACK, OSS, dmix) and prints errors to
/// stderr. We suppress fd 2 for the duration of enumeration to keep the terminal clean.
///
/// The user-pinned device name is appended when cpal omits it (e.g. HDMI busy while
/// streaming) so the Settings dropdown still matches `audioOutputDevice`.
#[tauri::command]
pub fn audio_list_devices(state: State<'_, AudioEngine>) -> Vec<String> {
    audio_list_devices_for_engine(&state)
}

/// Device id string for the host default output (matches an entry from `audio_list_devices` when present).
#[tauri::command]
pub fn audio_default_output_device_name() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.default_output_device()
            .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
    })
}

/// Switch the audio output device. `device_name = null` → follow system default.
/// Reopens the stream immediately; frontend must restart playback via audio:device-changed.
#[tauri::command]
pub async fn audio_set_device(
    device_name: Option<String>,
    state: State<'_, AudioEngine>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    *state.selected_device.lock().unwrap() = device_name.clone();

    let rate = state.stream_sample_rate.load(Ordering::Relaxed);
    let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<Arc<rodio::MixerDeviceSink>>(0);
    state.stream_reopen_tx
        .send((rate, false, device_name, reply_tx))
        .map_err(|e| e.to_string())?;

    let new_handle = tauri::async_runtime::spawn_blocking(move || {
        reply_rx.recv_timeout(Duration::from_secs(5)).ok()
    }).await.unwrap_or(None).ok_or("device open timed out")?;

    *state.stream_handle.lock().unwrap() = new_handle;

    // Drop active sinks — they were bound to the old stream.
    if let Some(s) = state.current.lock().unwrap().sink.take() { s.stop(); }
    if let Some(s) = state.fading_out_sink.lock().unwrap().take() { s.stop(); }

    app.emit("audio:device-changed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn audio_set_crossfade(enabled: bool, secs: f32, state: State<'_, AudioEngine>) {
    state.crossfade_enabled.store(enabled, Ordering::Relaxed);
    state.crossfade_secs.store(secs.clamp(0.1, 12.0).to_bits(), Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_set_gapless(enabled: bool, state: State<'_, AudioEngine>) {
    state.gapless_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_set_normalization(
    engine: String,
    target_lufs: f32,
    pre_analysis_attenuation_db: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) {
    let mode = match engine.as_str() {
        "replaygain" => 1,
        "loudness" => 2,
        _ => 0,
    };
    state.normalization_engine.store(mode, Ordering::Relaxed);
    let target = target_lufs.clamp(-30.0, -8.0);
    state
        .normalization_target_lufs
        .store(target.to_bits(), Ordering::Relaxed);
    let pre = pre_analysis_attenuation_db.clamp(-24.0, 0.0).min(0.0);
    state
        .loudness_pre_analysis_attenuation_db
        .store(pre.to_bits(), Ordering::Relaxed);
    crate::app_deprintln!(
        "[normalization] audio_set_normalization requested_engine={} resolved_engine={} target_lufs={:.2} pre_analysis_db={:.2}",
        engine,
        normalization_engine_name(mode),
        target,
        pre
    );
    maybe_emit_normalization_state(
        &app,
        NormalizationStatePayload {
            engine: normalization_engine_name(mode).to_string(),
            // At mode-switch time the effective track gain may not be recalculated yet.
            // Emit `None` and let audio_play/audio_update_replay_gain publish actual value.
            current_gain_db: None,
            target_lufs: target,
        },
    );
}

//! Tauri commands: audio_play / chain_preload / preload + the shared
//! spawn_progress_task helper. Transport (pause/resume/stop/seek), device,
//! radio, mix-mode and AutoEQ commands live in sibling modules.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rodio::Player;
use rodio::Source;
use tauri::{AppHandle, Emitter, State};

use super::decode::build_source;
use super::engine::AudioEngine;
use super::helpers::*;
use super::hi_res_blend::{self, OutgoingBlendSnapshot};
use super::ipc::{maybe_emit_normalization_state, NormalizationStatePayload};
use super::play_input::{select_play_input, url_format_hint, PlayInputContext};
use super::source_build::{build_playback_source_with_probe_fallback, BuildSourceArgs};
use super::sink_swap::{
    spawn_legacy_stream_start_when_armed, swap_in_new_sink, LegacyStreamStartWhenArmed,
    SinkSwapInputs,
};
use super::playback_rate::{preserve_pitch_will_run, raw_counter_samples_for_content_position};
use super::preview::preview_clear_for_new_main_playback;
use super::progress_task::spawn_progress_task;
use super::state::{ChainedInfo, PreloadedTrack};

// ─── Commands ─────────────────────────────────────────────────────────────────

/// `analysis_track_id`: Subsonic `song.id` from the UI — ties waveform/loudness
/// cache to the track when playing `psysonic-local://` (hot/offline). Optional
/// for HTTP streams (`playback_identity` is used as fallback).
///
/// `server_id`: app id of the server that owns this track (`playbackServerId ??
/// activeServerId` on the frontend). Scopes the analysis-cache write key so a
/// later server switch can't surface another server's waveform for the same bare
/// `track_id`. Empty/absent falls back to the legacy `''` scope.
///
/// `stream_format_suffix`: Subsonic `song.suffix` (e.g. m4a); `stream.view` URLs have no
/// file extension, so this helps pick a Symphonia `format_hint` for ranged HTTP.
#[tauri::command]
// NOTE: excluded from tauri-specta collect_commands! — specta's SpectaFn is only
// implemented up to 10 args and this has 24. Typing it needs the args bundled into
// a struct (a behaviour/contract change), tracked for the D4 flip; stays on
// generate_handler! for now.
#[allow(clippy::too_many_arguments)]
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
  hi_res_crossfade_resample_hz: Option<u32>, // 44100 / 88200 / 96000 when hi-res + crossfade
    analysis_track_id: Option<String>,
    server_id: Option<String>,
    stream_format_suffix: Option<String>,
    // Silent load: no `audio:playing`, sink stays paused. Optional + defaults to
    // `false` so older/external `audio_play` callers that omit it still work.
    start_paused: Option<bool>,
    // Silence-aware crossfade (B-head): begin playback past the next track's
    // leading silence. Optional + defaults to `0` so existing callers are
    // unaffected; only applied when the freshly built source is seekable.
    start_secs: Option<f64>,
    // Dynamic crossfade (phase 2): per-transition overlap length, computed by the
    // frontend from both tracks' waveform envelopes. Caps the fade for *this*
    // transition instead of the global `crossfade_secs`. `None` → use the global
    // setting (today's behaviour); always still clamped to the measured remaining.
    crossfade_secs_override: Option<f32>,
    // Scenario A (dynamic crossfade): engine fade-out length for the *outgoing*
    // track A, decoupled from B's fade-in. `Some(0)` → don't fade A at all (it
    // already fades out in the recording, so let it ride at full engine gain
    // while B rises underneath); `Some(x)` → fade A over x s; `None` → mirror
    // B's fade (today's behaviour). Always clamped to A's measured remaining.
    outgoing_fade_secs_override: Option<f32>,
    // AutoDJ smooth skip: short outgoing fade when the user hits next/previous
    // while a track is playing. Optional; only honoured when `manual` is true.
    manual_autodj_blend: Option<bool>,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let start_paused = start_paused.unwrap_or(false);
    let start_secs = start_secs.unwrap_or(0.0).max(0.0);
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
    // Ranged/legacy HTTP paths reset this to false in `select_play_input`.
    state.stream_playback_armed.store(true, Ordering::SeqCst);

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
    // Playback server scope for the analysis-cache write key (empty → legacy '').
    let analysis_server_id = server_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // Pin it so the gain-resolution + replay-gain-update + device-resume reads
    // scope to this server too (mirrors `current_analysis_track_id`).
    *state.current_playback_server_id.lock().unwrap() = analysis_server_id.map(str::to_string);

    let format_hint = url_format_hint(&url);

    let play_input = match select_play_input(
        PlayInputContext {
            url: &url,
            gen,
            duration_hint,
            stream_format_suffix: stream_format_suffix.as_deref(),
            format_hint: format_hint.as_deref(),
            cache_id_for_tasks: cache_id_for_tasks.as_deref(),
            server_id: analysis_server_id,
            reuse_chained_bytes,
        },
        &state,
        &app,
    ).await? {
        Some(input) => input,
        None => {
            crate::app_deprintln!(
                "[audio] audio_play superseded inside select_play_input: gen={} cur={} track_id={:?}",
                gen, state.generation.load(Ordering::SeqCst), cache_id_for_tasks
            );
            return Ok(());
        }
    };


    if state.generation.load(Ordering::SeqCst) != gen {
        crate::app_deprintln!(
            "[audio] audio_play superseded after select_play_input: gen={} cur={} track_id={:?}",
            gen, state.generation.load(Ordering::SeqCst), cache_id_for_tasks
        );
        return Ok(());
    }

    let gain_inputs = resolve_track_gain_inputs(&state, &app, &url, logical_trim.as_deref(), loudness_gain_db);
    let (gain_linear, effective_volume) = compute_gain(
        gain_inputs.norm_mode,
        replay_gain_db,
        replay_gain_peak,
        gain_inputs.effective_loudness_db,
        pre_gain_db,
        fallback_db,
        volume,
    );
    let current_gain_db = loudness_ui_current_gain_db(gain_linear);
    crate::app_deprintln!(
        "[normalization] audio_play track_id={:?} engine={} replay_gain_db={:?} replay_gain_peak={:?} loudness_gain_db={:?} gain_linear={:.4} current_gain_db={:?} target_lufs={:.2} volume={:.3} effective_volume={:.3}",
        playback_identity(&url),
        normalization_engine_name(gain_inputs.norm_mode),
        replay_gain_db,
        replay_gain_peak,
        gain_inputs.cache_loudness_db,
        gain_linear,
        current_gain_db,
        gain_inputs.target_lufs,
        volume,
        effective_volume
    );
    maybe_emit_normalization_state(
        &app,
        NormalizationStatePayload {
            engine: normalization_engine_name(gain_inputs.norm_mode).to_string(),
            current_gain_db,
            target_lufs: gain_inputs.target_lufs,
        },
    );

    // Manual skips bypass crossfade unless AutoDJ smooth skip requests a full blend.
    let manual_blend = manual && manual_autodj_blend.unwrap_or(false);
    let crossfade_enabled =
        state.crossfade_enabled.load(Ordering::Relaxed) && (!manual || manual_blend);
    // Per-transition override (dynamic crossfade) caps the fade for this swap;
    // otherwise fall back to the global crossfade length. Both clamped the same.
    let crossfade_secs_val = if let Some(override_secs) = crossfade_secs_override {
        override_secs.clamp(0.5, 30.0)
    } else {
        f32::from_bits(state.crossfade_secs.load(Ordering::Relaxed))
            .clamp(0.5, 12.0)
    };

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

    // Outgoing (Track A) fade-out, decoupled from B's fade-in. Defaults to
    // `actual_fade_secs` (symmetric crossfade, today's behaviour); a `Some(0)`
    // override means A already fades out in the recording, so we leave it at
    // full engine gain (scenario A). Never longer than A's remaining audio.
    let outgoing_fade_secs: f32 = if crossfade_enabled {
        match outgoing_fade_secs_override {
            Some(v) => v.max(0.0).min(actual_fade_secs),
            None => actual_fade_secs,
        }
    } else {
        0.0
    };

    let blend_rate = hi_res_blend::blend_rate_hz(
        hi_res_enabled,
        crossfade_enabled || (gapless && !manual),
        hi_res_crossfade_resample_hz,
    );
    let resample_target_hz = blend_rate.unwrap_or(0);

    // Build source: decode → trim → resample → EQ → fade-in → fade-out → notify → count.
    let done_flag = Arc::new(AtomicBool::new(false));
    // Reset sample counter for the new track.
    state.samples_played.store(0, Ordering::Relaxed);
    let playback_source = build_playback_source_with_probe_fallback(
        play_input,
        BuildSourceArgs {
            url: &url,
            gen,
            cache_id_for_tasks: cache_id_for_tasks.as_deref(),
            server_id: analysis_server_id,
            url_format_hint: format_hint.as_deref(),
            stream_format_suffix: stream_format_suffix.as_deref(),
            done_flag: done_flag.clone(),
            fade_in_dur,
            hi_res_enabled,
            resample_target_hz,
            duration_hint,
        },
        &state,
        &app,
    )
    .await
    .map_err(|e| {
        // Suppress the audio:error toast when this play was already superseded
        // by a newer audio_play (rapid skip): the failure is the inevitable
        // Ok(0)/EOF from RangedHttpSource after gen-bump, not a real codec
        // problem. The frontend would otherwise show "Couldn't play track" for
        // the abandoned URL while a new track is already loading.
        if state.generation.load(Ordering::SeqCst) == gen {
            app.emit("audio:error", &e).ok();
        } else {
            crate::app_deprintln!(
                "[audio] suppressed audio:error for superseded play (gen={} cur={}): {}",
                gen, state.generation.load(Ordering::SeqCst), e
            );
        }
        e
    })?;
    state.current_is_seekable.store(playback_source.is_seekable, Ordering::SeqCst);
    let source_seekable = playback_source.is_seekable;
    let built = playback_source.built;
    let mut source = built.source;
    let duration_secs = built.duration_secs;
    let output_rate = built.output_rate;
    let output_channels = built.output_channels;

    // Store the actual output rate/channels for position calculation.
    state.current_sample_rate.store(output_rate, Ordering::Relaxed);
    state.current_channels.store(output_channels as u32, Ordering::Relaxed);

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let current_stream_rate = state.stream_sample_rate.load(Ordering::Relaxed);
    let outgoing_blend: Option<OutgoingBlendSnapshot> =
        if let Some(blend) = blend_rate {
            if crossfade_enabled && current_stream_rate > 0 && current_stream_rate != blend {
                hi_res_blend::capture_outgoing_blend_snapshot(
                    &state,
                    outgoing_fade_secs,
                    actual_fade_secs,
                )
            } else {
                None
            }
        } else {
            None
        };

    if outgoing_blend.is_some() {
        hi_res_blend::detach_current_sink_for_blend_reopen(&state);
    }

    // ── Stream rate management ────────────────────────────────────────────────
    // Hi-Res ON:  open device at file's native rate (bit-perfect, no resampler).
    // Hi-Res OFF: if the stream was previously opened at a hi-res rate (e.g. the
    //             toggle was just turned off mid-session), restore the device
    //             default rate so playback is no longer at 88.2/96 kHz etc.
    //             If already at the device default — skip entirely (no IPC, no
    //             PipeWire reconfigure, no scheduler cost).
    {
        let target_rate = if let Some(blend) = blend_rate {
            blend
        } else if hi_res_enabled {
            output_rate // native file rate
        } else {
            state.device_default_rate // restore device default
        };
        let needs_switch = target_rate > 0 && target_rate != current_stream_rate;
        if needs_switch {
            let dev = state.selected_device.lock().unwrap().clone();
            match super::engine::open_output_stream_blocking(
                &state,
                target_rate,
                hi_res_enabled,
                dev,
            ) {
                Ok(_) => {
                    // Give PipeWire time to reconfigure at the new rate before
                    // we open a Sink — only needed for large hi-res quanta.
                    if hi_res_enabled && target_rate > 48_000 {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                }
                Err(_) => {
                    crate::app_eprintln!(
                        "[psysonic] stream rate switch timed out, keeping {current_stream_rate} Hz"
                    );
                }
            }
        }

        // Re-check gen: a rapid skip during the settle sleep would have bumped it.
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(());
        }
    }

    if let (Some(snap), Some(blend)) = (&outgoing_blend, blend_rate) {
        if let Err(e) = hi_res_blend::spawn_outgoing_blend_resample(
            &app,
            &state,
            snap,
            blend,
            gen,
        )
        .await
        {
            crate::app_eprintln!("{e}");
        }
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(());
        }
    }

    let stream = super::engine::ensure_output_stream_open(&state)?;
    let sink = Arc::new(Player::connect_new(stream.mixer()));
    sink.set_volume(effective_volume);

    // ── Sink pre-fill for hi-res tracks ──────────────────────────────────────
    // At sample rates > 48 kHz the hardware quantum is larger and the first
    // period demands more decoded frames than at 44.1/48 kHz.
    // Strategy: pause the sink before appending so rodio's internal mixer
    // decodes into its ring buffer ahead of the hardware. After a short delay
    // we resume — the buffer is already full and the hardware gets its frames
    // without an underrun on the very first period.
    // Standard mode: no pre-fill needed — default 44.1/48 kHz quantum is small.
    // Preserve-pitch phase vocoder runs on a worker thread; pre-fill gives the
    // ring buffer time to build headroom before the cpal callback drains it.
    let needs_preserve_prefill = preserve_pitch_will_run(&state.playback_rate);
    let needs_prefill =
        (hi_res_enabled && blend_rate.unwrap_or(output_rate) > 48_000) || needs_preserve_prefill;
    let defer_playback_start = !state.stream_playback_armed.load(Ordering::Relaxed);
    if needs_prefill || defer_playback_start {
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

    // Silence-aware crossfade (B-head): skip the next track's leading silence by
    // seeking the freshly built source before it is appended. The outermost
    // `CountingSource` stores the sample counter on a successful seek; we still
    // re-seed `samples_played` + `seek_offset` explicitly after the swap (below)
    // so the seekbar and the crossfade-remaining math are content-relative.
    let did_start_seek = if start_secs > 0.05 && source_seekable {
        source.try_seek(Duration::from_secs_f64(start_secs)).is_ok()
    } else {
        false
    };

    sink.append(source);

    if needs_prefill {
        let prefill_ms = if needs_preserve_prefill {
            800
        } else {
            500
        };
        tokio::time::sleep(Duration::from_millis(prefill_ms)).await;
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(()); // skipped during pre-fill — abort silently
        }
        if !defer_playback_start && !start_paused {
            sink.play();
        }
    }

    swap_in_new_sink(&state, SinkSwapInputs {
        sink,
        duration_secs,
        volume,
        gain_linear,
        fadeout_trigger: built.fadeout_trigger,
        fadeout_samples: built.fadeout_samples,
        crossfade_enabled,
        actual_fade_secs,
        outgoing_fade_secs,
        start_paused,
    });

    // B-head: `swap_in_new_sink` resets `seek_offset` to 0 and starts the play
    // clock — re-anchor both the wall-clock baseline (`seek_offset`) and the
    // sample counter to the content offset so position reporting is correct.
    if did_start_seek {
        {
            let mut cur = state.current.lock().unwrap();
            cur.seek_offset = start_secs;
        }
        state.samples_played.store(
            raw_counter_samples_for_content_position(
                start_secs,
                output_rate,
                output_channels as u32,
                &state.playback_rate,
            ),
            Ordering::Relaxed,
        );
    }

    if defer_playback_start {
        if !start_paused {
            let mut cur = state.current.lock().unwrap();
            cur.play_started = None;
            cur.paused_at = Some(0.0);
        }
        spawn_legacy_stream_start_when_armed(LegacyStreamStartWhenArmed {
            gen,
            gen_arc: state.generation.clone(),
            playback_armed: state.stream_playback_armed.clone(),
            samples_played: state.samples_played.clone(),
            current: state.current.clone(),
            app: app.clone(),
            duration_secs,
            hold_paused: start_paused,
        });
    } else if !start_paused {
        app.emit("audio:playing", duration_secs).ok();
    }

    // ── Progress + ended detection ────────────────────────────────────────────
    let analysis_app = app.clone();
    spawn_progress_task(
        gen,
        state.generation.clone(),
        state.current.clone(),
        state.chained_info.clone(),
        state.crossfade_enabled.clone(),
        state.crossfade_secs.clone(),
        state.autodj_suppress_autocrossfade.clone(),
        done_flag,
        app,
        Some(analysis_app),
        state.samples_played.clone(),
        state.current_sample_rate.clone(),
        state.current_channels.clone(),
        state.gapless_switch_at.clone(),
        state.current_playback_url.clone(),
        state.stream_playback_armed.clone(),
        state.playback_rate.clone(),
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
// NOTE: excluded from tauri-specta collect_commands! — 13 args exceed specta's
// 10-arg SpectaFn limit; needs arg-bundling for the D4 flip. Stays on
// generate_handler! for now.
#[allow(clippy::too_many_arguments)]
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
    hi_res_crossfade_resample_hz: Option<u32>,
    analysis_track_id: Option<String>,
    server_id: Option<String>,
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
        } else if let Some(path) = url.strip_prefix("psysonic-local://") {
            tokio::fs::read(path).await.map_err(|e| e.to_string())?
        } else {
            let resp = crate::engine::playback_scoped_get(
                &state,
                &app,
                &url,
                server_id.as_deref(),
            )
            .send()
            .await
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
    let analysis_server_id = server_id.as_deref().map(str::trim).filter(|s| !s.is_empty());

    if let Some(track_id) = analysis_cache_track_id(logical_trim.as_deref(), &url) {
        let (sid, priority) = crate::analysis_dispatch::prepare_playback_analysis(
            &app,
            &state,
            analysis_server_id,
            &track_id,
            Some(psysonic_analysis::analysis_runtime::AnalysisBackfillPriority::Middle),
        );
        let bytes = (*raw_bytes).clone();
        crate::analysis_dispatch::spawn_track_analysis_bytes(
            app.clone(),
            crate::analysis_dispatch::TrackAnalysisOrigin::GaplessChainReady,
            sid,
            track_id,
            bytes,
            priority,
            None,
        );
    }

    // Only `gain_linear` is needed — `effective_volume` is intentionally NOT
    // applied to the Sink here. `audio_chain_preload` runs ~30 s before the
    // current track ends, and `Sink::set_volume` affects the WHOLE Sink (incl.
    // the still-playing current source). Volume for the chained track is
    // applied at the gapless transition in `spawn_progress_task`, not here.
    let gain_inputs = resolve_track_gain_inputs(&state, &app, &url, logical_trim.as_deref(), loudness_gain_db);
    let (gain_linear, _effective_volume) = compute_gain(
        gain_inputs.norm_mode,
        replay_gain_db,
        replay_gain_peak,
        gain_inputs.effective_loudness_db,
        pre_gain_db,
        fallback_db,
        volume,
    );

    let done_next = Arc::new(AtomicBool::new(false));
    // Use a dedicated counter for the chained source — it will be swapped into
    // samples_played when the chained track becomes active.
    let chain_counter = Arc::new(AtomicU64::new(0));
    // Always 0 unless hi-res gapless blend resampling is active.
    let blend_rate = hi_res_blend::blend_rate_hz(hi_res_enabled, hi_res_enabled, hi_res_crossfade_resample_hz);
    let target_rate: u32 = blend_rate.unwrap_or(0);
    let format_hint = url.rsplit('.').next()
        .and_then(|ext| ext.split('?').next())
        .map(|s| s.to_lowercase());
    let built = build_source(
        (*raw_bytes).clone(),
        duration_hint,
        state.eq_gains.clone(),
        state.eq_enabled.clone(),
        state.eq_pre_gain.clone(),
        state.playback_rate.clone(),
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

    // Hi-res gapless: resample the chained track to the blend rate and realign
    // the output stream when its Hz differs from the current track.
    let stream_rate = state.stream_sample_rate.load(Ordering::Relaxed);
    if let Some(br) = blend_rate {
        if stream_rate > 0 && stream_rate != br {
            if let Some(snap) = hi_res_blend::capture_outgoing_blend_snapshot(&state, 0.0, 0.0) {
                hi_res_blend::detach_current_sink_for_blend_reopen(&state);
                let dev = state.selected_device.lock().unwrap().clone();
                if super::engine::open_output_stream_blocking(&state, br, true, dev).is_ok() {
                    if hi_res_enabled && br > 48_000 {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                    if state.generation.load(Ordering::SeqCst) == snapshot_gen {
                        if let Err(e) = hi_res_blend::rebuild_current_track_at_blend_rate(
                            &app,
                            &state,
                            &snap,
                            br,
                            snapshot_gen,
                        )
                        .await
                        {
                            crate::app_eprintln!("{e}");
                            *state.preloaded.lock().unwrap() = Some(PreloadedTrack {
                                url: url.clone(),
                                data: Arc::try_unwrap(raw_bytes).unwrap_or_else(|a| (*a).clone()),
                            });
                            return Ok(());
                        }
                    }
                } else {
                    crate::app_eprintln!(
                        "[psysonic] gapless blend stream reopen failed (wanted {br} Hz, had {stream_rate} Hz)"
                    );
                    *state.preloaded.lock().unwrap() = Some(PreloadedTrack {
                        url,
                        data: Arc::try_unwrap(raw_bytes).unwrap_or_else(|a| (*a).clone()),
                    });
                    return Ok(());
                }
            } else {
                crate::app_eprintln!(
                    "[psysonic] gapless blend skipped: current track not cached for realign"
                );
                *state.preloaded.lock().unwrap() = Some(PreloadedTrack {
                    url,
                    data: Arc::try_unwrap(raw_bytes).unwrap_or_else(|a| (*a).clone()),
                });
                return Ok(());
            }
        }
    } else {
        let next_rate = if hi_res_enabled { built.output_rate } else { 44_100 };
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
        analysis_track_id: logical_trim,
        server_id: analysis_server_id.map(str::to_string),
        raw_bytes,
        duration_secs,
        replay_gain_linear: gain_linear,
        base_volume: volume.clamp(0.0, 1.0),
        source_done: done_next,
        sample_counter: chain_counter,
    });

    Ok(())
}


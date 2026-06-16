//! Rust-side seamless replay after an output-device switch.
//!
//! `try_resume_after_device_change` is called from `reopen_output_stream`
//! (device_watcher.rs) after the new CPAL stream is ready and the old sink
//! has been stopped. It attempts to restart the current track on the new
//! device without any frontend round-trip.
//!
//! Supported source paths (in order of preference):
//!   - `psysonic-local://` — opened directly from disk via `LocalFileSource`.
//!   - HTTP, fully cached in RAM — replayed from `stream_completed_cache`.
//!   - HTTP, spilled to disk — bytes read from `stream_completed_spill`.
//!
//! Falls back to the frontend (returns `false`) for:
//!   - paused playback
//!   - radio / live stream
//!   - HTTP track whose download was only partial
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use rodio::Player;
use tauri::Emitter;
use tauri::Manager;

use super::engine::AudioEngine;
use super::play_input::{url_format_hint, PlayInput};
use super::source_build::{
    build_playback_source_with_probe_fallback, BuildSourceArgs, PlaybackSource,
};
use super::sink_swap::{swap_in_new_sink, SinkSwapInputs};
use super::progress_task::spawn_progress_task;
use super::stream::LocalFileSource;

/// Snapshot of playback state captured before the blocking stream reopen.
pub(crate) struct ResumeSnapshot {
    pub(crate) url: Option<String>,
    pub(crate) current_time_secs: f64,
    pub(crate) duration_secs: f64,
    pub(crate) base_volume: f32,
    pub(crate) gain_linear: f32,
    pub(crate) analysis_track_id: Option<String>,
    pub(crate) is_playing: bool,
}

/// Try to replay the current track on the new device without involving the
/// frontend. Returns `true` if playback was successfully restarted.
///
/// Conditions that cause an immediate `false` (frontend fallback):
/// - Paused playback — user can press play on the new device via the cold path.
/// - Radio stream — live, non-seekable; frontend handles reconnect.
/// - No current URL — nothing was playing.
/// - HTTP track whose download was only partial (cache/spill absent) — frontend
///   re-fetches from the server via the seekFallbackVisualTarget path.
pub(crate) async fn try_resume_after_device_change(
    app: &tauri::AppHandle,
    snap: &ResumeSnapshot,
) -> bool {
    // Only resume actively-playing (not paused) tracks.
    if !snap.is_playing {
        return false;
    }
    let url = match snap.url.as_deref() {
        Some(u) if !u.is_empty() => u,
        _ => return false,
    };

    let Some(engine) = app.try_state::<AudioEngine>() else {
        return false;
    };

    // Skip radio — live streams don't have a resume position.
    if engine.radio_state.lock().unwrap().is_some() {
        return false;
    }

    // Build a PlayInput without re-downloading:
    //   - psysonic-local://  → seekable file
    //   - HTTP, fully cached → in-memory bytes (stream_completed_cache)
    //   - HTTP, spilled      → bytes read from spill file
    //   - HTTP, partial      → return false (frontend will re-fetch)
    let play_input: PlayInput = if url.starts_with("psysonic-local://") {
        let path = url.strip_prefix("psysonic-local://").unwrap_or(url);
        match std::fs::File::open(path) {
            Ok(file) => {
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                PlayInput::SeekableMedia {
                    reader: Box::new(LocalFileSource { file, len }),
                    format_hint: url_format_hint(url),
                    tag: "LocalFile[device-resume]",
                    random_access: true,
                    mp4_probe_gate: None,
                }
            }
            Err(e) => {
                crate::app_eprintln!("[device-resume] cannot open local file: {e}");
                return false;
            }
        }
    } else {
        // HTTP track — use completed in-memory cache or spill file.
        // If the download was only partial, fall back to the frontend path
        // which will re-fetch from the server.
        let ram_bytes = {
            let guard = engine.stream_completed_cache.lock().unwrap();
            guard.as_ref().filter(|t| t.url == url).map(|t| t.data.clone())
        };
        let bytes = if let Some(b) = ram_bytes {
            b
        } else {
            let spill_path = {
                let guard = engine.stream_completed_spill.lock().unwrap();
                guard.as_ref().filter(|s| s.url == url).map(|s| s.path.clone())
            };
            match spill_path {
                Some(p) => match std::fs::read(&p) {
                    Ok(b) => b,
                    Err(e) => {
                        crate::app_eprintln!("[device-resume] spill read failed: {e}");
                        return false;
                    }
                },
                None => return false, // not fully cached yet — frontend will re-fetch
            }
        };
        PlayInput::Bytes(bytes)
    };

    // Bump generation so the old progress task exits cleanly.
    let gen = engine.generation.fetch_add(1, Ordering::SeqCst) + 1;
    engine.stream_playback_armed.store(true, Ordering::SeqCst);
    *engine.chained_info.lock().unwrap() = None;
    *engine.current_playback_url.lock().unwrap() = Some(url.to_owned());

    if engine.generation.load(Ordering::SeqCst) != gen {
        return false; // raced with another audio_play
    }

    let format_hint = url_format_hint(url);
    let stream_format_suffix: Option<String> = url
        .rsplit('.')
        .next()
        .and_then(|e| e.split('?').next())
        .map(|s| s.to_lowercase());
    let done_flag = Arc::new(AtomicBool::new(false));
    engine.samples_played.store(0, Ordering::Relaxed);

    let hi_res_enabled = engine.current_sample_rate.load(Ordering::Relaxed) > 48_000;
    // Resume re-plays the current track → scope its analysis writes to the
    // pinned playback server (empty → legacy '').
    let resume_server = crate::helpers::current_playback_server_id_str(&engine);

    let ps: PlaybackSource = match build_playback_source_with_probe_fallback(
        play_input,
        BuildSourceArgs {
            url,
            gen,
            cache_id_for_tasks: snap.analysis_track_id.as_deref(),
            server_id: Some(resume_server.as_str()),
            url_format_hint: format_hint.as_deref(),
            stream_format_suffix: stream_format_suffix.as_deref(),
            done_flag: done_flag.clone(),
            fade_in_dur: std::time::Duration::from_millis(5),
            hi_res_enabled,
            duration_hint: snap.duration_secs,
        },
        &engine,
        app,
    )
    .await
    {
        Ok(ps) => ps,
        Err(e) => {
            crate::app_eprintln!("[device-resume] source build failed: {e}");
            return false;
        }
    };

    if engine.generation.load(Ordering::SeqCst) != gen {
        return false;
    }

    engine
        .current_is_seekable
        .store(ps.is_seekable, Ordering::SeqCst);
    engine
        .current_sample_rate
        .store(ps.built.output_rate, Ordering::Relaxed);
    engine
        .current_channels
        .store(ps.built.output_channels as u32, Ordering::Relaxed);

    let stream = match super::engine::ensure_output_stream_open(&engine) {
        Ok(s) => s,
        Err(e) => {
            crate::app_eprintln!("[device-resume] output stream open failed: {e}");
            return false;
        }
    };
    let sink = Arc::new(Player::connect_new(stream.mixer()));
    let effective_volume = (snap.base_volume * snap.gain_linear).clamp(0.0, 1.0);
    sink.set_volume(effective_volume);
    sink.append(ps.built.source);

    swap_in_new_sink(
        &engine,
        SinkSwapInputs {
            sink,
            duration_secs: ps.built.duration_secs,
            volume: snap.base_volume,
            gain_linear: snap.gain_linear,
            fadeout_trigger: ps.built.fadeout_trigger,
            fadeout_samples: ps.built.fadeout_samples,
            crossfade_enabled: false,
            actual_fade_secs: 0.0,
            start_paused: false,
        },
    );

    // Seek to the saved position for seekable sources (local files, ranged HTTP).
    if ps.is_seekable && snap.current_time_secs > 0.5 {
        let seek_sink = engine.current.lock().unwrap().sink.as_ref().map(Arc::clone);
        if let Some(sk) = seek_sink {
            let target = std::time::Duration::from_secs_f64(snap.current_time_secs.max(0.0));
            let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
            std::thread::spawn(move || {
                let _ = tx.send(sk.try_seek(target).map_err(|e| e.to_string()));
            });
            match rx.recv_timeout(std::time::Duration::from_millis(700)) {
                Ok(Ok(())) => {
                    let mut cur = engine.current.lock().unwrap();
                    cur.seek_offset = snap.current_time_secs;
                    cur.play_started = Some(Instant::now());
                    engine.samples_played.store(
                        crate::playback_rate::raw_counter_samples_for_content_position(
                            snap.current_time_secs,
                            engine.current_sample_rate.load(Ordering::Relaxed),
                            engine.current_channels.load(Ordering::Relaxed),
                            &engine.playback_rate,
                        ),
                        Ordering::Relaxed,
                    );
                }
                Ok(Err(e)) => {
                    crate::app_eprintln!("[device-resume] seek failed: {e}");
                }
                Err(_) => {
                    crate::app_eprintln!("[device-resume] seek timed out");
                }
            }
        }
    }

    // Inform the frontend of the new duration (keeps seekbar range correct).
    app.emit("audio:playing", ps.built.duration_secs).ok();

    let analysis_app = app.clone();
    spawn_progress_task(
        gen,
        engine.generation.clone(),
        engine.current.clone(),
        engine.chained_info.clone(),
        engine.crossfade_enabled.clone(),
        engine.crossfade_secs.clone(),
        done_flag,
        app.clone(),
        Some(analysis_app),
        engine.samples_played.clone(),
        engine.current_sample_rate.clone(),
        engine.current_channels.clone(),
        engine.gapless_switch_at.clone(),
        engine.current_playback_url.clone(),
        engine.stream_playback_armed.clone(),
        engine.playback_rate.clone(),
    );

    crate::app_deprintln!(
        "[device-resume] internal replay ok — url={url:?} resume_at={:.2}s seekable={}",
        snap.current_time_secs,
        ps.is_seekable
    );
    true
}

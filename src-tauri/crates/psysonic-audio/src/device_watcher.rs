//! Poll default output device and pinned-device presence; reopen stream when needed.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rodio::Player;
use tauri::Emitter;
use tauri::Manager;

use super::engine::AudioEngine;
use super::play_input::{
    build_playback_source_with_probe_fallback, swap_in_new_sink, url_format_hint,
    BuildSourceArgs, PlayInput, PlaybackSource, SinkSwapInputs,
};
use super::progress_task::spawn_progress_task;
use super::stream::LocalFileSource;
#[cfg(not(target_os = "linux"))]
use super::dev_io::output_enumeration_includes_pinned;

/// What to tell the frontend after a successful stream reopen.
pub(crate) enum ReopenNotify {
    /// Normal path — same as `audio_set_device`.
    DeviceChanged,
    /// Pinned device unplugged (Windows/macOS only); Rust cleared the pin — clear Settings + restart playback.
    #[cfg(not(target_os = "linux"))]
    DeviceReset,
}

/// Opens a new CPAL/rodio output stream with the given rate and device name (same path as
/// manual device switch). Used by the device watcher and Windows suspend/resume notifications.
///
/// If the interrupted track is a seekable local file or a fully-cached HTTP download
/// (in-memory or spill file), the function replays it internally from the saved position —
/// no frontend round-trip, no audible restart. On success it emits
/// `audio:device-changed` / `audio:device-reset` with a `null` payload so the frontend
/// knows Rust already handled playback.
/// For radio, partially-buffered HTTP tracks, or paused playback, it falls back to the
/// previous behaviour: emit with the captured `current_time_secs` so the frontend calls
/// `playTrack`.
pub(crate) async fn reopen_output_stream(
    app: &tauri::AppHandle,
    device_name: Option<String>,
    notify: ReopenNotify,
) -> bool {
    let Some(engine) = app.try_state::<AudioEngine>() else {
        return false;
    };

    let rate = engine.stream_sample_rate.load(Ordering::Relaxed);
    let reopen_tx = engine.stream_reopen_tx.clone();
    let stream_handle = engine.stream_handle.clone();
    let current = engine.current.clone();
    let fading_out = engine.fading_out_sink.clone();

    // Snapshot state we need BEFORE the blocking stream reopen (while the old sink
    // is still live and position() is still valid).
    let snapshot = {
        let cur = current.lock().unwrap();
        let is_playing = cur.play_started.is_some() && cur.paused_at.is_none();
        ResumeSnapshot {
            url: engine.current_playback_url.lock().unwrap().clone(),
            current_time_secs: cur.position(),
            duration_secs: cur.duration_secs,
            base_volume: cur.base_volume,
            gain_linear: cur.replay_gain_linear,
            analysis_track_id: engine.current_analysis_track_id.lock().unwrap().clone(),
            is_playing,
        }
    };

    let new_handle = tauri::async_runtime::spawn_blocking(move || {
        let (reply_tx, reply_rx) =
            std::sync::mpsc::sync_channel::<Arc<rodio::MixerDeviceSink>>(0);
        if reopen_tx
            .send((rate, false, device_name, reply_tx))
            .is_err()
        {
            return None;
        }
        reply_rx.recv_timeout(Duration::from_secs(5)).ok()
    })
    .await
    .unwrap_or(None);

    let Some(handle) = new_handle else {
        return false;
    };

    *stream_handle.lock().unwrap() = handle;
    if let Some(s) = current.lock().unwrap().sink.take() {
        s.stop();
    }
    if let Some(s) = fading_out.lock().unwrap().take() {
        s.stop();
    }

    // Attempt a Rust-side internal replay (no frontend involvement).
    // Falls back gracefully to the frontend path if conditions aren't met.
    let resumed = try_resume_after_device_change(app, &snapshot).await;

    match notify {
        ReopenNotify::DeviceChanged => {
            // null  → Rust already resumed; frontend skips playTrack
            // f64   → fallback; frontend calls playTrack + seek
            if resumed {
                app.emit("audio:device-changed", Option::<f64>::None).ok();
            } else {
                app.emit("audio:device-changed", snapshot.current_time_secs).ok();
            }
        }
        #[cfg(not(target_os = "linux"))]
        ReopenNotify::DeviceReset => {
            if resumed {
                app.emit("audio:device-reset", Option::<f64>::None).ok();
            } else {
                app.emit("audio:device-reset", snapshot.current_time_secs).ok();
            }
        }
    }
    true
}

struct ResumeSnapshot {
    url: Option<String>,
    current_time_secs: f64,
    duration_secs: f64,
    base_volume: f32,
    gain_linear: f32,
    analysis_track_id: Option<String>,
    is_playing: bool,
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
async fn try_resume_after_device_change(
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

    let ps: PlaybackSource = match build_playback_source_with_probe_fallback(
        play_input,
        BuildSourceArgs {
            url,
            gen,
            cache_id_for_tasks: snap.analysis_track_id.as_deref(),
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

    let sink = Arc::new(Player::connect_new(
        engine.stream_handle.lock().unwrap().mixer(),
    ));
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

    spawn_progress_task(
        gen,
        engine.generation.clone(),
        engine.current.clone(),
        engine.chained_info.clone(),
        engine.crossfade_enabled.clone(),
        engine.crossfade_secs.clone(),
        done_flag,
        app.clone(),
        engine.samples_played.clone(),
        engine.current_sample_rate.clone(),
        engine.current_channels.clone(),
        engine.gapless_switch_at.clone(),
        engine.current_playback_url.clone(),
        engine.stream_playback_armed.clone(),
    );

    crate::app_deprintln!(
        "[device-resume] internal replay ok — url={url:?} resume_at={:.2}s seekable={}",
        snap.current_time_secs,
        ps.is_seekable
    );
    true
}

pub fn start_device_watcher(engine: &AudioEngine, app: tauri::AppHandle) {
    let selected_device = engine.selected_device.clone();
    let samples_played = engine.samples_played.clone();
    let current = engine.current.clone();

    tauri::async_runtime::spawn(async move {
        let mut last_default: Option<String> = tauri::async_runtime::spawn_blocking(|| {
            use rodio::cpal::traits::{DeviceTrait, HostTrait};
            rodio::cpal::default_host()
                .default_output_device()
                .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()))
        }).await.unwrap_or(None);

        // macOS/Windows: consecutive polls where a pinned device is absent from cpal's list.
        #[cfg(not(target_os = "linux"))]
        let mut pinned_miss_count: u32 = 0;
        // Fallback recovery when OS sleep/resume notifications are missed: if playback is
        // "running" but sample counter is flat for too long, reopen output stream.
        // To avoid false positives during normal playback, arm this watchdog only
        // after a suspiciously long poll gap (e.g. process resumed after sleep).
        let mut last_samples_seen: u64 = 0;
        let mut stalled_since: Option<Instant> = None;
        let mut last_stall_recover_at: Option<Instant> = None;
        let mut last_poll_at = Instant::now();
        let mut watchdog_armed_until: Option<Instant> = None;

        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let now = Instant::now();
            let poll_gap = now.saturating_duration_since(last_poll_at);
            last_poll_at = now;
            if poll_gap >= Duration::from_secs(15) {
                let armed_until = now + Duration::from_secs(120);
                watchdog_armed_until = Some(armed_until);
                crate::app_eprintln!(
                    "[psysonic] device-watcher: watchdog armed for 120s (poll gap {:?}, likely sleep/resume)",
                    poll_gap
                );
            }
            let watchdog_armed = watchdog_armed_until.is_some_and(|until| now < until);

            // ── Fallback stall detector (works even if sleep/resume signal was missed) ──
            let mut should_recover_stall = false;
            let mut stall_for = Duration::ZERO;
            {
                let samples_now = samples_played.load(Ordering::Relaxed);
                let cur = current.lock().unwrap();
                let active = cur
                    .sink
                    .as_ref()
                    .is_some_and(|s| !s.is_paused() && !s.empty());

                if !watchdog_armed {
                    if stalled_since.take().is_some() {
                        crate::app_eprintln!(
                            "[psysonic] device-watcher: watchdog disarmed, clearing stall candidate"
                        );
                    }
                    last_samples_seen = samples_now;
                } else if !active || samples_now != last_samples_seen {
                    if stalled_since.take().is_some() {
                        crate::app_eprintln!(
                            "[psysonic] device-watcher: stall candidate cleared (active={active}, samples_delta={})",
                            samples_now as i128 - last_samples_seen as i128
                        );
                    }
                    stalled_since = None;
                    last_samples_seen = samples_now;
                } else {
                    let since = stalled_since.get_or_insert_with(Instant::now);
                    if since.elapsed() < Duration::from_millis(100) {
                        crate::app_eprintln!(
                            "[psysonic] device-watcher: stall candidate started (samples={}, active={active})",
                            samples_now
                        );
                    }
                    stall_for = since.elapsed();
                    let cooldown_ok = last_stall_recover_at
                        .map(|t| t.elapsed() >= Duration::from_secs(20))
                        .unwrap_or(true);
                    if stall_for >= Duration::from_secs(8) && cooldown_ok {
                        should_recover_stall = true;
                    }
                }
            }

            if should_recover_stall {
                let pinned = selected_device.lock().unwrap().clone();
                let samples_now = samples_played.load(Ordering::Relaxed);
                crate::app_eprintln!(
                    "[psysonic] device-watcher: output stalled for {:?} (samples={}) — reopening stream, pinned={:?}",
                    stall_for,
                    samples_now,
                    pinned
                );
                if reopen_output_stream(&app, pinned, ReopenNotify::DeviceChanged).await {
                    last_stall_recover_at = Some(Instant::now());
                    stalled_since = None;
                    last_samples_seen = samples_played.load(Ordering::Relaxed);
                    crate::app_eprintln!(
                        "[psysonic] device-watcher: stalled-output recovery succeeded"
                    );
                } else {
                    crate::app_eprintln!(
                        "[psysonic] device-watcher: stalled-output reopen timed out"
                    );
                }
            }

            // Enumerate all available output devices and the current default.
            // Suppress stderr on Unix to avoid ALSA probing noise (JACK, OSS, dmix).
            let (current_default, available) = tauri::async_runtime::spawn_blocking(|| {
                use rodio::cpal::traits::{DeviceTrait, HostTrait};
                #[cfg(unix)]
                let _guard = unsafe {
                    struct StderrGuard(i32);
                    impl Drop for StderrGuard {
                        fn drop(&mut self) { unsafe { libc::dup2(self.0, 2); libc::close(self.0); } }
                    }
                    let saved = libc::dup(2);
                    let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
                    libc::dup2(devnull, 2);
                    libc::close(devnull);
                    StderrGuard(saved)
                };
                let host = rodio::cpal::default_host();
                let default = host
                    .default_output_device()
                    .and_then(|d| d.description().ok().map(|desc| desc.name().to_string()));
                let available: Vec<String> = host
                    .output_devices()
                    .map(|iter| {
                        iter.filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                (default, available)
            }).await.unwrap_or((None, vec![]));

            // Empty list almost always means a transient enumeration failure, not
            // that every output device vanished. Treating it as "pinned missing"
            // caused false audio:device-reset (UI jumped back to system default)
            // when switching to external USB / class-compliant interfaces.
            if available.is_empty() {
                continue;
            }

            let pinned = selected_device.lock().unwrap().clone();

            #[cfg(target_os = "linux")]
            if pinned.is_some() {
                // Do not infer "unplugged" from `output_devices()` when a device is pinned.
                // ALSA/cpal often omit the active HDMI/USB sink from enumeration for the
                // whole session — any miss counter eventually tripped audio:device-reset.
                // Clearing the pin is left to the user (Settings → System Default) or
                // to a future explicit error signal from the output stream.
                continue;
            }

            // ── Case 2 (non-Linux): pinned device disappeared from enumeration ─
            #[cfg(not(target_os = "linux"))]
            if let Some(ref dev_name) = pinned {
                if !output_enumeration_includes_pinned(&available, dev_name) {
                    pinned_miss_count += 1;
                    if pinned_miss_count < 3 {
                        continue;
                    }
                    crate::app_eprintln!("[psysonic] device-watcher: pinned device '{dev_name}' disconnected, falling back to system default");
                    pinned_miss_count = 0;
                    *selected_device.lock().unwrap() = None;

                    tokio::time::sleep(Duration::from_millis(500)).await;

                    let reopened = reopen_output_stream(&app, None, ReopenNotify::DeviceReset).await;
                    if !reopened {
                        crate::app_eprintln!("[psysonic] device-watcher: stream reopen timed out (pinned disconnect)");
                    }

                    last_default = current_default;
                } else {
                    pinned_miss_count = 0;
                }
                continue;
            }

            // ── Case 1: no pinned device, system default changed ──────────────
            if current_default == last_default {
                continue;
            }

            last_default = current_default.clone();

            let Some(_new_name) = current_default else { continue };

            // Debounce: give the OS time to finish configuring the new device.
            tokio::time::sleep(Duration::from_millis(500)).await;

            if !reopen_output_stream(&app, None, ReopenNotify::DeviceChanged).await {
                crate::app_eprintln!("[psysonic] device-watcher: stream reopen timed out");
            }
        }
    });
}

//! Poll default output device and pinned-device presence; reopen stream when needed.
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::Emitter;
use tauri::Manager;

use super::device_resume::{try_resume_after_device_change, ResumeOutcome, ResumeSnapshot};
use super::engine::AudioEngine;
#[cfg(not(target_os = "linux"))]
use super::dev_io::output_enumeration_includes_pinned;

/// What to tell the frontend after a successful stream reopen.
#[derive(Clone, Copy)]
pub(crate) enum ReopenNotify {
    /// Normal path — same as `audio_set_device`.
    DeviceChanged,
    /// Pinned device unplugged (Windows/macOS only); Rust cleared the pin — clear Settings + restart playback.
    #[cfg(not(target_os = "linux"))]
    DeviceReset,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReopenOutcome {
    Reopened,
    Superseded,
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
async fn reopen_output_stream(
    app: &tauri::AppHandle,
    device_name: Option<String>,
    notify: ReopenNotify,
    required_generation: Option<u64>,
) -> Result<ReopenOutcome, String> {
    enum ReopenPrepared {
        Superseded,
        Notify {
            snapshot: ResumeSnapshot,
            stream_reopened: bool,
        },
    }

    let Some(engine) = app.try_state::<AudioEngine>() else {
        return Err("audio engine is unavailable".to_string());
    };
    let expected_generation = required_generation
        .unwrap_or_else(|| engine.generation.load(Ordering::SeqCst));
    let app_for_open = app.clone();
    let expected_device = device_name.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let engine = app_for_open.state::<AudioEngine>();
        let _stream_guard = engine.stream_open_lock.lock().unwrap();
        super::engine::wait_for_stream_attachments_locked(&engine);

        // A manual switch or a new playback command completed while this
        // watcher request was queued. Its state is authoritative; do not reopen
        // the device or replay the stale snapshot.
        if engine.generation.load(Ordering::SeqCst) != expected_generation
            || *engine.selected_device.lock().unwrap() != expected_device
        {
            return Ok(ReopenPrepared::Superseded);
        }

        let rate = engine.stream_requested_rate.load(Ordering::Relaxed);
        let open_rate = if rate > 0 {
            rate
        } else {
            engine.device_default_rate
        };
        let mut snapshot = {
            let cur = engine.current.lock().unwrap();
            let is_playing = cur.play_started.is_some() && cur.paused_at.is_none();
            ResumeSnapshot {
                url: engine.current_playback_url.lock().unwrap().clone(),
                current_time_secs: cur.position(),
                duration_secs: cur.duration_secs,
                base_volume: cur.base_volume,
                gain_linear: cur.replay_gain_linear,
                analysis_track_id: engine.current_analysis_track_id.lock().unwrap().clone(),
                is_playing,
                generation: expected_generation,
            }
        };

        if let Err(error) = super::engine::open_output_stream_blocking_locked(
            &engine,
            open_rate,
            false,
            device_name,
            false,
        ) {
            let _commit_guard = engine.playback_commit_lock.lock().unwrap();
            if engine.generation.load(Ordering::SeqCst) != expected_generation {
                super::stream_idle::teardown_playback_sinks_for_idle_release(&engine);
                snapshot.current_time_secs = 0.0;
                snapshot.is_playing = false;
                return Ok(ReopenPrepared::Notify {
                    snapshot,
                    stream_reopened: false,
                });
            }
            engine.generation.fetch_add(1, Ordering::SeqCst);
            super::stream_idle::teardown_playback_sinks_for_idle_release(&engine);
            engine.current.lock().unwrap().paused_at = Some(snapshot.current_time_secs);
            return Err(error);
        }

        // `audio_play` can bump the generation before it reaches the stream
        // lock. Leave the newly opened stream for that command, stop players
        // tied to the replaced mixer, and ask the frontend to retry whichever
        // track is current now rather than replaying this stale snapshot.
        let _commit_guard = engine.playback_commit_lock.lock().unwrap();
        if engine.generation.load(Ordering::SeqCst) != expected_generation {
            super::stream_idle::teardown_playback_sinks_for_idle_release(&engine);
            snapshot.current_time_secs = 0.0;
            snapshot.is_playing = false;
            return Ok(ReopenPrepared::Notify {
                snapshot,
                stream_reopened: true,
            });
        }

        if !snapshot.is_playing {
            engine.generation.fetch_add(1, Ordering::SeqCst);
        }
        if let Some(sink) = engine.current.lock().unwrap().sink.take() {
            sink.stop();
        }
        if let Some(sink) = engine.fading_out_sink.lock().unwrap().take() {
            sink.stop();
        }
        snapshot.generation = engine.generation.load(Ordering::SeqCst);
        Ok(ReopenPrepared::Notify {
            snapshot,
            stream_reopened: true,
        })
    })
    .await
    .map_err(|error| format!("audio stream reopen task failed: {error}"))?;
    let (snapshot, stream_reopened) = match snapshot {
        Ok(ReopenPrepared::Notify {
            snapshot,
            stream_reopened,
        }) => (snapshot, stream_reopened),
        Ok(ReopenPrepared::Superseded) => return Ok(ReopenOutcome::Superseded),
        Err(error) => {
            app.emit("audio:output-released", ()).ok();
            return Err(error);
        }
    };

    // Attempt a Rust-side internal replay (no frontend involvement).
    // Falls back gracefully to the frontend path if conditions aren't met.
    let resume_outcome = try_resume_after_device_change(app, &snapshot).await;
    if resume_outcome == ResumeOutcome::Superseded {
        return Ok(if stream_reopened {
            ReopenOutcome::Reopened
        } else {
            ReopenOutcome::Superseded
        });
    }
    let resumed = resume_outcome == ResumeOutcome::Resumed;

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
    Ok(if stream_reopened {
        ReopenOutcome::Reopened
    } else {
        ReopenOutcome::Superseded
    })
}

/// Retry one transient backend failure after the OS audio stack settles. Abort
/// the retry if a manual device selection superseded the original request.
pub(crate) async fn reopen_output_stream_with_retry(
    app: &tauri::AppHandle,
    device_name: Option<String>,
    notify: ReopenNotify,
) -> Result<ReopenOutcome, String> {
    let Some(engine) = app.try_state::<AudioEngine>() else {
        return Err("audio engine is unavailable".to_string());
    };
    let first_generation = {
        let _commit_guard = engine.playback_commit_lock.lock().unwrap();
        engine.generation.load(Ordering::SeqCst)
    };
    let first_error = match reopen_output_stream(
        app,
        device_name.clone(),
        notify,
        Some(first_generation),
    )
    .await
    {
        Ok(outcome) => return Ok(outcome),
        Err(error) => error,
    };

    let retry_generation = first_generation.wrapping_add(1);
    {
        let _commit_guard = engine.playback_commit_lock.lock().unwrap();
        if engine.generation.load(Ordering::SeqCst) != retry_generation {
            return Ok(ReopenOutcome::Superseded);
        }
    };
    tokio::time::sleep(Duration::from_millis(1200)).await;

    reopen_output_stream(app, device_name, notify, Some(retry_generation))
        .await
        .map_err(|retry_error| format!("{first_error}; retry failed: {retry_error}"))
}

pub fn start_device_watcher(engine: &AudioEngine, app: tauri::AppHandle) {
    let selected_device = engine.selected_device.clone();
    #[cfg(not(target_os = "linux"))]
    let stream_open_lock = engine.stream_open_lock.clone();
    let samples_played = engine.samples_played.clone();
    let current = engine.current.clone();

    tauri::async_runtime::spawn(async move {
        let mut last_default: Option<String> = tauri::async_runtime::spawn_blocking(|| {
            super::dev_io::effective_default_output_device_name_for_poll()
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
                last_stall_recover_at = Some(Instant::now());
                let pinned = selected_device.lock().unwrap().clone();
                let samples_now = samples_played.load(Ordering::Relaxed);
                crate::app_eprintln!(
                    "[psysonic] device-watcher: output stalled for {:?} (samples={}) — reopening stream, pinned={:?}",
                    stall_for,
                    samples_now,
                    pinned
                );
                match reopen_output_stream_with_retry(
                    &app,
                    pinned,
                    ReopenNotify::DeviceChanged,
                )
                .await
                {
                    Ok(ReopenOutcome::Reopened) => {
                        stalled_since = None;
                        last_samples_seen = samples_played.load(Ordering::Relaxed);
                        crate::app_eprintln!(
                            "[psysonic] device-watcher: stalled-output recovery succeeded"
                        );
                    }
                    Ok(ReopenOutcome::Superseded) => {}
                    Err(error) => {
                        crate::app_eprintln!(
                            "[psysonic] device-watcher: stalled-output reopen failed: {error}"
                        );
                    }
                }
            }

            // The full `output_devices()` + per-device `description()` scan is the
            // CoreAudio HAL call that contends with the audio render thread and
            // produces a brief dropout once per poll interval (issue #996: stutter
            // every ~3s, cadence tracking the poll exactly). It is only needed to
            // detect a *pinned* output device disappearing. With no pin — system
            // default, the common case — only the current default is needed, a
            // single cheap query, so the full enumeration is skipped entirely.
            let pinned = selected_device.lock().unwrap().clone();
            let need_full_enum = pinned.is_some();

            // Suppress stderr on Unix to avoid ALSA probing noise (JACK, OSS, dmix).
            let (current_default, available) = tauri::async_runtime::spawn_blocking(move || {
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
                let default = super::dev_io::effective_default_output_device_name_for_poll();
                let available: Vec<String> = if need_full_enum {
                    super::dev_io::enumerate_output_device_names()
                } else {
                    Vec::new()
                };
                (default, available)
            }).await.unwrap_or((None, vec![]));

            // Empty list (only when we actually enumerated for a pinned device)
            // almost always means a transient enumeration failure, not that every
            // output device vanished. Treating it as "pinned missing" caused false
            // audio:device-reset (UI jumped back to system default) when switching
            // to external USB / class-compliant interfaces.
            if need_full_enum && available.is_empty() {
                continue;
            }

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
                    {
                        let _stream_guard = stream_open_lock.lock().unwrap();
                        let mut selected = selected_device.lock().unwrap();
                        if selected.as_ref() != Some(dev_name) {
                            continue;
                        }
                        *selected = None;
                    }

                    tokio::time::sleep(Duration::from_millis(500)).await;

                    match reopen_output_stream_with_retry(
                        &app,
                        None,
                        ReopenNotify::DeviceReset,
                    )
                    .await
                    {
                        Ok(ReopenOutcome::Reopened) => last_default = current_default,
                        Ok(ReopenOutcome::Superseded) => {}
                        Err(error) => {
                            crate::app_eprintln!(
                                "[psysonic] device-watcher: stream reopen failed after pinned disconnect: {error}"
                            );
                        }
                    }
                } else {
                    pinned_miss_count = 0;
                }
                continue;
            }

            // ── Case 1: no pinned device, system default changed ──────────────
            if current_default == last_default {
                continue;
            }

            let Some(new_name) = current_default else {
                // Transient wpctl/cpal miss — keep last known default.
                continue;
            };

            if last_default.is_none() {
                last_default = Some(new_name.clone());
                continue;
            }

            // Linux/PipeWire: cpal default labels can drift while the physical sink
            // is unchanged — compare via ALSA logical keys before reopening.
            #[cfg(target_os = "linux")]
            if let Some(ref prev) = last_default {
                let prev_name = prev.clone();
                let new_name_for_eq = new_name.clone();
                let same_sink = tauri::async_runtime::spawn_blocking(move || {
                    let list = super::dev_io::enumerate_output_device_names();
                    super::dev_io::output_device_keys_equivalent(
                        &prev_name,
                        &new_name_for_eq,
                        &list,
                    )
                })
                .await
                .unwrap_or(false);
                if same_sink {
                    last_default = Some(new_name);
                    continue;
                }
            }

            // Debounce: give the OS time to finish configuring the new device.
            tokio::time::sleep(Duration::from_millis(500)).await;

            #[cfg(target_os = "linux")]
            {
                let stream_on_default = tauri::async_runtime::spawn_blocking(|| {
                    super::dev_io::linux_psysonic_stream_routes_to_default_sink()
                })
                .await
                .unwrap_or(false);
                if stream_on_default {
                    // PipeWire already moved playback — notify frontend (EQ sync) only.
                    app.emit("audio:device-changed", Option::<f64>::None).ok();
                    last_default = Some(new_name.clone());
                    continue;
                }
            }

            match reopen_output_stream_with_retry(&app, None, ReopenNotify::DeviceChanged).await {
                Ok(ReopenOutcome::Reopened) => last_default = Some(new_name),
                Ok(ReopenOutcome::Superseded) => {}
                Err(error) => {
                    crate::app_eprintln!(
                        "[psysonic] device-watcher: stream reopen failed: {error}"
                    );
                }
            }
        }
    });
}

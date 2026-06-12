//! Poll default output device and pinned-device presence; reopen stream when needed.
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::Emitter;
use tauri::Manager;

use super::device_resume::{try_resume_after_device_change, ResumeSnapshot};
use super::engine::AudioEngine;
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
    let open_rate = if rate > 0 {
        rate
    } else {
        engine.device_default_rate
    };
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

    let app_for_open = app.clone();
    let device_name_for_open = device_name.clone();
    let opened = tauri::async_runtime::spawn_blocking(move || {
        let engine = app_for_open.state::<AudioEngine>();
        super::engine::open_output_stream_blocking(
            &engine,
            open_rate,
            false,
            device_name_for_open,
        )
        .is_ok()
    })
    .await
    .unwrap_or(false);

    if !opened {
        return false;
    }
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
                let available: Vec<String> = if need_full_enum {
                    host.output_devices()
                        .map(|iter| {
                            iter.filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                                .collect()
                        })
                        .unwrap_or_default()
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

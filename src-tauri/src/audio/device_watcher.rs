//! Poll default output device and pinned-device presence; reopen stream when needed.
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;
use tauri::Manager;

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
    match notify {
        ReopenNotify::DeviceChanged => {
            app.emit("audio:device-changed", ()).ok();
        }
        #[cfg(not(target_os = "linux"))]
        ReopenNotify::DeviceReset => {
            app.emit("audio:device-reset", ()).ok();
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
        let mut last_samples_seen: u64 = 0;
        let mut stalled_since: Option<std::time::Instant> = None;
        let mut last_stall_recover_at: Option<std::time::Instant> = None;

        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            // ── Fallback stall detector (works even if sleep/resume signal was missed) ──
            let mut should_recover_stall = false;
            {
                let samples_now = samples_played.load(Ordering::Relaxed);
                let cur = current.lock().unwrap();
                let active = cur
                    .sink
                    .as_ref()
                    .is_some_and(|s| !s.is_paused() && !s.empty());

                if !active || samples_now != last_samples_seen {
                    stalled_since = None;
                    last_samples_seen = samples_now;
                } else {
                    let since = stalled_since.get_or_insert_with(std::time::Instant::now);
                    let stalled_for = since.elapsed();
                    let cooldown_ok = last_stall_recover_at
                        .map(|t| t.elapsed() >= Duration::from_secs(20))
                        .unwrap_or(true);
                    if stalled_for >= Duration::from_secs(8) && cooldown_ok {
                        should_recover_stall = true;
                    }
                }
            }

            if should_recover_stall {
                let pinned = selected_device.lock().unwrap().clone();
                crate::app_eprintln!(
                    "[psysonic] device-watcher: output appears stalled (samples flat) — reopening stream"
                );
                if reopen_output_stream(&app, pinned, ReopenNotify::DeviceChanged).await {
                    last_stall_recover_at = Some(std::time::Instant::now());
                    stalled_since = None;
                    last_samples_seen = samples_played.load(Ordering::Relaxed);
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
                    let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_WRONLY);
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

//! Poll default output device and pinned-device presence; reopen stream when needed.
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::Emitter;

use super::engine::AudioEngine;
#[cfg(not(target_os = "linux"))]
use super::dev_io::output_enumeration_includes_pinned;

pub fn start_device_watcher(engine: &AudioEngine, app: tauri::AppHandle) {
    let reopen_tx       = engine.stream_reopen_tx.clone();
    let stream_handle   = engine.stream_handle.clone();
    let stream_rate     = engine.stream_sample_rate.clone();
    let current         = engine.current.clone();
    let fading_out      = engine.fading_out_sink.clone();
    let selected_device = engine.selected_device.clone();

    tauri::async_runtime::spawn(async move {
        let mut last_default: Option<String> = tauri::async_runtime::spawn_blocking(|| {
            use rodio::cpal::traits::{DeviceTrait, HostTrait};
            rodio::cpal::default_host()
                .default_output_device()
                .and_then(|d| d.name().ok())
        }).await.unwrap_or(None);

        // macOS/Windows: consecutive polls where a pinned device is absent from cpal's list.
        #[cfg(not(target_os = "linux"))]
        let mut pinned_miss_count: u32 = 0;

        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

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
                let default = host.default_output_device().and_then(|d| d.name().ok());
                let available: Vec<String> = host
                    .output_devices()
                    .map(|iter| iter.filter_map(|d| d.name().ok()).collect())
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

                    let rate = stream_rate.load(Ordering::Relaxed);
                    let reopen_tx2 = reopen_tx.clone();
                    let new_handle = tauri::async_runtime::spawn_blocking(move || {
                        let (reply_tx, reply_rx) =
                            std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);
                        if reopen_tx2.send((rate, false, None, reply_tx)).is_err() {
                            return None;
                        }
                        reply_rx.recv_timeout(Duration::from_secs(5)).ok()
                    }).await.unwrap_or(None);

                    if let Some(handle) = new_handle {
                        *stream_handle.lock().unwrap() = handle;
                        if let Some(s) = current.lock().unwrap().sink.take() { s.stop(); }
                        if let Some(s) = fading_out.lock().unwrap().take()   { s.stop(); }
                        app.emit("audio:device-reset", ()).ok();
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

            let rate = stream_rate.load(Ordering::Relaxed);
            let reopen_tx2 = reopen_tx.clone();
            let new_handle = tauri::async_runtime::spawn_blocking(move || {
                let (reply_tx, reply_rx) =
                    std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);
                if reopen_tx2.send((rate, false, None, reply_tx)).is_err() {
                    return None;
                }
                reply_rx.recv_timeout(Duration::from_secs(5)).ok()
            }).await.unwrap_or(None);

            let Some(handle) = new_handle else {
                crate::app_eprintln!("[psysonic] device-watcher: stream reopen timed out");
                continue;
            };

            *stream_handle.lock().unwrap() = handle;
            if let Some(s) = current.lock().unwrap().sink.take() { s.stop(); }
            if let Some(s) = fading_out.lock().unwrap().take()   { s.stop(); }
            app.emit("audio:device-changed", ()).ok();
        }
    });
}

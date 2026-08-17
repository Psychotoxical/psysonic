use std::sync::Mutex;

#[cfg(not(debug_assertions))]
use tauri::Emitter;
use tauri::Manager;

/// Shared handle to OS media controls (MPRIS2 on Linux, Now Playing on macOS, SMTC on Windows).
/// `None` if souvlaki failed to initialize (e.g. no D-Bus session on Linux).
pub(crate) type MprisControls = Mutex<Option<souvlaki::MediaControls>>;

pub(crate) fn normalize_mpris_volume(volume: f64) -> Option<f64> {
    volume.is_finite().then(|| volume.clamp(0.0, 1.0))
}

pub(crate) fn initialize(app: &mut tauri::App) {
    // Release only: debug builds share the D-Bus name / SMTC slot with prod.
    #[cfg(not(debug_assertions))]
    {
        use souvlaki::{MediaControlEvent, MediaControls, PlatformConfig};

        let maybe_controls: Option<MediaControls> = (|| {
            #[cfg(target_os = "linux")]
            {
                let dbus_ok = std::env::var("DBUS_SESSION_BUS_ADDRESS")
                    .map(|v| !v.is_empty())
                    .unwrap_or(false);
                if !dbus_ok {
                    crate::app_eprintln!(
                        "[Psysonic] No D-Bus session — MPRIS media controls disabled"
                    );
                    return None;
                }
            }

            #[cfg(target_os = "windows")]
            let hwnd = {
                let h = app
                    .get_webview_window("main")
                    .and_then(|w| w.hwnd().ok())
                    .map(|h| h.0);
                if h.is_none() {
                    crate::app_eprintln!(
                        "[Psysonic] Could not get HWND — Windows media controls disabled"
                    );
                    return None;
                }
                h
            };
            #[cfg(not(target_os = "windows"))]
            let hwnd: Option<*mut std::ffi::c_void> = None;

            let config = PlatformConfig {
                dbus_name: "psysonic",
                display_name: "Psysonic",
                hwnd,
            };

            match MediaControls::new(config) {
                Ok(mut controls) => {
                    let app_handle = app.handle().clone();
                    if let Err(e) = controls.attach(move |event: MediaControlEvent| match event {
                        MediaControlEvent::Toggle => {
                            let _ = app_handle.emit("media:play-pause", ());
                        }
                        MediaControlEvent::Play => {
                            let _ = app_handle.emit("media:play", ());
                        }
                        MediaControlEvent::Pause => {
                            let _ = app_handle.emit("media:pause", ());
                        }
                        MediaControlEvent::Next => {
                            let _ = app_handle.emit("media:next", ());
                        }
                        MediaControlEvent::Previous => {
                            let _ = app_handle.emit("media:prev", ());
                        }
                        MediaControlEvent::Seek(direction) => {
                            use souvlaki::SeekDirection;
                            let delta: f64 = match direction {
                                SeekDirection::Forward => 5.0,
                                SeekDirection::Backward => -5.0,
                            };
                            let _ = app_handle.emit("media:seek-relative", delta);
                        }
                        MediaControlEvent::SetPosition(pos) => {
                            let secs = pos.0.as_secs_f64();
                            let _ = app_handle.emit("media:seek-absolute", secs);
                        }
                        MediaControlEvent::SetVolume(volume) => {
                            if let Some(volume) = normalize_mpris_volume(volume) {
                                let _ = app_handle.emit("media:set-volume", volume);
                            }
                        }
                        _ => {}
                    }) {
                        crate::app_eprintln!("[Psysonic] Failed to attach media controls: {e:?}");
                    }
                    Some(controls)
                }
                Err(e) => {
                    crate::app_eprintln!("[Psysonic] Could not create media controls: {e:?}");
                    None
                }
            }
        })();

        app.manage(MprisControls::new(maybe_controls));
    }
    #[cfg(debug_assertions)]
    {
        app.manage(MprisControls::new(None));
    }

    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    {
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(hwnd) = w.hwnd() {
                crate::taskbar_win::init(app.handle(), hwnd.0 as isize);
            }
        }
    }

    let engine = app.state::<crate::audio::AudioEngine>();
    crate::audio::start_device_watcher(&engine, app.handle().clone());
    crate::audio::start_stream_idle_watcher(app.handle().clone());

    crate::audio::register_post_sleep_audio_recovery(app.handle().clone());
}

#[cfg(test)]
mod tests {
    use super::normalize_mpris_volume;

    #[test]
    fn normalizes_mpris_volume_to_player_range() {
        assert_eq!(normalize_mpris_volume(-0.5), Some(0.0));
        assert_eq!(normalize_mpris_volume(0.42), Some(0.42));
        assert_eq!(normalize_mpris_volume(1.5), Some(1.0));
        assert_eq!(normalize_mpris_volume(f64::NAN), None);
        assert_eq!(normalize_mpris_volume(f64::INFINITY), None);
    }
}

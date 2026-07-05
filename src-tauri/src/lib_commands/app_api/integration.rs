#[cfg(not(debug_assertions))]
use tauri::Emitter;

use crate::{MprisControls, ShortcutMap};

#[tauri::command]
#[specta::specta]
pub(crate) fn register_global_shortcut(
    app: tauri::AppHandle,
    shortcut_map: tauri::State<ShortcutMap>,
    shortcut: String,
    action: String,
) -> Result<(), String> {
    // Debug builds run alongside release with shared settings — do not grab OS shortcuts.
    #[cfg(debug_assertions)]
    {
        let _ = (app, shortcut_map, shortcut, action);
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

        let mut map = shortcut_map.lock().unwrap();

        // Idempotent: if this exact shortcut+action is already registered, skip.
        // This prevents on_shortcut() from accumulating duplicate handlers when
        // registerAll() is called again after a JS HMR reload or StrictMode double-effect.
        if map.get(&shortcut).map(|a| a == &action).unwrap_or(false) {
            return Ok(());
        }

        // Unregister any existing OS grab for this shortcut before re-registering.
        if let Ok(s) = shortcut.parse::<Shortcut>() {
            let _ = app.global_shortcut().unregister(s);
        }
        map.insert(shortcut.clone(), action.clone());
        drop(map); // release lock before the blocking OS call

        let parsed: Shortcut = shortcut.parse().map_err(|_| format!("Invalid shortcut: {shortcut}"))?;
        app.global_shortcut()
            .on_shortcut(parsed, move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = app.emit("shortcut:global-action", action.clone());
                }
            })
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn unregister_global_shortcut(
    app: tauri::AppHandle,
    shortcut_map: tauri::State<ShortcutMap>,
    shortcut: String,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        let _ = (app, shortcut_map, shortcut);
        Ok(())
    }

    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
        shortcut_map.lock().unwrap().remove(&shortcut);
        let parsed: Shortcut = shortcut.parse().map_err(|_| format!("Invalid shortcut: {shortcut}"))?;
        app.global_shortcut().unregister(parsed).map_err(|e| e.to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn mpris_set_metadata(
    controls: tauri::State<MprisControls>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    cover_url: Option<String>,
    duration_secs: Option<f64>,
) -> Result<(), String> {
    use souvlaki::MediaMetadata;
    use std::time::Duration;

    let duration = duration_secs.map(Duration::from_secs_f64);
    let mut guard = controls.lock().unwrap();
    let Some(ctrl) = guard.as_mut() else { return Ok(()); };

    // #1102: Windows SMTC cannot render our cached WebP covers. souvlaki loads
    // the file and SetThumbnail/set_metadata succeed, but the lock screen and
    // Quick-Settings media tile show a blank cover (the OS thumbnail decoder
    // does not handle WebP, even with the Store WebP extension installed).
    // Transcode local WebP covers to PNG for the OS media controls; macOS
    // (ImageIO) decodes WebP fine, so other platforms pass through unchanged.
    let cover_url = smtc_cover_url(cover_url);

    ctrl.set_metadata(MediaMetadata {
        title: title.as_deref(),
        artist: artist.as_deref(),
        album: album.as_deref(),
        cover_url: cover_url.as_deref(),
        duration,
    })
    .map_err(|e| format!("MPRIS set_metadata failed: {e:?}"))
}

/// Rewrite a cached WebP cover URL to a PNG the OS media controls can render.
/// Windows SMTC cannot decode WebP thumbnails (#1102); other platforms and any
/// non-`file://`/non-WebP URL pass through unchanged.
fn smtc_cover_url(cover_url: Option<String>) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(url) = cover_url.as_deref() {
            if let Some(path) = url.strip_prefix("file://") {
                let is_webp = std::path::Path::new(path)
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("webp"));
                if is_webp {
                    match webp_file_to_temp_png(path) {
                        Ok(png) => return Some(format!("file://{png}")),
                        Err(e) => {
                            crate::app_eprintln!("[mpris] cover WebP->PNG transcode failed: {e}")
                        }
                    }
                }
            }
        }
    }
    cover_url
}

/// Decode a WebP file (libwebp, the same codec that wrote the cover cache) and
/// re-encode it as a PNG in the temp dir, returning the native path. A single
/// reusable file is fine: souvlaki reads it synchronously inside `set_metadata`,
/// and the controls mutex serializes calls so it is never written concurrently.
#[cfg(target_os = "windows")]
fn webp_file_to_temp_png(webp_path: &str) -> Result<String, String> {
    let bytes = std::fs::read(webp_path).map_err(|e| e.to_string())?;
    let decoded = webp::Decoder::new(&bytes)
        .decode()
        .ok_or_else(|| "WebP decode returned None".to_string())?;
    let img = decoded.to_image();
    let out = std::env::temp_dir().join("psysonic-smtc-cover.png");
    img.save_with_format(&out, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn mpris_set_playback(
    controls: tauri::State<MprisControls>,
    playing: bool,
    position_secs: Option<f64>,
) -> Result<(), String> {
    use souvlaki::{MediaPlayback, MediaPosition};
    use std::time::Duration;

    let progress = position_secs.map(|s| MediaPosition(Duration::from_secs_f64(s)));
    let playback = if playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };
    let mut guard = controls.lock().unwrap();
    let Some(ctrl) = guard.as_mut() else { return Ok(()); };
    ctrl.set_playback(playback)
        .map_err(|e| format!("MPRIS set_playback failed: {e:?}"))
}

/// Returns true if `path` is an accessible directory (used for pre-flight checks in the frontend).
#[tauri::command]
#[specta::specta]
pub(crate) fn check_dir_accessible(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

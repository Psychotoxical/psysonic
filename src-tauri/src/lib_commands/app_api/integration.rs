use tauri::Emitter;

use crate::{MprisControls, ShortcutMap};

#[tauri::command]
pub(crate) fn register_global_shortcut(
    app: tauri::AppHandle,
    shortcut_map: tauri::State<ShortcutMap>,
    shortcut: String,
    action: String,
) -> Result<(), String> {
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

#[tauri::command]
pub(crate) fn unregister_global_shortcut(
    app: tauri::AppHandle,
    shortcut_map: tauri::State<ShortcutMap>,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    shortcut_map.lock().unwrap().remove(&shortcut);
    let parsed: Shortcut = shortcut.parse().map_err(|_| format!("Invalid shortcut: {shortcut}"))?;
    app.global_shortcut().unregister(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
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
    ctrl.set_metadata(MediaMetadata {
        title: title.as_deref(),
        artist: artist.as_deref(),
        album: album.as_deref(),
        cover_url: cover_url.as_deref(),
        duration,
    })
    .map_err(|e| format!("MPRIS set_metadata failed: {e:?}"))
}

#[tauri::command]
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
pub(crate) fn check_dir_accessible(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

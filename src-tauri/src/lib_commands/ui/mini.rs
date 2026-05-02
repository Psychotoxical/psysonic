use super::*;

use super::*;

// ── Mini Player window ──────────────────────────────────────────────────────
// Secondary always-on-top window with minimal playback controls. Uses the
// same frontend bundle as the main window; disambiguated by window label
// "mini". On tiling WMs (Hyprland, Sway, i3, …) always-on-top is ignored, so
// we fall back to a regular window there.

/// Persisted geometry for the mini player. Stored in
/// `<app_config_dir>/mini_player_pos.json` and rewritten (throttled) on
/// every `WindowEvent::Moved` so the window reopens where the user last
/// left it. Coordinates are physical pixels — that's what `set_position`
/// and the move event both report, so we don't need to round-trip through
/// scale factors that may differ across monitors.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug)]
pub(crate) struct MiniPlayerPosition {
    x: i32,
    y: i32,
}

pub(crate) fn mini_pos_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|p| p.join("mini_player_pos.json"))
}

pub(crate) fn read_mini_pos(app: &tauri::AppHandle) -> Option<MiniPlayerPosition> {
    let path = mini_pos_file(app)?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn write_mini_pos(app: &tauri::AppHandle, pos: MiniPlayerPosition) {
    let Some(path) = mini_pos_file(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(&pos) {
        let _ = std::fs::write(path, json);
    }
}

/// Tracks when we last set the mini player position programmatically.
/// `WindowEvent::Moved` fires for both user drags AND our own `show()` /
/// `set_position` calls — without this guard the WM's "centre on show"
/// behaviour would silently overwrite the user's saved position.
pub(crate) fn last_programmatic_pos_set() -> &'static Mutex<std::time::Instant> {
    static LAST: OnceLock<Mutex<std::time::Instant>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(10)))
}

pub(crate) fn mark_mini_pos_programmatic() {
    *last_programmatic_pos_set().lock().unwrap() = std::time::Instant::now();
}

pub(crate) fn is_mini_pos_programmatic() -> bool {
    last_programmatic_pos_set().lock().unwrap().elapsed()
        < std::time::Duration::from_millis(1000)
}

/// Throttle disk writes during a drag — `WindowEvent::Moved` fires on
/// every pointer step. 250 ms keeps the file fresh enough that any close
/// or release lands a recent position, without hammering the disk.
/// Programmatic moves (during `show()` / `set_position`) are skipped so
/// WM re-centring on re-show doesn't clobber the saved position.
pub(crate) fn persist_mini_pos_throttled(app: &tauri::AppHandle, x: i32, y: i32) {
    if is_mini_pos_programmatic() {
        return;
    }
    static LAST_WRITE: OnceLock<Mutex<std::time::Instant>> = OnceLock::new();
    let mu = LAST_WRITE.get_or_init(|| {
        Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(10))
    });
    {
        let mut last = mu.lock().unwrap();
        if last.elapsed() < std::time::Duration::from_millis(250) {
            return;
        }
        *last = std::time::Instant::now();
    }
    write_mini_pos(app, MiniPlayerPosition { x, y });
}

/// Returns true when the saved top-left lands inside an available monitor
/// with enough room (≥ 80 px in each axis) to leave a draggable corner of
/// the window on-screen. Used to drop persisted positions that point at a
/// monitor that is no longer enumerated (unplugged, hot-plug detection
/// race during early boot, resolution change, monitor reorder).
pub(crate) fn mini_position_visible(app: &tauri::AppHandle, x: i32, y: i32) -> bool {
    const MIN_VISIBLE: i32 = 80;
    let monitors = match app.available_monitors() {
        Ok(m) if !m.is_empty() => m,
        _ => return false,
    };
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        x >= mp.x
            && y >= mp.y
            && x + MIN_VISIBLE <= mp.x + ms.width as i32
            && y + MIN_VISIBLE <= mp.y + ms.height as i32
    })
}

/// Default position when nothing is persisted: bottom-right of the monitor
/// the main window sits on (falls back to primary). A 24 px logical margin
/// keeps it off the screen edge; +56 px on the bottom margin avoids most
/// taskbars/docks since Tauri does not expose work-area rects.
pub(crate) fn default_mini_position(app: &tauri::AppHandle) -> Option<tauri::PhysicalPosition<i32>> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;

    let scale = monitor.scale_factor();
    let m_pos = monitor.position();
    let m_size = monitor.size();

    let win_w = (340.0 * scale).round() as i32;
    let win_h = (260.0 * scale).round() as i32;
    let margin_x = (24.0 * scale).round() as i32;
    let margin_y = (56.0 * scale).round() as i32;

    Some(tauri::PhysicalPosition::new(
        m_pos.x + (m_size.width as i32) - win_w - margin_x,
        m_pos.y + (m_size.height as i32) - win_h - margin_y,
    ))
}

/// JS snippet to inject into a hidden webview to reduce compositor work while
/// the host window is invisible.
///
/// WebView2 on Windows can keep a GPU-backed compositor active even when the
/// native window is hidden. This script does **not** stop arbitrary JS timers
/// or every `requestAnimationFrame` loop — it sets a flag the app reads, zeros
/// `--psy-anim-speed` (for CSS that opts into it), and pauses **@keyframes**
/// animations via `animation-play-state` (not CSS transitions).
///
/// Also sets `data-psy-native-hidden` on `<html>` so global CSS can pause every
/// animation including `::before`/`::after` and portal content under `<body>`
/// when `document.hidden` stays false on some WebView2 builds after `win.hide()`.
pub(crate) const PAUSE_RENDERING_JS: &str = r#"
window.__psyHidden = true;
document.documentElement.setAttribute('data-psy-native-hidden', 'true');
document.documentElement.style.setProperty('--psy-anim-speed', '0');
(function () {
  const root = document.getElementById('root');
  if (!root) return;
  root.querySelectorAll('*').forEach(function (el) {
    el.style.animationPlayState = 'paused';
  });
})();
"#;

/// JS snippet to resume rendering when the window becomes visible again.
pub(crate) const RESUME_RENDERING_JS: &str = r#"
window.__psyHidden = false;
document.documentElement.removeAttribute('data-psy-native-hidden');
document.documentElement.style.removeProperty('--psy-anim-speed');
(function () {
  const root = document.getElementById('root');
  if (!root) return;
  root.querySelectorAll('*').forEach(function (el) {
    el.style.animationPlayState = '';
  });
})();
"#;

/// Build the mini player webview window. Caller decides `visible` so the
/// same code path serves both pre-creation (Windows, hidden at app start)
/// and lazy creation (other platforms, shown on demand).
pub(crate) fn build_mini_player_window(
    app: &tauri::AppHandle,
    visible: bool,
) -> Result<tauri::WebviewWindow, String> {
    let use_always_on_top = {
        #[cfg(target_os = "linux")]
        { !is_tiling_wm() }
        #[cfg(not(target_os = "linux"))]
        { true }
    };

    // Tiling WMs manage window sizes themselves — enforcing a max width
    // there fights the compositor. Everywhere else we cap the width so
    // a horizontal drag can't stretch the layout across a whole monitor.
    let cap_width = {
        #[cfg(target_os = "linux")]
        { !is_tiling_wm() }
        #[cfg(not(target_os = "linux"))]
        { true }
    };

    // Resolve target position BEFORE building so the WM places the window
    // correctly from creation. Calling `set_position` after `build()` is
    // unreliable on several Linux WMs which re-centre hidden windows.
    // Drop the persisted position if it would land on a monitor that is
    // no longer enumerated (unplugged second monitor, hot-plug race during
    // early boot, resolution change) — fall back to the default placement.
    let target_physical = read_mini_pos(app)
        .filter(|p| mini_position_visible(app, p.x, p.y))
        .map(|p| tauri::PhysicalPosition::new(p.x, p.y))
        .or_else(|| default_mini_position(app));
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);

    // macOS + Windows keep the native titlebar (traffic lights / caption
    // buttons + system look). Linux uses a custom in-page titlebar so the
    // mini fits a tighter visual style across all WMs (incl. tiling).
    let use_decorations = !cfg!(target_os = "linux");

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "mini",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Psysonic Mini")
    .inner_size(340.0, 260.0)
    .min_inner_size(320.0, 240.0)
    .resizable(true)
    .decorations(use_decorations)
    .always_on_top(use_always_on_top)
    .skip_taskbar(false)
    .visible(visible);

    // Cap width so horizontal drag can't stretch the layout across a whole
    // monitor. Height is intentionally left effectively unlimited so users
    // can grow the queue list as tall as they want. Skipped on tiling WMs
    // since those manage window sizing themselves.
    if cap_width {
        builder = builder.max_inner_size(400.0, 4096.0);
    }

    if let Some(pos) = target_physical {
        builder = builder.position(pos.x as f64 / scale, pos.y as f64 / scale);
    }

    // Suppress Moved-event echo for the initial show — Linux WMs sometimes
    // fire stray Moved events with default coords during the first paint.
    mark_mini_pos_programmatic();

    let win = builder
        .build()
        .map_err(|e| format!("failed to build mini player window: {e}"))?;

    // Inject pause script immediately when the window is created hidden.
    // On Windows WebView2 keeps the GPU context alive even with
    // `SetIsVisible(false)` — this JS stops all rendering work.
    if !visible {
        let _ = win.eval(PAUSE_RENDERING_JS);
    }

    Ok(win)
}

/// Pre-build the mini player window hidden, so the first `open_mini_player`
/// call becomes a pure show/hide and the user sees content instantly. On
/// Windows this already happens unconditionally in `.setup()` as a hang
/// workaround; this command is used by Linux/macOS when the user opts into
/// the `preloadMiniPlayer` setting. Idempotent — no-op if the window exists.
#[tauri::command]
pub(crate) fn preload_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("mini").is_some() {
        return Ok(());
    }
    build_mini_player_window(&app, false).map(|_| ())
}

/// Open (or toggle) the mini player window. On platforms where the window
/// was pre-created at startup (Windows), this is a pure show/hide. On
/// other platforms the window is created lazily on first call.
/// Opening the mini player minimizes the main window; hiding the mini
/// player restores the main window.
#[tauri::command]
pub(crate) fn open_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    let win = match app.get_webview_window("mini") {
        Some(w) => w,
        None => build_mini_player_window(&app, false)?,
    };

    let visible = win.is_visible().unwrap_or(false);
    if visible {
        // Pause before hide so `__psyHidden` is set while the webview is still
        // guaranteed schedulable (mirrors tray / main close ordering).
        let _ = win.eval(PAUSE_RENDERING_JS);
        win.hide().map_err(|e| e.to_string())?;
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    } else {
        // Resume rendering before showing — the window needs to be ready
        // to paint as soon as it becomes visible.
        let _ = win.eval(RESUME_RENDERING_JS);
        // Re-applying the saved position after show() — many Linux WMs
        // (Mutter, KWin) re-centre hidden windows when they're shown
        // again, ignoring any earlier set_position. Mark the move as
        // programmatic so the Moved-event handler doesn't echo the
        // intermediate centre coords back to disk.
        // Drop the persisted position if its monitor is gone and fall
        // back to the default placement so we don't open off-screen.
        let target = read_mini_pos(&app)
            .filter(|p| mini_position_visible(&app, p.x, p.y))
            .map(|p| tauri::PhysicalPosition::new(p.x, p.y))
            .or_else(|| default_mini_position(&app));
        mark_mini_pos_programmatic();
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_focus();
        if let Some(p) = target {
            let _ = win.set_position(p);
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.minimize();
        }
    }
    Ok(())
}

/// Hide the mini player window if it exists and restore the main window.
/// Does not destroy the mini window so its state is preserved for next open.
#[tauri::command]
pub(crate) fn close_mini_player(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("mini") {
        let _ = win.eval(PAUSE_RENDERING_JS);
        win.hide().map_err(|e| e.to_string())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

/// Unminimize + show + focus the main window. Called from the mini player's
/// "expand" button. Can't rely on a JS event bridge here because the main
/// window's JS is paused while minimized on WebKitGTK. Also hides the mini
/// window so the two don't sit on screen at the same time.
#[tauri::command]
pub(crate) fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.eval(PAUSE_RENDERING_JS);
        let _ = mini.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(RESUME_RENDERING_JS);
        main.unminimize().map_err(|e| e.to_string())?;
        main.show().map_err(|e| e.to_string())?;
        main.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Inject the pause script into this webview (CSS @keyframes pause + `__psyHidden`).
#[tauri::command]
pub(crate) fn pause_rendering(window: tauri::WebviewWindow) -> Result<(), String> {
    window.eval(PAUSE_RENDERING_JS).map_err(|e| e.to_string())
}

/// Resume rendering work in the current webview. Called when the window
/// becomes visible again.
#[tauri::command]
pub(crate) fn resume_rendering(window: tauri::WebviewWindow) -> Result<(), String> {
    window.eval(RESUME_RENDERING_JS).map_err(|e| e.to_string())
}

/// Toggle always-on-top on the mini player window.
///
/// Some window managers (KWin, certain Mutter releases, GNOME-on-Wayland)
/// silently ignore `set_always_on_top(true)` when the internal flag is
/// already `true` — which happens whenever the window was hidden and
/// re-shown, or focus was lost and the WM dropped the constraint. We
/// always force a `false → true` cycle so the WM re-evaluates the layer.
#[tauri::command]
pub(crate) fn set_mini_player_always_on_top(app: tauri::AppHandle, on_top: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("mini") {
        if on_top {
            let _ = win.set_always_on_top(false);
        }
        win.set_always_on_top(on_top).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize the mini player window (logical pixels). Used when toggling the
/// queue panel to expand/collapse without a capability dance. Optional
/// `minWidth` / `minHeight` adjust the window's resize floor so the user
/// can't shrink past the layout's minimum (e.g. 2 visible queue rows when
/// the queue panel is open).
#[tauri::command]
pub(crate) fn resize_mini_player(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("mini") {
        // Lower the floor first; otherwise set_size to a value below the
        // existing min would silently clamp.
        if let (Some(mw), Some(mh)) = (min_width, min_height) {
            win.set_min_size(Some(tauri::LogicalSize::new(mw, mh)))
                .map_err(|e| e.to_string())?;
        }
        win.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}


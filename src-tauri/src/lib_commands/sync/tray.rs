use super::*;

pub(crate) fn build_tray_icon(app: &tauri::AppHandle) -> tauri::Result<TrayIcon> {
    let labels = app
        .try_state::<TrayMenuLabelsState>()
        .map(|s| s.lock().unwrap().clone())
        .unwrap_or_default();

    let play_pause = MenuItemBuilder::with_id("play_pause", &labels.play_pause).build(app)?;
    let next       = MenuItemBuilder::with_id("next",       &labels.next).build(app)?;
    let previous   = MenuItemBuilder::with_id("previous",   &labels.previous).build(app)?;
    let sep1       = PredefinedMenuItem::separator(app)?;
    let show_hide  = MenuItemBuilder::with_id("show_hide",  &labels.show_hide).build(app)?;
    let sep2       = PredefinedMenuItem::separator(app)?;
    let quit       = MenuItemBuilder::with_id("quit",       &labels.quit).build(app)?;

    let cached_tooltip = app
        .try_state::<TrayTooltip>()
        .and_then(|s| {
            let g = s.lock().ok()?;
            if g.is_empty() { None } else { Some(g.clone()) }
        })
        .unwrap_or_else(|| "Psysonic".to_string());
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let playback_state = app
        .try_state::<TrayPlaybackState>()
        .map(|s| s.0.lock().unwrap().clone())
        .unwrap_or_else(|| "stop".to_string());
    #[cfg(target_os = "windows")]
    let tooltip_with_icon = format!("{} {}", tray_state_icon(&playback_state), cached_tooltip);

    // Linux/AppIndicator has no hover tooltip; surface the now-playing track as
    // a disabled menu entry at the top instead. The label is updated by
    // `set_tray_tooltip` on every track change.
    #[cfg(target_os = "linux")]
    let (now_playing, sep_now_playing) = {
        let icon = tray_state_icon(&playback_state);
        let label = if cached_tooltip == "Psysonic" {
            format!("{icon} {}", labels.nothing_playing)
        } else {
            format!("{icon} {cached_tooltip}")
        };
        let item = MenuItemBuilder::with_id("now_playing", &label)
            .enabled(false)
            .build(app)?;
        (item, PredefinedMenuItem::separator(app)?)
    };

    #[cfg(target_os = "linux")]
    let menu_builder = MenuBuilder::new(app)
        .item(&now_playing)
        .item(&sep_now_playing);
    #[cfg(not(target_os = "linux"))]
    let menu_builder = MenuBuilder::new(app);

    let menu = menu_builder
        .item(&play_pause)
        .item(&previous)
        .item(&next)
        .item(&sep1)
        .item(&show_hide)
        .item(&sep2)
        .item(&quit)
        .build()?;

    // Persist handles so set_tray_menu_labels and set_tray_tooltip can update
    // them without rebuilding the whole tray icon.
    if let Some(state) = app.try_state::<TrayMenuItemsState>() {
        *state.lock().unwrap() = Some(TrayMenuItems {
            play_pause: play_pause.clone(),
            next: next.clone(),
            previous: previous.clone(),
            show_hide: show_hide.clone(),
            quit: quit.clone(),
            #[cfg(target_os = "linux")]
            now_playing: Some(now_playing.clone()),
            #[cfg(not(target_os = "linux"))]
            now_playing: None,
        });
    }

    #[cfg(target_os = "windows")]
    let tray_builder = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip(&tooltip_with_icon)
        // tray-icon defaults to opening the context menu on every WM_LBUTTONUP when this is true.
        // A left double-click emits Down, Up, DoubleClick, Up — the final Up re-opens the menu right
        // after we hide the window from DoubleClick. We only use left double-click for show/hide
        // (see on_tray_icon_event); keep the menu on right-click like typical Windows tray apps.
        .show_menu_on_left_click(false);
    #[cfg(not(target_os = "windows"))]
    let tray_builder = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip(&cached_tooltip);

    tray_builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "play_pause" => { let _ = app.emit("tray:play-pause", ()); }
            "next"       => { let _ = app.emit("tray:next", ()); }
            "previous"   => { let _ = app.emit("tray:previous", ()); }
            "show_hide"  => {
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.eval(PAUSE_RENDERING_JS);
                        let _ = win.hide();
                    } else {
                        let _ = win.eval(RESUME_RENDERING_JS);
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            "quit" => { let _ = app.emit("app:force-quit", ()); }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Windows fires a Click on *every* half of a double-click, so a
            // double-click would toggle the window visibility twice and end up
            // back where it started (the bug #cucadmuh reported). Switch to the
            // Windows-only DoubleClick event there and ignore single clicks;
            // that matches the standard Windows tray convention (Discord, etc).
            #[cfg(target_os = "windows")]
            let should_toggle = matches!(
                event,
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }
            );
            #[cfg(not(target_os = "windows"))]
            let should_toggle = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            );
            if should_toggle {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.eval(PAUSE_RENDERING_JS);
                        let _ = win.hide();
                    } else {
                        let _ = win.eval(RESUME_RENDERING_JS);
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        })
        .build(app)
}

/// Creates the tray icon, or `None` if the OS cannot host one.
///
/// On Linux, `libayatana-appindicator3` / `libappindicator3` may be absent (minimal
/// installs, wrong `LD_LIBRARY_PATH`). The `tray-icon` stack can **panic** on `dlopen`
/// failure instead of returning `Err`, so we catch unwind and keep the app running
/// (e.g. cold start with `--player` still works without tray libraries).
pub(crate) fn try_build_tray_icon(app: &tauri::AppHandle) -> Option<TrayIcon> {
    let app = app.clone();
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_tray_icon(&app))) {
        Ok(Ok(tray)) => Some(tray),
        Ok(Err(e)) => {
            crate::app_eprintln!("[Psysonic] System tray unavailable: {e}");
            None
        }
        Err(_) => {
            crate::app_eprintln!(
                "[Psysonic] System tray unavailable — missing libayatana-appindicator3 or libappindicator3 \
                 (install the distro package or set LD_LIBRARY_PATH)"
            );
            None
        }
    }
}

/// Updates the system-tray icon tooltip with the currently playing track.
///
/// `tooltip` should be a compact "Artist – Title" form (no app suffix needed —
/// the tray icon itself identifies the app). An empty string resets to the
/// default `"Psysonic"` tooltip.
///
/// The text is truncated to 127 chars defensively to stay under the historical
/// Windows `NOTIFYICONDATA.szTip` limit (128 bytes including the null terminator).
/// On Linux the visibility depends on the desktop environment / panel —
/// StatusNotifierItem-aware panels (KDE, Cinnamon, GNOME with AppIndicator
/// extension) show it; pure-GNOME without the extension does not.
#[tauri::command]
pub(crate) fn set_tray_tooltip(
    app: tauri::AppHandle,
    tray_state: tauri::State<TrayState>,
    tooltip_cache: tauri::State<TrayTooltip>,
    playback_state_cache: tauri::State<TrayPlaybackState>,
    tooltip: String,
    playback_state: Option<String>,
) -> Result<(), String> {
    let has_track_input = !tooltip.is_empty();
    let state = playback_state.as_deref().unwrap_or(if has_track_input { "play" } else { "stop" });
    let icon = tray_state_icon(state);
    let icon_prefix_len = format!("{icon} ").chars().count();
    let max_text_chars = 127usize.saturating_sub(icon_prefix_len);
    let ellipsis_reserve = 3usize;
    let truncated = if tooltip.chars().count() > max_text_chars {
        let take = max_text_chars.saturating_sub(ellipsis_reserve);
        tooltip.chars().take(take).collect::<String>() + "..."
    } else {
        tooltip
    };
    let has_track = !truncated.is_empty();
    let effective = if has_track { truncated.clone() } else { "Psysonic".to_string() };
    #[cfg(target_os = "windows")]
    let effective_with_icon = format!("{icon} {effective}");

    *tooltip_cache.lock().unwrap() = truncated.clone();
    *playback_state_cache.0.lock().unwrap() = state.to_string();

    if let Some(tray) = tray_state.lock().unwrap().as_ref() {
        #[cfg(target_os = "windows")]
        tray.set_tooltip(Some(&effective_with_icon)).map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "windows"))]
        tray.set_tooltip(Some(&effective)).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(state) = app.try_state::<TrayMenuItemsState>() {
            if let Some(items) = state.lock().unwrap().as_ref() {
                if let Some(np) = items.now_playing.as_ref() {
                    let label = if has_track {
                        format!("{icon} {effective}")
                    } else {
                        let nothing = app.try_state::<TrayMenuLabelsState>()
                            .map(|s| s.lock().unwrap().nothing_playing.clone())
                            .unwrap_or_else(|| "Nothing playing".to_string());
                        format!("{icon} {nothing}")
                    };
                    let _ = np.set_text(&label);
                }
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = &app;

    Ok(())
}

/// Pushes localized labels into the tray menu. Called from the frontend on
/// startup and whenever the i18n language changes. Updates are applied
/// immediately to live menu items via `set_text` (no tray rebuild required)
/// and cached so the labels survive a tray hide/show cycle.
#[tauri::command]
pub(crate) fn set_tray_menu_labels(
    app: tauri::AppHandle,
    labels_state: tauri::State<TrayMenuLabelsState>,
    items_state: tauri::State<TrayMenuItemsState>,
    tooltip_cache: tauri::State<TrayTooltip>,
    play_pause: String,
    next: String,
    previous: String,
    show_hide: String,
    quit: String,
    nothing_playing: String,
) -> Result<(), String> {
    let new_labels = TrayMenuLabels {
        play_pause,
        next,
        previous,
        show_hide,
        quit,
        nothing_playing,
    };
    *labels_state.lock().unwrap() = new_labels.clone();

    if let Some(items) = items_state.lock().unwrap().as_ref() {
        let _ = items.play_pause.set_text(&new_labels.play_pause);
        let _ = items.next.set_text(&new_labels.next);
        let _ = items.previous.set_text(&new_labels.previous);
        let _ = items.show_hide.set_text(&new_labels.show_hide);
        let _ = items.quit.set_text(&new_labels.quit);

        // Linux now-playing item: only refresh the placeholder. The track
        // text itself is owned by `set_tray_tooltip` and shouldn't be
        // overwritten by an unrelated language change.
        #[cfg(target_os = "linux")]
        if let Some(np) = items.now_playing.as_ref() {
            let has_track = !tooltip_cache.lock().unwrap().is_empty();
            if !has_track {
                let state = app
                    .try_state::<TrayPlaybackState>()
                    .map(|s| s.0.lock().unwrap().clone())
                    .unwrap_or_else(|| "stop".to_string());
                let label = format!("{} {}", tray_state_icon(&state), new_labels.nothing_playing);
                let _ = np.set_text(&label);
            }
        }
    }

    let _ = (&app, &tooltip_cache);
    Ok(())
}

/// Show (`true`) or fully remove (`false`) the system-tray icon.
///
/// The command is strictly idempotent:
/// - `show=true`  when the icon is already present → no-op (prevents duplicate icons).
/// - `show=false` when the icon is already absent  → no-op.
///
/// For removal, `set_visible(false)` is called explicitly before the handle is
/// dropped because some platforms (Windows notification area, certain Linux DEs)
/// process the OS removal asynchronously — hiding first prevents a brief "ghost"
/// icon from appearing alongside a freshly created one.
#[tauri::command]
pub(crate) fn toggle_tray_icon(
    app: tauri::AppHandle,
    tray_state: tauri::State<TrayState>,
    show: bool,
) -> Result<(), String> {
    let mut guard = tray_state.lock().unwrap();

    if show {
        // Early-return when already shown — never build a second icon.
        if guard.is_some() {
            return Ok(());
        }
        let Some(tray) = try_build_tray_icon(&app) else {
            return Err(
                "Tray icon could not be created (missing system libraries on Linux).".into(),
            );
        };
        *guard = Some(tray);
    } else if let Some(tray) = guard.take() {
        // Hide synchronously before dropping so the OS processes the removal
        // before any subsequent show=true call can create a new icon.
        let _ = tray.set_visible(false);
        // `tray` drops here → frees the OS resource (NIM_DELETE / StatusNotifierItem / NSStatusItem).
    }

    Ok(())
}

/// Stops the Rust audio engine cleanly (mirrors the logic in `audio_stop`).
/// Called before process exit on macOS to ensure audio stops immediately.
pub(crate) fn stop_audio_engine(app: &tauri::AppHandle) {
    let engine = app.state::<audio::AudioEngine>();
    engine.generation.fetch_add(1, Ordering::SeqCst);
    *engine.chained_info.lock().unwrap() = None;
    drop(engine.radio_state.lock().unwrap().take());
    let mut cur = engine.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() { sink.stop(); }
}

/// Returns `true` if running under a tiling window manager (Hyprland, Sway, i3,
/// bspwm, AwesomeWM, Openbox, etc.).  Detection is based on environment variables
/// set by the compositor / DE.
#[cfg(target_os = "linux")]
pub(crate) fn is_tiling_wm() -> bool {
    // Direct compositor signatures (most reliable).
    let direct = [
        "HYPRLAND_INSTANCE_SIGNATURE", // Hyprland
        "SWAYSOCK",                     // Sway
        "I3SOCK",                       // i3
    ]
    .iter()
    .any(|&var| std::env::var_os(var).is_some());

    if direct {
        return true;
    }

    // Check XDG_CURRENT_DESKTOP for known tiling WMs.
    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        let desktop = desktop.to_lowercase();
        let tiling_wms = [
            "hyprland", "sway", "i3", "bspwm", "awesome", "openbox",
            "xmonad", "dwm", "qtile", "herbstluftwm", "leftwm",
        ];
        if tiling_wms.iter().any(|&wm| desktop.contains(wm)) {
            return true;
        }
    }

    false
}

/// Tauri command: returns true when WEBKIT_DISABLE_COMPOSITING_MODE=1 is set.
/// The frontend uses this to apply a CSS class that swaps out GPU-only effects
/// (backdrop-filter, CSS filter, mask-image) for software-friendly equivalents.
#[tauri::command]
pub(crate) fn no_compositing_mode() -> bool {
    std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn is_tiling_wm() -> bool {
    false
}

/// Tauri command: lets the frontend know whether we're running under a tiling
/// WM so it can decide whether to render the custom TitleBar component.
#[tauri::command]
pub(crate) fn is_tiling_wm_cmd() -> bool {
    is_tiling_wm()
}

//! Native-window + WebKitGTK platform tweaks exposed as Tauri commands.

use tauri::Manager;

/// `PSYSONIC_WEBKIT_WAYLAND_HW_POLICY` → WebKit hardware acceleration policy when
/// [`linux_webkit_apply_wayland_gpu_font_tuning`] runs. Default **`ondemand`**;
/// set **`never`** / **`software`** to force CPU-friendly layers (often sharper text
/// at the cost of compositor work); **`always`** forces the previous aggressive GPU path for A/B.
#[cfg(target_os = "linux")]
fn wayland_hw_acceleration_policy_from_env() -> webkit2gtk::HardwareAccelerationPolicy {
    use webkit2gtk::HardwareAccelerationPolicy;
    let v = std::env::var("PSYSONIC_WEBKIT_WAYLAND_HW_POLICY")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match v.as_str() {
        "never" | "off" | "0" | "software" => HardwareAccelerationPolicy::Never,
        "always" | "on" | "1" | "gpu" => HardwareAccelerationPolicy::Always,
        _ => HardwareAccelerationPolicy::OnDemand,
    }
}

/// True when `XDG_SESSION_TYPE` is Wayland, GPU compositing is not forced off,
/// and the user has not opted out via `PSYSONIC_SKIP_WAYLAND_FONT_TUNING`.
#[cfg(target_os = "linux")]
pub(crate) fn linux_wayland_gpu_font_tuning_should_apply() -> bool {
    fn skip_tuning() -> bool {
        matches!(
            std::env::var("PSYSONIC_SKIP_WAYLAND_FONT_TUNING").as_deref(),
            Ok("1") | Ok("true") | Ok("yes")
        )
    }
    if skip_tuning() {
        return false;
    }
    let wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);
    let no_comp = std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
        .map(|v| v == "1")
        .unwrap_or(false);
    wayland && !no_comp
}

/// WebKitGTK on Wayland with compositing: prefer on-demand GPU promotion so body
/// text is less often rasterised into GL layers (common "washed" / blurry look).
/// No-op on non-Linux or when [`linux_wayland_gpu_font_tuning_should_apply`] is false.
pub(crate) fn linux_webkit_apply_wayland_gpu_font_tuning(win: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if !linux_wayland_gpu_font_tuning_should_apply() {
            return Ok(());
        }
        win
            .with_webview(|platform| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                if let Some(settings) = platform.inner().settings() {
                    settings.set_hardware_acceleration_policy(wayland_hw_acceleration_policy_from_env());
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = win;
        Ok(())
    }
}

/// Toggle native window decorations at runtime (Linux custom title bar opt-out).
#[tauri::command]
pub(crate) fn set_window_decorations(enabled: bool, app_handle: tauri::AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.set_decorations(enabled);
        // Re-enabling native decorations on GTK causes the window manager to
        // re-stack the window, which drops focus. Bring it back immediately.
        if enabled {
            let _ = win.set_focus();
        }
    }
}

/// WebKitGTK: `enable-smooth-scrolling` also drives deferred / kinetic wheel scrolling.
#[cfg(target_os = "linux")]
pub(crate) fn linux_webkit_apply_smooth_scrolling(win: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    win.with_webview(move |platform| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = platform.inner().settings() {
            settings.set_enable_smooth_scrolling(enabled);
        }
    })
    .map_err(|e| e.to_string())
}

/// Called from the frontend settings toggle (Linux); no-op on other platforms.
#[tauri::command]
pub(crate) fn set_linux_webkit_smooth_scrolling(enabled: bool, app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        // Each WebviewWindow has its own WebKitGTK Settings — main-only left the
        // mini player on the default (inertial) wheel until the user toggled again.
        for label in ["main", "mini"] {
            if let Some(win) = app_handle.get_webview_window(label) {
                linux_webkit_apply_smooth_scrolling(&win, enabled)?;
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (enabled, app_handle);
    }
    Ok(())
}

/// True when [`linux_webkit_apply_wayland_gpu_font_tuning`] would change WebKit settings
/// (Wayland + GPU compositing, user has not set `PSYSONIC_SKIP_WAYLAND_FONT_TUNING`).
#[tauri::command]
pub(crate) fn linux_wayland_gpu_font_tuning_active() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux_wayland_gpu_font_tuning_should_apply()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

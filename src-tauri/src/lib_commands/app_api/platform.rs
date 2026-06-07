//! Native-window + WebKitGTK platform tweaks exposed as Tauri commands.

#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

#[cfg(target_os = "linux")]
const LINUX_WAYLAND_TEXT_PROFILE_FILE: &str = "linux_wayland_text_profile";

#[cfg(target_os = "linux")]
fn last_wayland_text_render_profile_cell() -> &'static Mutex<Option<String>> {
    static CELL: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

#[cfg(target_os = "linux")]
fn sanitized_wayland_text_profile(profile: &str) -> String {
    match profile.trim() {
        "balanced" | "sharp" | "gpu" | "minimal" => profile.trim().to_string(),
        _ => "sharp".to_string(),
    }
}

#[cfg(target_os = "linux")]
fn wayland_text_profile_persist_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|p| p.join(LINUX_WAYLAND_TEXT_PROFILE_FILE))
}

/// Load persisted Wayland text profile into the in-process cache before the main webview is tuned.
#[cfg(target_os = "linux")]
pub(crate) fn sync_wayland_text_profile_cache_from_disk(app: &tauri::AppHandle) {
    let Some(path) = wayland_text_profile_persist_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let s = sanitized_wayland_text_profile(&text);
    if let Ok(mut g) = last_wayland_text_render_profile_cell().lock() {
        *g = Some(s);
    }
}

#[cfg(target_os = "linux")]
fn remember_wayland_text_render_profile(profile: &str, app: Option<&tauri::AppHandle>) {
    let s = sanitized_wayland_text_profile(profile);
    if let Ok(mut g) = last_wayland_text_render_profile_cell().lock() {
        *g = Some(s.clone());
    }
    if let Some(app) = app {
        if let Some(path) = wayland_text_profile_persist_path(app) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&path, s);
        }
    }
}

/// Re-apply the last **Settings** Wayland text profile to a webview (used when the mini window is built).
#[cfg(target_os = "linux")]
pub(crate) fn linux_webkit_reapply_cached_wayland_text_render_profile(win: &tauri::WebviewWindow) -> Result<(), String> {
    let p = last_wayland_text_render_profile_cell()
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| "sharp".to_string());
    linux_webkit_apply_wayland_text_render_profile(win, &p)
}

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

/// Wayland session with WebKit GPU compositing (`WEBKIT_DISABLE_COMPOSITING_MODE` not forced on).
#[cfg(target_os = "linux")]
pub(crate) fn linux_wayland_gpu_compositing_context() -> bool {
    let wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);
    let no_comp = std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
        .map(|v| v == "1")
        .unwrap_or(false);
    wayland && !no_comp
}

/// True when [`linux_webkit_apply_wayland_gpu_font_tuning`] would change WebKit settings
/// (Wayland + GPU compositing, user has not set `PSYSONIC_SKIP_WAYLAND_FONT_TUNING`).
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
    linux_wayland_gpu_compositing_context()
}

/// WebKitGTK on Wayland with compositing: prefer on-demand GPU promotion so body
/// text is less often rasterised into GL layers (common "washed" / blurry look).
/// No-op when [`linux_wayland_gpu_font_tuning_should_apply`] is false.
#[cfg(target_os = "linux")]
pub(crate) fn linux_webkit_apply_wayland_gpu_font_tuning(win: &tauri::WebviewWindow) -> Result<(), String> {
    if !linux_wayland_gpu_font_tuning_should_apply() {
        return Ok(());
    }
    win
        .with_webview(|platform| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            if let Some(settings) = platform.inner().settings() {
                let policy = wayland_hw_acceleration_policy_from_env();
                if settings.hardware_acceleration_policy() != policy {
                    settings.set_hardware_acceleration_policy(policy);
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// Toggle native window decorations at runtime (Linux custom title bar opt-out).
/// Tauri command: true when theme animations may be costly on this setup —
/// Linux with the Nvidia WebKit quirk active (recorded once at startup) or
/// compositing forced off. The frontend warns on animated themes when true.
/// Always false off Linux.
#[tauri::command]
pub(crate) fn theme_animation_risk() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Compositing forced off → GPU-accelerated effects/animation are costly.
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
            .map(|v| v == "1")
            .unwrap_or(false)
        {
            return true;
        }
        crate::theme_animation::nvidia_quirk_active()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

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

#[cfg(target_os = "linux")]
fn hardware_acceleration_policy_from_render_profile(profile: &str) -> webkit2gtk::HardwareAccelerationPolicy {
    use webkit2gtk::HardwareAccelerationPolicy;
    match profile.trim() {
        // `Never` here has been observed to break main-viewport wheel scrolling on WebKitGTK
        // under Wayland+GPU compositing after the policy is applied at startup. CSS still
        // differentiates "sharp"; use `PSYSONIC_WEBKIT_WAYLAND_HW_POLICY=never` for true Never.
        "sharp" => HardwareAccelerationPolicy::OnDemand,
        "gpu" => HardwareAccelerationPolicy::Always,
        "balanced" | "minimal" => HardwareAccelerationPolicy::OnDemand,
        _ => HardwareAccelerationPolicy::OnDemand,
    }
}

/// Apply WebKit hardware acceleration policy from a **Settings** profile (`balanced` / `sharp` /
/// `gpu` / `minimal`). Call only at webview creation / startup — toggling this at runtime wedges
/// WebKitGTK on some Wayland stacks after a few changes.
#[cfg(target_os = "linux")]
pub(crate) fn linux_webkit_apply_wayland_text_render_profile(
    win: &tauri::WebviewWindow,
    profile: &str,
) -> Result<(), String> {
    if !linux_wayland_gpu_compositing_context() {
        return Ok(());
    }
    let policy = hardware_acceleration_policy_from_render_profile(profile);
    win
        .with_webview(move |platform| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            if let Some(settings) = platform.inner().settings() {
                if settings.hardware_acceleration_policy() != policy {
                    settings.set_hardware_acceleration_policy(policy);
                }
            }
        })
        .map_err(|e| e.to_string())
}

/// Persist the Wayland text profile for the next app start and for new mini-player webviews.
/// Does **not** touch WebKit on existing windows (avoids WebKitGTK hangs when toggling policy live).
#[tauri::command]
pub(crate) fn set_linux_wayland_text_render_profile(
    profile: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if !linux_wayland_gpu_compositing_context() {
            return Ok(());
        }
        remember_wayland_text_render_profile(&profile, Some(&app_handle));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (profile, app_handle);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn linux_wayland_text_render_settings_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        linux_wayland_gpu_compositing_context()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

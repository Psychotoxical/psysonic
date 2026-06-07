//! Startup-recorded display hint for the theme system.
//!
//! The Nvidia/WebKit GPU quirk is detected once at process start (in `main()`,
//! before the webview/GTK init). We record whether it was needed so the UI can
//! warn that animated themes may raise CPU load on this setup — without
//! re-probing the GPU later. Read via the `theme_animation_risk` command
//! (`lib_commands::app_api::platform`).

use std::sync::OnceLock;

static NVIDIA_QUIRK_ACTIVE: OnceLock<bool> = OnceLock::new();

/// Record the startup Nvidia-WebKit-quirk detection. Called once from `main()`.
pub fn set_nvidia_quirk_active(active: bool) {
    let _ = NVIDIA_QUIRK_ACTIVE.set(active);
}

/// Whether the Nvidia WebKit quirk was needed at startup. False when unrecorded
/// (non-Linux, or GPU acceleration opted in via `PSYSONIC_WEBKIT_GPU_ACCEL`).
pub(crate) fn nvidia_quirk_active() -> bool {
    NVIDIA_QUIRK_ACTIVE.get().copied().unwrap_or(false)
}

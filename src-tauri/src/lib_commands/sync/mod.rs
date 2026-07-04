pub(crate) mod tray;

pub(crate) use tray::{
    is_tiling_wm_cmd, linux_xdg_session_type, no_compositing_mode, set_tray_menu_labels, set_tray_tooltip,
    toggle_tray_icon,
};
// Internal helpers consumed elsewhere in the shell crate:
pub(crate) use tray::{stop_audio_engine, try_build_tray_icon};
#[cfg(target_os = "linux")]
pub(crate) use tray::is_tiling_wm;

// Sync commands now live in `psysonic_syncfs::sync::*` — invoke_handler!
// in lib.rs registers them with the full path so Tauri's `__cmd__*` magic
// macros resolve correctly across the crate boundary; nothing to re-export
// here.

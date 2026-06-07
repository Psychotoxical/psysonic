mod backup;
mod cli_bridge;
mod core;
mod integration;
mod migration;
mod network;
mod perf;
pub(crate) mod platform;

// Tauri commands re-exported for the lib.rs invoke_handler.
pub(crate) use backup::{
    backup_export_full, backup_export_library_db, backup_import_full, backup_import_library_db,
};
pub(crate) use cli_bridge::{
    cli_publish_library_list, cli_publish_player_snapshot, cli_publish_search_results,
    cli_publish_server_list,
};
pub(crate) use core::{
    exit_app, export_runtime_logs, frontend_debug_log, get_logging_mode, greet, set_logging_mode,
    set_subsonic_wire_user_agent, tail_runtime_logs,
};
pub(crate) use perf::performance_cpu_snapshot;
pub(crate) use platform::{
    linux_wayland_gpu_font_tuning_active, linux_wayland_text_render_settings_available,
    set_linux_wayland_text_render_profile, set_linux_webkit_smooth_scrolling, set_window_decorations,
    theme_animation_risk,
};
#[cfg(target_os = "linux")]
pub(crate) use platform::{
    linux_webkit_apply_wayland_gpu_font_tuning, linux_webkit_reapply_cached_wayland_text_render_profile,
    sync_wayland_text_profile_cache_from_disk,
};
pub(crate) use integration::{
    check_dir_accessible, mpris_set_metadata, mpris_set_playback, register_global_shortcut,
    unregister_global_shortcut,
};
pub(crate) use migration::{migration_inspect, migration_run};
pub(crate) use network::resolve_host_addresses;

// Discord, Navidrome admin, last.fm + radio-browser + CORS proxy, bandsintown,
// and analysis admin commands now live in their domain crates. invoke_handler!
// in lib.rs registers them with full paths so Tauri's `__cmd__*` macros resolve.

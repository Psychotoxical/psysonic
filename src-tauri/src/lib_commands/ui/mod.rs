mod mini;

pub(crate) use mini::{
    close_mini_player, open_mini_player, pause_rendering, persist_mini_pos_throttled,
    preload_mini_player, resize_mini_player, resume_rendering, set_mini_player_always_on_top,
    show_main_window, PAUSE_RENDERING_JS, RESUME_RENDERING_JS,
};
// Pre-create-on-startup is a Windows-only path (see `lib.rs:setup`); other
// platforms create the mini-player webview lazily on first invoke. The
// re-export is gated to match so non-Windows builds don't warn on an
// unused import.
#[cfg(target_os = "windows")]
pub(crate) use mini::build_mini_player_window;
// Bandsintown moved to psysonic-integration; lib.rs uses the full path.

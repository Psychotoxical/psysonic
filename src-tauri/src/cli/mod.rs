//! CLI surface for scripting / compositor bindings (e.g. Hyprland `exec`).

mod completions;
mod dispatch;
mod exchange;
mod help;
mod info;
#[cfg(target_os = "linux")]
mod linux_forward;
mod logs;
mod parse;
mod presenters;

pub use completions::try_completions_dispatch;
pub use dispatch::{
    describe_cli_command, describe_player_cli_cmd, emit_player_cli_cmd,
    handle_cli_on_primary_instance, spawn_deferred_cli_argv_handler,
};
pub use exchange::*;
pub use help::{print_help, print_version};
pub use info::run_info_and_exit;
#[cfg(target_os = "linux")]
pub use linux_forward::*;
pub use logs::run_tail_and_exit;
pub use parse::*;
pub use presenters::print_audio_devices_human;

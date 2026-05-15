// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use webkit2gtk_nvidia_quirk::{apply_workaround_with_options, ApplyWorkaroundOptions};

fn main() {
    // Linux GTK/WebKit: do not synthesize GDK_BACKEND or bespoke WEBKIT_DISABLE_* stacks here —
    // `webkit2gtk-nvidia-quirk` is the only automatic NVIDIA/session env layer (skipped when
    // `PSYSONIC_WEBKIT_GPU_ACCEL` is set).
    #[cfg(target_os = "linux")]
    {
        let skip_nv_quirk = std::env::var("PSYSONIC_WEBKIT_GPU_ACCEL").is_ok();
        if !skip_nv_quirk {
            apply_workaround_with_options(ApplyWorkaroundOptions::default());
        }
    }

    let args: Vec<String> = std::env::args().collect();
    if psysonic_lib::cli::wants_version(&args) {
        psysonic_lib::cli::print_version();
        return;
    }
    if psysonic_lib::cli::wants_help(&args) {
        psysonic_lib::cli::print_help(
            args.first().map(|s| s.as_str()).unwrap_or("psysonic"),
        );
        return;
    }
    if let Some(code) = psysonic_lib::cli::try_completions_dispatch(&args) {
        std::process::exit(code);
    }
    if psysonic_lib::cli::wants_info(&args) {
        psysonic_lib::cli::run_info_and_exit(&args);
    }
    if psysonic_lib::cli::wants_logs(&args) {
        psysonic_lib::cli::run_tail_and_exit(&args);
    }
    if psysonic_lib::cli::wants_tail(&args) {
        eprintln!("NOT OK: --tail is only valid with --logs");
        std::process::exit(2);
    }

    psysonic_lib::run();
}

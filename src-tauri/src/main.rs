// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use webkit2gtk_nvidia_quirk::{
    apply_workaround_with_options, needs_workaround, set_webkit_disable_dmabuf_renderer,
    ApplyWorkaroundOptions, WorkaroundKind,
};

#[cfg(target_os = "linux")]
fn apply_linux_webkit_nvidia_quirk() {
    if std::env::var("PSYSONIC_WEBKIT_GPU_ACCEL").is_ok() {
        return;
    }

    // dev.sh gpu-x11 / nix psysonic-x11-legacy: WebKit uses the X11 GDK path while the session
    // may still be `XDG_SESSION_TYPE=wayland`. The quirk maps that to `__NV_DISABLE_EXPLICIT_SYNC`,
    // which mismatches a real X11 EGL stack and can leave the webview gray — mirror the native-X11
    // branch (`WEBKIT_DISABLE_DMABUF_RENDERER` only) whenever GDK is pinned to x11 first in the list.
    let forced_x11_gdk = std::env::var("GDK_BACKEND").ok().is_some_and(|s| {
        matches!(s.split(',').next().map(str::trim), Some("x11"))
    });
    if forced_x11_gdk {
        match needs_workaround() {
            WorkaroundKind::None => {}
            WorkaroundKind::DisableWebkitDmabufRenderer | WorkaroundKind::DisableNvExplicitSync => {
                set_webkit_disable_dmabuf_renderer();
            }
        }
    } else {
        apply_workaround_with_options(ApplyWorkaroundOptions::default());
    }
}

fn main() {
    // Linux GTK/WebKit: `webkit2gtk-nvidia-quirk` (skipped when `PSYSONIC_WEBKIT_GPU_ACCEL` is set).
    // Forced `GDK_BACKEND=x11` uses the X11-only mitigation path — see `apply_linux_webkit_nvidia_quirk`.
    #[cfg(target_os = "linux")]
    apply_linux_webkit_nvidia_quirk();

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

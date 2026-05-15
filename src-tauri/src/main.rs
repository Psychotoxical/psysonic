// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use webkit2gtk_nvidia_quirk::{apply_workaround_with_options, ApplyWorkaroundOptions};

fn main() {
    // WebKitGTK on Wayland can be unstable — default to X11 when GDK_BACKEND is unset,
    // except when PSYSONIC_ALLOW_NATIVE_GDK is set (e.g. Nix psysonic-gdk-session wrapper).
    // Users can still override by setting GDK_BACKEND before launch.
    //
    // Safety: set_var modifies global process state. These calls are safe here
    // because we're in main() before the Tauri runtime starts — no other threads
    // exist yet. If this code moves to lazy init or a plugin context, it would
    // need synchronization or marking as unsafe (Rust 2024+).
    #[cfg(target_os = "linux")]
    {
        // Nix / AUR wrappers set this so we do not pin X11 when GDK should follow the session.
        let allow_native_gdk = std::env::var("PSYSONIC_ALLOW_NATIVE_GDK").is_ok();
        // `PSYSONIC_WEBKIT_GPU_ACCEL` — opt-out of the nvidia quirk (e.g. experimental X11 + DMA-BUF via dev script).
        let webkit_gpu_accel = std::env::var("PSYSONIC_WEBKIT_GPU_ACCEL").is_ok();
        // Escapes conservative compositing-off for X11 dev (`gpu-x11`) or full-GPU experiments.
        let webkit_allow_compositing =
            std::env::var("PSYSONIC_WEBKIT_ALLOW_COMPOSITING").is_ok() || webkit_gpu_accel;

        if std::env::var("GDK_BACKEND").is_err() && !allow_native_gdk {
            std::env::set_var("GDK_BACKEND", "x11");
        }

        let on_wayland_shell = matches!(
            std::env::var("XDG_SESSION_TYPE").as_deref(),
            Ok("wayland"),
        );
        let gdk_is_wayland = matches!(std::env::var("GDK_BACKEND").as_deref(), Ok("wayland"));
        // Native Wayland webview: let WebKit decide compositing; nvidia-quirk handles driver/session.
        let auto_wayland_webkit = on_wayland_shell && gdk_is_wayland;

        // webkit2gtk-nvidia-quirk: primary NVIDIA + proprietary module + X11 ⇒ DMA-BUF renderer off;
        // same + Wayland ⇒ `__NV_DISABLE_EXPLICIT_SYNC`. Skipped when PSYSONIC_WEBKIT_GPU_ACCEL is set.
        if !webkit_gpu_accel {
            apply_workaround_with_options(ApplyWorkaroundOptions::default());
        }

        // Hybrid / Optimus: NVIDIA may be usable while DRM `boot_vga` is still Intel — the crate only
        // applies on primary NVIDIA; keep the legacy X11 DMa-BUF guard without duplicating Wayland path.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
            && !webkit_gpu_accel
            && std::fs::metadata("/proc/driver/nvidia/version").is_ok()
            && !on_wayland_shell
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }

        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err()
            && !webkit_allow_compositing
            && !auto_wayland_webkit
        {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
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

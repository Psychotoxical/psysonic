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
    // Detect once and record it for the UI's animated-theme CPU-load warning,
    // so the theme_animation_risk command never has to re-probe the GPU.
    let kind = needs_workaround();
    psysonic_lib::theme_animation::set_nvidia_quirk_active(!matches!(kind, WorkaroundKind::None));

    let forced_x11_gdk = std::env::var("GDK_BACKEND").ok().is_some_and(|s| {
        matches!(s.split(',').next().map(str::trim), Some("x11"))
    });
    if forced_x11_gdk {
        match kind {
            WorkaroundKind::None => {}
            WorkaroundKind::DisableWebkitDmabufRenderer | WorkaroundKind::DisableNvExplicitSync => {
                set_webkit_disable_dmabuf_renderer();
            }
        }
    } else {
        apply_workaround_with_options(ApplyWorkaroundOptions::default());
    }
}

#[cfg(target_os = "linux")]
fn apply_pipewire_latency() {
    // Linux audio output goes through the pipewire-alsa bridge, which on some
    // setups negotiates a huge default buffer (~1M frames ≈ 10–20 s); play/pause/
    // seek/volume then lag until it drains (issue #862). cpal's buffer-size clamp
    // is ignored by those bridges. Setting the client-node latency via
    // `PIPEWIRE_LATENCY` caps it — the reporter confirmed `256/48000` makes
    // play/pause/volume instant. No-op on non-PipeWire Linux (var is ignored).
    // A user-provided value is left untouched.
    if std::env::var_os("PIPEWIRE_LATENCY").is_none() {
        std::env::set_var("PIPEWIRE_LATENCY", "256/48000");
    }
}

fn main() {
    // Linux audio: cap the pipewire-alsa client latency so play/pause/seek/volume
    // respond promptly (issue #862). Must run before any audio stream is opened.
    #[cfg(target_os = "linux")]
    apply_pipewire_latency();

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

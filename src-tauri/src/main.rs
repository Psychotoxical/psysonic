// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq)]
enum GpuVendor {
    Nvidia,
    Intel,
    Amd,
}

#[cfg(target_os = "linux")]
fn detect_gpu_vendor() -> Option<GpuVendor> {
    use std::fs;

    if fs::metadata("/proc/driver/nvidia/version").is_ok() {
        return Some(GpuVendor::Nvidia);
    }

    // Iterate every `/sys/class/drm/card*` — hybrid laptops expose multiple
    // cards, and some systems have no `card0` at all.
    let entries = fs::read_dir("/sys/class/drm").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("card") || name.contains('-') {
            continue;
        }
        let Ok(vendor_id) = fs::read_to_string(entry.path().join("device/vendor")) else {
            continue;
        };
        match vendor_id.trim() {
            "0x10de" => return Some(GpuVendor::Nvidia),
            "0x8086" => return Some(GpuVendor::Intel),
            "0x1002" => return Some(GpuVendor::Amd),
            _ => {}
        }
    }

    None
}

fn main() {
    // WebKitGTK on Wayland is unstable — force X11/XWayland on all Linux packages.
    // Users can still override by setting these vars before launch.
    //
    // Safety: set_var modifies global process state. These calls are safe here
    // because we're in main() before the Tauri runtime starts — no other threads
    // exist yet. If this code moves to lazy init or a plugin context, it would
    // need synchronization or marking as unsafe (Rust 2024+).
    #[cfg(target_os = "linux")]
    {
        if std::env::var("GDK_BACKEND").is_err() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }

        // NVIDIA proprietary adds a small but reproducible overhead on the
        // DMA-BUF renderer path (blind A/B confirmed on NVIDIA + proprietary).
        // Unknown GPUs keep the WebKitGTK default — VMs, ARM SBCs and anything
        // exotic should not be regressed by a guess.
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
            && matches!(detect_gpu_vendor(), Some(GpuVendor::Nvidia))
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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

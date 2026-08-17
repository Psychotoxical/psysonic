/// Map a child process name to a stable perf-probe label (Linux `comm` or macOS name).
// Matches the gating of its only test: `test` alone would define this on
// Windows test builds, where nothing calls it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn child_process_memory_label(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("webkitwebproces")
        || lower.contains("web content")
        || lower.contains("webcontent")
    {
        "WebKit web"
    } else if lower.contains("webkitnetwork")
        || (lower.contains("webkit") && lower.contains("network"))
    {
        "WebKit network"
    } else if lower.contains("webkitwebgp")
        || lower.contains("webkitgpuproc")
        || (lower.contains("webkit") && lower.contains("gpu"))
    {
        "WebKit GPU"
    } else if lower.contains("webkit") {
        "WebKit other"
    } else {
        "other child"
    }
}

/// Group in-process thread names for CPU attribution (`feat/rust-thread-names` uses `psy-*`).
#[cfg(any(test, target_os = "linux"))]
pub(super) fn thread_cpu_group_label(comm: &str) -> String {
    // Tauri default: `tokio-rt-worker`; `feat/rust-thread-names`: `psy-tokio-N`.
    if comm.starts_with("tokio-") || comm.starts_with("psy-tokio") {
        return "tokio".to_string();
    }
    if comm.starts_with("psy-") {
        return comm.to_string();
    }
    if comm.starts_with("psysonic-") {
        return comm.to_string();
    }
    if comm == "psysonic" {
        return "psysonic".to_string();
    }
    if comm.starts_with("pool") {
        return "blocking-pool".to_string();
    }
    if matches!(comm, "gmain" | "gdbus" | "dconf worker") {
        return "glib".to_string();
    }
    if comm.starts_with("cpal_")
        || comm.starts_with("alsa-")
        || comm == "module-rt"
        || comm.starts_with("data-loop")
    {
        return "audio/pipewire".to_string();
    }
    if comm.starts_with("reqwest-") {
        return "reqwest".to_string();
    }
    if comm.starts_with("async-io") || comm.starts_with("zbus::") {
        return "async-io".to_string();
    }
    "other".to_string()
}

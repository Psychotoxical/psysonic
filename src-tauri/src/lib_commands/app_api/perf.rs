//! Performance telemetry: process-level CPU + RSS and in-process thread CPU
//! groups. Linux uses `/proc`; macOS uses `sysinfo`. Other platforms return
//! `supported: false`.

use serde::Serialize;

mod labels;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) const CHILD_RESCAN_EVERY: u8 = 8;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct PerfProcessMemory {
    pub label: String,
    pub rss_kb: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct PerfThreadCpuGroup {
    pub label: String,
    pub thread_count: u32,
    pub jiffies: u64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub(crate) struct PerformanceCpuSnapshot {
    pub supported: bool,
    pub total_jiffies: u64,
    pub app_jiffies: u64,
    pub webkit_jiffies: u64,
    pub logical_cpus: u32,
    pub memory: Vec<PerfProcessMemory>,
    pub thread_cpu_groups: Vec<PerfThreadCpuGroup>,
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn empty_snapshot() -> PerformanceCpuSnapshot {
    PerformanceCpuSnapshot {
        supported: false,
        total_jiffies: 0,
        app_jiffies: 0,
        webkit_jiffies: 0,
        logical_cpus: 1,
        memory: Vec::new(),
        thread_cpu_groups: Vec::new(),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn performance_cpu_snapshot(
    include_thread_groups: Option<bool>,
) -> Result<PerformanceCpuSnapshot, String> {
    let include_thread_groups = include_thread_groups.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        performance_cpu_snapshot_blocking(include_thread_groups)
    })
    .await
    .map_err(|e| e.to_string())
}

fn performance_cpu_snapshot_blocking(include_thread_groups: bool) -> PerformanceCpuSnapshot {
    #[cfg(target_os = "linux")]
    {
        linux::performance_cpu_snapshot(include_thread_groups)
    }
    #[cfg(target_os = "macos")]
    {
        macos::performance_cpu_snapshot(include_thread_groups)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = include_thread_groups;
        empty_snapshot()
    }
}

#[cfg(test)]
mod tests;

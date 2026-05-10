//! Performance telemetry: process-level CPU snapshot for the Linux /proc
//! parser. Other platforms return `supported: false` — the frontend treats
//! that as "perf overlay not available" and hides itself.

use serde::Serialize;

#[cfg(target_os = "linux")]
use std::fs;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PerformanceCpuSnapshot {
    pub supported: bool,
    pub total_jiffies: u64,
    pub app_jiffies: u64,
    pub webkit_jiffies: u64,
    pub logical_cpus: u32,
}

#[cfg(target_os = "linux")]
fn parse_proc_stat_line(stat_line: &str) -> Option<(String, i32, u64, u64)> {
    let close_idx = stat_line.rfind(')')?;
    let open_idx = stat_line.find('(')?;
    if open_idx + 1 >= close_idx {
        return None;
    }
    let comm = stat_line.get(open_idx + 1..close_idx)?.to_string();
    let after = stat_line.get(close_idx + 2..)?;
    let mut parts = after.split_whitespace();
    let _state = parts.next()?;
    let ppid = parts.next()?.parse::<i32>().ok()?;
    let rest: Vec<&str> = parts.collect();
    // After `state` and `ppid`, remaining fields start at `pgrp` (field #5).
    // `utime` = field #14 => rest[9], `stime` = field #15 => rest[10].
    let utime = rest.get(9)?.parse::<u64>().ok()?;
    let stime = rest.get(10)?.parse::<u64>().ok()?;
    Some((comm, ppid, utime, stime))
}

#[cfg(target_os = "linux")]
fn read_total_jiffies() -> Option<u64> {
    let content = fs::read_to_string("/proc/stat").ok()?;
    let line = content.lines().next()?;
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    Some(it.filter_map(|n| n.parse::<u64>().ok()).sum())
}

#[cfg(target_os = "linux")]
fn collect_proc_stats() -> Vec<(i32, String, i32, u64)> {
    let mut rows = Vec::new();
    let entries = match fs::read_dir("/proc") {
        Ok(v) => v,
        Err(_) => return rows,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let pid = match name.to_string_lossy().parse::<i32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let stat_path = format!("/proc/{pid}/stat");
        let stat_line = match fs::read_to_string(stat_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some((comm, ppid, utime, stime)) = parse_proc_stat_line(stat_line.trim()) {
            rows.push((pid, comm, ppid, utime.saturating_add(stime)));
        }
    }
    rows
}

#[tauri::command]
pub(crate) fn performance_cpu_snapshot() -> PerformanceCpuSnapshot {
    #[cfg(target_os = "linux")]
    {
        let total_jiffies = read_total_jiffies().unwrap_or(0);
        let logical_cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1);
        let self_pid = std::process::id() as i32;
        let rows = collect_proc_stats();
        let app_jiffies = rows
            .iter()
            .find(|(pid, _, _, _)| *pid == self_pid)
            .map(|(_, _, _, ticks)| *ticks)
            .unwrap_or(0);
        let webkit_jiffies = rows
            .iter()
            // Linux `/proc/*/stat` `comm` is capped to 15 chars, so
            // "WebKitWebProcess" appears as "WebKitWebProces".
            .filter(|(_, comm, ppid, _)| comm.starts_with("WebKitWebProces") && *ppid == self_pid)
            .map(|(_, _, _, ticks)| *ticks)
            .sum::<u64>();
        PerformanceCpuSnapshot {
            supported: true,
            total_jiffies,
            app_jiffies,
            webkit_jiffies,
            logical_cpus,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        PerformanceCpuSnapshot {
            supported: false,
            total_jiffies: 0,
            app_jiffies: 0,
            webkit_jiffies: 0,
            logical_cpus: 1,
        }
    }
}

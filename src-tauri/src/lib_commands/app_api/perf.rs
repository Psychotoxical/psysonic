//! Performance telemetry: process-level CPU + RSS and in-process thread CPU
//! groups for the Linux `/proc` parser. Other platforms return `supported: false`.

use serde::Serialize;

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PerfProcessMemory {
    pub label: String,
    pub rss_kb: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PerfThreadCpuGroup {
    pub label: String,
    pub thread_count: u32,
    pub jiffies: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PerformanceCpuSnapshot {
    pub supported: bool,
    pub total_jiffies: u64,
    pub app_jiffies: u64,
    pub webkit_jiffies: u64,
    pub logical_cpus: u32,
    pub memory: Vec<PerfProcessMemory>,
    pub thread_cpu_groups: Vec<PerfThreadCpuGroup>,
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
fn read_status_rss_kb(path: &str) -> Option<u64> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if let Some(kb) = line.strip_prefix("VmRSS:") {
            return kb.split_whitespace().next()?.parse().ok();
        }
    }
    None
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

/// Map a child `comm` (15-char Linux cap) to a stable perf-probe label.
#[cfg(target_os = "linux")]
fn child_process_memory_label(comm: &str) -> &'static str {
    if comm.starts_with("WebKitWebProces") {
        "WebKit web"
    } else if comm.starts_with("WebKitNetworkP") {
        "WebKit network"
    } else if comm.starts_with("WebKitWebGP") || comm.starts_with("WebKitGPUProc") {
        "WebKit GPU"
    } else if comm.starts_with("WebKit") {
        "WebKit other"
    } else {
        "other child"
    }
}

/// Group in-process thread names for CPU attribution (`feat/rust-thread-names` uses `psy-*`).
#[cfg(any(test, target_os = "linux"))]
fn thread_cpu_group_label(comm: &str) -> String {
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

#[cfg(target_os = "linux")]
fn collect_task_cpu_groups(pid: i32) -> Vec<PerfThreadCpuGroup> {
    let task_root = format!("/proc/{pid}/task");
    let entries = match fs::read_dir(&task_root) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut groups: HashMap<String, (u32, u64)> = HashMap::new();
    for entry in entries.flatten() {
        let tid = entry.file_name();
        let stat_path = task_root.clone() + "/" + &tid.to_string_lossy() + "/stat";
        let stat_line = match fs::read_to_string(&stat_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some((comm, _, utime, stime)) = parse_proc_stat_line(stat_line.trim()) else {
            continue;
        };
        let label = thread_cpu_group_label(&comm);
        let entry = groups.entry(label).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = entry.1.saturating_add(utime.saturating_add(stime));
    }
    let mut out: Vec<PerfThreadCpuGroup> = groups
        .into_iter()
        .map(|(label, (thread_count, jiffies))| PerfThreadCpuGroup {
            label,
            thread_count,
            jiffies,
        })
        .collect();
    out.sort_by(|a, b| b.jiffies.cmp(&a.jiffies).then_with(|| a.label.cmp(&b.label)));
    out
}

#[cfg(target_os = "linux")]
fn collect_process_memory(pid: i32, rows: &[(i32, String, i32, u64)], self_pid: i32) -> Vec<PerfProcessMemory> {
    let mut groups: HashMap<&'static str, u64> = HashMap::new();
    if let Some(rss) = read_status_rss_kb(&format!("/proc/{pid}/status")) {
        groups.insert("psysonic", rss);
    }
    for (child_pid, comm, ppid, _) in rows {
        if *ppid != self_pid || *child_pid == self_pid {
            continue;
        }
        let Some(rss) = read_status_rss_kb(&format!("/proc/{child_pid}/status")) else {
            continue;
        };
        let label = child_process_memory_label(comm);
        let entry = groups.entry(label).or_insert(0);
        *entry = entry.saturating_add(rss);
    }
    let order = [
        "psysonic",
        "WebKit web",
        "WebKit network",
        "WebKit GPU",
        "WebKit other",
        "other child",
    ];
    let mut out: Vec<PerfProcessMemory> = groups
        .into_iter()
        .map(|(label, rss_kb)| PerfProcessMemory {
            label: label.to_string(),
            rss_kb,
        })
        .collect();
    out.sort_by(|a, b| {
        let ai = order.iter().position(|&x| x == a.label).unwrap_or(order.len());
        let bi = order.iter().position(|&x| x == b.label).unwrap_or(order.len());
        ai.cmp(&bi).then_with(|| b.rss_kb.cmp(&a.rss_kb))
    });
    out
}

#[cfg(not(target_os = "linux"))]
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
            memory: collect_process_memory(self_pid, &rows, self_pid),
            thread_cpu_groups: collect_task_cpu_groups(self_pid),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        empty_snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_cpu_group_label_tokio_and_named() {
        assert_eq!(thread_cpu_group_label("psy-tokio-3"), "tokio");
        assert_eq!(thread_cpu_group_label("tokio-runtime-w"), "tokio");
        assert_eq!(thread_cpu_group_label("tokio-rt-worker"), "tokio");
        assert_eq!(thread_cpu_group_label("psy-audio-out"), "psy-audio-out");
        assert_eq!(thread_cpu_group_label("psy-decode"), "psy-decode");
        assert_eq!(
            thread_cpu_group_label("psysonic-audio-"),
            "psysonic-audio-"
        );
        assert_eq!(thread_cpu_group_label("pool-1"), "blocking-pool");
        assert_eq!(thread_cpu_group_label("gmain"), "glib");
        assert_eq!(thread_cpu_group_label("cpal_alsa_out"), "audio/pipewire");
        assert_eq!(thread_cpu_group_label("reqwest-interna"), "reqwest");
        assert_eq!(thread_cpu_group_label("rustc"), "other");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_process_memory_label_webkit_truncation() {
        assert_eq!(
            child_process_memory_label("WebKitWebProces"),
            "WebKit web"
        );
        assert_eq!(
            child_process_memory_label("WebKitNetworkP"),
            "WebKit network"
        );
    }
}

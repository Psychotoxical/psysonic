//! Performance telemetry: process-level CPU + RSS and in-process thread CPU
//! groups. Linux uses `/proc`; macOS uses `sysinfo`. Other platforms return
//! `supported: false`.

use serde::Serialize;

#[cfg(target_os = "linux")]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::fs;

#[cfg(any(target_os = "linux", target_os = "macos"))]
const CHILD_RESCAN_EVERY: u8 = 8;

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
fn proc_exists(pid: i32) -> bool {
    fs::metadata(format!("/proc/{pid}")).is_ok()
}

#[cfg(target_os = "linux")]
fn read_proc_stat_row(pid: i32) -> Option<(i32, String, i32, u64)> {
    let stat_line = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (comm, ppid, utime, stime) = parse_proc_stat_line(stat_line.trim())?;
    Some((pid, comm, ppid, utime.saturating_add(stime)))
}

#[cfg(target_os = "linux")]
fn scan_child_pids(self_pid: i32) -> Vec<i32> {
    let mut out = Vec::new();
    let entries = match fs::read_dir("/proc") {
        Ok(v) => v,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let pid = match entry.file_name().to_string_lossy().parse::<i32>() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if pid == self_pid {
            continue;
        }
        let Some((_, _, ppid, _)) = read_proc_stat_row(pid) else {
            continue;
        };
        if ppid == self_pid {
            out.push(pid);
        }
    }
    out
}

#[cfg(target_os = "linux")]
struct ChildPidCache {
    child_pids: Vec<i32>,
    ticks_until_rescan: u8,
}

#[cfg(target_os = "linux")]
impl ChildPidCache {
    fn refresh(&mut self, self_pid: i32) {
        let stale = self
            .child_pids
            .iter()
            .any(|pid| !proc_exists(*pid));
        if self.ticks_until_rescan == 0 || stale {
            self.child_pids = scan_child_pids(self_pid);
            self.ticks_until_rescan = CHILD_RESCAN_EVERY;
        } else {
            self.ticks_until_rescan -= 1;
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_child_cache() -> std::sync::MutexGuard<'static, ChildPidCache> {
    static CACHE: Mutex<ChildPidCache> = Mutex::new(ChildPidCache {
        child_pids: Vec::new(),
        ticks_until_rescan: 0,
    });
    CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(target_os = "linux")]
fn collect_relevant_proc_stats(self_pid: i32) -> Vec<(i32, String, i32, u64)> {
    let mut rows = Vec::new();
    if let Some(row) = read_proc_stat_row(self_pid) {
        rows.push(row);
    }
    let child_pids = {
        let mut cache = linux_child_cache();
        cache.refresh(self_pid);
        cache.child_pids.clone()
    };
    for child_pid in child_pids {
        let Some(row) = read_proc_stat_row(child_pid) else {
            continue;
        };
        if row.2 == self_pid {
            rows.push(row);
        }
    }
    rows
}

/// Map a child process name to a stable perf-probe label (Linux `comm` or macOS name).
#[cfg(any(test, target_os = "linux", target_os = "macos"))]
fn child_process_memory_label(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.contains("webkitwebproces") || lower.contains("web content") || lower.contains("webcontent") {
        "WebKit web"
    } else if lower.contains("webkitnetwork") || (lower.contains("webkit") && lower.contains("network")) {
        "WebKit network"
    } else if lower.contains("webkitwebgp") || lower.contains("webkitgpuproc") || (lower.contains("webkit") && lower.contains("gpu")) {
        "WebKit GPU"
    } else if lower.contains("webkit") {
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

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        child_process_memory_label, PerformanceCpuSnapshot, PerfProcessMemory, CHILD_RESCAN_EVERY,
    };
    use std::collections::HashMap;
    use std::mem;
    use std::sync::Mutex;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    struct ChildPidCache {
        child_pids: Vec<Pid>,
        ticks_until_rescan: u8,
    }

    impl ChildPidCache {
        fn refresh(&mut self, sys: &mut System, self_pid: Pid) {
            let stale = self
                .child_pids
                .iter()
                .any(|pid| sys.process(*pid).is_none());
            if self.ticks_until_rescan == 0 || stale {
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    false,
                    ProcessRefreshKind::nothing().with_cpu().with_memory(),
                );
                self.child_pids = sys
                    .processes()
                    .iter()
                    .filter_map(|(pid, process)| {
                        if process.parent() == Some(self_pid) {
                            Some(*pid)
                        } else {
                            None
                        }
                    })
                    .collect();
                self.ticks_until_rescan = CHILD_RESCAN_EVERY;
            } else {
                self.ticks_until_rescan -= 1;
            }
        }
    }

    static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

    fn child_cache() -> std::sync::MutexGuard<'static, ChildPidCache> {
        static CACHE: Mutex<ChildPidCache> = Mutex::new(ChildPidCache {
            child_pids: Vec::new(),
            ticks_until_rescan: 0,
        });
        CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_host_total_cpu_ticks() -> u64 {
        use mach2::kern_return::KERN_SUCCESS;
        use mach2::mach_init::mach_host_self;
        use mach2::traps::mach_task_self;
        use mach2::vm::mach_vm_deallocate;
        use mach2::vm_types::{mach_vm_address_t, mach_vm_size_t};

        let mut num_cpus: u32 = 0;
        let mut cpu_info: *mut i32 = std::ptr::null_mut();
        let mut num_cpu_info: u32 = 0;
        let ok = unsafe {
            libc::host_processor_info(
                mach_host_self(),
                libc::PROCESSOR_CPU_LOAD_INFO,
                &mut num_cpus,
                &mut cpu_info,
                &mut num_cpu_info,
            ) == KERN_SUCCESS
        };
        if !ok || cpu_info.is_null() {
            return 0;
        }
        let total: u64 = unsafe {
            std::slice::from_raw_parts(cpu_info, num_cpu_info as usize)
                .iter()
                .map(|&ticks| ticks as u64)
                .sum()
        };
        unsafe {
            let size = num_cpu_info as usize * mem::size_of::<i32>();
            mach_vm_deallocate(
                mach_task_self(),
                cpu_info as mach_vm_address_t,
                size as mach_vm_size_t,
            );
        }
        total
    }

    fn refresh_target_processes(sys: &mut System, self_pid: Pid) -> Vec<Pid> {
        let child_pids = {
            let mut cache = child_cache();
            cache.refresh(sys, self_pid);
            cache.child_pids.clone()
        };
        let mut target = Vec::with_capacity(1 + child_pids.len());
        target.push(self_pid);
        target.extend(child_pids);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&target),
            false,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        target
    }

    fn is_webkit_web_cpu_process(name: &str) -> bool {
        child_process_memory_label(name) == "WebKit web"
    }

    fn collect_process_memory(sys: &System, self_pid: Pid, child_pids: &[Pid]) -> Vec<PerfProcessMemory> {
        let mut groups: HashMap<&'static str, u64> = HashMap::new();
        if let Some(process) = sys.process(self_pid) {
            groups.insert("psysonic", process.memory() / 1024);
        }
        for child_pid in child_pids {
            if *child_pid == self_pid {
                continue;
            }
            let Some(process) = sys.process(*child_pid) else {
                continue;
            };
            let name = process.name().to_string_lossy();
            let label = child_process_memory_label(&name);
            let entry = groups.entry(label).or_insert(0);
            *entry = entry.saturating_add(process.memory() / 1024);
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

    pub(super) fn performance_cpu_snapshot(_include_thread_groups: bool) -> PerformanceCpuSnapshot {
        let mut guard = SYSTEM.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = Some(System::new());
        }
        let sys = guard.as_mut().unwrap();
        let self_pid = Pid::from_u32(std::process::id());
        let child_pids = refresh_target_processes(sys, self_pid);
        let logical_cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1);
        let total_jiffies = read_host_total_cpu_ticks();
        let app_jiffies = sys
            .process(self_pid)
            .map(|process| process.accumulated_cpu_time())
            .unwrap_or(0);
        let webkit_jiffies: u64 = child_pids
            .iter()
            .filter_map(|pid| sys.process(*pid))
            .filter(|process| is_webkit_web_cpu_process(&process.name().to_string_lossy()))
            .map(|process| process.accumulated_cpu_time())
            .sum();
        PerformanceCpuSnapshot {
            supported: true,
            total_jiffies,
            app_jiffies,
            webkit_jiffies,
            logical_cpus,
            memory: collect_process_memory(sys, self_pid, &child_pids),
            thread_cpu_groups: Vec::new(),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn performance_cpu_snapshot(
    include_thread_groups: Option<bool>,
) -> Result<PerformanceCpuSnapshot, String> {
    let include_thread_groups = include_thread_groups.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || performance_cpu_snapshot_blocking(include_thread_groups))
        .await
        .map_err(|e| e.to_string())
}

fn performance_cpu_snapshot_blocking(include_thread_groups: bool) -> PerformanceCpuSnapshot {
    #[cfg(target_os = "linux")]
    {
        let total_jiffies = read_total_jiffies().unwrap_or(0);
        let logical_cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1);
        let self_pid = std::process::id() as i32;
        let rows = collect_relevant_proc_stats(self_pid);
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
            thread_cpu_groups: if include_thread_groups {
                collect_task_cpu_groups(self_pid)
            } else {
                Vec::new()
            },
        }
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

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn child_process_memory_label_webkit_names() {
        assert_eq!(
            child_process_memory_label("WebKitWebProces"),
            "WebKit web"
        );
        assert_eq!(
            child_process_memory_label("WebKitNetworkP"),
            "WebKit network"
        );
        assert_eq!(
            child_process_memory_label("com.apple.WebKit.WebContent.xpc"),
            "WebKit web"
        );
        assert_eq!(
            child_process_memory_label("WebKit Networking"),
            "WebKit network"
        );
    }
}

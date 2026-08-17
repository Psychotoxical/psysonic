use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use super::labels::{child_process_memory_label, thread_cpu_group_label};
use super::{PerfProcessMemory, PerfThreadCpuGroup, PerformanceCpuSnapshot, CHILD_RESCAN_EVERY};

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

fn read_total_jiffies() -> Option<u64> {
    let content = fs::read_to_string("/proc/stat").ok()?;
    let line = content.lines().next()?;
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    Some(it.filter_map(|n| n.parse::<u64>().ok()).sum())
}

fn read_status_rss_kb(path: &str) -> Option<u64> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if let Some(kb) = line.strip_prefix("VmRSS:") {
            return kb.split_whitespace().next()?.parse().ok();
        }
    }
    None
}

fn proc_exists(pid: i32) -> bool {
    fs::metadata(format!("/proc/{pid}")).is_ok()
}

fn read_proc_stat_row(pid: i32) -> Option<(i32, String, i32, u64)> {
    let stat_line = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (comm, ppid, utime, stime) = parse_proc_stat_line(stat_line.trim())?;
    Some((pid, comm, ppid, utime.saturating_add(stime)))
}

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

struct ChildPidCache {
    child_pids: Vec<i32>,
    ticks_until_rescan: u8,
}

impl ChildPidCache {
    fn refresh(&mut self, self_pid: i32) {
        let stale = self.child_pids.iter().any(|pid| !proc_exists(*pid));
        if self.ticks_until_rescan == 0 || stale {
            self.child_pids = scan_child_pids(self_pid);
            self.ticks_until_rescan = CHILD_RESCAN_EVERY;
        } else {
            self.ticks_until_rescan -= 1;
        }
    }
}

fn linux_child_cache() -> std::sync::MutexGuard<'static, ChildPidCache> {
    static CACHE: Mutex<ChildPidCache> = Mutex::new(ChildPidCache {
        child_pids: Vec::new(),
        ticks_until_rescan: 0,
    });
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
    out.sort_by(|a, b| {
        b.jiffies
            .cmp(&a.jiffies)
            .then_with(|| a.label.cmp(&b.label))
    });
    out
}

fn collect_process_memory(
    pid: i32,
    rows: &[(i32, String, i32, u64)],
    self_pid: i32,
) -> Vec<PerfProcessMemory> {
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
        let ai = order
            .iter()
            .position(|&x| x == a.label)
            .unwrap_or(order.len());
        let bi = order
            .iter()
            .position(|&x| x == b.label)
            .unwrap_or(order.len());
        ai.cmp(&bi).then_with(|| b.rss_kb.cmp(&a.rss_kb))
    });
    out
}

pub(super) fn performance_cpu_snapshot(include_thread_groups: bool) -> PerformanceCpuSnapshot {
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

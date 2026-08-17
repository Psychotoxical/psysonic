use std::collections::HashMap;
use std::mem;
use std::sync::Mutex;

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use super::labels::child_process_memory_label;
use super::{PerfProcessMemory, PerformanceCpuSnapshot, CHILD_RESCAN_EVERY};

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
    CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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

fn collect_process_memory(
    sys: &System,
    self_pid: Pid,
    child_pids: &[Pid],
) -> Vec<PerfProcessMemory> {
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

pub(super) fn performance_cpu_snapshot(_include_thread_groups: bool) -> PerformanceCpuSnapshot {
    let mut guard = SYSTEM
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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

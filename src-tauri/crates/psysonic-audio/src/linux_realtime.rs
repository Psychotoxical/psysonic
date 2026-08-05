//! Best-effort RealtimeKit scheduling for Linux audio callback threads.

use std::collections::HashSet;
use std::fs;
use std::thread;
use std::time::Duration;

const RTKIT_SERVICE: &str = "org.freedesktop.RealtimeKit1";
const RTKIT_PATH: &str = "/org/freedesktop/RealtimeKit1";
const RTKIT_INTERFACE: &str = "org.freedesktop.RealtimeKit1";
const CPAL_PRIORITY: u32 = 10;
const PIPEWIRE_PRIORITY: u32 = 5;
const DISCOVERY_ATTEMPTS: usize = 20;
const DISCOVERY_INTERVAL: Duration = Duration::from_millis(10);

pub(crate) fn promote_audio_threads() {
    if let Err(error) = thread::Builder::new()
        .name("psysonic-rtkit".into())
        .spawn(|| {
            if let Err(error) = promote_audio_threads_blocking() {
                crate::app_deprintln!(
                    "[psysonic] Linux realtime audio scheduling unavailable: {error}"
                );
            }
        })
    {
        crate::app_deprintln!("[psysonic] could not spawn Linux realtime audio scheduler: {error}");
    }
}

fn promote_audio_threads_blocking() -> Result<(), String> {
    let connection = zbus::blocking::Connection::system()
        .map_err(|error| format!("RealtimeKit system bus: {error}"))?;
    let proxy = zbus::blocking::Proxy::new(&connection, RTKIT_SERVICE, RTKIT_PATH, RTKIT_INTERFACE)
        .map_err(|error| format!("RealtimeKit proxy: {error}"))?;
    let max_priority = proxy
        .get_property::<i32>("MaxRealtimePriority")
        .map_err(|error| format!("RealtimeKit MaxRealtimePriority: {error}"))?;
    if max_priority <= 0 {
        return Err("RealtimeKit reports no available realtime priority".into());
    }

    let process_id = u64::from(std::process::id());
    let mut promoted = HashSet::new();
    let mut found_pipewire = false;
    let mut promoted_cpal = false;
    let mut promoted_pipewire = false;
    let mut last_error = None;

    for attempt in 0..DISCOVERY_ATTEMPTS {
        for (thread_id, thread_name) in audio_threads()? {
            let Some(priority) = realtime_priority_for_thread(&thread_name, max_priority as u32)
            else {
                continue;
            };

            found_pipewire |= thread_name.starts_with("data-loop.");
            if promoted.contains(&thread_id) {
                continue;
            }

            let result: zbus::Result<()> = proxy.call(
                "MakeThreadRealtimeWithPID",
                &(process_id, thread_id, priority),
            );
            if let Err(error) = result {
                last_error = Some(format!(
                    "RealtimeKit could not promote {thread_name} (tid {thread_id}, priority {priority}): {error}"
                ));
                continue;
            }
            promoted.insert(thread_id);
            promoted_cpal |= thread_name == "cpal_alsa_out";
            promoted_pipewire |= thread_name.starts_with("data-loop.");
        }

        if promoted_cpal && promoted_pipewire {
            break;
        }
        if attempt + 1 < DISCOVERY_ATTEMPTS {
            thread::sleep(DISCOVERY_INTERVAL);
        }
    }

    if !promoted_cpal || (found_pipewire && !promoted_pipewire) {
        return Err(last_error
            .unwrap_or_else(|| "CPAL/PipeWire audio threads could not be promoted".into()));
    }

    crate::app_deprintln!(
        "[psysonic] promoted {} Linux audio thread(s) through RealtimeKit",
        promoted.len()
    );
    Ok(())
}

fn audio_threads() -> Result<Vec<(u64, String)>, String> {
    let entries = fs::read_dir("/proc/self/task")
        .map_err(|error| format!("read /proc/self/task: {error}"))?;
    let mut threads = Vec::new();

    for entry in entries.flatten() {
        let Some(thread_id) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse().ok())
        else {
            continue;
        };
        let Ok(thread_name) = fs::read_to_string(entry.path().join("comm")) else {
            continue;
        };
        threads.push((thread_id, thread_name.trim().to_string()));
    }

    Ok(threads)
}

fn realtime_priority_for_thread(thread_name: &str, max_priority: u32) -> Option<u32> {
    let requested = if thread_name == "cpal_alsa_out" {
        CPAL_PRIORITY
    } else if thread_name.starts_with("data-loop.") {
        PIPEWIRE_PRIORITY
    } else {
        return None;
    };
    (max_priority > 0).then(|| requested.min(max_priority))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_audio_threads_and_caps_priority() {
        assert_eq!(realtime_priority_for_thread("cpal_alsa_out", 20), Some(10));
        assert_eq!(realtime_priority_for_thread("data-loop.0", 20), Some(5));
        assert_eq!(realtime_priority_for_thread("cpal_alsa_out", 3), Some(3));
        assert_eq!(realtime_priority_for_thread("data-loop.12", 2), Some(2));
        assert_eq!(realtime_priority_for_thread("psysonic-audio", 20), None);
        assert_eq!(realtime_priority_for_thread("cpal_alsa_out", 0), None);
    }
}

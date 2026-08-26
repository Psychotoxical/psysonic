//! `psysonic-syncfs` — offline / hot-cache, device sync, and the shared HTTP
//! download helpers used by both.
//!
//! This crate hosts the Tauri commands that read/write the on-disk caches
//! (`offline_*`, `hot_cache_*`) and that copy tracks to mounted USB / SD-card
//! devices (`sync_*`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// Re-export logging facade so submodules can keep `crate::app_eprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

pub mod cache;
pub mod file_transfer;
pub mod sync;

/// Shared semaphore that caps simultaneous `download_track_offline` executions.
pub type DownloadSemaphore = Arc<tokio::sync::Semaphore>;

struct FilesystemWriteBarrier {
    active_generation: AtomicU64,
    lock: Arc<tokio::sync::RwLock<()>>,
    migration_guard: Mutex<Option<(u64, tokio::sync::OwnedRwLockWriteGuard<()>)>>,
}

fn filesystem_write_barrier() -> &'static FilesystemWriteBarrier {
    static BARRIER: OnceLock<FilesystemWriteBarrier> = OnceLock::new();
    BARRIER.get_or_init(|| FilesystemWriteBarrier {
        active_generation: AtomicU64::new(0),
        lock: Arc::new(tokio::sync::RwLock::new(())),
        migration_guard: Mutex::new(None),
    })
}

pub async fn filesystem_write_guard() -> Result<tokio::sync::OwnedRwLockReadGuard<()>, String> {
    let barrier = filesystem_write_barrier();
    let active = barrier.active_generation.load(Ordering::Acquire);
    if active != 0 {
        return Err(format!(
            "migration generation {active} blocks ordinary filesystem writes"
        ));
    }
    let guard = barrier.lock.clone().read_owned().await;
    let active = barrier.active_generation.load(Ordering::Acquire);
    if active != 0 {
        drop(guard);
        return Err(format!(
            "migration generation {active} blocks ordinary filesystem writes"
        ));
    }
    Ok(guard)
}

pub async fn activate_filesystem_migration_generation(generation: u64) -> Result<(), String> {
    if generation == 0 {
        return Err("filesystem migration generation must be non-zero".to_string());
    }
    let barrier = filesystem_write_barrier();
    match barrier.active_generation.compare_exchange(
        0,
        generation,
        Ordering::AcqRel,
        Ordering::Acquire,
    ) {
        Ok(_) => {}
        Err(active) if active == generation => return Ok(()),
        Err(active) => {
            return Err(format!(
                "filesystem writers are already blocked by migration generation {active}"
            ));
        }
    }
    let guard = barrier.lock.clone().write_owned().await;
    let mut slot = barrier
        .migration_guard
        .lock()
        .map_err(|_| "filesystem migration guard lock poisoned".to_string())?;
    *slot = Some((generation, guard));
    Ok(())
}

pub fn deactivate_filesystem_migration_generation(generation: u64) -> Result<(), String> {
    let barrier = filesystem_write_barrier();
    let mut slot = barrier
        .migration_guard
        .lock()
        .map_err(|_| "filesystem migration guard lock poisoned".to_string())?;
    if !matches!(slot.as_ref(), Some((active, _)) if *active == generation) {
        return Err(format!(
            "cannot release filesystem migration generation {generation}"
        ));
    }
    slot.take();
    barrier
        .active_generation
        .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| ())
        .map_err(|active| {
            format!(
                "cannot release filesystem migration generation {generation}; active generation is {active}"
            )
        })
}

/// Per-job cancellation flags for `sync_batch_to_device`.
/// Each running sync registers an `Arc<AtomicBool>` here; `cancel_device_sync`
/// flips it.
pub fn sync_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-download cancellation flags for offline album/playlist downloads,
/// keyed by the frontend-supplied download id. Each `download_track_offline`
/// call checks its flag (once after acquiring a slot, then on every chunk
/// while streaming); `cancel_offline_downloads` flips it. Mirrors
/// [`sync_cancel_flags`] for the device-sync side.
pub fn offline_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn offline_cancel_senders() -> &'static Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>> {
    static SENDERS: OnceLock<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>> =
        OnceLock::new();
    SENDERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn offline_download_cancellation(
    download_id: &str,
) -> file_transfer::DownloadCancellation {
    let flag = offline_cancel_flags()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(download_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    let sender = offline_cancel_senders()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(download_id.to_string())
        .or_insert_with(|| tokio::sync::watch::channel(flag.load(Ordering::Relaxed)).0)
        .clone();
    if flag.load(Ordering::Relaxed) {
        sender.send_replace(true);
    }
    file_transfer::DownloadCancellation::new(flag, sender.subscribe())
}

pub(crate) fn cancel_offline_download(download_id: String) {
    let flag = offline_cancel_flags()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(download_id.clone())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    flag.store(true, Ordering::Relaxed);
    let sender = offline_cancel_senders()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(download_id)
        .or_insert_with(|| tokio::sync::watch::channel(true).0)
        .clone();
    sender.send_replace(true);
}

pub(crate) fn clear_offline_download_cancellation(download_id: &str) {
    offline_cancel_flags()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(download_id);
    offline_cancel_senders()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(download_id);
}

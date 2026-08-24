//! `psysonic-syncfs` — offline / hot-cache, device sync, and the shared HTTP
//! download helpers used by both.
//!
//! This crate hosts the Tauri commands that read/write the on-disk caches
//! (`offline_*`, `hot_cache_*`) and that copy tracks to mounted USB / SD-card
//! devices (`sync_*`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// Re-export logging facade so submodules can keep `crate::app_eprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

pub mod cache;
pub mod file_transfer;
pub mod sync;

/// Shared semaphore that caps simultaneous `download_track_offline` executions.
pub type DownloadSemaphore = Arc<tokio::sync::Semaphore>;

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

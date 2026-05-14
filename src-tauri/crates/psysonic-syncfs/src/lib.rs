//! `psysonic-syncfs` — offline / hot-cache, device sync, and the shared HTTP
//! download helpers used by both.
//!
//! This crate hosts the Tauri commands that read/write the on-disk caches
//! (`offline_*`, `hot_cache_*`) and that copy tracks to mounted USB / SD-card
//! devices (`sync_*`).

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
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

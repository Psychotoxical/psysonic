//! Sync orchestrator.
//!
//! PR-3a landed the foundation (`CapabilityProbe` C1 +
//! `SyncStateRepository` C7); PR-3b adds the initial-sync runner,
//! ingest-strategy selection, backoff, and the §6.9 id remap path.
//! `DeltaSyncRunner` / background scheduler / Tauri surface follow in
//! PR-3c / PR-3d / PR-5.

pub mod artist_index;
pub mod backoff;
pub mod bandwidth;
pub mod budget;
pub mod capability;
pub mod cursor;
pub mod delta;
pub mod error;
pub mod ingest_parallel;
pub mod initial;
pub mod mapping;
pub mod poll_stats;
pub mod progress;
pub mod scheduler;
pub mod strategy;
pub mod supervisor;
pub mod tombstone;

pub use backoff::{with_jitter, Backoff};
pub use bandwidth::{ParallelismBudget, PlaybackHint};
pub use budget::{PassKind, RequestBudget};
pub use capability::{CapabilityFlags, CapabilityProbe, NavidromeProbeCredentials};
pub use cursor::{CursorPhase, InitialSyncCursor, StrategyState};
pub use delta::{DeltaSyncReport, DeltaSyncRunner};
pub use error::SyncError;
pub use initial::{InitialSyncReport, InitialSyncRunner};
pub use mapping::{navidrome_song_to_track_row, subsonic_song_to_track_row};
pub use poll_stats::{classify_tier, next_interval_ms, LibraryTier, PollStats};
pub use progress::{ChannelProgress, NoopProgress, Progress, ProgressEvent};
pub use scheduler::{BackgroundScheduler, SchedulerTickReport, DEFAULT_TOMBSTONE_THRESHOLD_PCT};
pub use strategy::IngestStrategy;
pub use supervisor::SyncSupervisor;
pub use tombstone::{should_auto_reconcile, TombstoneReconciler, TombstoneReport};

/// Wall-clock milliseconds since the Unix epoch, saturating to `i64::MAX`.
pub(crate) fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

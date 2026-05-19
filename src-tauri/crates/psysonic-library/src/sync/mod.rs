//! Sync orchestrator.
//!
//! PR-3a landed the foundation (`CapabilityProbe` C1 +
//! `SyncStateRepository` C7); PR-3b adds the initial-sync runner,
//! ingest-strategy selection, backoff, and the §6.9 id remap path.
//! `DeltaSyncRunner` / background scheduler / Tauri surface follow in
//! PR-3c / PR-3d / PR-5.

pub mod backoff;
pub mod capability;
pub mod cursor;
pub mod delta;
pub mod error;
pub mod initial;
pub mod mapping;
pub mod strategy;
pub mod tombstone;

pub use backoff::{with_jitter, Backoff};
pub use capability::{CapabilityFlags, CapabilityProbe, NavidromeProbeCredentials};
pub use cursor::{CursorPhase, InitialSyncCursor, StrategyState};
pub use delta::{DeltaSyncReport, DeltaSyncRunner};
pub use error::SyncError;
pub use initial::{InitialSyncReport, InitialSyncRunner};
pub use mapping::{navidrome_song_to_track_row, subsonic_song_to_track_row};
pub use strategy::IngestStrategy;
pub use tombstone::{should_auto_reconcile, TombstoneReconciler, TombstoneReport};

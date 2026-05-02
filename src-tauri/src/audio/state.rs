//! Small shared structs for preload / gapless chain metadata.
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

pub(crate) struct PreloadedTrack {
    pub(crate) url: String,
    pub(crate) data: Vec<u8>,
}

/// Info about the track that has been appended (chained) to the current Sink
/// but whose source has not yet started playing (gapless mode only).
pub(crate) struct ChainedInfo {
    /// The URL that was chained — used by audio_play to detect a pre-chain hit.
    pub(crate) url: String,
    /// Raw file bytes (shared with the chained decoder). Lets manual skip reuse
    /// them instead of re-downloading after dropping the Sink queue.
    pub(crate) raw_bytes: Arc<Vec<u8>>,
    pub(crate) duration_secs: f64,
    pub(crate) replay_gain_linear: f32,
    pub(crate) base_volume: f32,
    /// Set by NotifyingSource when this chained track's source is exhausted.
    pub(crate) source_done: Arc<AtomicBool>,
    /// Atomic sample counter for this chained source (swapped into
    /// samples_played on transition).
    pub(crate) sample_counter: Arc<AtomicU64>,
}

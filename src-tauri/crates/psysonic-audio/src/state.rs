//! Small shared structs for preload / gapless chain metadata.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Completion signal for the source currently owned by a playback generation.
/// Hi-Res realignment may replace the source without incrementing generation,
/// so the progress task must resolve this slot dynamically instead of retaining
/// the flag created by the original `audio_play` call.
pub(crate) type CurrentSourceDone = Arc<Mutex<Option<(u64, Arc<AtomicBool>)>>>;

/// Publish a source completion flag only while its playback generation remains
/// current. Holding the slot lock across the generation check prevents a late
/// resume/rebuild from overwriting a newer play's flag.
pub(crate) fn install_current_source_done(
    slot: &CurrentSourceDone,
    generation: &AtomicU64,
    expected_generation: u64,
    done: Arc<AtomicBool>,
) -> bool {
    let mut current = slot.lock().unwrap();
    if generation.load(Ordering::SeqCst) != expected_generation {
        return false;
    }
    *current = Some((expected_generation, done));
    true
}

pub(crate) struct PreloadedTrack {
    pub(crate) url: String,
    pub(crate) data: Vec<u8>,
}

/// Completed ranged stream too large for `stream_completed_cache`; bytes live on disk.
pub(crate) struct StreamCompletedSpill {
    pub(crate) url: String,
    pub(crate) path: std::path::PathBuf,
}

/// Info about the track that has been appended (chained) to the current Sink
/// but whose source has not yet started playing (gapless mode only).
pub(crate) struct ChainedInfo {
    /// The URL that was chained — used by audio_play to detect a pre-chain hit.
    pub(crate) url: String,
    /// Subsonic track id for analysis dispatch (from `audio_chain_preload`).
    pub(crate) analysis_track_id: Option<String>,
    /// Playback server scope for analysis writes.
    pub(crate) server_id: Option<String>,
    /// Main playback generation shared with the predecessor. Gapless advances
    /// do not bump it, so provenance events can remain identity-qualified.
    pub(crate) generation: u64,
    /// Raw file bytes (shared with the chained decoder). Lets manual skip reuse
    /// them instead of re-downloading after dropping the Sink queue.
    pub(crate) raw_bytes: Arc<Vec<u8>>,
    /// Real decoded format of the chained successor, for the `audio:format`
    /// event emitted at the gapless transition.
    pub(crate) resolved_format: Option<crate::decode::ResolvedCodecInfo>,
    /// Actual source shape after any blend-rate resampling.
    pub(crate) output_rate: u32,
    pub(crate) output_channels: u16,
    pub(crate) duration_secs: f64,
    pub(crate) replay_gain_linear: f32,
    pub(crate) base_volume: f32,
    /// Set by NotifyingSource when this chained track's source is exhausted.
    pub(crate) source_done: Arc<AtomicBool>,
    /// Stops this queued source when preload configuration is invalidated,
    /// without touching the source that is currently audible.
    pub(crate) cancel: Arc<AtomicBool>,
    /// Atomic sample counter for this chained source (swapped into
    /// samples_played on transition).
    pub(crate) sample_counter: Arc<AtomicU64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_generation_cannot_replace_current_source_completion() {
        let generation = AtomicU64::new(2);
        let current_done = Arc::new(AtomicBool::new(false));
        let slot = Arc::new(Mutex::new(Some((2, current_done.clone()))));

        assert!(!install_current_source_done(
            &slot,
            &generation,
            1,
            Arc::new(AtomicBool::new(false)),
        ));

        let guard = slot.lock().unwrap();
        let (slot_generation, slot_done) = guard.as_ref().unwrap();
        assert_eq!(*slot_generation, 2);
        assert!(Arc::ptr_eq(slot_done, &current_done));
    }
}

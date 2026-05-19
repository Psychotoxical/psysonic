//! C11 — bandwidth priority lane (spec §6.2.4).
//!
//! PR-3d2 ships the data types + parallelism resolver. The signal
//! itself is pushed in from the top crate (PR-5 hooks audio engine
//! events from `psysonic-audio` into a shared `PlaybackHint` cell);
//! the library side just consumes it.

/// What the player is currently doing — drives crawl parallelism.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PlaybackHint {
    /// Nothing playing, queue idle → bulk crawl runs at normal
    /// parallelism.
    #[default]
    Idle,
    /// Active stream (user listening). Bulk drops to single-request
    /// crawling and increases inter-request delay.
    Playing,
    /// Queue prefetch / waveform analysis hot — priority lane only;
    /// bulk pauses entirely.
    PrefetchActive,
}

/// Parallelism budget the bulk crawl uses for this tick. `0` means
/// bulk is suspended this tick (PR-3d2 returns the value; the runner
/// honoring it is wired in PR-3d2 too via `BackgroundScheduler`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParallelismBudget {
    pub max_concurrent: u32,
    /// Minimum gap between successive bulk requests, in ms.
    pub min_request_gap_ms: u32,
}

impl ParallelismBudget {
    pub fn resolve(hint: PlaybackHint) -> Self {
        match hint {
            PlaybackHint::Idle => Self {
                max_concurrent: 4,
                min_request_gap_ms: 0,
            },
            PlaybackHint::Playing => Self {
                max_concurrent: 1,
                min_request_gap_ms: 250,
            },
            PlaybackHint::PrefetchActive => Self {
                max_concurrent: 0,
                min_request_gap_ms: 0,
            },
        }
    }

    pub fn bulk_paused(&self) -> bool {
        self.max_concurrent == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_resolves_to_normal_parallelism() {
        let b = ParallelismBudget::resolve(PlaybackHint::Idle);
        assert_eq!(b.max_concurrent, 4);
        assert_eq!(b.min_request_gap_ms, 0);
        assert!(!b.bulk_paused());
    }

    #[test]
    fn playing_caps_parallelism_to_one_with_inter_request_gap() {
        let b = ParallelismBudget::resolve(PlaybackHint::Playing);
        assert_eq!(b.max_concurrent, 1);
        assert!(b.min_request_gap_ms >= 100, "playing must space requests out");
        assert!(!b.bulk_paused());
    }

    #[test]
    fn prefetch_active_pauses_bulk_crawl_entirely() {
        let b = ParallelismBudget::resolve(PlaybackHint::PrefetchActive);
        assert!(b.bulk_paused());
    }

    #[test]
    fn playback_hint_default_is_idle() {
        assert_eq!(PlaybackHint::default(), PlaybackHint::Idle);
    }
}

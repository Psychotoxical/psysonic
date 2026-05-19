//! C10 — adaptive poll interval (spec §6.2.2).
//!
//! Rolling EWMA over the last delta pass's HTTP response stats plus
//! the artist-count signal classifies the server into a `LibraryTier`,
//! which then drives the next poll interval. Persisted in
//! `sync_state.poll_stats_json` so the scheduler picks up where it
//! left off across restarts.

use serde::{Deserialize, Serialize};

/// EWMA smoothing factor — higher values weight recent samples more.
/// 0.3 matches the §6.2.2 "rolling EWMA" target without over-reacting
/// to a single slow response.
pub const EWMA_ALPHA: f64 = 0.3;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryTier {
    /// `<2k` artists.
    Small,
    /// `2k-15k` artists.
    Medium,
    /// `>15k` artists OR `ewma_bytes > 2 MB`.
    Huge,
    #[default]
    Unknown,
}

impl LibraryTier {
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Huge => "huge",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct PollStats {
    /// Last successful `getArtists.index` cardinality, or
    /// `getScanStatus.count` estimate. Used as the primary tier
    /// signal.
    #[serde(default)]
    pub artist_count: u64,
    /// EWMA of the most recent poll response sizes, in bytes.
    /// Decompressed (post-gzip) per §2.2.1.
    #[serde(default)]
    pub ewma_bytes: f64,
    /// EWMA of the most recent poll wall-clock durations, in ms.
    #[serde(default)]
    pub ewma_duration_ms: f64,
    /// Resolved tier from the inputs above.
    #[serde(default)]
    pub library_tier: LibraryTier,
}

impl PollStats {
    /// Fold a new sample into the EWMAs. First sample seeds the
    /// averages directly so a single fresh poll yields a meaningful
    /// tier classification.
    pub fn observe(&mut self, bytes: u64, duration_ms: u64) {
        let b = bytes as f64;
        let d = duration_ms as f64;
        self.ewma_bytes = if self.ewma_bytes == 0.0 {
            b
        } else {
            EWMA_ALPHA * b + (1.0 - EWMA_ALPHA) * self.ewma_bytes
        };
        self.ewma_duration_ms = if self.ewma_duration_ms == 0.0 {
            d
        } else {
            EWMA_ALPHA * d + (1.0 - EWMA_ALPHA) * self.ewma_duration_ms
        };
    }

    /// Update `artist_count` and recompute the resolved tier.
    pub fn set_artist_count(&mut self, count: u64) {
        self.artist_count = count;
        self.library_tier = classify_tier(self.artist_count, self.ewma_bytes);
    }

    /// Force a tier re-classification — call after a fresh
    /// `observe()` pair if a borderline `ewma_bytes` may have tipped
    /// the threshold.
    pub fn reclassify(&mut self) {
        self.library_tier = classify_tier(self.artist_count, self.ewma_bytes);
    }
}

/// §6.2.2 classification table.
pub fn classify_tier(artist_count: u64, ewma_bytes: f64) -> LibraryTier {
    if artist_count == 0 && ewma_bytes == 0.0 {
        return LibraryTier::Unknown;
    }
    if artist_count > 15_000 || ewma_bytes > 2_000_000.0 {
        return LibraryTier::Huge;
    }
    if artist_count >= 2_000 {
        return LibraryTier::Medium;
    }
    LibraryTier::Small
}

/// Spec §6.2.2 formula. Returns the delta in milliseconds — caller
/// stamps `next_poll_at = now + this`. All arithmetic in `f64` so the
/// `load_factor` clamp produces a smooth curve.
pub fn next_interval_ms(stats: &PollStats) -> u64 {
    let base_ms: u64 = match stats.library_tier {
        LibraryTier::Huge => 15 * 60 * 1000,
        LibraryTier::Medium => 10 * 60 * 1000,
        LibraryTier::Small => 5 * 60 * 1000,
        // No data yet — start short so the first real tick lands
        // quickly and re-classifies.
        LibraryTier::Unknown => 60 * 1000,
    };
    let load_factor = if stats.ewma_duration_ms <= 0.0 {
        1.0
    } else {
        (stats.ewma_duration_ms / 3000.0).clamp(1.0, 10.0)
    };
    let artist_factor: f64 = if matches!(stats.library_tier, LibraryTier::Huge) {
        3.0
    } else {
        1.0
    };
    let scaled = (base_ms as f64) * load_factor * artist_factor;
    scaled.min(u64::MAX as f64) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_returns_unknown_with_zero_signals() {
        assert_eq!(classify_tier(0, 0.0), LibraryTier::Unknown);
    }

    #[test]
    fn classify_small_under_2k_artists() {
        assert_eq!(classify_tier(500, 1000.0), LibraryTier::Small);
        assert_eq!(classify_tier(1_999, 1000.0), LibraryTier::Small);
    }

    #[test]
    fn classify_medium_in_range() {
        assert_eq!(classify_tier(2_000, 1000.0), LibraryTier::Medium);
        assert_eq!(classify_tier(15_000, 1000.0), LibraryTier::Medium);
    }

    #[test]
    fn classify_huge_above_15k_artists() {
        assert_eq!(classify_tier(15_001, 1000.0), LibraryTier::Huge);
    }

    #[test]
    fn classify_huge_when_ewma_bytes_exceed_2mb_even_with_few_artists() {
        // Slow-network signal — the spec's `ewma_bytes > 2MB` override.
        assert_eq!(classify_tier(500, 2_500_000.0), LibraryTier::Huge);
    }

    #[test]
    fn observe_first_sample_seeds_ewmas_directly() {
        let mut s = PollStats::default();
        s.observe(100_000, 1500);
        assert_eq!(s.ewma_bytes, 100_000.0);
        assert_eq!(s.ewma_duration_ms, 1500.0);
    }

    #[test]
    fn observe_subsequent_samples_apply_alpha_smoothing() {
        let mut s = PollStats::default();
        s.observe(100_000, 1000);
        s.observe(200_000, 2000);
        // 0.3 * 200_000 + 0.7 * 100_000 = 60_000 + 70_000 = 130_000
        assert!((s.ewma_bytes - 130_000.0).abs() < 0.001);
        assert!((s.ewma_duration_ms - 1300.0).abs() < 0.001);
    }

    #[test]
    fn set_artist_count_triggers_reclassification() {
        let mut s = PollStats::default();
        s.observe(50_000, 1500);
        s.set_artist_count(5_000);
        assert_eq!(s.library_tier, LibraryTier::Medium);
    }

    #[test]
    fn next_interval_unknown_tier_starts_short() {
        let s = PollStats::default();
        assert_eq!(next_interval_ms(&s), 60_000);
    }

    #[test]
    fn next_interval_small_base_5min_at_idle_load() {
        let mut s = PollStats::default();
        s.set_artist_count(1000);
        // load_factor clamps at 1.0 when ewma_duration_ms = 0.
        assert_eq!(next_interval_ms(&s), 5 * 60_000);
    }

    #[test]
    fn next_interval_huge_uses_artist_factor_3x() {
        let mut s = PollStats::default();
        s.set_artist_count(20_000);
        // 15 min * 3 = 45 min on idle load.
        assert_eq!(next_interval_ms(&s), 45 * 60_000);
    }

    #[test]
    fn next_interval_load_factor_stretches_with_slow_network() {
        let mut s = PollStats::default();
        s.set_artist_count(1000);
        s.observe(50_000, 9_000); // 3× the 3000ms target
        // 5 min * 3 (load_factor) = 15 min.
        let ms = next_interval_ms(&s);
        assert!(
            (14 * 60_000..=16 * 60_000).contains(&ms),
            "expected ~15min, got {ms}ms"
        );
    }

    #[test]
    fn next_interval_load_factor_clamped_at_10x() {
        let mut s = PollStats::default();
        s.set_artist_count(1000);
        s.observe(50_000, 60_000); // 20× target → clamps at 10
        assert_eq!(next_interval_ms(&s), 10 * 5 * 60_000);
    }

    #[test]
    fn poll_stats_round_trips_through_json() {
        let mut s = PollStats::default();
        s.observe(123_456, 789);
        s.set_artist_count(3_500);
        let json = serde_json::to_value(s).unwrap();
        let back: PollStats = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn poll_stats_deserialize_tolerates_missing_fields() {
        // Stored default is `'{}'` per spec §5.1; runner must accept it
        // as a fresh stats object.
        let s: PollStats = serde_json::from_str("{}").unwrap();
        assert_eq!(s, PollStats::default());
    }
}

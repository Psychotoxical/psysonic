//! C2 ingest strategy selection. Per the PR-3 kickoff answer (workdocs
//! `2026-05-19-pr3-kickoff.md` Q3) the choice is made once at initial
//! sync start from the probed capability flags; the runner does not
//! auto-switch on transient failure (C12 retries the same batch).

use super::capability::CapabilityFlags;

/// Server track count above which N1 is skipped in favour of S1 at initial
/// sync start (R7-15 Q4). N1's native `/api/song` deep-offset 500 wall makes
/// it unable to finish very large catalogs; S1 (`search3`) does not hit it.
/// Tunable constant — the live wall was observed past ~50k.
pub const LARGE_LIBRARY_THRESHOLD: i64 = 40_000;

/// Spec §6.3 IS-3 strategies. Names match §6.1.1 capability bits where
/// applicable; S2 has no flag of its own — it's the universal
/// album-crawl fallback assumed available whenever the Subsonic ping
/// succeeds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum IngestStrategy {
    /// N1 — Navidrome native `GET /api/song` paginated. Cheapest at
    /// 500k; requires `NavidromeNativeBulk` flag set by the probe.
    N1,
    /// S1 — Subsonic `search3` empty query, songOffset paged. Requires
    /// `SubsonicSearch3Bulk`.
    S1,
    /// S2 — `getAlbumList2` + `getAlbum` per album. Universal Subsonic
    /// fallback — assumed available whenever the ping returns ok.
    S2,
    /// S3 — `getIndexes` + `getMusicDirectory` recursive file-tree
    /// crawl. Last resort; PR-3b does not auto-select it.
    S3,
}

impl IngestStrategy {
    /// Pick the cheapest strategy supported by `flags`. Per kickoff Q3:
    /// `N1 → S1 → S2`. S3 is enumerated for completeness but never
    /// auto-selected — when neither N1 nor S1 is available, S2 is
    /// always tried first because every Subsonic-compliant server
    /// exposes `getAlbumList2` + `getAlbum`.
    pub fn select_from_flags(flags: CapabilityFlags) -> Self {
        if flags.contains(CapabilityFlags::NAVIDROME_NATIVE_BULK) {
            Self::N1
        } else if flags.contains(CapabilityFlags::SUBSONIC_SEARCH3_BULK) {
            Self::S1
        } else {
            Self::S2
        }
    }

    /// Pick the initial-sync strategy with the large-library policy on top
    /// of `select_from_flags` (R7-15 Q4). A large catalog — or one already
    /// flagged `n1_bulk_unreliable` after an N1 deep-offset 500 — must avoid
    /// N1, which cannot finish past the wall. Prefer S1 (`search3`) and fall
    /// back to S2 (universal album crawl) when search3 bulk is unavailable.
    ///
    /// `server_track_count` is best-effort at IS-1 (probe `getScanStatus`
    /// count or a prior watermark); `None` means unknown, in which case only
    /// the `n1_bulk_unreliable` flag forces the non-N1 path (a first run with
    /// no count still tries the cheapest strategy and learns from a 500).
    pub fn select_initial_strategy(
        flags: CapabilityFlags,
        server_track_count: Option<i64>,
        n1_bulk_unreliable: bool,
    ) -> Self {
        let is_large = server_track_count
            .map(|c| c > LARGE_LIBRARY_THRESHOLD)
            .unwrap_or(false);
        if n1_bulk_unreliable || is_large {
            if flags.contains(CapabilityFlags::SUBSONIC_SEARCH3_BULK) {
                return Self::S1;
            }
            return Self::S2;
        }
        Self::select_from_flags(flags)
    }

    /// String tag stored in `initial_sync_cursor_json` so the runner
    /// can resume after restart without re-running capability probe.
    pub fn as_tag(self) -> &'static str {
        match self {
            Self::N1 => "n1",
            Self::S1 => "s1",
            Self::S2 => "s2",
            Self::S3 => "s3",
        }
    }

    pub fn from_tag(tag: &str) -> Option<Self> {
        match tag {
            "n1" => Some(Self::N1),
            "s1" => Some(Self::S1),
            "s2" => Some(Self::S2),
            "s3" => Some(Self::S3),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_prefers_navidrome_native_when_both_n1_and_s1_present() {
        // At 500k, N1 cuts request count by 10× vs S1 — selector must
        // pick it whenever the flag is set, regardless of S1.
        let flags = CapabilityFlags::new(
            CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK,
        );
        assert_eq!(IngestStrategy::select_from_flags(flags), IngestStrategy::N1);
    }

    #[test]
    fn select_falls_back_to_s1_without_n1() {
        let flags = CapabilityFlags::new(CapabilityFlags::SUBSONIC_SEARCH3_BULK);
        assert_eq!(IngestStrategy::select_from_flags(flags), IngestStrategy::S1);
    }

    #[test]
    fn select_falls_back_to_s2_when_no_bulk_flag_set() {
        // Generic Subsonic server without search3 bulk → universal
        // album crawl. S3 is not auto-selected even with FileTreeBrowse.
        let flags = CapabilityFlags::new(CapabilityFlags::FILE_TREE_BROWSE);
        assert_eq!(IngestStrategy::select_from_flags(flags), IngestStrategy::S2);
    }

    #[test]
    fn select_falls_back_to_s2_with_no_flags() {
        // Default-flag (`0x000`) — fresh DB before probe runs, or a
        // truly minimal Subsonic implementation. Still resolves to a
        // strategy; runner surfaces errors if S2 endpoints then fail.
        assert_eq!(
            IngestStrategy::select_from_flags(CapabilityFlags::default()),
            IngestStrategy::S2
        );
    }

    // ── select_initial_strategy (R7-15 Q4 large-library policy) ──────────

    fn navidrome_full() -> CapabilityFlags {
        CapabilityFlags::new(
            CapabilityFlags::NAVIDROME_NATIVE_BULK | CapabilityFlags::SUBSONIC_SEARCH3_BULK,
        )
    }

    #[test]
    fn initial_strategy_small_library_keeps_cheapest_n1() {
        // Below threshold, not flagged unreliable → unchanged N1-first chain.
        let s = IngestStrategy::select_initial_strategy(navidrome_full(), Some(1_000), false);
        assert_eq!(s, IngestStrategy::N1);
    }

    #[test]
    fn initial_strategy_large_library_avoids_n1_for_s1() {
        // Over threshold → S1 even though N1 is advertised (deep-offset wall).
        let s = IngestStrategy::select_initial_strategy(navidrome_full(), Some(170_000), false);
        assert_eq!(s, IngestStrategy::S1);
    }

    #[test]
    fn initial_strategy_unreliable_flag_avoids_n1_regardless_of_size() {
        // Learned `n1_bulk_unreliable` forces the non-N1 path even when the
        // count is small/unknown (covers R7-15 "unknown → large if N1 failed").
        let small =
            IngestStrategy::select_initial_strategy(navidrome_full(), Some(500), true);
        assert_eq!(small, IngestStrategy::S1);
        let unknown = IngestStrategy::select_initial_strategy(navidrome_full(), None, true);
        assert_eq!(unknown, IngestStrategy::S1);
    }

    #[test]
    fn initial_strategy_large_without_search3_falls_back_to_s2() {
        // Avoid-N1 path but no search3 bulk → universal album crawl, not N1.
        let flags = CapabilityFlags::new(CapabilityFlags::NAVIDROME_NATIVE_BULK);
        let s = IngestStrategy::select_initial_strategy(flags, Some(170_000), false);
        assert_eq!(s, IngestStrategy::S2);
    }

    #[test]
    fn initial_strategy_unknown_count_uses_cheapest_when_not_flagged() {
        // First run, no count yet, N1 never failed → try cheapest (N1); the
        // mid-run N1→S1 fallback (R7-15 Q5) handles the wall if hit.
        let s = IngestStrategy::select_initial_strategy(navidrome_full(), None, false);
        assert_eq!(s, IngestStrategy::N1);
    }

    #[test]
    fn initial_strategy_threshold_is_strictly_greater_than() {
        // Exactly at the threshold is not "large"; one above is.
        let at = IngestStrategy::select_initial_strategy(
            navidrome_full(),
            Some(LARGE_LIBRARY_THRESHOLD),
            false,
        );
        assert_eq!(at, IngestStrategy::N1);
        let over = IngestStrategy::select_initial_strategy(
            navidrome_full(),
            Some(LARGE_LIBRARY_THRESHOLD + 1),
            false,
        );
        assert_eq!(over, IngestStrategy::S1);
    }

    #[test]
    fn tag_roundtrip_is_stable_for_cursor_persistence() {
        for s in [
            IngestStrategy::N1,
            IngestStrategy::S1,
            IngestStrategy::S2,
            IngestStrategy::S3,
        ] {
            assert_eq!(IngestStrategy::from_tag(s.as_tag()), Some(s));
        }
        assert_eq!(IngestStrategy::from_tag("unknown"), None);
    }
}

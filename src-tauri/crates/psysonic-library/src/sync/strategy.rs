//! C2 ingest strategy selection. Per the PR-3 kickoff answer (workdocs
//! `2026-05-19-pr3-kickoff.md` Q3) the choice is made once at initial
//! sync start from the probed capability flags; the runner does not
//! auto-switch on transient failure (C12 retries the same batch).

use super::capability::CapabilityFlags;

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

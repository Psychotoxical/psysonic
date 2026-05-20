//! Cursor shape persisted in `sync_state.initial_sync_cursor_json`.
//! Resume after a restart, kill, or app crash deserializes this value
//! and tells the runner where to pick up. Strategy is recorded so a
//! cap-flag change between runs is detected and the stale cursor is
//! reset — the runner restarts ingest under the newly-selected strategy
//! rather than resuming the wrong loop.

use serde::{Deserialize, Serialize};

use super::strategy::IngestStrategy;

/// Top-level cursor. `phase` advances `Ingest → ArtistPass → Watermarks
/// → Done`; each phase only reads the fields it owns.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InitialSyncCursor {
    /// Ingest strategy in flight — stored as the tag string so the JSON
    /// is human-readable on disk.
    pub strategy: String,
    pub phase: CursorPhase,
    /// Scope this run operates on (Navidrome `library_id` / Subsonic
    /// `musicFolderId`). `None` means "all libraries on this server".
    #[serde(default)]
    pub library_scope: Option<String>,
    /// Tracks ingested across the entire run so far — informational,
    /// matches the §6 progress event payload.
    #[serde(default)]
    pub ingested_count: u32,
    /// Per-strategy offset state. Discriminated by `strategy` so a
    /// future field add doesn't break old cursors.
    #[serde(default)]
    pub strategy_state: StrategyState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CursorPhase {
    Ingest,
    ArtistPass,
    Watermarks,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StrategyState {
    /// N1 / S1 — single linear offset.
    LinearOffset { offset: u32 },
    /// S2 — outer album-list offset plus optional in-flight album we
    /// were halfway through when interrupted.
    AlbumCrawl {
        album_offset: u32,
        #[serde(default)]
        current_album_id: Option<String>,
    },
    /// Fresh cursor with no progress yet.
    #[default]
    Empty,
}

impl InitialSyncCursor {
    pub fn fresh(strategy: IngestStrategy, library_scope: Option<String>) -> Self {
        let strategy_state = match strategy {
            IngestStrategy::N1 | IngestStrategy::S1 => StrategyState::LinearOffset { offset: 0 },
            IngestStrategy::S2 => StrategyState::AlbumCrawl {
                album_offset: 0,
                current_album_id: None,
            },
            IngestStrategy::S3 => StrategyState::Empty,
        };
        Self {
            strategy: strategy.as_tag().to_string(),
            phase: CursorPhase::Ingest,
            library_scope,
            ingested_count: 0,
            strategy_state,
        }
    }

    pub fn strategy_tag(&self) -> &str {
        &self.strategy
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fresh_n1_starts_at_offset_zero() {
        let c = InitialSyncCursor::fresh(IngestStrategy::N1, None);
        assert_eq!(c.phase, CursorPhase::Ingest);
        assert_eq!(c.ingested_count, 0);
        match c.strategy_state {
            StrategyState::LinearOffset { offset } => assert_eq!(offset, 0),
            other => panic!("expected LinearOffset, got {other:?}"),
        }
    }

    #[test]
    fn fresh_s2_uses_album_crawl_state() {
        let c = InitialSyncCursor::fresh(IngestStrategy::S2, Some("lib-1".into()));
        assert_eq!(c.library_scope.as_deref(), Some("lib-1"));
        match c.strategy_state {
            StrategyState::AlbumCrawl { album_offset, current_album_id } => {
                assert_eq!(album_offset, 0);
                assert!(current_album_id.is_none());
            }
            other => panic!("expected AlbumCrawl, got {other:?}"),
        }
    }

    #[test]
    fn cursor_roundtrips_through_json() {
        // The cursor lives as TEXT in `sync_state.initial_sync_cursor_json`;
        // serde must keep the round trip stable for resume to work.
        let c = InitialSyncCursor {
            strategy: "n1".into(),
            phase: CursorPhase::Ingest,
            library_scope: Some("lib-1".into()),
            ingested_count: 2500,
            strategy_state: StrategyState::LinearOffset { offset: 2500 },
        };
        let json = serde_json::to_value(&c).unwrap();
        let back: InitialSyncCursor = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(c, back);

        // strategy_state internally tagged with `"kind"`.
        assert_eq!(
            json.get("strategy_state").and_then(|s| s.get("kind")),
            Some(&json!("linear_offset"))
        );
    }

    #[test]
    fn cursor_deserialize_tolerates_omitted_defaults() {
        // Minimal cursor produced by a much older client must still
        // deserialize as a "fresh ingest" state.
        let raw = json!({
            "strategy": "s1",
            "phase": "ingest"
        });
        let c: InitialSyncCursor = serde_json::from_value(raw).unwrap();
        assert_eq!(c.ingested_count, 0);
        assert_eq!(c.library_scope, None);
        assert!(matches!(c.strategy_state, StrategyState::Empty));
    }

    #[test]
    fn empty_object_does_not_parse_as_cursor() {
        // sync_state.initial_sync_cursor_json default is `'{}'`; that
        // value is not a valid cursor (no strategy / phase). Runner
        // must treat it as "no cursor → start fresh".
        let raw = json!({});
        assert!(serde_json::from_value::<InitialSyncCursor>(raw).is_err());
    }
}

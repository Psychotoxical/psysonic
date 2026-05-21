//! Errors surfaced by the sync orchestrator. Designed so callers
//! (PR-5 Tauri command surface) can pattern-match on the variant for
//! UI affordances — `Cancelled` is silent, `Transport`/`HttpStatus`
//! retry, `Subsonic { code: 70, .. }` flows into the tombstone path,
//! and `StrategyUnsupported` surfaces a Settings hint.

use std::fmt;

use psysonic_integration::subsonic::SubsonicError;

#[derive(Debug)]
pub enum SyncError {
    /// Network / TLS / DNS failure surfaced by the Subsonic or
    /// Navidrome HTTP client. Retryable per §6.8.
    Transport(String),

    /// Subsonic-level error after the envelope parsed cleanly. The
    /// dedicated `NotFound` (error code 70) is kept inline rather
    /// than collapsed into a string so the tombstone path can match.
    Subsonic { code: i32, message: String },

    /// Subsonic returned error code 70 — track missing from the
    /// server. Tombstone reconciler matches on this variant directly.
    NotFound,

    /// Navidrome native REST returned a non-success status; carries
    /// the flattened HTTP error string from `nd_err`.
    Navidrome(String),

    /// Persistence layer (SQLite) failure.
    Storage(String),

    /// Strategy is enumerated but not implemented for v1
    /// (currently only `S3`).
    StrategyUnsupported {
        strategy: &'static str,
    },

    /// Cancellation token tripped — caller asked us to abort.
    /// Cursor stays where it was so the next run resumes the batch.
    Cancelled,

    /// Cursor JSON in `sync_state` is from an incompatible strategy
    /// (e.g. switching from N1 to S2 mid-sync). Caller should clear
    /// the cursor and restart initial sync.
    CursorIncompatible {
        expected: &'static str,
        actual: String,
    },
}

impl fmt::Display for SyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(m) => write!(f, "sync transport: {m}"),
            Self::Subsonic { code, message } => write!(f, "subsonic {code}: {message}"),
            Self::NotFound => write!(f, "subsonic: not found (code 70)"),
            Self::Navidrome(m) => write!(f, "navidrome: {m}"),
            Self::Storage(m) => write!(f, "storage: {m}"),
            Self::StrategyUnsupported { strategy } => {
                write!(f, "ingest strategy not supported: {strategy}")
            }
            Self::Cancelled => write!(f, "sync cancelled"),
            Self::CursorIncompatible { expected, actual } => write!(
                f,
                "sync cursor strategy mismatch: cursor says `{actual}`, runner is `{expected}`"
            ),
        }
    }
}

impl std::error::Error for SyncError {}

impl SyncError {
    /// Parsed HTTP status when this is a Navidrome native REST failure
    /// shaped like `HTTP 500` or `HTTP 500: body`.
    pub fn navidrome_http_status(&self) -> Option<u16> {
        let SyncError::Navidrome(msg) = self else {
            return None;
        };
        let rest = msg.strip_prefix("HTTP ")?.split(':').next()?.trim();
        rest.split_whitespace().next()?.parse().ok()
    }
}

impl From<SubsonicError> for SyncError {
    fn from(e: SubsonicError) -> Self {
        match e {
            SubsonicError::Transport(m) => Self::Transport(m),
            SubsonicError::HttpStatus(s) => Self::Transport(format!("http {s}")),
            SubsonicError::Api { code, message } => Self::Subsonic { code, message },
            SubsonicError::NotFound => Self::NotFound,
            SubsonicError::Decode(m) => Self::Transport(format!("decode: {m}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subsonic_not_found_maps_to_sync_not_found() {
        let e: SyncError = SubsonicError::NotFound.into();
        assert!(matches!(e, SyncError::NotFound));
    }

    #[test]
    fn subsonic_api_error_carries_code_through() {
        let e: SyncError = SubsonicError::Api { code: 40, message: "bad creds".into() }.into();
        match e {
            SyncError::Subsonic { code, message } => {
                assert_eq!(code, 40);
                assert!(message.contains("bad creds"));
            }
            other => panic!("expected Subsonic, got {other:?}"),
        }
    }

    #[test]
    fn http_status_collapses_into_transport() {
        let e: SyncError = SubsonicError::HttpStatus(reqwest::StatusCode::SERVICE_UNAVAILABLE).into();
        assert!(matches!(e, SyncError::Transport(ref m) if m.contains("503")));
    }

    #[test]
    fn navidrome_http_status_parses_status_line() {
        let e = SyncError::Navidrome("HTTP 500".into());
        assert_eq!(e.navidrome_http_status(), Some(500));
        let with_body = SyncError::Navidrome("HTTP 503: upstream timeout".into());
        assert_eq!(with_body.navidrome_http_status(), Some(503));
        let with_reason = SyncError::Navidrome("HTTP 500 Internal Server Error".into());
        assert_eq!(with_reason.navidrome_http_status(), Some(500));
        assert_eq!(
            SyncError::Transport("http 500".into()).navidrome_http_status(),
            None
        );
    }

    #[test]
    fn cursor_incompatible_renders_both_strategies() {
        let s = SyncError::CursorIncompatible {
            expected: "n1",
            actual: "s2".into(),
        }
        .to_string();
        assert!(s.contains("n1") && s.contains("s2"));
    }
}

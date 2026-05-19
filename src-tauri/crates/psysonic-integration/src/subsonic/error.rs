use std::fmt;

/// Errors surfaced by `SubsonicClient`. Designed for the sync engine
/// (PR-3): `NotFound` exists as a first-class variant so the tombstone
/// reconciler can match Subsonic error code 70 without parsing strings.
///
/// Spec §2.6 — code 70 = "The requested data was not found".
#[derive(Debug)]
pub enum SubsonicError {
    /// Transport failure (DNS, TCP, TLS, body read). Wraps the flattened
    /// reqwest error chain so toasts can surface the real cause.
    Transport(String),

    /// Server replied with a non-2xx HTTP status before the JSON envelope
    /// was inspectable.
    HttpStatus(reqwest::StatusCode),

    /// Subsonic-level failure (`status = "failed"` in the envelope).
    Api { code: i32, message: String },

    /// Convenience for the common error code 70. Equivalent to
    /// `Api { code: 70, .. }` and produced by the same parser.
    NotFound,

    /// Response body wasn't the expected JSON shape.
    Decode(String),
}

impl fmt::Display for SubsonicError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SubsonicError::Transport(m) => write!(f, "subsonic transport: {m}"),
            SubsonicError::HttpStatus(s) => write!(f, "subsonic http status: {s}"),
            SubsonicError::Api { code, message } => {
                write!(f, "subsonic api error {code}: {message}")
            }
            SubsonicError::NotFound => write!(f, "subsonic: not found (code 70)"),
            SubsonicError::Decode(m) => write!(f, "subsonic decode: {m}"),
        }
    }
}

impl std::error::Error for SubsonicError {}

/// Flatten a `reqwest::Error` source chain into one readable string —
/// mirrors `psysonic-integration::navidrome::nd_err` so the two clients
/// surface comparable diagnostic text.
pub(crate) fn flatten_reqwest_error(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(" | ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_includes_error_code_for_api_variant() {
        let e = SubsonicError::Api { code: 40, message: "Wrong username or password".into() };
        let s = e.to_string();
        assert!(s.contains("40"));
        assert!(s.contains("Wrong username"));
    }

    #[test]
    fn not_found_renders_with_code_70_for_log_search() {
        let s = SubsonicError::NotFound.to_string();
        assert!(s.contains("70"), "got {s}");
    }
}

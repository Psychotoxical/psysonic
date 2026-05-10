//! Process-global outbound User-Agent for Rust-side HTTP.
//!
//! Initialised to `psysonic/<version>` (workspace package version) and then
//! overridden from the main WebView's `navigator.userAgent` once the frontend
//! reports it during startup. Every Rust HTTP client (`reqwest::Client`,
//! handcrafted `header::USER_AGENT`) reads the current value via
//! [`subsonic_wire_user_agent`] so a single switch keeps server-side
//! request-fingerprints consistent.

use std::sync::{OnceLock, RwLock};

pub fn default_subsonic_wire_user_agent() -> String {
    format!("psysonic/{}", env!("CARGO_PKG_VERSION"))
}

pub fn runtime_subsonic_wire_user_agent() -> &'static RwLock<String> {
    static UA: OnceLock<RwLock<String>> = OnceLock::new();
    UA.get_or_init(|| RwLock::new(default_subsonic_wire_user_agent()))
}

pub fn subsonic_wire_user_agent() -> String {
    runtime_subsonic_wire_user_agent()
        .read()
        .map(|ua| ua.clone())
        .unwrap_or_else(|_| default_subsonic_wire_user_agent())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_user_agent_starts_with_psysonic_slash() {
        let ua = default_subsonic_wire_user_agent();
        assert!(ua.starts_with("psysonic/"), "got {ua:?}");
        assert!(
            ua.len() > "psysonic/".len(),
            "version suffix missing: {ua:?}"
        );
    }

    #[test]
    fn runtime_user_agent_returns_default_until_overridden() {
        let ua = subsonic_wire_user_agent();
        assert_eq!(ua, default_subsonic_wire_user_agent());
    }
}

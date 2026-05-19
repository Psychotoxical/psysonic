//! `psysonic-integration` — outbound bridges to external services that the
//! UI surfaces but the WebView can't talk to directly (CORS, custom auth, etc.).
//!
//! Domains:
//! - `discord`     — Discord Rich Presence (album artwork via iTunes)
//! - `navidrome`   — Navidrome's native REST API (admin: users/playlists/covers/queries)
//! - `subsonic`    — Subsonic REST surface for the library-sync engine
//! - `remote`      — radio-browser, last.fm, ICY-meta probe, generic CORS proxy
//! - `bandsintown` — bandsintown events for an artist

// Re-export the logging facade so submodules keep using
// `crate::app_eprintln!()` and `crate::app_deprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

pub mod bandsintown;
pub mod discord;
pub mod navidrome;
pub mod remote;
pub mod subsonic;

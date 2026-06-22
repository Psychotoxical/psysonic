//! Navidrome native REST API: split into a small client/auth/retry core
//! plus per-domain submodules (covers, users, queries, playlists). Each
//! Tauri command goes through `nd_http_client()` + `nd_retry()` so flaky
//! reverse proxies in front of the server don't surface as user-visible
//! transport errors on a single retry-able blip.

mod client;
pub mod covers;
pub mod playlists;
pub mod probe;
pub mod queries;
pub mod users;

pub use client::{navidrome_token, navidrome_token_with_registry, nd_apply_request};

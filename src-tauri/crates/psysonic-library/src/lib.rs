//! `psysonic-library` — unified track store and (future) sync engine.
//!
//! v1 scope (this crate, across PR-1..PR-7):
//! - `store`  — SQLite connection, WAL config, versioned migration runner
//! - `repos`  — typed repositories over the v1 schema (track, album, artist, …)
//! - `search` — FTS5 query helpers
//! - `filter` — `FilterFieldRegistry` (Rust source of truth for Advanced Search)
//! - `sync`   — capability probe + orchestrator (PR-3*)

pub mod filter;
pub mod repos;
pub mod search;
pub mod store;
pub mod sync;

pub use store::{LibraryStore, LIBRARY_DB_SCHEMA_VERSION};

// Re-export logging facade so submodules can write `crate::app_eprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

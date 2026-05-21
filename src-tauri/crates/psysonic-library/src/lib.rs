//! `psysonic-library` — unified track store and (future) sync engine.
//!
//! v1 scope (this crate, across PR-1..PR-7):
//! - `store`  — SQLite connection, WAL config, versioned migration runner
//! - `repos`  — typed repositories over the v1 schema (track, album, artist, …)
//! - `search` — FTS5 query helpers
//! - `filter` — `FilterFieldRegistry` (Rust source of truth for Advanced Search)
//! - `sync`   — capability probe + orchestrator (PR-3*)

pub(crate) mod bulk_ingest;
pub mod advanced_search;
pub mod canonical;
pub mod commands;
pub mod cross_server;
pub mod dto;
pub mod filter;
pub mod live_search;
pub mod payload;
pub mod repos;
pub mod runtime;
pub mod search;
pub mod store;
pub mod sync;
pub(crate) mod track_fts;

pub use payload::LibrarySyncProgressPayload;
pub use runtime::LibraryRuntime;

pub use store::{LibraryStore, LIBRARY_DB_SCHEMA_VERSION};

// Re-export logging facade so submodules can write `crate::app_eprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

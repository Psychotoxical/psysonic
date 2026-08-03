//! `psysonic-library` — unified track store and (future) sync engine.
//!
//! v1 scope (this crate, across PR-1..PR-7):
//! - `store`  — SQLite connection, WAL config, versioned migration runner
//! - `repos`  — typed repositories over the v1 schema (track, album, artist, …)
//! - `search` — FTS5 query helpers
//! - `filter` — `FilterFieldRegistry` (Rust source of truth for Advanced Search)
//! - `sync`   — capability probe + orchestrator (PR-3*)

pub mod advanced_search;
mod advanced_search_mood;
pub mod album_overlay;
pub mod album_compilation_filter;
pub mod analysis_backfill;
pub mod analysis_backfill_policy;
pub mod artist_artwork;
pub mod artist_lossless_browse;
pub mod artist_sort;
pub mod browse_projection;
pub mod browse_support;
pub(crate) mod bulk_ingest;
pub mod canonical;
pub mod commands;
pub mod composer_projection;
pub mod composer_scope;
pub mod cover_backfill;
pub mod cover_resolve;
pub mod cross_server;
pub mod dto;
pub mod enrichment;
pub mod filter;
pub mod genre_album_browse;
pub mod genre_tags;
pub mod genre_tags_backfill;
pub mod identity;
pub mod library_readiness;
pub mod live_search;
pub mod lossless_albums;
pub mod lossless_formats;
pub mod mainstage_browse;
pub mod mood_groups;
pub mod most_played;
pub mod orphan_cleanup;
pub mod payload;
#[cfg(test)]
mod perf_probe;
pub mod random_artists;
pub mod repos;
pub mod runtime;
pub mod scope_browse;
pub mod scope_merge;
pub mod search;
pub mod starred_browse;
pub mod statistics;
pub mod store;
pub mod sync;
pub(crate) mod track_fts;

pub use payload::{LibrarySyncIdlePayload, LibrarySyncProgressPayload};
pub use runtime::LibraryRuntime;

pub use store::{LibraryStore, LIBRARY_DB_SCHEMA_VERSION};

// Re-export logging facade so submodules can write `crate::app_eprintln!()`.
pub use psysonic_core::{app_deprintln, app_eprintln, logging};

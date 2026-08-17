//! Advanced Search SQL builder (spec §5.13). PR-5d ships the backend only —
//! the `SearchBrowsePage.tsx` UI wiring stays PR-7 (F2). Cross-server search
//! (§5.5B) lives in the sibling `cross_server` module.
//!
//! The builder turns a `LibraryAdvancedSearchRequest` into one parameterised
//! query per requested entity (track / album / artist), each sharing a WHERE
//! built from the `FilterFieldRegistry` resolution in `filter.rs`. Only
//! builder-supplied column expressions ever reach the SQL string; every value
//! is bound (§5.13.5: parameterised only).

mod album;
mod artist;
mod artist_tracks;
mod dispatch;
mod filters;
mod planner;
mod sql;
mod track;

pub use planner::run_advanced_search;

#[allow(unused_imports)]
pub(crate) use filters::{push_album_id_allowlist, resolve_clause, WhereBuilder};
#[allow(unused_imports)]
pub(crate) use sql::{
    album_order_from_track_groups, deduped_album_order_sql, deduped_artist_order_sql,
    deduped_track_order_sql, grouped_album_order_sql, order_clause, sort_column, trimmed_nonempty,
};

#[cfg(test)]
mod tests;

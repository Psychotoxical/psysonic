//! Candidate-first, cursor-paginated browse over ordered library scopes.
//!
//! Advanced Search remains responsible for FTS and arbitrary compound filters.
//! This module serves ordinary catalogue pages from materialized/indexed rows.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};

use crate::browse_support::overlay_album_artist_links;
use crate::dto::{
    LibraryAlbumDto, LibraryScopeBrowseEntity, LibraryScopeBrowseRequest,
    LibraryScopeBrowseResponse, LibraryScopePair, LibrarySortClause, LibraryTrackDto,
};
use crate::repos::{row_to_track_row, TrackRow};
use crate::scope_merge::TRACK_CLUSTER_PARTITION_KEY;
use crate::store::LibraryStore;

const CANDIDATE_PAGE_SIZE: usize = 64;

mod album;
mod track;

#[cfg(test)]
use track::{query_track_scope_candidates, track_identity_priorities};

fn scope_key(scopes: &[LibraryScopePair]) -> String {
    scopes
        .iter()
        .map(|scope| {
            format!(
                "{}\u{1f}{}",
                scope.server_id,
                scope.library_id.as_deref().unwrap_or("\u{0}")
            )
        })
        .collect::<Vec<_>>()
        .join("\u{1e}")
}

pub fn browse(
    store: &LibraryStore,
    request: &LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    crate::scope_merge::non_empty_scopes(&request.scopes)?;
    match request.entity {
        LibraryScopeBrowseEntity::Album => {
            if !crate::browse_projection::is_ready(store)? {
                return Err("scope browse projection is not ready".into());
            }
            album::browse_albums(store, request)
        }
        LibraryScopeBrowseEntity::Track => track::browse_tracks(store, request),
        LibraryScopeBrowseEntity::Artist => {
            Err("scope browse entity is not implemented yet".into())
        }
    }
}

#[cfg(test)]
#[path = "scope_browse/tests.rs"]
mod tests;

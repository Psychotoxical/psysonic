use std::collections::BTreeSet;

use serde_json::Value;

use super::album::build_album;
use super::artist::build_artist;
use super::dispatch::{run_advanced_search_layer1_scope, run_advanced_search_multi_scope};
use super::sql::{is_fast_random_track_sample, trimmed_nonempty};
use super::track::build_track;
use crate::dto::{
    multi_library_merge_enabled, ordered_library_scope_pairs, scoped_layer1_eligible,
    LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse, LibraryFilterClause,
    LibrarySearchTotals,
};
use crate::filter::{self, EntityKind};
use crate::search::{fts_query_meets_min_len, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

/// `library_advanced_search` (§5.13). Runs only the queries named in
/// `entityTypes`; absent entities return empty + zero totals.
pub fn run_advanced_search(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
) -> Result<LibraryAdvancedSearchResponse, String> {
    // `query` shorthand → text input; a `text` filter clause is an alias for
    // the same thing. Everything else is a scalar filter.
    let mut text_input: Option<String> = trimmed_nonempty(req.query.as_deref());
    let mut scalar: Vec<&LibraryFilterClause> = Vec::new();
    for c in &req.filters {
        if c.field == "text" {
            if text_input.is_none() {
                if let Some(Value::String(s)) = &c.value {
                    text_input = trimmed_nonempty(Some(s));
                }
            }
        } else {
            scalar.push(c);
        }
    }

    // Up-front validation: an unknown field or an op the registry doesn't
    // declare is an error regardless of entity routing (§5.13.5).
    for c in &scalar {
        let field = filter::lookup(&c.field)
            .ok_or_else(|| filter::FilterError::UnknownField(c.field.clone()).to_string())?;
        if !field.ops.contains(&c.op) {
            return Err(filter::FilterError::UnsupportedOp {
                field: c.field.clone(),
                op: c.op.as_str(),
            }
            .to_string());
        }
    }

    if text_input
        .as_deref()
        .is_some_and(|t| !fts_query_meets_min_len(t))
    {
        return Ok(LibraryAdvancedSearchResponse {
            artists: Vec::new(),
            albums: Vec::new(),
            tracks: Vec::new(),
            totals: LibrarySearchTotals {
                artists: 0,
                albums: 0,
                tracks: 0,
            },
            applied_filters: Vec::new(),
            source: "local".to_string(),
        });
    }

    let limit = req.limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = req.offset;
    let skip_totals = req.skip_totals;
    let scope_pairs = ordered_library_scope_pairs(
        &req.server_id,
        req.library_scope.as_deref(),
        req.library_scopes.as_deref(),
    )?;
    let single_scope_random_track = scope_pairs.len() == 1
        && req.entity_types.len() == 1
        && req.entity_types[0] == EntityKind::Track
        && is_fast_random_track_sample(req, text_input.as_deref(), &scalar, offset);
    // Any >1-library scope dedups album/artist rows via cluster keys, including
    // the Layer-1 same-server path — build keys first so dedup works on a cold
    // index (idempotent; only rebuilds when needed).
    if multi_library_merge_enabled(&scope_pairs) && !single_scope_random_track {
        crate::scope_merge::ensure_cluster_keys_for_scopes(store, &scope_pairs)?;
    }
    if scoped_layer1_eligible(&scope_pairs) && !single_scope_random_track {
        return run_advanced_search_layer1_scope(
            store,
            req,
            &scope_pairs,
            text_input,
            scalar,
            limit,
            offset,
            skip_totals,
        );
    }
    if multi_library_merge_enabled(&scope_pairs) && !single_scope_random_track {
        return run_advanced_search_multi_scope(
            store,
            req,
            &scope_pairs,
            text_input,
            scalar,
            limit,
            offset,
            skip_totals,
        );
    }

    let mut legacy = req.clone();
    legacy.library_scopes = None;
    if legacy.library_scope.is_none() {
        if let Some(pair) = scope_pairs.first() {
            legacy.library_scope = pair.library_id.clone();
        }
    }

    let text = text_input.as_deref();
    let want = |k: EntityKind| legacy.entity_types.contains(&k);
    let mut applied: BTreeSet<String> = BTreeSet::new();

    let (artists, artists_total) = if want(EntityKind::Artist) {
        build_artist(
            store,
            &legacy,
            text,
            &scalar,
            limit,
            offset,
            skip_totals,
            &mut applied,
        )?
    } else {
        (Vec::new(), 0)
    };
    let (albums, albums_total) = if want(EntityKind::Album) {
        build_album(
            store,
            &legacy,
            text,
            &scalar,
            limit,
            offset,
            skip_totals,
            &mut applied,
        )?
    } else {
        (Vec::new(), 0)
    };
    let (tracks, tracks_total) = if want(EntityKind::Track) {
        build_track(
            store,
            &legacy,
            text,
            &scalar,
            limit,
            offset,
            skip_totals,
            &mut applied,
        )?
    } else {
        (Vec::new(), 0)
    };

    Ok(LibraryAdvancedSearchResponse {
        artists,
        albums,
        tracks,
        totals: LibrarySearchTotals {
            artists: artists_total,
            albums: albums_total,
            tracks: tracks_total,
        },
        applied_filters: applied.into_iter().collect(),
        source: "local".to_string(),
    })
}

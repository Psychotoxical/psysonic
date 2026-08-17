use std::collections::BTreeSet;

use rusqlite::types::Value as SqlValue;

use super::artist::{build_artist_from_table, push_artist_letter_bucket};
use super::filters::{
    album_artist_credit_mode, multi_scope_track_filter_sql, resolve_clause,
    scalar_requires_track_derived_entities, WhereBuilder,
};
use super::sql::{
    deduped_album_order_sql, deduped_artist_order_sql, deduped_track_order_sql,
    grouped_album_order_sql, is_fast_random_track_sample, order_clause,
};
use crate::dto::{
    LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse, LibraryAlbumDto, LibraryArtistDto,
    LibraryFilterClause, LibraryScopePair, LibrarySearchTotals, LibraryTrackDto,
};
use crate::filter::EntityKind;
use crate::scope_merge;
use crate::search::{fts_track_prefix_match_query, like_contains_folded};
use crate::store::LibraryStore;

#[allow(clippy::too_many_arguments)]
pub(super) fn run_advanced_search_layer1_scope(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text_input: Option<String>,
    scalar: Vec<&LibraryFilterClause>,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<LibraryAdvancedSearchResponse, String> {
    let text = text_input.as_deref();
    let want = |k: EntityKind| req.entity_types.contains(&k);
    let mut applied: BTreeSet<String> = BTreeSet::new();

    let (artists, artists_total) = if want(EntityKind::Artist) {
        build_layer1_scope_artist(
            store,
            req,
            scopes,
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
        build_layer1_scope_album(
            store,
            req,
            scopes,
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
        build_layer1_scope_track(
            store,
            req,
            scopes,
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

#[allow(clippy::too_many_arguments)]
fn build_layer1_scope_album(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let (extra_where, extra_params) =
        multi_scope_track_filter_sql(store, req, scopes, text, scalar, None, applied)?;
    // Two shapes, two order clauses: the `GROUP BY t.album_id` branches need the
    // aggregates inside the sort key, the outer dedup subquery projects plain
    // columns. Sharing one string silently mis-sorted the grouped branches.
    let grouped_order = grouped_album_order_sql(&req.sort);
    let deduped_order = deduped_album_order_sql(&req.sort);
    let fast_browse = scopes.len() > 1 && skip_totals && extra_where.trim().is_empty();
    scope_merge::list_albums_layer1_filtered(
        store,
        scopes,
        &extra_where,
        &extra_params,
        &grouped_order,
        &deduped_order,
        limit,
        offset,
        skip_totals,
        !fast_browse,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_layer1_scope_artist(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    if !scalar_requires_track_derived_entities(scalar) {
        applied.insert("library_scope".to_string());
        if album_artist_credit_mode(req) {
            // #1209: album credit browses the `artist` table (album_count), scoped via tracks.
            return build_artist_from_table(
                store,
                req,
                Some(scopes),
                text,
                scalar,
                limit,
                offset,
                skip_totals,
                applied,
            );
        }
        // Track credit: performers from in-scope tracks (GROUP BY artist_id).
        let (extra_where, extra_params) = multi_scope_track_filter_sql(
            store,
            req,
            scopes,
            text,
            scalar,
            Some(EntityKind::Artist),
            applied,
        )?;
        let order = deduped_artist_order_sql(&req.sort);
        return scope_merge::list_artists_layer1_filtered(
            store,
            scopes,
            &extra_where,
            &extra_params,
            &order,
            limit,
            offset,
            skip_totals,
        );
    }
    let (extra_where, extra_params) = multi_scope_track_filter_sql(
        store,
        req,
        scopes,
        text,
        scalar,
        Some(EntityKind::Artist),
        applied,
    )?;
    let order = deduped_artist_order_sql(&req.sort);
    scope_merge::list_artists_layer1_filtered(
        store,
        scopes,
        &extra_where,
        &extra_params,
        &order,
        limit,
        offset,
        skip_totals,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_layer1_scope_track(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    if let Some(q) = text.and_then(fts_track_prefix_match_query) {
        applied.insert("text".to_string());
        let (extra_where, extra_params) =
            multi_scope_track_filter_sql(store, req, scopes, None, scalar, None, applied)?;
        return scope_merge::search_tracks_filtered(
            store,
            scopes,
            &q,
            &extra_where,
            &extra_params,
            limit,
            skip_totals,
        );
    }
    let (extra_where, extra_params) =
        multi_scope_track_filter_sql(store, req, scopes, text, scalar, None, applied)?;
    let order = order_clause(&req.sort, EntityKind::Track)
        .unwrap_or_else(|| "ORDER BY t.title COLLATE NOCASE ASC, t.id ASC".to_string());
    let bpm_resolved = scalar.iter().any(|c| c.field == "bpm");
    let random_window = is_fast_random_track_sample(req, text, scalar, offset);
    scope_merge::list_tracks_layer1_filtered(
        store,
        scopes,
        &extra_where,
        &extra_params,
        &order,
        limit,
        offset,
        skip_totals,
        bpm_resolved,
        random_window,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_advanced_search_multi_scope(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text_input: Option<String>,
    scalar: Vec<&LibraryFilterClause>,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<LibraryAdvancedSearchResponse, String> {
    let text = text_input.as_deref();
    let want = |k: EntityKind| req.entity_types.contains(&k);
    let mut applied: BTreeSet<String> = BTreeSet::new();

    let (artists, artists_total) = if want(EntityKind::Artist) {
        build_multi_scope_artist(
            store,
            req,
            scopes,
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
        build_multi_scope_album(
            store,
            req,
            scopes,
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
        build_multi_scope_track(
            store,
            req,
            scopes,
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

#[allow(clippy::too_many_arguments)]
fn build_multi_scope_album(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let (extra_where, extra_params) =
        multi_scope_track_filter_sql(store, req, scopes, text, scalar, None, applied)?;
    let order = deduped_album_order_sql(&req.sort);
    scope_merge::list_albums_filtered(
        store,
        scopes,
        &extra_where,
        &extra_params,
        &order,
        limit,
        offset,
        skip_totals,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_multi_scope_artist(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    if album_artist_credit_mode(req) && !scalar_requires_track_derived_entities(scalar) {
        applied.insert("library_scope".to_string());
        applied.insert("artist_credit_mode".to_string());
        let mut filter = WhereBuilder::new();
        if let Some(bucket) = req.artist_letter_bucket.as_deref() {
            push_artist_letter_bucket(&mut filter, bucket, applied);
        }
        if let Some(query) = text {
            filter.push_param(
                "ar.name_fold LIKE ? ESCAPE '\\'",
                SqlValue::Text(like_contains_folded(query)),
            );
            applied.insert("text".to_string());
        }
        for clause in scalar {
            if let Some(fragment) = resolve_clause(clause, EntityKind::Artist)? {
                applied.insert(clause.field.clone());
                filter.push(fragment);
            }
        }
        let order = deduped_artist_order_sql(&req.sort);
        return scope_merge::list_index_artists_multi_scope_album_filtered(
            store,
            scopes,
            &filter.where_sql(),
            filter.params(),
            &order,
            limit,
            offset,
            skip_totals,
        );
    }
    let (extra_where, extra_params) = multi_scope_track_filter_sql(
        store,
        req,
        scopes,
        text,
        scalar,
        Some(EntityKind::Artist),
        applied,
    )?;
    let order = deduped_artist_order_sql(&req.sort);
    scope_merge::list_artists_filtered(
        store,
        scopes,
        &extra_where,
        &extra_params,
        &order,
        limit,
        offset,
        skip_totals,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_multi_scope_track(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let bpm_resolved = scalar.iter().any(|c| c.field == "bpm");
    if let Some(q) = text.and_then(fts_track_prefix_match_query) {
        applied.insert("text".to_string());
        let (extra_where, extra_params) =
            multi_scope_track_filter_sql(store, req, scopes, None, scalar, None, applied)?;
        return scope_merge::search_tracks_filtered(
            store,
            scopes,
            &q,
            &extra_where,
            &extra_params,
            limit,
            skip_totals,
        );
    }
    let (extra_where, extra_params) =
        multi_scope_track_filter_sql(store, req, scopes, text, scalar, None, applied)?;
    let order = deduped_track_order_sql(&req.sort);
    let random_window = is_fast_random_track_sample(req, text, scalar, offset);
    scope_merge::list_tracks_filtered(
        store,
        scopes,
        &extra_where,
        &extra_params,
        &order,
        limit,
        offset,
        skip_totals,
        bpm_resolved,
        random_window,
    )
}

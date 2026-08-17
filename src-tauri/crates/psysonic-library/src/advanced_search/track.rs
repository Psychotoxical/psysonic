use std::collections::BTreeSet;

use rusqlite::types::Value as SqlValue;

use super::filters::{resolve_clause, WhereBuilder};
use super::sql::{
    fts_candidate_pool_size, is_fast_random_track_sample, order_clause, query_random_track_rows,
    query_rows, query_rows_fts, scoped_fts_pick_join_sql, scoped_fts_subquery_bind,
    trimmed_nonempty,
};
use crate::dto::{LibraryAdvancedSearchRequest, LibraryFilterClause, LibraryTrackDto};
use crate::filter::EntityKind;
use crate::repos;
use crate::search::{
    aliased_track_columns, aliased_track_columns_resolved_bpm, fts_track_prefix_match_query,
    library_scope_sargable_equals_sql,
};
use crate::store::LibraryStore;

#[allow(clippy::too_many_arguments)]
pub(super) fn build_track(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_sargable_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    if req.starred_only == Some(true) {
        w.push_raw("t.starred_at IS NOT NULL");
        applied.insert("starred".to_string());
    }

    let bpm_resolved = scalar.iter().any(|c| c.field == "bpm");
    let cols = if bpm_resolved {
        aliased_track_columns_resolved_bpm("t")
    } else {
        aliased_track_columns("t")
    };
    let map_track = if bpm_resolved {
        map_track_row_resolved_bpm
    } else {
        map_track_row_default
    };
    if let Some(q) = text.and_then(fts_track_prefix_match_query) {
        applied.insert("text".to_string());
        let pool = fts_candidate_pool_size(limit, offset);
        let scope = trimmed_nonempty(req.library_scope.as_deref());
        let from = scoped_fts_pick_join_sql(pool, scope.as_deref());
        let order = order_clause(&req.sort, EntityKind::Track)
            .unwrap_or_else(|| "ORDER BY fts_pick.fts_rank".to_string());
        return query_rows_fts(
            store,
            &cols,
            &from,
            &q,
            &scoped_fts_subquery_bind(&req.server_id, scope.as_deref()),
            &w,
            &order,
            limit,
            offset,
            skip_totals,
            map_track,
        );
    }

    if is_fast_random_track_sample(req, text, scalar, offset) {
        return query_random_track_rows(store, &cols, &w, limit, map_track);
    }

    let order = order_clause(&req.sort, EntityKind::Track)
        .unwrap_or_else(|| "ORDER BY t.title COLLATE NOCASE ASC, t.id ASC".to_string());
    query_rows(
        store,
        &cols,
        "track t",
        &w,
        &order,
        limit,
        offset,
        skip_totals,
        map_track,
    )
}

fn map_track_row_default(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrackDto> {
    repos::row_to_track_row(row).map(|r| LibraryTrackDto::from_row(&r))
}

fn map_track_row_resolved_bpm(row: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryTrackDto> {
    crate::search::row_to_track_dto_resolved_bpm(row)
}

use std::collections::{BTreeSet, HashSet};

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::filters::{
    album_artist_credit_mode, push_artist_track_letter_bucket, resolve_clause, WhereBuilder,
};
use super::sql::{
    order_clause, query_grouped_rows, scoped_fts_rowid_subquery_sql, scoped_fts_subquery_bind,
    trimmed_nonempty,
};
use crate::dto::{LibraryAdvancedSearchRequest, LibraryArtistDto, LibraryFilterClause};
use crate::filter::EntityKind;
use crate::search::{library_scope_sargable_equals_sql, like_contains_folded};
use crate::store::LibraryStore;

/// Artist browse for a single scoped library — one `GROUP BY artist_id` over
/// in-scope tracks (COALESCE/json `library_id` match), with `artist` table
/// metadata when present.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
fn build_artist_from_tracks_scoped(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.artist_id IS NOT NULL AND t.artist_id != ''");
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_sargable_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
        applied.insert("library_scope".to_string());
    }
    if album_artist_credit_mode(req) {
        w.push_raw(
            "EXISTS (SELECT 1 FROM artist ar WHERE ar.server_id = t.server_id \
             AND ar.id = t.artist_id AND ar.album_count IS NOT NULL)",
        );
        applied.insert("artist_credit_mode".to_string());
    }
    if let Some(bucket) = req.artist_letter_bucket.as_deref() {
        push_artist_track_letter_bucket(&mut w, bucket, applied);
    }
    if let Some(t) = text {
        w.push_param(
            "t.artist LIKE ? ESCAPE '\\'",
            SqlValue::Text(like_contains_folded(t)),
        );
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let artist_name = "MAX(COALESCE((SELECT ar.name FROM artist ar \
        WHERE ar.server_id = t.server_id AND ar.id = t.artist_id), t.artist))";
    let select = format!(
        "t.server_id, t.artist_id, {artist_name}, COUNT(DISTINCT t.album_id), MAX(t.synced_at)"
    );
    let order = order_clause(&req.sort, EntityKind::Artist)
        .map(|s| {
            s.replace("COALESCE(ar.name_sort, ar.name)", artist_name)
                .replace("ar.id", "t.artist_id")
        })
        .unwrap_or_else(|| format!("ORDER BY {artist_name} COLLATE NOCASE ASC, t.artist_id ASC"));
    query_grouped_rows(
        store,
        &select,
        "track t",
        &w,
        "GROUP BY t.artist_id",
        &order,
        limit,
        offset,
        skip_totals,
        map_artist_from_tracks,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_artist_from_tracks(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.artist_id IS NOT NULL AND t.artist_id != ''");
    w.push_raw(
        "NOT EXISTS (SELECT 1 FROM artist ar WHERE ar.server_id = t.server_id AND ar.id = t.artist_id)",
    );
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_sargable_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    if let Some(t) = text {
        w.push_param(
            "t.artist LIKE ? ESCAPE '\\'",
            SqlValue::Text(like_contains_folded(t)),
        );
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let select =
        "t.server_id, t.artist_id, MAX(t.artist), COUNT(DISTINCT t.album_id), MAX(t.synced_at)";
    let order = order_clause(&req.sort, EntityKind::Artist).unwrap_or_else(|| {
        "ORDER BY MAX(t.artist) COLLATE NOCASE ASC, t.artist_id ASC".to_string()
    });
    query_grouped_rows(
        store,
        select,
        "track t",
        &w,
        "GROUP BY t.artist_id",
        &order,
        limit,
        offset,
        skip_totals,
        map_artist_from_tracks,
    )
}

/// Text search for artists when the `artist` table is empty — FTS + dedupe.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_artist_from_fts(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    fts: &str,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    applied.insert("text".to_string());
    let need = limit.saturating_add(offset) as i64;
    let pool = (need.saturating_mul(8)).clamp(64, 2_000);
    let scope = trimmed_nonempty(req.library_scope.as_deref());

    let mut w = WhereBuilder::new();
    w.push_params(
        &format!(
            "t.rowid IN ({})",
            scoped_fts_rowid_subquery_sql(pool, scope.as_deref())
        ),
        {
            let mut p = vec![SqlValue::Text(fts.to_string())];
            p.extend(scoped_fts_subquery_bind(&req.server_id, scope.as_deref()));
            p
        },
    );
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    w.push_raw("t.artist_id IS NOT NULL AND t.artist_id != ''");
    if let Some(scope) = scope {
        let clause = library_scope_sargable_equals_sql("t");
        w.push_param(&clause, SqlValue::Text(scope));
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Track)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT t.server_id, t.artist_id, t.artist, t.synced_at \
             FROM track t \
             WHERE {where_sql}"
        );
        let params = w.params.clone();
        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<(String, String, Option<String>, i64)> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut seen = HashSet::new();
        let mut deduped: Vec<LibraryArtistDto> = Vec::new();
        for (server_id, artist_id, artist, synced_at) in rows {
            if !seen.insert(artist_id.clone()) {
                continue;
            }
            let name = artist.unwrap_or_default();
            let name_sort = crate::artist_sort::sort_key_for_display_name(
                &name,
                crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
            );
            deduped.push(LibraryArtistDto {
                server_id,
                id: artist_id,
                name,
                name_sort: Some(name_sort),
                album_count: None,
                synced_at,
                raw_json: Value::Null,
            });
            if deduped.len() >= need as usize {
                break;
            }
        }

        let total = if skip_totals { 0 } else { deduped.len() as u32 };
        let page = deduped
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();
        Ok((page, total))
    })
}

fn map_artist_from_tracks(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    let name: String = r.get(2)?;
    let name_sort = crate::artist_sort::sort_key_for_display_name(
        &name,
        crate::artist_sort::DEFAULT_IGNORED_ARTICLES,
    );
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name,
        name_sort: Some(name_sort),
        album_count: Some(r.get(3)?),
        synced_at: r.get(4)?,
        raw_json: Value::Null,
    })
}

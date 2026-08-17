use std::collections::BTreeSet;

use super::artist_tracks::{build_artist_from_fts, build_artist_from_tracks};
use super::filters::{
    album_artist_credit_mode, resolve_clause, scalar_requires_track_derived_entities, WhereBuilder,
};
use super::sql::{order_clause, parse_raw_json, query_rows};
use crate::dto::{
    ordered_library_scope_pairs, LibraryAdvancedSearchRequest, LibraryArtistDto,
    LibraryFilterClause, LibraryScopePair,
};
use crate::filter::EntityKind;
use crate::scope_merge;
use crate::search::{
    fts_column_prefix_query, library_scope_in_sql, library_scope_sargable_equals_sql,
    like_contains_folded,
};
use crate::store::LibraryStore;
use rusqlite::types::Value as SqlValue;

const ARTIST_COLUMNS: &str = "ar.server_id, ar.id, ar.name, ar.name_sort, ar.album_count, \
  ar.synced_at, ar.raw_json";

/// Letter bucket filter on `name_sort` (articles already stripped in column).
pub(super) fn push_artist_letter_bucket(
    w: &mut WhereBuilder,
    bucket: &str,
    applied: &mut BTreeSet<String>,
) {
    if bucket.is_empty() || bucket.eq_ignore_ascii_case("ALL") {
        return;
    }
    let col = "COALESCE(ar.name_sort, ar.name)";
    match bucket {
        "#" => {
            w.push_raw(&format!("SUBSTR({col}, 1, 1) GLOB '[0-9]'"));
        }
        "OTHER" => {
            w.push_raw(&format!(
                "LENGTH({col}) > 0 \
                 AND SUBSTR({col}, 1, 1) NOT GLOB '[0-9]' \
                 AND LOWER(SUBSTR({col}, 1, 1)) NOT GLOB '[a-z]'"
            ));
        }
        letter if letter.len() == 1 => {
            let Some(ch) = letter.chars().next() else {
                return;
            };
            if !ch.is_ascii_alphabetic() {
                return;
            }
            let lower = ch.to_ascii_lowercase().to_string();
            w.push_param(
                &format!("LOWER(SUBSTR({col}, 1, 1)) = ?"),
                SqlValue::Text(lower),
            );
        }
        _ => return,
    }
    applied.insert("letter".to_string());
}

/// `artist` rows are server-wide; narrow to artists with tracks in the active scope.
fn push_artist_library_scope_pairs(
    w: &mut WhereBuilder,
    _server_id: &str,
    pairs: &[LibraryScopePair],
    applied: &mut BTreeSet<String>,
) {
    // A whole-server pair needs no additional predicate because this query is
    // already pinned to `ar.server_id`. Empty-string ids remain exact scopes.
    if pairs.iter().any(|pair| pair.library_id.is_none()) {
        return;
    }
    let scoped: Vec<&String> = pairs
        .iter()
        .filter_map(|pair| pair.library_id.as_ref())
        .collect();
    if scoped.is_empty() {
        return;
    }
    let exists_prefix = "EXISTS (SELECT 1 FROM track t WHERE t.server_id = ar.server_id \
        AND t.deleted = 0 AND t.artist_id = ar.id AND ";
    if scoped.len() == 1 {
        let clause = library_scope_sargable_equals_sql("t");
        w.push_params(
            &format!("{exists_prefix}{clause})"),
            vec![SqlValue::Text(scoped[0].to_string())],
        );
    } else {
        let in_clause = library_scope_in_sql("t", scoped.len());
        w.push_params(
            &format!("{exists_prefix}{in_clause})"),
            scoped
                .iter()
                .map(|library_id| SqlValue::Text((*library_id).clone()))
                .collect(),
        );
    }
    applied.insert("library_scope".to_string());
}

fn push_artist_library_scope(
    w: &mut WhereBuilder,
    req: &LibraryAdvancedSearchRequest,
    applied: &mut BTreeSet<String>,
) -> Result<(), String> {
    let pairs = ordered_library_scope_pairs(
        &req.server_id,
        req.library_scope.as_deref(),
        req.library_scopes.as_deref(),
    )?;
    push_artist_library_scope_pairs(w, &req.server_id, &pairs, applied);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_artist(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    // #1209: album/track credit modes browse the `artist` table — not track GROUP BY.
    if !scalar_requires_track_derived_entities(scalar) {
        return build_artist_from_table(
            store,
            req,
            None,
            text,
            scalar,
            limit,
            offset,
            skip_totals,
            applied,
        );
    }
    if let Some(q) = text.and_then(|t| fts_column_prefix_query("artist", t)) {
        return build_artist_from_fts(store, req, &q, scalar, limit, offset, skip_totals, applied);
    }
    build_artist_from_tracks(
        store,
        req,
        text,
        scalar,
        limit,
        offset,
        skip_totals,
        applied,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn build_artist_from_table(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scope_pairs: Option<&[LibraryScopePair]>,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    skip_totals: bool,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    if let Some(pairs) = scope_pairs {
        if !pairs.is_empty() {
            applied.insert("library_scope".to_string());
            let mut filter = WhereBuilder::new();
            if let Some(bucket) = req.artist_letter_bucket.as_deref() {
                push_artist_letter_bucket(&mut filter, bucket, applied);
            }
            if let Some(t) = text {
                filter.push_param(
                    "COALESCE(ar.name_sort, ar.name) LIKE ? ESCAPE '\\'",
                    SqlValue::Text(like_contains_folded(t)),
                );
                applied.insert("text".to_string());
            }
            for c in scalar {
                if let Some(frag) = resolve_clause(c, EntityKind::Artist)? {
                    applied.insert(c.field.clone());
                    filter.push(frag);
                }
            }
            if album_artist_credit_mode(req) {
                applied.insert("artist_credit_mode".to_string());
            }
            let order = order_clause(&req.sort, EntityKind::Artist).unwrap_or_else(|| {
                "ORDER BY COALESCE(ar.name_sort, ar.name) COLLATE NOCASE ASC, ar.id ASC".to_string()
            });
            return scope_merge::list_index_artists_layer1_filtered(
                store,
                &req.server_id,
                pairs,
                album_artist_credit_mode(req),
                &filter.where_sql(),
                filter.params(),
                &order,
                limit,
                offset,
                skip_totals,
            );
        }
    }
    let mut w = WhereBuilder::new();
    w.push_param("ar.server_id = ?", SqlValue::Text(req.server_id.clone()));
    push_artist_library_scope(&mut w, req, applied)?;
    if album_artist_credit_mode(req) {
        w.push_raw("ar.album_count IS NOT NULL");
        applied.insert("artist_credit_mode".to_string());
    }
    if let Some(bucket) = req.artist_letter_bucket.as_deref() {
        push_artist_letter_bucket(&mut w, bucket, applied);
    }
    if let Some(t) = text {
        // Match `name_sort` (Unicode lowercase from sync) so Cyrillic and other
        // non-ASCII names are case-insensitive; COALESCE covers pre-014 rows.
        w.push_param(
            "COALESCE(ar.name_sort, ar.name) LIKE ? ESCAPE '\\'",
            SqlValue::Text(like_contains_folded(t)),
        );
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Artist)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    let order = order_clause(&req.sort, EntityKind::Artist).unwrap_or_else(|| {
        "ORDER BY COALESCE(ar.name_sort, ar.name) COLLATE NOCASE ASC, ar.id ASC".to_string()
    });
    query_rows(
        store,
        ARTIST_COLUMNS,
        "artist ar",
        &w,
        &order,
        limit,
        offset,
        skip_totals,
        map_artist,
    )
}

fn map_artist(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    let raw: Option<String> = r.get(6)?;
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        name_sort: r.get(3)?,
        album_count: r.get(4)?,
        synced_at: r.get(5)?,
        raw_json: parse_raw_json(raw),
    })
}

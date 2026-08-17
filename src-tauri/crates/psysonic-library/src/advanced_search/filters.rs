use std::collections::BTreeSet;

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::sql::{fts_album_text_match_query, fts_candidate_pool_size};
use crate::dto::{
    ArtistCreditMode, LibraryAdvancedSearchRequest, LibraryFilterClause, LibraryScopePair,
};
use crate::filter::{self, EntityKind, FilterOp, SqlFragment};
use crate::scope_merge::collect_scope_fts_rowids;
use crate::search::{
    bpm_resolved_expr, fts_column_prefix_query, like_contains, like_contains_folded,
};
use crate::store::LibraryStore;

/// `bpm` dual-storage resolution (§5.13.4): prefer analysis `track_fact(bpm)`,
/// then hot `track.bpm` tag, then other fact sources.
fn bpm_resolved_sql() -> String {
    bpm_resolved_expr("t")
}

pub(super) fn album_artist_credit_mode(req: &LibraryAdvancedSearchRequest) -> bool {
    !matches!(req.artist_credit_mode, Some(ArtistCreditMode::Track))
}

/// Letter bucket filter on track performer name (multi-scope artist browse).
pub(super) fn push_artist_track_letter_bucket(
    w: &mut WhereBuilder,
    bucket: &str,
    applied: &mut BTreeSet<String>,
) {
    if bucket.is_empty() || bucket.eq_ignore_ascii_case("ALL") {
        return;
    }
    let col = "t.artist";
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

#[allow(clippy::too_many_arguments)]
pub(super) fn multi_scope_track_filter_sql(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    scopes: &[LibraryScopePair],
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    text_entity: Option<EntityKind>,
    applied: &mut BTreeSet<String>,
) -> Result<(String, Vec<SqlValue>), String> {
    let mut w = WhereBuilder::new();
    if text_entity == Some(EntityKind::Artist) {
        if album_artist_credit_mode(req) {
            w.push_raw(
                "EXISTS (SELECT 1 FROM artist ar \
                 WHERE ar.server_id = t.server_id AND ar.id = t.artist_id AND ar.album_count IS NOT NULL)",
            );
            applied.insert("artist_credit_mode".to_string());
        }
        if let Some(bucket) = req.artist_letter_bucket.as_deref() {
            push_artist_track_letter_bucket(&mut w, bucket, applied);
        }
    }
    if let Some(t) = text {
        match text_entity {
            Some(EntityKind::Artist) => {
                if let Some(fts) = fts_column_prefix_query("artist", t) {
                    let pool = fts_candidate_pool_size(req.limit, req.offset);
                    let rowids = store.with_read_conn(|conn| {
                        collect_scope_fts_rowids(conn, &fts, scopes, pool)
                    })?;
                    if rowids.is_empty() {
                        w.push_raw("1 = 0");
                    } else {
                        let placeholders = std::iter::repeat_n("?", rowids.len())
                            .collect::<Vec<_>>()
                            .join(", ");
                        w.push_params(
                            &format!("t.rowid IN ({placeholders})"),
                            rowids.into_iter().map(SqlValue::Integer).collect(),
                        );
                    }
                } else {
                    w.push_param(
                        "t.artist LIKE ? ESCAPE '\\'",
                        SqlValue::Text(like_contains_folded(t)),
                    );
                }
                applied.insert("text".to_string());
            }
            Some(EntityKind::Album) | None => {
                if let Some(fts) = fts_album_text_match_query(req, t) {
                    let pool = fts_candidate_pool_size(req.limit, req.offset);
                    let rowids = store.with_read_conn(|conn| {
                        collect_scope_fts_rowids(conn, &fts, scopes, pool)
                    })?;
                    if rowids.is_empty() {
                        w.push_raw("1 = 0");
                    } else {
                        let placeholders = std::iter::repeat_n("?", rowids.len())
                            .collect::<Vec<_>>()
                            .join(", ");
                        w.push_params(
                            &format!("t.rowid IN ({placeholders})"),
                            rowids.into_iter().map(SqlValue::Integer).collect(),
                        );
                    }
                    applied.insert("text".to_string());
                } else {
                    w.push_param(
                        "t.album LIKE ? ESCAPE '\\'",
                        SqlValue::Text(like_contains(t)),
                    );
                    applied.insert("text".to_string());
                }
            }
            _ => {}
        }
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
    push_album_id_allowlist(
        &mut w,
        "t.album_id",
        req.restrict_album_ids.as_deref(),
        applied,
    );
    Ok((w.where_sql(), w.params().to_vec()))
}

/// Track-only filters that require joining through `track` (mood enrichment facts).
/// Other track-only fields (e.g. `bpm`) are skipped silently on album/artist queries.
pub(super) fn scalar_requires_track_derived_entities(scalar: &[&LibraryFilterClause]) -> bool {
    scalar
        .iter()
        .any(|c| matches!(c.field.as_str(), "mood_group" | "mood_tag"))
}

/// Lossless is defined on track `suffix`; year/genre filters must apply to the
/// same track rows, not stale `album` table metadata.
pub(super) fn scalar_requires_lossless_track_grouping(scalar: &[&LibraryFilterClause]) -> bool {
    scalar.iter().any(|c| c.field == "lossless")
}

/// Resolve one scalar clause to a WHERE fragment for `entity`. `Ok(None)`
/// means the field is known but doesn't route to this entity (§5.13.3 skip).
pub(crate) fn resolve_clause(
    c: &LibraryFilterClause,
    entity: EntityKind,
) -> Result<Option<SqlFragment>, String> {
    let applies = filter::validate_for_entity(&c.field, c.op, entity).map_err(|e| e.to_string())?;
    if !applies {
        return Ok(None);
    }
    if c.field == "bpm" && entity == EntityKind::Track {
        let col = bpm_resolved_sql();
        let value = json_to_opt_i64(&c.field, c.value.as_ref())?;
        let value_to = json_to_opt_i64(&c.field, c.value_to.as_ref())?;
        return filter::compare_fragment(&c.field, &col, c.op, value, value_to)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    let col = match (c.field.as_str(), entity) {
        ("genre", EntityKind::Track) => "t.genre",
        ("genre", EntityKind::Album) => "a.genre",
        ("year", EntityKind::Track) => "t.year",
        ("year", EntityKind::Album) => "a.year",
        ("starred", EntityKind::Track) => "t.starred_at",
        ("starred", EntityKind::Album) => "a.starred_at",
        // `artist` has no `starred_at` column — favorites use the network list.
        ("starred", EntityKind::Artist) => return Ok(None),
        ("mood_group" | "mood_tag", EntityKind::Track) => {
            return crate::advanced_search_mood::resolve_mood_clause(c);
        }
        ("lossless", EntityKind::Track) => {
            return Ok(Some(SqlFragment {
                sql: crate::lossless_formats::track_is_lossless_sql("t"),
                params: vec![],
            }));
        }
        ("lossless", EntityKind::Album) => {
            return Ok(Some(SqlFragment {
                sql: crate::lossless_formats::album_has_lossless_track_sql("a"),
                params: vec![],
            }));
        }
        ("lossless", EntityKind::Artist) => {
            return Ok(Some(SqlFragment {
                sql: crate::lossless_formats::artist_has_lossless_track_sql("ar"),
                params: vec![],
            }));
        }
        ("compilation", EntityKind::Album) => {
            return compilation_filter_fragment(
                &c.field,
                c.op,
                c.value.as_ref(),
                EntityKind::Album,
            );
        }
        ("compilation", EntityKind::Track) => {
            return compilation_filter_fragment(
                &c.field,
                c.op,
                c.value.as_ref(),
                EntityKind::Track,
            );
        }
        ("compilation", _) => return Ok(None),
        // `text` is handled by the entity builder (FTS / LIKE), never here.
        ("text", _) => return Ok(None),
        // Registered but no v1 SQL builder (user_rating / suffix / bit_rate).
        _ => return Err(filter::FilterError::NotQueryable(c.field.clone()).to_string()),
    };

    if c.field == "genre" {
        let v = json_to_text(&c.field, c.value.as_ref())?;
        let sql = match entity {
            EntityKind::Track => "EXISTS (SELECT 1 FROM track_genre tg \
                 WHERE tg.server_id = t.server_id AND tg.track_id = t.id \
                   AND tg.genre = ? COLLATE NOCASE)"
                .to_string(),
            EntityKind::Album => "EXISTS (SELECT 1 FROM track_genre tg \
                 WHERE tg.server_id = a.server_id AND tg.album_id = a.id \
                   AND tg.genre = ? COLLATE NOCASE)"
                .to_string(),
            _ => {
                return Err(filter::FilterError::NotQueryable(c.field.clone()).to_string());
            }
        };
        return Ok(Some(SqlFragment {
            sql,
            params: vec![v],
        }));
    }
    if c.field == "starred" {
        return filter::compare_fragment(&c.field, col, FilterOp::IsTrue, None, None)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    // Numeric fields: year / bpm.
    let value = json_to_opt_i64(&c.field, c.value.as_ref())?;
    let value_to = json_to_opt_i64(&c.field, c.value_to.as_ref())?;
    filter::compare_fragment(&c.field, col, c.op, value, value_to)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Restrict album browse to an explicit id set (server favorites ∩ local filters).
pub(crate) fn push_album_id_allowlist(
    w: &mut WhereBuilder,
    column: &str,
    ids: Option<&[String]>,
    applied: &mut BTreeSet<String>,
) {
    let Some(ids) = ids else {
        return;
    };
    applied.insert("albumIds".to_string());
    if ids.is_empty() {
        w.push_raw("1 = 0");
        return;
    }
    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("{column} IN ({placeholders})");
    let params = ids.iter().map(|id| SqlValue::Text(id.clone())).collect();
    w.push_params(&sql, params);
}

/// Accumulates `AND`-joined WHERE clauses and their positional params in
/// lockstep so anonymous `?` placeholders bind left-to-right.
pub(crate) struct WhereBuilder {
    pub(super) clauses: Vec<String>,
    pub(super) params: Vec<SqlValue>,
}

impl WhereBuilder {
    pub(crate) fn new() -> Self {
        Self {
            clauses: Vec::new(),
            params: Vec::new(),
        }
    }
    pub(crate) fn push(&mut self, frag: SqlFragment) {
        self.clauses.push(frag.sql);
        self.params.extend(frag.params);
    }
    pub(crate) fn push_raw(&mut self, sql: &str) {
        self.clauses.push(sql.to_string());
    }
    pub(crate) fn push_param(&mut self, sql: &str, param: SqlValue) {
        self.clauses.push(sql.to_string());
        self.params.push(param);
    }
    pub(crate) fn push_params(&mut self, sql: &str, params: Vec<SqlValue>) {
        self.clauses.push(sql.to_string());
        self.params.extend(params);
    }
    pub(crate) fn where_sql(&self) -> String {
        self.clauses.join(" AND ")
    }
    pub(crate) fn params(&self) -> &[SqlValue] {
        &self.params
    }
}

fn compilation_filter_fragment(
    field: &str,
    op: FilterOp,
    value: Option<&Value>,
    kind: EntityKind,
) -> Result<Option<SqlFragment>, String> {
    let comp_sql = match kind {
        EntityKind::Album => {
            crate::album_compilation_filter::compilation_predicate_sql("a", Some("a.artist"), None)
        }
        EntityKind::Track => crate::album_compilation_filter::compilation_predicate_sql(
            "t",
            Some("t.artist"),
            Some("t.album_artist"),
        ),
        _ => crate::album_compilation_filter::compilation_raw_json_sql("t"),
    };
    match op {
        FilterOp::IsTrue => Ok(Some(SqlFragment {
            sql: comp_sql,
            params: vec![],
        })),
        FilterOp::Eq => {
            let want_comp = json_to_bool(field, value)?;
            let sql = if want_comp {
                comp_sql
            } else {
                format!("NOT ({comp_sql})")
            };
            Ok(Some(SqlFragment {
                sql,
                params: vec![],
            }))
        }
        _ => Err(filter::FilterError::UnsupportedOp {
            field: field.to_string(),
            op: op.as_str(),
        }
        .to_string()),
    }
}

fn json_to_bool(field: &str, v: Option<&Value>) -> Result<bool, String> {
    match v {
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::Number(n)) => Ok(n.as_i64() == Some(1)),
        Some(Value::String(s)) => Ok(matches!(s.as_str(), "1" | "true" | "TRUE")),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected boolean".to_string(),
        }
        .to_string()),
    }
}

fn json_to_text(field: &str, v: Option<&Value>) -> Result<SqlValue, String> {
    match v {
        Some(Value::String(s)) => Ok(SqlValue::Text(s.clone())),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected a string value".to_string(),
        }
        .to_string()),
    }
}

fn json_to_opt_i64(field: &str, v: Option<&Value>) -> Result<Option<SqlValue>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(|i| Some(SqlValue::Integer(i)))
            .ok_or_else(|| {
                filter::FilterError::BadValue {
                    field: field.to_string(),
                    detail: "expected an integer value".to_string(),
                }
                .to_string()
            }),
        _ => Err(filter::FilterError::BadValue {
            field: field.to_string(),
            detail: "expected a numeric value".to_string(),
        }
        .to_string()),
    }
}

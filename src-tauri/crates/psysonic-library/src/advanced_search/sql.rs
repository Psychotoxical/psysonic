use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::filters::WhereBuilder;
use crate::album_compilation_filter::sql_display_artist_from;
use crate::dto::{LibraryAdvancedSearchRequest, LibraryFilterClause, LibrarySortClause, SortDir};
use crate::filter::EntityKind;
use crate::search::{
    fts_album_prefix_match_query, fts_album_title_prefix_match_query,
    library_scope_sargable_equals_sql,
};
use crate::store::LibraryStore;

pub(super) fn fts_candidate_pool_size(limit: u32, offset: u32) -> i64 {
    let need = limit.saturating_add(offset) as i64;
    need.saturating_mul(20).clamp(256, 10_000)
}

/// FTS rowid pick scoped to the active server (and optional library folder).
/// FTS-first `EXISTS` (never `JOIN track … ORDER BY bm25`), matching the fast
/// single-server path in `search.rs`: FTS stays the driving table and the
/// server/scope predicates are a correlated existence check on the hot
/// (backfilled) `library_id` column — no row widening before the bm25 sort.
pub(super) fn scoped_fts_rowid_subquery_sql(pool: i64, library_scope: Option<&str>) -> String {
    let alias = "t_fts";
    let mut scope_sql = String::new();
    if library_scope.is_some() {
        scope_sql = format!(" AND {}", library_scope_sargable_equals_sql(alias));
    }
    format!(
        "SELECT f.rowid FROM track_fts f \
         WHERE track_fts MATCH ? \
           AND EXISTS (\
             SELECT 1 FROM track {alias} \
             WHERE {alias}.rowid = f.rowid \
               AND {alias}.server_id = ? \
               AND {alias}.deleted = 0{scope_sql}\
           ) \
         ORDER BY bm25(track_fts) LIMIT {pool}"
    )
}

pub(super) fn scoped_fts_pick_join_sql(pool: i64, library_scope: Option<&str>) -> String {
    let alias = "t_fts";
    let mut scope_sql = String::new();
    if library_scope.is_some() {
        scope_sql = format!(" AND {}", library_scope_sargable_equals_sql(alias));
    }
    format!(
        "track t INNER JOIN (\
           SELECT f.rowid, bm25(track_fts) AS fts_rank \
           FROM track_fts f \
           WHERE track_fts MATCH ? \
             AND EXISTS (\
               SELECT 1 FROM track {alias} \
               WHERE {alias}.rowid = f.rowid \
                 AND {alias}.server_id = ? \
                 AND {alias}.deleted = 0{scope_sql}\
             ) \
           ORDER BY fts_rank \
           LIMIT {pool}\
         ) fts_pick ON t.rowid = fts_pick.rowid"
    )
}

pub(super) fn scoped_fts_subquery_bind(
    server_id: &str,
    library_scope: Option<&str>,
) -> Vec<SqlValue> {
    let mut params = vec![SqlValue::Text(server_id.to_string())];
    if let Some(scope) = library_scope.filter(|s| !s.trim().is_empty()) {
        params.push(SqlValue::Text(scope.to_string()));
    }
    params
}

pub(super) fn fts_album_text_match_query(
    req: &LibraryAdvancedSearchRequest,
    text: &str,
) -> Option<String> {
    if req.query_album_title_only == Some(true) {
        fts_album_title_prefix_match_query(text)
    } else {
        fts_album_prefix_match_query(text)
    }
}

/// Cap full-table FTS counts — exact totals on 100k+ hits are not worth
/// blocking the UI for tens of seconds (§5.9 p95 budget).
const FTS_MATCH_COUNT_CAP: i64 = 10_001;

fn count_matching_rows(
    conn: &rusqlite::Connection,
    from: &str,
    where_sql: &str,
    params: &[SqlValue],
    skip_totals: bool,
) -> Result<u32, rusqlite::Error> {
    if skip_totals {
        return Ok(0);
    }
    if from.contains("track_fts") {
        let mut bound: Vec<SqlValue> = params.to_vec();
        bound.push(SqlValue::Integer(FTS_MATCH_COUNT_CAP));
        let count_sql =
            format!("SELECT COUNT(*) FROM (SELECT 1 FROM {from} WHERE {where_sql} LIMIT ?)");
        let n: i64 = conn.query_row(&count_sql, rusqlite::params_from_iter(bound.iter()), |r| {
            r.get(0)
        })?;
        return Ok(n.max(0) as u32);
    }
    let count_sql = format!("SELECT COUNT(*) FROM {from} WHERE {where_sql}");
    let n: i64 = conn.query_row(&count_sql, rusqlite::params_from_iter(params.iter()), |r| {
        r.get(0)
    })?;
    Ok(n.max(0) as u32)
}

/// Run the COUNT (full match total) + the paged SELECT in one connection
/// borrow. Both share `where`'s params; the page appends `LIMIT ? OFFSET ?`.
#[allow(clippy::too_many_arguments)]
pub(super) fn query_rows<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    w: &WhereBuilder,
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let total = count_matching_rows(conn, from, &where_sql, &w.params, skip_totals)?;

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        let mut page_params: Vec<SqlValue> = w.params.clone();
        page_params.push(SqlValue::Integer(limit as i64));
        page_params.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        let collected: rusqlite::Result<Vec<T>> = stmt
            .query_map(rusqlite::params_from_iter(page_params.iter()), |r| map(r))?
            .collect();
        let rows = collected?;
        Ok((rows, total))
    })
}

pub(super) fn query_random_track_rows<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    w: &WhereBuilder,
    limit: u32,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T> + Copy,
{
    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let bounds_sql =
            format!("SELECT MIN(t.rowid), MAX(t.rowid) FROM track t WHERE {where_sql}");
        let (min_rowid, max_rowid): (Option<i64>, Option<i64>) = conn.query_row(
            &bounds_sql,
            rusqlite::params_from_iter(w.params.iter()),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let (Some(min_rowid), Some(max_rowid)) = (min_rowid, max_rowid) else {
            return Ok((Vec::new(), 0));
        };
        let pivot = random_rowid_pivot(min_rowid, max_rowid);

        let collect = |comparison: &str, pivot: i64, page_limit: u32| -> rusqlite::Result<Vec<T>> {
            let page_sql = format!(
                "SELECT {select_cols} FROM track t WHERE {where_sql} \
                 AND t.rowid {comparison} ? ORDER BY t.rowid LIMIT ?"
            );
            let mut page_params: Vec<SqlValue> = w.params.clone();
            page_params.push(SqlValue::Integer(pivot));
            page_params.push(SqlValue::Integer(i64::from(page_limit)));
            let mut stmt = conn.prepare(&page_sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(page_params.iter()), |row| {
                    map(row)
                })?
                .collect::<rusqlite::Result<Vec<T>>>()?;
            Ok(rows)
        };

        let mut rows = collect(">=", pivot, limit)?;
        if rows.len() < limit as usize {
            let remaining = limit.saturating_sub(rows.len() as u32);
            rows.extend(collect("<", pivot, remaining)?);
        }
        Ok((rows, 0))
    })
}

pub(super) fn random_rowid_pivot(min_rowid: i64, max_rowid: i64) -> i64 {
    if min_rowid >= max_rowid {
        return min_rowid;
    }
    let span = (max_rowid - min_rowid) as u128 + 1;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    min_rowid + (nanos % span) as i64
}

/// Track search with FTS rowid prefilter — MATCH param is bound first (subquery in `from`).
#[allow(clippy::too_many_arguments)]
pub(super) fn query_rows_fts<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    fts_match: &str,
    fts_subquery_params: &[SqlValue],
    w: &WhereBuilder,
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_read_conn(|conn| {
        let mut bind: Vec<SqlValue> = vec![SqlValue::Text(fts_match.to_string())];
        bind.extend(fts_subquery_params.iter().cloned());
        bind.extend(w.params.iter().cloned());

        let total = count_matching_rows(conn, from, &where_sql, &bind, skip_totals)?;

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        bind.push(SqlValue::Integer(limit as i64));
        bind.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), |r| map(r))?
            .collect::<rusqlite::Result<Vec<T>>>()?;
        Ok((rows, total))
    })
}

/// Grouped SELECT (album/artist rows derived from `track`). Skips COUNT when
/// `skip_totals` — Live Search only needs the first page.
#[allow(clippy::too_many_arguments)]
pub(super) fn query_grouped_rows<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    w: &WhereBuilder,
    group_sql: &str,
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_scope_detail_read_conn(|conn| {
        let total = if skip_totals {
            0u32
        } else {
            // Grouped browse totals must count distinct groups (album/artist rows),
            // not raw track rows matching the WHERE clause.
            let count_sql = format!(
                "SELECT COUNT(*) FROM (SELECT 1 FROM {from} WHERE {where_sql} {group_sql})"
            );
            let n: i64 = conn.query_row(
                &count_sql,
                rusqlite::params_from_iter(w.params.iter()),
                |r| r.get(0),
            )?;
            n.max(0) as u32
        };

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {group_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        let mut page_params: Vec<SqlValue> = w.params.clone();
        page_params.push(SqlValue::Integer(limit as i64));
        page_params.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        let collected: rusqlite::Result<Vec<T>> = stmt
            .query_map(rusqlite::params_from_iter(page_params.iter()), |r| map(r))?
            .collect();
        let rows = collected?;
        Ok((rows, total))
    })
}

pub(crate) fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub(crate) fn order_clause(sort: &[LibrarySortClause], entity: EntityKind) -> Option<String> {
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        if let Some(col) = sort_column(&s.field, entity) {
            let dir = match s.dir {
                SortDir::Asc => "ASC",
                SortDir::Desc => "DESC",
            };
            keys.push(format!("{col} {dir}"));
        }
    }
    if keys.is_empty() {
        None
    } else {
        Some(format!("ORDER BY {}", keys.join(", ")))
    }
}

/// Column expressions the album sort orders by, per query shape.
///
/// `artist` must be the **displayed** album artist, not the raw track artist:
/// the row mappers derive it with `pick_album_group_artist` (album-artist first),
/// so ordering by `MAX(t.artist)` sorted by something the user never sees — on a
/// featured-guest album that is "X feat. Z" while the row reads "X", which tore
/// such albums out of their artist's year run (#1217).
struct AlbumOrderCols {
    name: &'static str,
    artist: String,
    year: &'static str,
}

impl AlbumOrderCols {
    /// Rows aggregated from `track t` (`GROUP BY t.album_id`) — the expressions
    /// must be aggregates. Must not reference `album a`: absent in this shape.
    fn grouped() -> Self {
        Self {
            name: "MAX(t.album) COLLATE NOCASE",
            artist: sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)"),
            year: "MAX(t.year)",
        }
    }

    /// Multi-library dedup shape: the outer select projects plain columns.
    fn deduped() -> Self {
        Self {
            name: "album COLLATE NOCASE",
            artist: sql_display_artist_from("artist", "album_artist"),
            year: "year",
        }
    }
}

fn album_order_sql(sort: &[LibrarySortClause], cols: &AlbumOrderCols) -> Option<String> {
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        let col = match s.field.as_str() {
            "name" => cols.name.to_string(),
            "artist" => format!("{} COLLATE NOCASE", cols.artist),
            "year" => cols.year.to_string(),
            "random" => "RANDOM()".to_string(),
            _ => continue,
        };
        let dir = match s.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        keys.push(format!("{col} {dir}"));
    }
    if keys.is_empty() {
        None
    } else {
        Some(format!("ORDER BY {}", keys.join(", ")))
    }
}

/// Sort for album rows aggregated from `track t` (`GROUP BY t.album_id`).
pub(crate) fn album_order_from_track_groups(sort: &[LibrarySortClause]) -> Option<String> {
    album_order_sql(sort, &AlbumOrderCols::grouped())
}

/// Allowlist of sortable fields per entity → trusted column expression.
/// Unknown sort fields are ignored (fall back to the default order).
pub(crate) fn sort_column(field: &str, entity: EntityKind) -> Option<&'static str> {
    match (field, entity) {
        ("title", EntityKind::Track) => Some("t.title COLLATE NOCASE"),
        ("year", EntityKind::Track) => Some("t.year"),
        ("duration", EntityKind::Track) => Some("t.duration_sec"),
        ("artist", EntityKind::Track) => Some("t.artist COLLATE NOCASE"),
        ("album", EntityKind::Track) => Some("t.album COLLATE NOCASE"),
        ("track_number", EntityKind::Track) => Some("t.track_number"),
        ("play_count", EntityKind::Track) => Some("t.play_count"),
        ("name", EntityKind::Album) => Some("a.name COLLATE NOCASE"),
        ("year", EntityKind::Album) => Some("a.year"),
        ("artist", EntityKind::Album) => Some("a.artist COLLATE NOCASE"),
        ("name", EntityKind::Artist) => Some("COALESCE(ar.name_sort, ar.name) COLLATE NOCASE"),
        // General filtered random sorts retain SQLite's full-set shuffle. The
        // unfiltered Home track sample uses a bounded random window instead.
        ("random", _) => Some("RANDOM()"),
        _ => None,
    }
}

pub(super) fn is_fast_random_track_sample(
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    offset: u32,
) -> bool {
    req.skip_totals
        && offset == 0
        && text.is_none()
        && scalar.is_empty()
        && req.starred_only != Some(true)
        && req.restrict_album_ids.as_ref().is_none_or(Vec::is_empty)
        && req.sort.len() == 1
        && req.sort[0].field == "random"
}

pub(super) fn parse_raw_json(raw: Option<String>) -> Value {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// Same sort, built directly against the dedup shape's projected columns. It used
/// to be the grouped SQL with `MAX(t.x)` string-replaced into column names — that
/// only held while every key was a bare aggregate, and would silently mangle the
/// display-artist expression.
pub(crate) fn deduped_album_order_sql(sort: &[LibrarySortClause]) -> String {
    album_order_sql(sort, &AlbumOrderCols::deduped())
        .unwrap_or_else(|| "ORDER BY album COLLATE NOCASE ASC, album_id ASC".to_string())
}

/// Same sort for a `GROUP BY t.album_id` shape, with the default fallback the
/// scoped browse needs.
///
/// The deduped form must NOT be used on a grouped query. Its keys are bare
/// names, and SQLite resolves a bare name inside an expression (our display-
/// artist `CASE`) against the FROM tables, not against a `MAX(...) AS artist`
/// result alias — aliases only substitute when the whole ORDER BY term is a
/// plain identifier. On a grouped query the bare column is then read from an
/// arbitrary row of the group, so an album whose tracks carry `album_artist`
/// unevenly sorts under whichever row SQLite happened to pick. The grouped form
/// puts the aggregates inside the `CASE`, so there is no bare column left to
/// resolve.
pub(crate) fn grouped_album_order_sql(sort: &[LibrarySortClause]) -> String {
    album_order_from_track_groups(sort)
        .unwrap_or_else(|| "ORDER BY MAX(t.album) COLLATE NOCASE ASC, t.album_id ASC".to_string())
}

pub(crate) fn deduped_artist_order_sql(sort: &[LibrarySortClause]) -> String {
    order_clause(sort, EntityKind::Artist)
        .map(|s| {
            s.replace("COALESCE(ar.name_sort, ar.name)", "artist")
                .replace("ar.id", "artist_id")
        })
        .unwrap_or_else(|| "ORDER BY artist COLLATE NOCASE ASC, artist_id ASC".to_string())
}

pub(crate) fn deduped_track_order_sql(sort: &[LibrarySortClause]) -> String {
    order_clause(sort, EntityKind::Track)
        .map(|s| s.replace("t.", ""))
        .unwrap_or_else(|| "ORDER BY title COLLATE NOCASE ASC, id ASC".to_string())
}

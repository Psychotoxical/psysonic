//! Advanced Search SQL builder (spec §5.13). PR-5d ships the backend only —
//! the `AdvancedSearch.tsx` UI wiring stays PR-7 (F2). Cross-server search
//! (§5.5B) lives in the sibling `cross_server` module.
//!
//! The builder turns a `LibraryAdvancedSearchRequest` into one parameterised
//! query per requested entity (track / album / artist), each sharing a WHERE
//! built from the `FilterFieldRegistry` resolution in `filter.rs`. Only
//! builder-supplied column expressions ever reach the SQL string; every value
//! is bound (§5.13.5: parameterised only).

use std::collections::BTreeSet;

use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::dto::{
    LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse, LibraryAlbumDto, LibraryArtistDto,
    LibraryFilterClause, LibrarySearchTotals, LibrarySortClause, LibraryTrackDto, SortDir,
};
use crate::filter::{self, EntityKind, FilterOp, SqlFragment};
use crate::repos;
use crate::search::{aliased_track_columns, fts_query, like_contains, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

/// `bpm` dual-storage resolution (§5.13.4): prefer the hot `track.bpm`
/// column, fall back to the highest-priority `track_fact(bpm)` value. The
/// spec's `not_found = 0` guard is dropped — the live `track_fact` schema
/// has no such column (that lives on `track_artifact`).
const BPM_RESOLVED_EXPR: &str = "COALESCE(t.bpm, (SELECT f.value_int FROM track_fact f \
  WHERE f.server_id = t.server_id AND f.track_id = t.id AND f.fact_kind = 'bpm' \
  ORDER BY CASE f.source_kind WHEN 'user' THEN 0 WHEN 'server_tag' THEN 1 \
  WHEN 'analysis' THEN 2 ELSE 3 END LIMIT 1))";

const ALBUM_COLUMNS: &str = "a.server_id, a.id, a.name, a.artist, a.artist_id, \
  a.song_count, a.duration_sec, a.year, a.genre, a.cover_art_id, a.starred_at, \
  a.synced_at, a.raw_json";

const ARTIST_COLUMNS: &str = "ar.server_id, ar.id, ar.name, ar.album_count, \
  ar.synced_at, ar.raw_json";

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

    let limit = req.limit.clamp(1, PAGE_LIMIT_MAX);
    let offset = req.offset;
    let text = text_input.as_deref();
    let want = |k: EntityKind| req.entity_types.contains(&k);
    let mut applied: BTreeSet<String> = BTreeSet::new();

    let (artists, artists_total) = if want(EntityKind::Artist) {
        build_artist(store, req, text, &scalar, limit, offset, &mut applied)?
    } else {
        (Vec::new(), 0)
    };
    let (albums, albums_total) = if want(EntityKind::Album) {
        build_album(store, req, text, &scalar, limit, offset, &mut applied)?
    } else {
        (Vec::new(), 0)
    };
    let (tracks, tracks_total) = if want(EntityKind::Track) {
        build_track(store, req, text, &scalar, limit, offset, &mut applied)?
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

// ── per-entity builders ────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn build_track(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let mut w = WhereBuilder::new();
    let from;
    let default_order;
    if let Some(q) = text.and_then(fts_query) {
        from = "track_fts f JOIN track t ON t.rowid = f.rowid".to_string();
        w.push_param("track_fts MATCH ?", SqlValue::Text(q));
        default_order = "ORDER BY bm25(track_fts)".to_string();
        applied.insert("text".to_string());
    } else {
        from = "track t".to_string();
        default_order = "ORDER BY t.title COLLATE NOCASE ASC, t.id ASC".to_string();
    }
    w.push_raw("t.deleted = 0");
    w.push_param("t.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        w.push_param("t.library_id = ?", SqlValue::Text(scope));
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

    let order = order_clause(&req.sort, EntityKind::Track).unwrap_or(default_order);
    let cols = aliased_track_columns("t");
    query_rows(store, &cols, &from, &w, &order, limit, offset, |r| {
        repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))
    })
}

#[allow(clippy::too_many_arguments)]
fn build_album(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    // `album` has no `library_id` / `deleted` columns, so `libraryScope` is
    // a track-only filter (P20) and does not narrow album results.
    let mut w = WhereBuilder::new();
    w.push_param("a.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(t) = text {
        w.push_param("a.name LIKE ? ESCAPE '\\'", SqlValue::Text(like_contains(t)));
        applied.insert("text".to_string());
    }
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Album)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }
    if req.starred_only == Some(true) {
        w.push_raw("a.starred_at IS NOT NULL");
        applied.insert("starred".to_string());
    }

    let order = order_clause(&req.sort, EntityKind::Album)
        .unwrap_or_else(|| "ORDER BY a.name COLLATE NOCASE ASC, a.id ASC".to_string());
    query_rows(store, ALBUM_COLUMNS, "album a", &w, &order, limit, offset, map_album)
}

#[allow(clippy::too_many_arguments)]
fn build_artist(
    store: &LibraryStore,
    req: &LibraryAdvancedSearchRequest,
    text: Option<&str>,
    scalar: &[&LibraryFilterClause],
    limit: u32,
    offset: u32,
    applied: &mut BTreeSet<String>,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let mut w = WhereBuilder::new();
    w.push_param("ar.server_id = ?", SqlValue::Text(req.server_id.clone()));
    if let Some(t) = text {
        w.push_param("ar.name LIKE ? ESCAPE '\\'", SqlValue::Text(like_contains(t)));
        applied.insert("text".to_string());
    }
    // Only `text` routes to artist with a real column; other registered
    // fields resolve to `None` (skip). `starredOnly` has no artist column.
    for c in scalar {
        if let Some(frag) = resolve_clause(c, EntityKind::Artist)? {
            applied.insert(c.field.clone());
            w.push(frag);
        }
    }

    let order = order_clause(&req.sort, EntityKind::Artist)
        .unwrap_or_else(|| "ORDER BY ar.name COLLATE NOCASE ASC, ar.id ASC".to_string());
    query_rows(store, ARTIST_COLUMNS, "artist ar", &w, &order, limit, offset, map_artist)
}

// ── clause resolution ──────────────────────────────────────────────────

/// Resolve one scalar clause to a WHERE fragment for `entity`. `Ok(None)`
/// means the field is known but doesn't route to this entity (§5.13.3 skip).
fn resolve_clause(
    c: &LibraryFilterClause,
    entity: EntityKind,
) -> Result<Option<SqlFragment>, String> {
    let applies = filter::validate_for_entity(&c.field, c.op, entity).map_err(|e| e.to_string())?;
    if !applies {
        return Ok(None);
    }
    let col = match (c.field.as_str(), entity) {
        ("genre", EntityKind::Track) => "t.genre",
        ("genre", EntityKind::Album) => "a.genre",
        ("year", EntityKind::Track) => "t.year",
        ("year", EntityKind::Album) => "a.year",
        ("starred", EntityKind::Track) => "t.starred_at",
        ("starred", EntityKind::Album) => "a.starred_at",
        // `starred` routes to artist in the registry, but the `artist`
        // table has no `starred_at` column — skip rather than error.
        ("starred", EntityKind::Artist) => return Ok(None),
        ("bpm", EntityKind::Track) => BPM_RESOLVED_EXPR,
        // `text` is handled by the entity builder (FTS / LIKE), never here.
        ("text", _) => return Ok(None),
        // Registered but no v1 SQL builder (user_rating / suffix / bit_rate).
        _ => return Err(filter::FilterError::NotQueryable(c.field.clone()).to_string()),
    };

    if c.field == "genre" {
        let v = json_to_text(&c.field, c.value.as_ref())?;
        return Ok(Some(SqlFragment {
            sql: format!("{col} = ? COLLATE NOCASE"),
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

// ── query execution ────────────────────────────────────────────────────

/// Accumulates `AND`-joined WHERE clauses and their positional params in
/// lockstep so anonymous `?` placeholders bind left-to-right.
struct WhereBuilder {
    clauses: Vec<String>,
    params: Vec<SqlValue>,
}

impl WhereBuilder {
    fn new() -> Self {
        Self {
            clauses: Vec::new(),
            params: Vec::new(),
        }
    }
    fn push(&mut self, frag: SqlFragment) {
        self.clauses.push(frag.sql);
        self.params.extend(frag.params);
    }
    fn push_raw(&mut self, sql: &str) {
        self.clauses.push(sql.to_string());
    }
    fn push_param(&mut self, sql: &str, param: SqlValue) {
        self.clauses.push(sql.to_string());
        self.params.push(param);
    }
    fn where_sql(&self) -> String {
        self.clauses.join(" AND ")
    }
}

/// Run the COUNT (full match total) + the paged SELECT in one connection
/// borrow. Both share `where`'s params; the page appends `LIMIT ? OFFSET ?`.
#[allow(clippy::too_many_arguments)]
fn query_rows<T, F>(
    store: &LibraryStore,
    select_cols: &str,
    from: &str,
    w: &WhereBuilder,
    order_sql: &str,
    limit: u32,
    offset: u32,
    map: F,
) -> Result<(Vec<T>, u32), String>
where
    F: Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let where_sql = w.where_sql();
    store.with_conn(|conn| {
        let count_sql = format!("SELECT COUNT(*) FROM {from} WHERE {where_sql}");
        let total: i64 = conn.query_row(
            &count_sql,
            rusqlite::params_from_iter(w.params.iter()),
            |r| r.get(0),
        )?;

        let page_sql = format!(
            "SELECT {select_cols} FROM {from} WHERE {where_sql} {order_sql} LIMIT ? OFFSET ?"
        );
        let mut page_params: Vec<SqlValue> = w.params.clone();
        page_params.push(SqlValue::Integer(limit as i64));
        page_params.push(SqlValue::Integer(offset as i64));
        let mut stmt = conn.prepare(&page_sql)?;
        // Bind the collected `Result` before unwrapping so the `MappedRows`
        // borrow of `stmt` ends inside the block (rusqlite borrow quirk).
        let collected: rusqlite::Result<Vec<T>> = stmt
            .query_map(rusqlite::params_from_iter(page_params.iter()), |r| map(r))?
            .collect();
        let rows = collected?;
        Ok((rows, total.max(0) as u32))
    })
}

// ── row mappers ────────────────────────────────────────────────────────

fn map_album(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    let raw: Option<String> = r.get(12)?;
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: r.get(3)?,
        artist_id: r.get(4)?,
        song_count: r.get(5)?,
        duration_sec: r.get(6)?,
        year: r.get(7)?,
        genre: r.get(8)?,
        cover_art_id: r.get(9)?,
        starred_at: r.get(10)?,
        synced_at: r.get(11)?,
        raw_json: parse_raw_json(raw),
    })
}

fn map_artist(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryArtistDto> {
    let raw: Option<String> = r.get(5)?;
    Ok(LibraryArtistDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        album_count: r.get(3)?,
        synced_at: r.get(4)?,
        raw_json: parse_raw_json(raw),
    })
}

fn parse_raw_json(raw: Option<String>) -> Value {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

// ── small helpers ──────────────────────────────────────────────────────

fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn order_clause(sort: &[LibrarySortClause], entity: EntityKind) -> Option<String> {
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

/// Allowlist of sortable fields per entity → trusted column expression.
/// Unknown sort fields are ignored (fall back to the default order).
fn sort_column(field: &str, entity: EntityKind) -> Option<&'static str> {
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
        ("name", EntityKind::Artist) => Some("ar.name COLLATE NOCASE"),
        _ => None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::SortDir;
    use crate::repos::{TrackRepository, TrackRow};
    use serde_json::json;

    // ── fixtures ───────────────────────────────────────────────────────

    fn track(server: &str, id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: Some(format!("ar_{artist}")),
            album: album.into(),
            album_id: Some(format!("al_{album}")),
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn insert_album(store: &LibraryStore, server: &str, id: &str, name: &str, year: Option<i64>, genre: Option<&str>) {
        store
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, year, genre, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, '{}')",
                    rusqlite::params![server, id, name, year, genre],
                )
            })
            .unwrap();
    }

    fn insert_artist(store: &LibraryStore, server: &str, id: &str, name: &str) {
        store
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, 1, '{}')",
                    rusqlite::params![server, id, name],
                )
            })
            .unwrap();
    }

    fn req(server: &str, entities: &[EntityKind]) -> LibraryAdvancedSearchRequest {
        LibraryAdvancedSearchRequest {
            server_id: server.into(),
            library_scope: None,
            query: None,
            entity_types: entities.to_vec(),
            filters: Vec::new(),
            starred_only: None,
            sort: Vec::new(),
            limit: 50,
            offset: 0,
        }
    }

    fn clause(field: &str, op: FilterOp, value: Option<Value>, value_to: Option<Value>) -> LibraryFilterClause {
        LibraryFilterClause {
            field: field.into(),
            op,
            value,
            value_to,
        }
    }

    // ── text / FTS ─────────────────────────────────────────────────────

    #[test]
    fn text_query_matches_track_via_fts() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora", "Anna", "Skylines"),
                track("s1", "t2", "Sunset", "Beth", "Skylines"),
            ])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.query = Some("aurora".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
        assert_eq!(resp.totals.tracks, 1);
        assert!(resp.applied_filters.contains(&"text".to_string()));
        assert_eq!(resp.source, "local");
    }

    #[test]
    fn text_query_matches_album_and_artist_via_like() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Aurora Nights", None, None);
        insert_album(&store, "s1", "al2", "Other", None, None);
        insert_artist(&store, "s1", "ar1", "Aurora Quartet");
        let mut r = req("s1", &[EntityKind::Album, EntityKind::Artist]);
        r.query = Some("aurora".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al1");
        assert_eq!(resp.artists.len(), 1);
        assert_eq!(resp.artists[0].id, "ar1");
    }

    #[test]
    fn special_chars_in_query_do_not_crash_fts() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Hello World", "A", "B")])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        // Each of these is a raw FTS5 syntax error if passed unescaped; the
        // builder must quote them into safe terms so the call returns Ok.
        for q in ["\"", "AND", "foo*", "a OR b", "((", "near/"] {
            r.query = Some(q.to_string());
            assert!(
                run_advanced_search(&store, &r).is_ok(),
                "query `{q}` must not raise an FTS syntax error"
            );
        }
    }

    #[test]
    fn quoted_token_query_still_matches_clean_terms() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Hello World", "A", "B")])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        // Multi-token query AND-s its terms — both present → one hit.
        r.query = Some("hello world".into());
        assert_eq!(run_advanced_search(&store, &r).unwrap().tracks.len(), 1);
    }

    // ── genre / year / starred ─────────────────────────────────────────

    #[test]
    fn genre_filter_is_case_insensitive() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.genre = Some("Ambient".into());
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.genre = Some("Techno".into());
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("genre", FilterOp::Eq, Some(json!("ambient")), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
        assert!(resp.applied_filters.contains(&"genre".to_string()));
    }

    #[test]
    fn year_between_is_inclusive() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.year = Some(2000);
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.year = Some(2010);
        let mut c = track("s1", "t3", "C", "X", "Alb");
        c.year = Some(2011);
        TrackRepository::new(&store).upsert_batch(&[a, b, c]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("year", FilterOp::Between, Some(json!(2000)), Some(json!(2010)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t1", "t2"]);
    }

    #[test]
    fn year_only_branch_runs_without_fts() {
        // Genre/year-only (no query) must not require an FTS join (§5.13.7).
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.year = Some(1999);
        TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("year", FilterOp::Gte, Some(json!(1999)), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert!(!resp.applied_filters.contains(&"text".to_string()));
    }

    #[test]
    fn starred_only_filters_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.starred_at = Some(123);
        let b = track("s1", "t2", "B", "X", "Alb");
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.starred_only = Some(true);
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    // ── bpm dual storage ───────────────────────────────────────────────

    #[test]
    fn bpm_filter_matches_hot_column() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.bpm = Some(125);
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.bpm = Some(90);
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(120)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn bpm_filter_falls_back_to_track_fact() {
        let store = LibraryStore::open_in_memory();
        // No hot `bpm`; an analysis fact carries it instead.
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
            .unwrap();
        store
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO track_fact \
                     (server_id, track_id, fact_kind, value_int, source_kind, source_id, confidence, fetched_at) \
                     VALUES ('s1', 't1', 'bpm', 128, 'analysis', 'seed', 1.0, 1)",
                    [],
                )
            })
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(125)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1, "bpm should resolve via track_fact fallback");
    }

    // ── entity routing / errors ────────────────────────────────────────

    #[test]
    fn track_only_filter_is_ignored_for_album_entity_no_error() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Some Album", Some(2001), None);
        let mut r = req("s1", &[EntityKind::Album]);
        // bpm is track-only; for an album query it must be skipped, not error.
        r.filters = vec![clause("bpm", FilterOp::Between, Some(json!(120)), Some(json!(130)))];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert!(!resp.applied_filters.contains(&"bpm".to_string()));
    }

    #[test]
    fn unknown_field_is_an_error() {
        let store = LibraryStore::open_in_memory();
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("nope", FilterOp::Eq, Some(json!("x")), None)];
        let err = run_advanced_search(&store, &r).unwrap_err();
        assert!(err.contains("unknown filter field"), "got: {err}");
    }

    #[test]
    fn planned_but_unbuilt_field_is_an_error() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
            .unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        // `suffix` is registered (Planned) but has no v1 SQL builder.
        r.filters = vec![clause("suffix", FilterOp::Eq, Some(json!("flac")), None)];
        let err = run_advanced_search(&store, &r).unwrap_err();
        assert!(err.contains("not queryable"), "got: {err}");
    }

    #[test]
    fn undeclared_op_for_known_field_is_an_error() {
        let store = LibraryStore::open_in_memory();
        let mut r = req("s1", &[EntityKind::Track]);
        // `genre` only declares `eq`.
        r.filters = vec![clause("genre", FilterOp::Gte, Some(json!("rock")), None)];
        let err = run_advanced_search(&store, &r).unwrap_err();
        assert!(err.contains("not supported"), "got: {err}");
    }

    // ── scope / pagination / totals ────────────────────────────────────

    #[test]
    fn library_scope_narrows_track_results() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.library_id = Some("lib1".into());
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.library_id = Some("lib2".into());
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.library_scope = Some("lib1".into());
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert_eq!(resp.tracks[0].id, "t1");
    }

    #[test]
    fn totals_reflect_full_match_count_not_page_size() {
        let store = LibraryStore::open_in_memory();
        let rows: Vec<TrackRow> = (0..10)
            .map(|i| track("s1", &format!("t{i}"), "Common Title", "X", "Alb"))
            .collect();
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.query = Some("common".into());
        r.limit = 3;
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(resp.tracks.len(), 3, "page is capped by limit");
        assert_eq!(resp.totals.tracks, 10, "total is the full match count");
    }

    #[test]
    fn offset_pages_through_results() {
        let store = LibraryStore::open_in_memory();
        let rows: Vec<TrackRow> = (0..5)
            .map(|i| track("s1", &format!("t{i}"), &format!("Title {i}"), "X", "Alb"))
            .collect();
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.sort = vec![LibrarySortClause { field: "title".into(), dir: SortDir::Asc }];
        r.limit = 2;
        r.offset = 2;
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t2", "t3"]);
        assert_eq!(resp.totals.tracks, 5);
    }

    #[test]
    fn unrequested_entities_are_empty() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
            .unwrap();
        insert_album(&store, "s1", "al1", "Alb", None, None);
        let resp = run_advanced_search(&store, &req("s1", &[EntityKind::Track])).unwrap();
        assert_eq!(resp.tracks.len(), 1);
        assert!(resp.albums.is_empty());
        assert!(resp.artists.is_empty());
        assert_eq!(resp.totals.albums, 0);
    }

    #[test]
    fn sort_desc_orders_results() {
        let store = LibraryStore::open_in_memory();
        let mut a = track("s1", "t1", "A", "X", "Alb");
        a.year = Some(2000);
        let mut b = track("s1", "t2", "B", "X", "Alb");
        b.year = Some(2020);
        TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
        let mut r = req("s1", &[EntityKind::Track]);
        r.sort = vec![LibrarySortClause { field: "year".into(), dir: SortDir::Desc }];
        let resp = run_advanced_search(&store, &r).unwrap();
        let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t2", "t1"]);
    }
}

//! FTS5-backed track search — FTS-first `EXISTS` (never `JOIN track … ORDER BY bm25`).

use std::collections::HashMap;

use crate::store::LibraryStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackHit {
    pub server_id: String,
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: String,
}

/// Run a single-server FTS5 match against `track_fts`, returning rows in
/// bm25 order. `library_scopes` empty = all libraries on the server.
pub fn search_tracks(
    store: &LibraryStore,
    server_id: &str,
    query: &str,
    limit: i64,
    library_scopes: &[String],
) -> Result<Vec<TrackHit>, String> {
    if !fts_query_meets_min_len(query) {
        return Ok(Vec::new());
    }
    let fts = fts_track_match_query(query).ok_or_else(|| "empty query".to_string())?;
    let scopes = normalized_library_scopes(library_scopes);
    store.with_read_conn(|conn| {
        let rowids = collect_search_fts_rowids(conn, &fts, server_id, &scopes, limit)?;
        fetch_track_hits_by_rowids(conn, &rowids, server_id, &scopes)
    })
}

/// FTS rowids for a single-server track search — bm25 inside the FTS subquery.
fn collect_search_fts_rowids(
    conn: &rusqlite::Connection,
    fts: &str,
    server_id: &str,
    library_scopes: &[String],
    limit: i64,
) -> rusqlite::Result<Vec<i64>> {
    let mut scope_sql = String::new();
    if !library_scopes.is_empty() {
        scope_sql = format!(" AND {}", library_scope_in_sql("c", library_scopes.len()));
    }
    let sql = format!(
        "SELECT f.rowid FROM track_fts f \
         WHERE track_fts MATCH ? \
           AND EXISTS (\
             SELECT 1 FROM track c \
             WHERE c.rowid = f.rowid \
               AND c.server_id = ? \
               AND c.deleted = 0{scope_sql}\
           ) \
         ORDER BY bm25(track_fts) LIMIT ?",
    );
    let mut bind: Vec<rusqlite::types::Value> = vec![
        rusqlite::types::Value::Text(fts.to_string()),
        rusqlite::types::Value::Text(server_id.to_string()),
    ];
    push_library_scope_binds(&mut bind, library_scopes);
    bind.push(rusqlite::types::Value::Integer(limit));
    let mut stmt = conn.prepare(&sql)?;
    let collected: rusqlite::Result<Vec<i64>> = stmt
        .query_map(rusqlite::params_from_iter(bind.iter()), |r| r.get(0))?
        .collect();
    collected
}

fn fetch_track_hits_by_rowids(
    conn: &rusqlite::Connection,
    rowids: &[i64],
    server_id: &str,
    library_scopes: &[String],
) -> rusqlite::Result<Vec<TrackHit>> {
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (0..rowids.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
    let mut scope_sql = String::new();
    if !library_scopes.is_empty() {
        scope_sql = format!(" AND {}", library_scope_in_sql("t", library_scopes.len()));
    }
    let sql = format!(
        "SELECT t.rowid, t.server_id, t.id, t.title, t.artist, t.album \
         FROM track t \
         WHERE t.rowid IN ({placeholders}) \
           AND t.server_id = ? \
           AND t.deleted = 0{scope_sql}",
    );
    let mut bind: Vec<rusqlite::types::Value> = rowids
        .iter()
        .copied()
        .map(rusqlite::types::Value::Integer)
        .collect();
    bind.push(rusqlite::types::Value::Text(server_id.to_string()));
    push_library_scope_binds(&mut bind, library_scopes);
    let mut stmt = conn.prepare(&sql)?;
    let mut by_rowid: HashMap<i64, TrackHit> = HashMap::new();
    for row in stmt.query_map(rusqlite::params_from_iter(bind.iter()), |r| {
        let rowid: i64 = r.get(0)?;
        Ok((
            rowid,
            TrackHit {
                server_id: r.get(1)?,
                id: r.get(2)?,
                title: r.get(3)?,
                artist: r.get(4)?,
                album: r.get(5)?,
            },
        ))
    })? {
        let (rowid, hit) = row?;
        by_rowid.insert(rowid, hit);
    }
    Ok(rowids
        .iter()
        .filter_map(|rid| by_rowid.get(rid).cloned())
        .collect())
}

// ── shared search SQL helpers (Advanced Search §5.13 + cross-server §5.5B) ──

/// Hard ceiling on a single search page — keeps the FTS5 p95 budget (§5.9).
/// Callers clamp their requested `limit` into `1..=PAGE_LIMIT_MAX`.
pub(crate) const PAGE_LIMIT_MAX: u32 = 500;

/// Characters that break FTS5 quoted tokens — not `*` (censorship stars in titles).
const FTS_QUERY_SYNTAX_CHARS: &[char] = &['=', ':', '(', ')', '^', '<', '>', '%', '|', '\\'];

fn is_wildcard_only_token(token: &str) -> bool {
    !token.is_empty() && token.chars().all(|c| c == '*')
}

/// True when `token` can be safely wrapped in FTS5 quotes for prefix/phrase match.
pub(crate) fn fts_token_is_safe(token: &str) -> bool {
    let t = token.trim();
    !t.is_empty()
        && !is_wildcard_only_token(t)
        && !t.chars().any(|c| FTS_QUERY_SYNTAX_CHARS.contains(&c))
        && t.chars().any(|c| c.is_alphanumeric() || c as u32 >= 0x80)
}

/// Whitespace-split tokens when every segment is FTS-safe; otherwise `None`.
pub(crate) fn fts_safe_whitespace_tokens(raw: &str) -> Option<Vec<&str>> {
    let tokens: Vec<&str> = raw.split_whitespace().filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() || !tokens.iter().all(|t| fts_token_is_safe(t)) {
        None
    } else {
        Some(tokens)
    }
}

/// Local FTS is skipped below this length — single-character queries (e.g. Cyrillic
/// «а», Latin «a») match huge fractions of a large library and bm25+LIMIT can
/// take tens of seconds (§5.9: no heavy work on every keystroke).
pub const LOCAL_FTS_MIN_QUERY_CHARS: usize = 2;

/// True when `raw` has enough graphemes for a scoped FTS MATCH.
pub fn fts_query_meets_min_len(raw: &str) -> bool {
    raw.trim().chars().count() >= LOCAL_FTS_MIN_QUERY_CHARS
}

/// Build a safe FTS5 MATCH string: each whitespace token is quoted (and its
/// internal `"` doubled) so arbitrary user input can't trip FTS5 query
/// syntax. Tokens are implicitly AND-ed. `None` when the input has no tokens.
pub(crate) fn fts_query(raw: &str) -> Option<String> {
    let tokens = fts_token_expr(raw)?;
    Some(tokens)
}

/// Token expression only (`"a" "b"`), shared by column-scoped builders.
pub(crate) fn fts_token_expr(raw: &str) -> Option<String> {
    fts_token_expr_with(raw, false)
}

/// Prefix token expression (`"a"* "b"*`) for Live Search as-you-type matching.
pub(crate) fn fts_prefix_token_expr(raw: &str) -> Option<String> {
    fts_token_expr_with(raw, true)
}

/// Navidrome-style any-word prefix match (`"a"* OR "b"*`).
pub(crate) fn fts_prefix_token_or_expr(raw: &str) -> Option<String> {
    let tokens: Vec<String> = fts_safe_whitespace_tokens(raw)?
        .into_iter()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if tokens.len() == 1 {
        Some(tokens.into_iter().next().unwrap())
    } else {
        Some(tokens.join(" OR "))
    }
}

fn fts_token_expr_with(raw: &str, prefix: bool) -> Option<String> {
    let tokens: Vec<String> = fts_safe_whitespace_tokens(raw)?
        .into_iter()
        .map(|t| {
            let quoted = format!("\"{}\"", t.replace('"', "\"\""));
            if prefix {
                format!("{quoted}*")
            } else {
                quoted
            }
        })
        .collect();
    Some(tokens.join(" "))
}

/// Column-scoped prefix match (`artist : "met"*` → Metallica).
pub(crate) fn fts_column_prefix_query(column: &str, raw: &str) -> Option<String> {
    fts_prefix_token_expr(raw).map(|tokens| format!("{column} : {tokens}"))
}

/// Prefix variants for Live Search / Advanced Search as-you-type matching.
pub(crate) fn fts_track_prefix_match_query(raw: &str) -> Option<String> {
    fts_prefix_token_expr(raw).map(|tokens| {
        ["title", "artist", "album", "album_artist"]
            .iter()
            .map(|col| format!("{col} : {tokens}"))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

pub(crate) fn fts_album_prefix_match_query(raw: &str) -> Option<String> {
    fts_prefix_token_expr(raw).map(|tokens| {
        format!("(album : {tokens} OR album_artist : {tokens})")
    })
}

/// Album title column only (All Albums scoped browse — not album artist).
pub(crate) fn fts_album_title_prefix_match_query(raw: &str) -> Option<String> {
    fts_prefix_token_expr(raw).map(|tokens| format!("album : {tokens}"))
}

/// Live Search album match — any query word may hit album or album_artist (Navidrome parity).
pub(crate) fn fts_album_prefix_any_token_match_query(raw: &str) -> Option<String> {
    fts_prefix_token_or_expr(raw).map(|tokens| {
        format!("(album : ({tokens}) OR album_artist : ({tokens}))")
    })
}

/// Live Search artist match — performer fields only (not album title).
pub(crate) fn fts_artist_prefix_any_token_match_query(raw: &str) -> Option<String> {
    fts_prefix_token_or_expr(raw).map(|tokens| {
        format!("(artist : ({tokens}) OR album_artist : ({tokens}))")
    })
}

/// Live Search song match — any query word across display columns.
pub(crate) fn fts_track_prefix_any_token_match_query(raw: &str) -> Option<String> {
    fts_prefix_token_or_expr(raw).map(|tokens| {
        ["title", "artist", "album", "album_artist"]
            .iter()
            .map(|col| format!("{col} : ({tokens})"))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

/// Song / track entity: match primary display fields (excludes `genre` to cut
/// noise and FTS fan-out on large libraries).
pub(crate) fn fts_track_match_query(raw: &str) -> Option<String> {
    fts_token_expr(raw).map(|tokens| {
        ["title", "artist", "album", "album_artist"]
            .iter()
            .map(|col| format!("{col} : {tokens}"))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

/// Hot-path scoped filter on the backfilled `library_id` column (spec §4).
pub(crate) fn library_scope_sargable_equals_sql(table_alias: &str) -> String {
    format!("{table_alias}.library_id = ?")
}

/// Sargable multi-library filter on the hot `library_id` column (WO-1 backfill).
pub(crate) fn library_scope_in_sql(table_alias: &str, count: usize) -> String {
    let placeholders = (0..count).map(|_| "?").collect::<Vec<_>>().join(", ");
    format!("{table_alias}.library_id IN ({placeholders})")
}

/// Combine the legacy single `library_scope` with an ordered `library_scopes`
/// list into a normalized set of library ids. The multi-select list wins when
/// present; empty result means "all libraries" (no filter).
pub(crate) fn combined_scope_library_ids(
    library_scope: Option<&str>,
    library_scopes: Option<&[String]>,
) -> Vec<String> {
    if let Some(multi) = library_scopes {
        let norm = normalized_library_scopes(multi);
        if !norm.is_empty() {
            return norm;
        }
    }
    library_scope
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

/// Non-empty trimmed ids; empty input means no library filter (all libraries).
pub(crate) fn normalized_library_scopes(scopes: &[String]) -> Vec<String> {
    scopes
        .iter()
        .filter_map(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        })
        .collect()
}

pub(crate) fn push_library_scope_binds(
    params: &mut Vec<rusqlite::types::Value>,
    scopes: &[String],
) {
    for s in scopes {
        params.push(rusqlite::types::Value::Text(s.clone()));
    }
}

/// Project the `track` hot columns prefixed with `alias` (e.g. `t.title`),
/// in `repos::row_to_track_row`'s positional order so the Advanced Search /
/// cross-server builders can reuse the shared row mapper.
pub(crate) fn aliased_track_columns(alias: &str) -> String {
    crate::repos::track_columns()
        .split(',')
        .map(|c| format!("{alias}.{}", c.trim()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Same projection as [`aliased_track_columns`], but `bpm` uses analysis fact +
/// tag dual-storage resolution (§5.13.4) and appends `bpm_source` for UI tooltips.
pub(crate) fn aliased_track_columns_resolved_bpm(alias: &str) -> String {
    let base = aliased_track_columns_with_resolved_bpm_expr(alias);
    format!("{base}, ({}) AS bpm_source", bpm_source_expr(alias))
}

fn aliased_track_columns_with_resolved_bpm_expr(alias: &str) -> String {
    let bpm_expr = bpm_resolved_expr(alias);
    crate::repos::track_columns()
        .split(',')
        .map(|c| {
            let col = c.trim();
            if col == "bpm" {
                format!("({bpm_expr}) AS bpm")
            } else {
                format!("{alias}.{col}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Oximedia / analysis `track_fact(bpm)` — preferred over hot `track.bpm` tag.
fn bpm_analysis_fact_subquery(table_alias: &str) -> String {
    format!(
        "(SELECT f.value_int FROM track_fact f \
         WHERE f.server_id = {table_alias}.server_id AND f.track_id = {table_alias}.id \
         AND f.fact_kind = 'bpm' AND f.source_kind = 'analysis' \
         AND f.value_int IS NOT NULL AND f.value_int > 0 \
         ORDER BY f.confidence DESC LIMIT 1)"
    )
}

pub(crate) fn bpm_resolved_expr(table_alias: &str) -> String {
    let analysis = bpm_analysis_fact_subquery(table_alias);
    let tag = format!(
        "CASE WHEN {table_alias}.bpm IS NOT NULL AND {table_alias}.bpm > 0 \
         THEN {table_alias}.bpm END"
    );
    let other_fact = format!(
        "(SELECT f.value_int FROM track_fact f \
         WHERE f.server_id = {table_alias}.server_id AND f.track_id = {table_alias}.id \
         AND f.fact_kind = 'bpm' AND f.source_kind NOT IN ('analysis') \
         AND f.value_int IS NOT NULL AND f.value_int > 0 \
         ORDER BY CASE f.source_kind WHEN 'user' THEN 0 WHEN 'server_tag' THEN 1 ELSE 2 END LIMIT 1)"
    );
    format!("COALESCE({analysis}, {tag}, {other_fact})")
}

/// `'analysis'` when measured fact wins; `'tag'` when hot `track.bpm` is shown.
pub(crate) fn bpm_source_expr(table_alias: &str) -> String {
    let analysis = bpm_analysis_fact_subquery(table_alias);
    format!(
        "CASE \
         WHEN {analysis} IS NOT NULL THEN 'analysis' \
         WHEN {table_alias}.bpm IS NOT NULL AND {table_alias}.bpm > 0 THEN 'tag' \
         ELSE NULL END"
    )
}

pub(crate) fn track_projection_column_count() -> usize {
    crate::repos::track_columns().split(',').count()
}

/// Map a BPM-resolved Advanced Search row (extra trailing `bpm_source` column).
pub(crate) fn row_to_track_dto_resolved_bpm(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<crate::dto::LibraryTrackDto> {
    let mut dto = crate::dto::LibraryTrackDto::from_row(&crate::repos::row_to_track_row(row)?);
    dto.bpm_source = row.get(track_projection_column_count()).ok();
    Ok(dto)
}

/// Build a `%…%` LIKE pattern with the LIKE wildcards (`%`, `_`) and the
/// `\` escape char escaped, for use with `LIKE ? ESCAPE '\'`. Shared by the
/// Advanced Search album/artist name match and the cross-server fuzzy
/// title fallback (§5.9).
pub(crate) fn like_contains(raw: &str) -> String {
    let escaped = raw
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// `like_contains` with Unicode case folding on the needle. Use when matching
/// against `name_sort` (already lowercase) or when SQLite `LIKE` would treat
/// non-ASCII letters as case-sensitive.
pub(crate) fn like_contains_folded(raw: &str) -> String {
    like_contains(&raw.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};
    use std::collections::HashSet;

    fn row(server: &str, id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: None,
            album: album.into(),
            album_id: None,
            album_artist: Some(artist.into()),
            duration_sec: 200,
            track_number: None,
            disc_number: None,
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
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn row_with_lib(
        server: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        library_id: Option<&str>,
    ) -> TrackRow {
        let mut r = row(server, id, title, artist, album);
        r.library_id = library_id.map(str::to_string);
        r
    }

    #[test]
    fn match_finds_track_by_title() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                row("s1", "t1", "Aurora", "Anna", "Skylines"),
                row("s1", "t2", "Sunset", "Beth", "Skylines"),
            ])
            .unwrap();
        let hits = search_tracks(&store, "s1", "aurora", 10, &[]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "t1");
    }

    #[test]
    fn match_filters_by_server_id() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                row("s1", "t1", "Aurora", "Anna", "Skylines"),
                row("s2", "t1", "Aurora", "Anna", "Skylines"),
            ])
            .unwrap();
        let hits = search_tracks(&store, "s2", "aurora", 10, &[]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].server_id, "s2");
    }

    #[test]
    fn match_skips_deleted_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        repo.upsert_batch(&[row("s1", "t1", "Aurora", "Anna", "Skylines")])
            .unwrap();
        let mut gone = row("s1", "t1", "Aurora", "Anna", "Skylines");
        gone.deleted = true;
        repo.upsert_batch(&[gone]).unwrap();
        let hits = search_tracks(&store, "s1", "aurora", 10, &[]).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn match_library_scope_narrows_single_id() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                row_with_lib("s1", "t1", "Scoped Song", "A", "Al1", Some("lib1")),
                row_with_lib("s1", "t2", "Scoped Song", "B", "Al2", Some("lib2")),
            ])
            .unwrap();
        let hits = search_tracks(&store, "s1", "scoped", 10, &["lib1".into()]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "t1");
    }

    #[test]
    fn match_library_scope_narrows_multi_id() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                row_with_lib("s1", "t1", "Scoped Song", "A", "Al1", Some("lib1")),
                row_with_lib("s1", "t2", "Scoped Song", "B", "Al2", Some("lib2")),
                row_with_lib("s1", "t3", "Scoped Song", "C", "Al3", Some("lib3")),
            ])
            .unwrap();
        let hits = search_tracks(
            &store,
            "s1",
            "scoped",
            10,
            &["lib1".into(), "lib3".into()],
        )
        .unwrap();
        assert_eq!(hits.len(), 2);
        let ids: HashSet<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, HashSet::from(["t1", "t3"]));
    }

    #[test]
    fn match_fts_first_returns_correct_hit_on_large_fixture() {
        let store = LibraryStore::open_in_memory();
        let mut batch = Vec::new();
        for i in 0..80 {
            batch.push(row(
                "s1",
                &format!("t_noise_{i}"),
                "Noise Track",
                "Filler Artist",
                "Filler Album",
            ));
        }
        batch.push(row("s1", "t_target", "Unique Aurora Title", "Target Artist", "Target Album"));
        TrackRepository::new(&store).upsert_batch(&batch).unwrap();
        let hits = search_tracks(&store, "s1", "aurora", 10, &[]).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "t_target");
    }

    #[test]
    fn library_scope_in_sql_produces_sargable_in_clause() {
        assert_eq!(
            library_scope_in_sql("t", 2),
            "t.library_id IN (?, ?)"
        );
    }

    #[test]
    fn fts_column_prefix_query_scopes_to_one_column() {
        assert_eq!(
            fts_column_prefix_query("artist", "metal").as_deref(),
            Some("artist : \"metal\"*")
        );
    }

    #[test]
    fn fts_prefix_token_or_expr_matches_any_word() {
        assert_eq!(
            fts_prefix_token_or_expr("love supreme").as_deref(),
            Some("\"love\"* OR \"supreme\"*")
        );
    }

    #[test]
    fn fts_album_prefix_any_token_match_query_or_across_album_fields() {
        assert_eq!(
            fts_album_prefix_any_token_match_query("dark side").as_deref(),
            Some("(album : (\"dark\"* OR \"side\"*) OR album_artist : (\"dark\"* OR \"side\"*))")
        );
    }

    #[test]
    fn fts_prefix_token_expr_ands_multiword_prefixes() {
        assert_eq!(
            fts_prefix_token_expr("arch enemy").as_deref(),
            Some("\"arch\"* \"enemy\"*")
        );
    }

    #[test]
    fn fts_track_prefix_match_query_or_across_display_columns() {
        let q = fts_track_prefix_match_query("metal").unwrap();
        assert!(q.contains("title : \"metal\"*"));
        assert!(q.contains("artist : \"metal\"*"));
        assert!(!q.contains("genre"));
    }

    #[test]
    fn fts_album_prefix_match_query_includes_album_artist() {
        assert_eq!(
            fts_album_prefix_match_query("metal").as_deref(),
            Some("(album : \"metal\"* OR album_artist : \"metal\"*)")
        );
    }

    #[test]
    fn fts_album_title_prefix_match_query_is_album_column_only() {
        assert_eq!(
            fts_album_title_prefix_match_query("metal").as_deref(),
            Some("album : \"metal\"*")
        );
    }

    #[test]
    fn fts_track_match_query_or_across_display_columns() {
        let q = fts_track_match_query("manowar").unwrap();
        assert!(q.contains("title : \"manowar\""));
        assert!(q.contains("artist : \"manowar\""));
        assert!(!q.contains("genre"));
    }

    #[test]
    fn fts_query_meets_min_len_requires_two_graphemes() {
        assert!(!fts_query_meets_min_len("a"));
        assert!(!fts_query_meets_min_len("а"));
        assert!(fts_query_meets_min_len("ab"));
        assert!(fts_query_meets_min_len("ма"));
    }

    #[test]
    fn fts_query_quotes_tokens_and_doubles_inner_quotes() {
        assert_eq!(fts_query("hello world").as_deref(), Some("\"hello\" \"world\""));
        assert_eq!(fts_query("a\"b").as_deref(), Some("\"a\"\"b\""));
    }

    #[test]
    fn fts_query_is_none_for_blank_input() {
        assert!(fts_query("").is_none());
        assert!(fts_query("   ").is_none());
    }

    #[test]
    fn fts_prefix_token_or_expr_rejects_syntax_metachar_tokens() {
        assert!(fts_prefix_token_or_expr("1=2").is_none());
        assert!(fts_prefix_token_or_expr("1=1").is_none());
        assert!(fts_prefix_token_or_expr("M=c").is_none());
        assert!(fts_prefix_token_or_expr("V()>P").is_none());
        assert!(fts_prefix_token_or_expr("**").is_none());
        assert!(fts_prefix_token_or_expr("****").is_none());
    }

    #[test]
    fn fts_prefix_token_or_expr_allows_censorship_stars_in_titles() {
        assert_eq!(
            fts_prefix_token_or_expr("***Flawless").as_deref(),
            Some("\"***Flawless\"*")
        );
        assert_eq!(
            fts_prefix_token_or_expr("B********").as_deref(),
            Some("\"B********\"*")
        );
    }

    #[test]
    fn fts_prefix_token_or_expr_still_builds_safe_tokens() {
        assert_eq!(
            fts_prefix_token_or_expr("love supreme").as_deref(),
            Some("\"love\"* OR \"supreme\"*")
        );
        assert_eq!(fts_prefix_token_or_expr("25").as_deref(), Some("\"25\"*"));
    }

    #[test]
    fn aliased_track_columns_prefixes_every_column() {
        let cols = aliased_track_columns("t");
        assert!(cols.starts_with("t.server_id, t.id, t.title"));
        assert!(cols.ends_with("t.raw_json"));
        // One alias per column — count matches the shared column list.
        assert_eq!(cols.matches("t.").count(), crate::repos::track_columns().split(',').count());
    }
}

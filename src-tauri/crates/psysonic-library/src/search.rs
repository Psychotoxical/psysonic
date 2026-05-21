//! FTS5-backed track search. Skeleton landed in PR-1a — the multi-server +
//! libraryScope + bm25 ranking shape from spec §5.9 will be filled in by the
//! sync / search PRs.

use rusqlite::params;

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
/// bm25 order. `query` is passed straight to FTS5 — callers are expected to
/// sanitise / quote user input (see §5.13.5: parameterised only).
pub fn search_tracks(
    store: &LibraryStore,
    server_id: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<TrackHit>, String> {
    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(
            r#"
            SELECT t.server_id, t.id, t.title, t.artist, t.album
              FROM track_fts f
              JOIN track t ON t.rowid = f.rowid
             WHERE track_fts MATCH ?1
               AND t.server_id = ?2
               AND t.deleted = 0
             ORDER BY bm25(track_fts)
             LIMIT ?3
            "#,
        )?;
        let rows = stmt
            .query_map(params![query, server_id, limit], |r| {
                Ok(TrackHit {
                    server_id: r.get(0)?,
                    id: r.get(1)?,
                    title: r.get(2)?,
                    artist: r.get(3)?,
                    album: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

// ── shared search SQL helpers (Advanced Search §5.13 + cross-server §5.5B) ──

/// Hard ceiling on a single search page — keeps the FTS5 p95 budget (§5.9).
/// Callers clamp their requested `limit` into `1..=PAGE_LIMIT_MAX`.
pub(crate) const PAGE_LIMIT_MAX: u32 = 500;

/// Build a safe FTS5 MATCH string: each whitespace token is quoted (and its
/// internal `"` doubled) so arbitrary user input can't trip FTS5 query
/// syntax. Tokens are implicitly AND-ed. `None` when the input has no tokens.
pub(crate) fn fts_query(raw: &str) -> Option<String> {
    let tokens: Vec<String> = raw
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

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
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
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
        let hits = search_tracks(&store, "s1", "aurora", 10).unwrap();
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
        let hits = search_tracks(&store, "s2", "aurora", 10).unwrap();
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
        let hits = search_tracks(&store, "s1", "aurora", 10).unwrap();
        assert!(hits.is_empty());
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
    fn aliased_track_columns_prefixes_every_column() {
        let cols = aliased_track_columns("t");
        assert!(cols.starts_with("t.server_id, t.id, t.title"));
        assert!(cols.ends_with("t.raw_json"));
        // One alias per column — count matches the shared column list.
        assert_eq!(cols.matches("t.").count(), crate::repos::track_columns().split(',').count());
    }
}

//! Cross-server search (spec §5.5B / §5.9). Primary FTS union (`hits`,
//! bm25-ordered, deduped by canonical id) plus the H3 fuzzy fallback
//! (`fuzzy`): per-server `title LIKE` matches the exact FTS pass missed.
//! UI wiring stays PR-7.

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value as SqlValue;

use crate::dto::{LibraryCrossServerSearchResponse, LibraryTrackDto};
use crate::repos;
use crate::search::{
    aliased_track_columns, fts_query, library_scope_in_sql, like_contains,
    normalized_library_scopes, push_library_scope_binds, PAGE_LIMIT_MAX,
};
use crate::store::LibraryStore;

/// §5.9 caps the fuzzy fallback at "top 20 per server" so a `LIKE %…%` scan
/// (no index) stays bounded.
const FUZZY_PER_SERVER_CAP: usize = 20;

/// `library_search_cross_server` (§5.5B / §5.9 A′). Primary FTS union over
/// the requested servers (or all `ready` servers), bm25-ordered, deduped by
/// canonical id where a `track_canonical_link` row exists.
pub fn run_cross_server_search(
    store: &LibraryStore,
    query: &str,
    limit: u32,
    servers: Option<&[String]>,
    library_scopes: Option<&[String]>,
) -> Result<LibraryCrossServerSearchResponse, String> {
    let limit = limit.clamp(1, PAGE_LIMIT_MAX);
    let Some(fts) = fts_query(query) else {
        return Ok(LibraryCrossServerSearchResponse::default());
    };

    // Explicit `servers` is an override (caller's choice); otherwise default
    // to every server whose index is `ready` (§5.9).
    let targets: Vec<String> = match servers {
        Some(list) if !list.is_empty() => list.to_vec(),
        _ => ready_servers(store)?,
    };
    if targets.is_empty() {
        return Ok(LibraryCrossServerSearchResponse::default());
    }

    let scopes = library_scopes
        .map(normalized_library_scopes)
        .unwrap_or_default();

    let rowids = collect_cross_server_fts_rowids(store, &fts, &targets, &scopes, limit as i64)?;
    let rows = fetch_cross_server_hits(store, &rowids, &scopes)?;

    // Dedup the exact hits by canonical id (§5.5B step 2). Rows with no
    // canonical link are always kept — the link table is sparse for tracks
    // lacking ISRC/MBID.
    let mut seen: HashSet<String> = HashSet::new();
    let mut hits: Vec<LibraryTrackDto> = Vec::with_capacity(rows.len());
    for (track, canonical) in rows {
        if let Some(cid) = canonical {
            if !seen.insert(cid) {
                continue;
            }
        }
        hits.push(track);
    }

    // H3 fuzzy fallback (§5.9): catch what the exact FTS pass missed.
    let hit_keys: HashSet<(String, String)> = hits
        .iter()
        .map(|t| (t.server_id.clone(), t.id.clone()))
        .collect();
    let fuzzy = fuzzy_matches(
        store,
        &targets,
        query.trim(),
        &mut seen,
        &hit_keys,
        limit as usize,
        &scopes,
    )?;

    Ok(LibraryCrossServerSearchResponse {
        hits,
        fuzzy,
        servers_searched: targets,
    })
}

fn collect_cross_server_fts_rowids(
    store: &LibraryStore,
    fts: &str,
    targets: &[String],
    library_scopes: &[String],
    limit: i64,
) -> Result<Vec<i64>, String> {
    let server_placeholders = vec!["?"; targets.len()].join(", ");
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
               AND c.deleted = 0 \
               AND c.server_id IN ({server_placeholders}){scope_sql}\
           ) \
         ORDER BY bm25(track_fts) LIMIT ?",
    );
    store.with_read_conn(|conn| {
        let mut bind: Vec<SqlValue> = vec![SqlValue::Text(fts.to_string())];
        for s in targets {
            bind.push(SqlValue::Text(s.clone()));
        }
        push_library_scope_binds(&mut bind, library_scopes);
        bind.push(SqlValue::Integer(limit));
        let mut stmt = conn.prepare(&sql)?;
        let collected: rusqlite::Result<Vec<i64>> = stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), |r| r.get(0))?
            .collect();
        collected
    })
}

fn fetch_cross_server_hits(
    store: &LibraryStore,
    rowids: &[i64],
    library_scopes: &[String],
) -> Result<Vec<(LibraryTrackDto, Option<String>)>, String> {
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; rowids.len()].join(", ");
    let cols = aliased_track_columns("t");
    let mut scope_sql = String::new();
    if !library_scopes.is_empty() {
        scope_sql = format!(" AND {}", library_scope_in_sql("t", library_scopes.len()));
    }
    let sql = format!(
        "SELECT {cols}, l.canonical_id, t.rowid \
         FROM track t \
         LEFT JOIN track_canonical_link l ON l.server_id = t.server_id AND l.track_id = t.id \
         WHERE t.rowid IN ({placeholders}) \
           AND t.deleted = 0{scope_sql}",
    );
    let canonical_idx = repos::track_columns().split(',').count();
    let rowid_idx = canonical_idx + 1;
    store.with_read_conn(|conn| {
        let mut bind: Vec<SqlValue> = rowids.iter().copied().map(SqlValue::Integer).collect();
        push_library_scope_binds(&mut bind, library_scopes);
        let mut stmt = conn.prepare(&sql)?;
        let mut by_rowid: HashMap<i64, (LibraryTrackDto, Option<String>)> = HashMap::new();
        for row in stmt.query_map(rusqlite::params_from_iter(bind.iter()), |r| {
            let track = repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))?;
            let canonical: Option<String> = r.get(canonical_idx)?;
            let rowid: i64 = r.get(rowid_idx)?;
            Ok((rowid, (track, canonical)))
        })? {
            let (rowid, pair) = row?;
            by_rowid.insert(rowid, pair);
        }
        Ok(rowids
            .iter()
            .filter_map(|rid| by_rowid.get(rid).cloned())
            .collect())
    })
}

/// §5.9 fuzzy fallback: per target server, `title LIKE %query%` for matches
/// the exact FTS pass missed (diacritics, partial words). Skips rows already
/// in `hit_keys` and dedupes by canonical id against `seen` (which holds the
/// exact hits' canonical ids). Capped per server (`FUZZY_PER_SERVER_CAP`) and
/// overall (`overall_cap`).
fn fuzzy_matches(
    store: &LibraryStore,
    targets: &[String],
    query: &str,
    seen: &mut HashSet<String>,
    hit_keys: &HashSet<(String, String)>,
    overall_cap: usize,
    library_scopes: &[String],
) -> Result<Vec<LibraryTrackDto>, String> {
    let like = like_contains(query);
    let cols = aliased_track_columns("t");
    let canonical_idx = repos::track_columns().split(',').count();
    let mut scope_sql = String::new();
    if !library_scopes.is_empty() {
        scope_sql = format!(" AND {}", library_scope_in_sql("t", library_scopes.len()));
    }
    let sql = format!(
        "SELECT {cols}, l.canonical_id \
         FROM track t \
         LEFT JOIN track_canonical_link l ON l.server_id = t.server_id AND l.track_id = t.id \
         WHERE t.server_id = ? AND t.deleted = 0 AND t.title LIKE ? ESCAPE '\\'{scope_sql} \
         ORDER BY t.title COLLATE NOCASE ASC LIMIT ?"
    );

    let mut out: Vec<LibraryTrackDto> = Vec::new();
    for server in targets {
        if out.len() >= overall_cap {
            break;
        }
        let mut bound = vec![
            SqlValue::Text(server.clone()),
            SqlValue::Text(like.clone()),
        ];
        push_library_scope_binds(&mut bound, library_scopes);
        bound.push(SqlValue::Integer(FUZZY_PER_SERVER_CAP as i64));
        let rows: Vec<(LibraryTrackDto, Option<String>)> = store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let collected: rusqlite::Result<Vec<(LibraryTrackDto, Option<String>)>> = stmt
                .query_map(rusqlite::params_from_iter(bound.iter()), |r| {
                    let track =
                        repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))?;
                    let canonical: Option<String> = r.get(canonical_idx)?;
                    Ok((track, canonical))
                })?
                .collect();
            collected
        })?;

        for (track, canonical) in rows {
            if out.len() >= overall_cap {
                break;
            }
            if hit_keys.contains(&(track.server_id.clone(), track.id.clone())) {
                continue; // already an exact hit
            }
            if let Some(cid) = canonical {
                if !seen.insert(cid) {
                    continue; // canonical already represented (hit or earlier fuzzy)
                }
            }
            out.push(track);
        }
    }
    Ok(out)
}

fn ready_servers(store: &LibraryStore) -> Result<Vec<String>, String> {
    store.with_read_conn(|conn| {
        let mut stmt =
            conn.prepare("SELECT DISTINCT server_id FROM sync_state WHERE sync_phase = 'ready'")?;
        let collected: rusqlite::Result<Vec<String>> =
            stmt.query_map([], |r| r.get(0))?.collect();
        collected
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

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
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn set_phase(store: &LibraryStore, server: &str, phase: &str) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO sync_state (server_id, library_scope, sync_phase) \
                     VALUES (?1, '', ?2) \
                     ON CONFLICT(server_id, library_scope) DO UPDATE SET sync_phase = excluded.sync_phase",
                    rusqlite::params![server, phase],
                )
            })
            .unwrap();
    }

    fn track_with_lib(
        server: &str,
        id: &str,
        title: &str,
        artist: &str,
        album: &str,
        library_id: Option<&str>,
    ) -> TrackRow {
        let mut t = track(server, id, title, artist, album);
        t.library_id = library_id.map(str::to_string);
        t
    }

    #[test]
    fn library_scope_narrows_cross_server_hits() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_with_lib("s1", "t1", "Aurora", "Anna", "Alb", Some("lib1")),
                track_with_lib("s2", "t2", "Aurora", "Beth", "Alb", Some("lib2")),
            ])
            .unwrap();
        set_phase(&store, "s1", "ready");
        set_phase(&store, "s2", "ready");
        let resp = run_cross_server_search(
            &store,
            "aurora",
            50,
            None,
            Some(&["lib1".to_string()]),
        )
        .unwrap();
        assert_eq!(resp.hits.len(), 1);
        assert_eq!(resp.hits[0].server_id, "s1");
    }

    #[test]
    fn union_searches_ready_servers_only() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora", "Anna", "Alb"),
                track("s2", "t2", "Aurora", "Beth", "Alb"),
                track("s3", "t3", "Aurora", "Cara", "Alb"),
            ])
            .unwrap();
        set_phase(&store, "s1", "ready");
        set_phase(&store, "s2", "ready");
        set_phase(&store, "s3", "idle"); // not ready → excluded
        let resp = run_cross_server_search(&store, "aurora", 50, None, None).unwrap();
        let servers: HashSet<&str> = resp.hits.iter().map(|t| t.server_id.as_str()).collect();
        assert_eq!(servers, HashSet::from(["s1", "s2"]));
        assert_eq!(resp.servers_searched.len(), 2);
    }

    #[test]
    fn explicit_servers_override_ready_gate() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s9", "t1", "Aurora", "Anna", "Alb")])
            .unwrap();
        // s9 is not marked ready, but an explicit servers list overrides.
        let resp = run_cross_server_search(&store, "aurora", 50, Some(&["s9".to_string()]), None).unwrap();
        assert_eq!(resp.hits.len(), 1);
        assert_eq!(resp.servers_searched, vec!["s9".to_string()]);
    }

    #[test]
    fn dedups_by_canonical_id() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora", "Anna", "Alb"),
                track("s2", "t2", "Aurora", "Anna", "Alb"),
            ])
            .unwrap();
        // Both tracks link to the same canonical id → one survives.
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO canonical_track (id, created_at, updated_at) VALUES ('can1', 1, 1)",
                    [],
                )?;
                for (s, t) in [("s1", "t1"), ("s2", "t2")] {
                    c.execute(
                        "INSERT INTO track_canonical_link \
                         (server_id, track_id, canonical_id, match_method, confidence, linked_at) \
                         VALUES (?1, ?2, 'can1', 'isrc', 1.0, 1)",
                        rusqlite::params![s, t],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        set_phase(&store, "s1", "ready");
        set_phase(&store, "s2", "ready");
        let resp = run_cross_server_search(&store, "aurora", 50, None, None).unwrap();
        assert_eq!(resp.hits.len(), 1, "duplicate canonical id collapses to one hit");
    }

    #[test]
    fn unlinked_rows_are_never_deduped() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Aurora", "Anna", "Alb"),
                track("s2", "t2", "Aurora", "Beth", "Alb"),
            ])
            .unwrap();
        set_phase(&store, "s1", "ready");
        set_phase(&store, "s2", "ready");
        // No canonical links → both kept even though titles match.
        let resp = run_cross_server_search(&store, "aurora", 50, None, None).unwrap();
        assert_eq!(resp.hits.len(), 2);
    }

    #[test]
    fn empty_query_returns_empty() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Aurora", "Anna", "Alb")])
            .unwrap();
        set_phase(&store, "s1", "ready");
        let resp = run_cross_server_search(&store, "   ", 50, None, None).unwrap();
        assert!(resp.hits.is_empty());
        assert!(resp.servers_searched.is_empty());
    }

    #[test]
    fn no_ready_servers_returns_empty() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Aurora", "Anna", "Alb")])
            .unwrap();
        // No sync_state row marked ready, and no explicit servers given.
        let resp = run_cross_server_search(&store, "aurora", 50, None, None).unwrap();
        assert!(resp.hits.is_empty());
        assert!(resp.servers_searched.is_empty());
    }

    // ── H3: fuzzy fallback (§5.9) ──────────────────────────────────────

    #[test]
    fn fuzzy_catches_titles_the_exact_pass_missed() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                // exact FTS term hit
                track("s1", "t1", "Aurora", "Anna", "Alb"),
                // FTS tokenizes to "auroras"/"borealis" → misses term "aurora";
                // LIKE %aurora% still catches it.
                track("s2", "t2", "Auroras Borealis", "Beth", "Alb"),
            ])
            .unwrap();
        set_phase(&store, "s1", "ready");
        set_phase(&store, "s2", "ready");
        let resp = run_cross_server_search(&store, "aurora", 50, None, None).unwrap();
        assert_eq!(resp.hits.len(), 1, "exact FTS hit");
        assert_eq!(resp.hits[0].id, "t1");
        assert_eq!(resp.fuzzy.len(), 1, "fuzzy catches the FTS miss");
        assert_eq!(resp.fuzzy[0].id, "t2");
    }

    #[test]
    fn fuzzy_excludes_exact_hits() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Aurora", "Anna", "Alb")])
            .unwrap();
        set_phase(&store, "s1", "ready");
        // "Aurora" is both an FTS hit and a LIKE match — must appear only once.
        let resp = run_cross_server_search(&store, "aurora", 50, None, None).unwrap();
        assert_eq!(resp.hits.len(), 1);
        assert!(resp.fuzzy.is_empty(), "exact hits are not repeated in fuzzy");
    }
}

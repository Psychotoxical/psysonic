//! Cross-server search (spec §5.5B / §5.9 A′). PR-5d ships the primary FTS
//! union; the fuzzy 0-hit fallback (§5.5B step C) lands additively with
//! cross-server matching in PR-4 (H3). UI wiring stays PR-7.

use std::collections::HashSet;

use rusqlite::types::Value as SqlValue;

use crate::dto::{LibraryCrossServerSearchResponse, LibraryTrackDto};
use crate::repos;
use crate::search::{aliased_track_columns, fts_query, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

/// `library_search_cross_server` (§5.5B / §5.9 A′). Primary FTS union over
/// the requested servers (or all `ready` servers), bm25-ordered, deduped by
/// canonical id where a `track_canonical_link` row exists.
pub fn run_cross_server_search(
    store: &LibraryStore,
    query: &str,
    limit: u32,
    servers: Option<&[String]>,
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

    let placeholders = vec!["?"; targets.len()].join(", ");
    let cols = aliased_track_columns("t");
    let sql = format!(
        "SELECT {cols}, l.canonical_id \
         FROM track_fts f \
         JOIN track t ON t.rowid = f.rowid \
         LEFT JOIN track_canonical_link l ON l.server_id = t.server_id AND l.track_id = t.id \
         WHERE track_fts MATCH ? AND t.deleted = 0 AND t.server_id IN ({placeholders}) \
         ORDER BY bm25(track_fts) LIMIT ?"
    );

    let mut params: Vec<SqlValue> = Vec::with_capacity(targets.len() + 2);
    params.push(SqlValue::Text(fts));
    for s in &targets {
        params.push(SqlValue::Text(s.clone()));
    }
    params.push(SqlValue::Integer(limit as i64));

    let canonical_idx = repos::track_columns().split(',').count();
    let rows: Vec<(LibraryTrackDto, Option<String>)> = store.with_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        // Bind the collected `Result` before unwrapping so the `MappedRows`
        // borrow of `stmt` ends inside the block (rusqlite borrow quirk).
        let collected: rusqlite::Result<Vec<(LibraryTrackDto, Option<String>)>> = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                let track = repos::row_to_track_row(r).map(|row| LibraryTrackDto::from_row(&row))?;
                let canonical: Option<String> = r.get(canonical_idx)?;
                Ok((track, canonical))
            })?
            .collect();
        collected
    })?;

    // Dedup by canonical id (§5.5B step 2). Rows with no canonical link are
    // always kept — pre-PR-4 the link table is sparse, so this is a no-op
    // for most rows.
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

    Ok(LibraryCrossServerSearchResponse {
        hits,
        servers_searched: targets,
    })
}

fn ready_servers(store: &LibraryStore) -> Result<Vec<String>, String> {
    store.with_conn(|conn| {
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
            .with_conn(|c| {
                c.execute(
                    "INSERT INTO sync_state (server_id, library_scope, sync_phase) \
                     VALUES (?1, '', ?2) \
                     ON CONFLICT(server_id, library_scope) DO UPDATE SET sync_phase = excluded.sync_phase",
                    rusqlite::params![server, phase],
                )
            })
            .unwrap();
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
        let resp = run_cross_server_search(&store, "aurora", 50, None).unwrap();
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
        let resp = run_cross_server_search(&store, "aurora", 50, Some(&["s9".to_string()])).unwrap();
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
            .with_conn(|c| {
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
        let resp = run_cross_server_search(&store, "aurora", 50, None).unwrap();
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
        let resp = run_cross_server_search(&store, "aurora", 50, None).unwrap();
        assert_eq!(resp.hits.len(), 2);
    }

    #[test]
    fn empty_query_returns_empty() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Aurora", "Anna", "Alb")])
            .unwrap();
        set_phase(&store, "s1", "ready");
        let resp = run_cross_server_search(&store, "   ", 50, None).unwrap();
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
        let resp = run_cross_server_search(&store, "aurora", 50, None).unwrap();
        assert!(resp.hits.is_empty());
        assert!(resp.servers_searched.is_empty());
    }
}

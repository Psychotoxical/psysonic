//! Local perf probes against a **copy** of a real library database.
//!
//! Ignored by default: they need a database this repository does not ship, and
//! they measure wall clock, which no CI machine can hold steady. Run one by
//! pointing `PSYSONIC_PERF_DB` at a copy of `library.sqlite` (with its
//! `library-cluster.db` sidecar beside it) and naming the test:
//!
//! ```text
//! PSYSONIC_PERF_DB=/path/to/copy/library.sqlite \
//!   cargo test -p psysonic-library --lib perf_probe -- --ignored --nocapture
//! ```
//!
//! Point it at a copy, never at the live file: opening runs migrations.
//!
//! These probes identify scopes by **index**, never by server address. Their
//! output ends up pasted into PRs and handoffs, and a hostname or IP from a real
//! user's library does not belong there.
//!
//! These exist because two stalls in a row (#1359 and #1360) were first
//! diagnosed wrong from reasoning alone. A query that
//! reads the whole `track` table looks fine on a seeded three-row test and
//! costs tens of seconds on a real one; nothing but a real one shows that.

use std::time::Instant;

use crate::dto::{LibraryAdvancedSearchRequest, LibraryScopePair, LibrarySortClause, SortDir};
use crate::filter::EntityKind;
use crate::store::LibraryStore;

fn probe_db_path() -> Option<std::path::PathBuf> {
    let raw = std::env::var("PSYSONIC_PERF_DB").ok()?;
    let path = std::path::PathBuf::from(raw);
    path.exists().then_some(path)
}

/// Every `(server_id, library_id)` pair that actually carries tracks, in the
/// order the browse UI would hand them over.
fn scopes_from_db(store: &LibraryStore) -> Vec<LibraryScopePair> {
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT server_id, library_id FROM track WHERE deleted = 0 \
                 ORDER BY server_id, library_id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(LibraryScopePair {
                        server_id: row.get(0)?,
                        library_id: row.get::<_, Option<String>>(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("scope pairs")
}

/// Index of the scope with the most live tracks — the one a stall shows up on.
fn largest_scope_index(store: &LibraryStore, scopes: &[LibraryScopePair]) -> usize {
    let mut best = (0usize, -1i64);
    for (index, scope) in scopes.iter().enumerate() {
        let count = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track \
                     WHERE server_id = ? AND library_id IS ? AND deleted = 0",
                    rusqlite::params![scope.server_id, scope.library_id],
                    |r| r.get::<_, i64>(0),
                )
            })
            .unwrap_or(0);
        if count > best.1 {
            best = (index, count);
        }
    }
    best.0
}

fn row_counts(store: &LibraryStore) -> (i64, i64, i64) {
    store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT COUNT(*) FROM track WHERE deleted = 0", [], |r| {
                    r.get(0)
                })?,
                conn.query_row("SELECT COUNT(*) FROM album", [], |r| r.get(0))?,
                conn.query_row("SELECT COUNT(*) FROM artist", [], |r| r.get(0))?,
            ))
        })
        .expect("row counts")
}

fn artist_browse_request(
    scopes: &[LibraryScopePair],
    limit: u32,
    offset: u32,
) -> LibraryAdvancedSearchRequest {
    LibraryAdvancedSearchRequest {
        server_id: scopes[0].server_id.clone(),
        library_scope: None,
        library_scopes: Some(scopes.to_vec()),
        query: None,
        entity_types: vec![EntityKind::Artist],
        filters: Vec::new(),
        starred_only: None,
        restrict_album_ids: None,
        query_album_title_only: None,
        sort: vec![LibrarySortClause {
            field: "name".to_string(),
            dir: SortDir::Asc,
        }],
        limit,
        offset,
        skip_totals: true,
        artist_credit_mode: None,
        artist_letter_bucket: None,
    }
}

/// What the Artists page does on entry: a small bootstrap chunk, then the tail,
/// then the pages the infinite scroller asks for.
#[test]
#[ignore = "needs PSYSONIC_PERF_DB pointing at a copy of a real library"]
fn artist_browse_first_chunks_on_a_real_library() {
    let Some(db) = probe_db_path() else {
        eprintln!("PSYSONIC_PERF_DB unset or missing — skipping");
        return;
    };
    let open_start = Instant::now();
    let store = LibraryStore::open_path_for_test(&db).expect("open probe db");
    eprintln!("open_ms={}", open_start.elapsed().as_millis());

    let (tracks, albums, artists) = row_counts(&store);
    let scopes = scopes_from_db(&store);
    eprintln!(
        "tracks={tracks} albums={albums} artists={artists} scopes={}",
        scopes.len(),
    );

    for (label, limit, offset) in [
        ("bootstrap", 30u32, 0u32),
        ("tail", 170, 30),
        ("page2", 200, 200),
    ] {
        let req = artist_browse_request(&scopes, limit, offset);
        let started = Instant::now();
        let result = crate::advanced_search::run_advanced_search(&store, &req).expect("search");
        eprintln!(
            "{label}: limit={limit} offset={offset} artists={} elapsed_ms={}",
            result.artists.len(),
            started.elapsed().as_millis(),
        );
    }
}

/// The local half of a deletion/gap census: our own album inventory, the set a
/// `getAlbumList2` page run would be diffed against. Its cost matters more than
/// the HTTP side — the requests are bounded by the page size, this query would
/// run on the shared read connection on a fixed cadence, and every browse
/// surface behind that mutex pays for it.
///
/// Reports per server by index, never by address.
#[test]
#[ignore = "needs PSYSONIC_PERF_DB pointing at a copy of a real library"]
fn album_census_inventory_on_a_real_library() {
    let Some(db) = probe_db_path() else {
        eprintln!("PSYSONIC_PERF_DB unset or missing — skipping");
        return;
    };
    let store = LibraryStore::open_path_for_test(&db).expect("open probe db");

    let servers: Vec<String> = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT server_id FROM track WHERE deleted = 0 ORDER BY server_id",
            )?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("server ids");

    // The aggregate the census deliberately does *not* use, kept as the
    // baseline the projection is measured against.
    const AGGREGATE_SQL: &str = "SELECT album_id, COUNT(*) AS song_count, \
         COALESCE(SUM(duration_sec), 0) AS total_duration \
         FROM track INDEXED BY idx_track_album \
         WHERE server_id = ?1 AND deleted = 0 \
           AND album_id IS NOT NULL AND album_id != '' \
         GROUP BY album_id";

    for (index, server) in servers.iter().enumerate() {
        let started = Instant::now();
        let inventory =
            crate::sync::census::local_album_inventory(&store, server).expect("inventory");
        let projection_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let aggregated = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(AGGREGATE_SQL)?;
                let rows = stmt
                    .query_map(rusqlite::params![server], |row| {
                        Ok(crate::sync::census::AlbumInventoryEntry {
                            album_id: row.get(0)?,
                            song_count: row.get(1)?,
                            duration_sec: row.get(2)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("aggregate");
        let aggregate_ms = started.elapsed().as_millis();

        // The projection is only a usable stand-in if it agrees with the rows
        // it summarises — a census run against a stale summary would invent
        // gaps and removal candidates out of nothing.
        let drift = crate::sync::census::diff_inventories(&inventory, &aggregated);
        let songs: i64 = inventory
            .iter()
            .filter_map(|entry| entry.song_count)
            .sum();
        eprintln!(
            "server {index}: albums={} songs={songs} pages_at_500={} \
             projection_ms={projection_ms} aggregate_ms={aggregate_ms} \
             drift(missing/absent)={}/{}",
            inventory.len(),
            inventory.len().div_ceil(500),
            drift.missing_locally.len(),
            drift.absent_on_server.len(),
        );
    }
}

/// The request the app actually sends on entering /artists: **one** scope, not
/// all of them. One pair takes `build_layer1_scope_artist`, a different branch
/// from the multi-scope merge above — measuring the wrong one is how the first
/// reading of this stall came out looking harmless.
#[test]
#[ignore = "needs PSYSONIC_PERF_DB pointing at a copy of a real library"]
fn artist_browse_single_scope_bootstrap_on_a_real_library() {
    let Some(db) = probe_db_path() else {
        eprintln!("PSYSONIC_PERF_DB unset or missing — skipping");
        return;
    };
    let store = LibraryStore::open_path_for_test(&db).expect("open probe db");
    let all = scopes_from_db(&store);

    for (index, scope) in all.iter().enumerate() {
        let one = vec![scope.clone()];
        // `chunkSize: 60` in the trace = ARTIST_BROWSE_BOOTSTRAP_CHUNK.
        let req = artist_browse_request(&one, 60, 0);
        let started = Instant::now();
        let result = crate::advanced_search::run_advanced_search(&store, &req).expect("search");
        eprintln!(
            "scope {index}: artists={} elapsed_ms={}",
            result.artists.len(),
            started.elapsed().as_millis(),
        );
    }
}

/// Splits the **layer-1** (single-scope) artist query, the one the app sends.
/// Two things in `list_index_artists_layer1_filtered` can run unbounded — the
/// cluster-key rebuild it calls first, and the `scoped_ids` join — and from the
/// outside they are indistinguishable.
#[test]
#[ignore = "needs PSYSONIC_PERF_DB pointing at a copy of a real library"]
fn artist_browse_layer1_phase_breakdown_on_a_real_library() {
    let Some(db) = probe_db_path() else {
        eprintln!("PSYSONIC_PERF_DB unset or missing — skipping");
        return;
    };
    let store = LibraryStore::open_path_for_test(&db).expect("open probe db");
    // Defaults to the scope holding the most tracks, which is the one worth
    // measuring. `PSYSONIC_PERF_SCOPE` picks a different index into the list.
    let all = scopes_from_db(&store);
    let index: usize = std::env::var("PSYSONIC_PERF_SCOPE")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or_else(|| largest_scope_index(&store, &all));
    let Some(scope) = all.get(index) else {
        eprintln!("no scope at index {index} — skipping");
        return;
    };
    let server = scope.server_id.clone();
    let library = scope.library_id.clone().unwrap_or_default();
    let scopes = vec![scope.clone()];
    eprintln!("scope index={index} of {}", all.len());

    let started = Instant::now();
    let cluster = crate::scope_merge::ensure_cluster_keys_for_scopes(&store, &scopes);
    eprintln!(
        "ensure_cluster_keys: ok={} elapsed_ms={}",
        cluster.is_ok(),
        started.elapsed().as_millis()
    );

    let scope_cte = "WITH scope(pr, server_id, library_id) AS (SELECT 0, ?, ?)";
    let album_scoped = format!(
        "{scope_cte}, album_scoped AS ( \
           SELECT t.album_id, \
                  COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
           FROM scope s \
           CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
           WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
           GROUP BY t.album_id \
         )"
    );

    let binds = rusqlite::params![server.clone(), library.clone(), server.clone()];
    let started = Instant::now();
    let credits: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                &format!("{album_scoped} SELECT COUNT(*) FROM album_scoped"),
                rusqlite::params![server.clone(), library.clone()],
                |r| r.get(0),
            )
        })
        .expect("album_scoped");
    eprintln!(
        "album_scoped: rows={credits} elapsed_ms={}",
        started.elapsed().as_millis()
    );

    // The join the app's request actually runs, taken from the shipped constant
    // so this probe cannot drift away from it. Its plan is printed before it is
    // executed, so the plan is on record even when the query does not return.
    let scoped_ids = format!(
        "{album_scoped} SELECT COUNT(*) FROM ( \
           SELECT DISTINCT ar.id \
           FROM album_scoped ac {} \
         )",
        crate::scope_merge::LAYER1_ARTIST_CREDIT_JOIN_SQL,
    );
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {scoped_ids}"))?;
            let rows = stmt
                .query_map(binds, |r| r.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for line in rows {
                eprintln!("plan: {line}");
            }
            Ok(())
        })
        .expect("plan");

    let started = Instant::now();
    let ids: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                &scoped_ids,
                rusqlite::params![server.clone(), library.clone(), server.clone()],
                |r| r.get(0),
            )
        })
        .expect("scoped_ids");
    eprintln!(
        "scoped_ids: rows={ids} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}

/// Splits the multi-scope artist query into the pieces it is built from, so a
/// slow total can be attributed instead of guessed at.
#[test]
#[ignore = "needs PSYSONIC_PERF_DB pointing at a copy of a real library"]
fn artist_browse_phase_breakdown_on_a_real_library() {
    let Some(db) = probe_db_path() else {
        eprintln!("PSYSONIC_PERF_DB unset or missing — skipping");
        return;
    };
    let store = LibraryStore::open_path_for_test(&db).expect("open probe db");
    let scopes = scopes_from_db(&store);

    let scope_values: Vec<String> = scopes
        .iter()
        .map(|s| {
            format!(
                "('{}', {})",
                s.server_id.replace('\'', "''"),
                match &s.library_id {
                    Some(id) => format!("'{}'", id.replace('\'', "''")),
                    None => "NULL".to_string(),
                },
            )
        })
        .collect();
    let scope_rows = scope_values
        .iter()
        .enumerate()
        .map(|(i, v)| format!("SELECT {i} AS pr, * FROM (VALUES {v})"))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    let scope_cte = format!(
        "WITH scope(pr, server_id, library_id) AS ({scope_rows})"
    );

    let phases: [(&str, String); 4] = [
        (
            "count_scoped_tracks",
            format!(
                "{scope_cte} SELECT COUNT(*) FROM scope s \
                 CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
                 WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != ''"
            ),
        ),
        (
            "album_credits_cte",
            format!(
                "{scope_cte}, album_credits AS ( \
                   SELECT t.server_id, t.album_id, s.pr, \
                          COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
                   FROM scope s \
                   CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
                   WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
                   GROUP BY t.server_id, t.album_id, s.pr \
                 ) SELECT COUNT(*) FROM album_credits"
            ),
        ),
        (
            "matched_join_artist",
            format!(
                "{scope_cte}, album_credits AS ( \
                   SELECT t.server_id, t.album_id, s.pr, \
                          COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
                   FROM scope s \
                   CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
                   WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
                   GROUP BY t.server_id, t.album_id, s.pr \
                 ) SELECT COUNT(*) FROM album_credits ac \
                   INNER JOIN artist ar ON ar.server_id = ac.server_id \
                     AND ar.name_fold = psysonic_lower_name(ac.credit_name) \
                   WHERE ar.album_count IS NOT NULL"
            ),
        ),
        (
            "artist_table_only",
            "SELECT COUNT(*) FROM artist WHERE album_count IS NOT NULL".to_string(),
        ),
    ];

    for (label, sql) in phases {
        let started = Instant::now();
        let count: i64 = store
            .with_read_conn(|conn| conn.query_row(&sql, [], |r| r.get(0)))
            .expect(label);
        eprintln!(
            "{label}: rows={count} elapsed_ms={}",
            started.elapsed().as_millis()
        );
    }

    let plan_sql = format!(
        "{scope_cte}, album_credits AS ( \
           SELECT t.server_id, t.album_id, s.pr, \
                  COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
           FROM scope s \
           CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
           WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
           GROUP BY t.server_id, t.album_id, s.pr \
         ) SELECT COUNT(*) FROM album_credits"
    );
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {plan_sql}"))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for line in rows {
                eprintln!("plan: {line}");
            }
            Ok(())
        })
        .expect("plan");
}

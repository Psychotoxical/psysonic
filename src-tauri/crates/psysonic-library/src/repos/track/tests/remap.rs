use rusqlite::params;

use super::super::remap::{REMAP_LOOKUP_BY_HASH_SQL, REMAP_LOOKUP_BY_PATH_SQL};
use super::*;

fn row_with_id_hash(server: &str, id: &str, hash: &str, path: &str) -> TrackRow {
    let mut r = row(server, id, "Title");
    r.content_hash = if hash.is_empty() {
        None
    } else {
        Some(hash.into())
    };
    r.server_path = if path.is_empty() {
        None
    } else {
        Some(path.into())
    };
    r
}

#[test]
fn remap_disabled_never_records_history_even_on_hash_collision() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "deadbeef", "")])
        .unwrap();

    // Generic Subsonic path: caller passes `unstable_track_ids = false`.
    let stats = repo
        .upsert_batch_with_remap(&[row_with_id_hash("s1", "tr_new", "deadbeef", "")], false)
        .unwrap();
    assert!(stats.remapped.is_empty());

    let track_count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    let hist_count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track_id_history", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(track_count, 2, "both ids coexist when remap is off");
    assert_eq!(hist_count, 0);
}

#[test]
fn remap_via_content_hash_replaces_old_row_and_records_history() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    // Seed with the old id; child tables get a row each that must
    // follow the remap.
    repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "deadbeef", "/path/x.flac")])
        .unwrap();
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO track_offline \
                 (server_id, track_id, local_path, cached_at) \
                 VALUES ('s1', 'tr_old', '/local/x.flac', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO track_extension \
                 (server_id, track_id, kind, payload, updated_at) \
                 VALUES ('s1', 'tr_old', 'user_note', X'7B7D', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let stats = repo
        .upsert_batch_with_remap(
            &[row_with_id_hash("s1", "tr_new", "deadbeef", "/path/x.flac")],
            true,
        )
        .unwrap();
    assert_eq!(stats.remapped.len(), 1);
    assert_eq!(stats.remapped[0].old_id, "tr_old");
    assert_eq!(stats.remapped[0].new_id, "tr_new");

    // Old track row gone, new one in place.
    let ids: Vec<String> = store
        .with_conn("misc", |c| {
            let mut stmt = c.prepare("SELECT id FROM track WHERE server_id = 's1'")?;
            let r: rusqlite::Result<Vec<String>> = stmt.query_map([], |r| r.get(0))?.collect();
            r
        })
        .unwrap();
    assert_eq!(ids, vec!["tr_new"]);

    // Child tables follow the new id.
    let offline_id: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT track_id FROM track_offline WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(offline_id, "tr_new");
    let ext_id: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT track_id FROM track_extension WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(ext_id, "tr_new");

    // History row recorded.
    let hist = crate::repos::TrackIdHistoryRepository::new(&store);
    assert_eq!(
        hist.lookup_new_id("s1", "tr_old").unwrap().as_deref(),
        Some("tr_new")
    );
}

#[test]
fn remap_via_server_path_only_works_when_hash_missing() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "", "/path/y.mp3")])
        .unwrap();
    // Server only ships server_path on the new row — no hash yet.
    let stats = repo
        .upsert_batch_with_remap(&[row_with_id_hash("s1", "tr_new", "", "/path/y.mp3")], true)
        .unwrap();
    assert_eq!(stats.remapped.len(), 1, "path-based remap must trigger");
}

#[test]
fn remap_skips_when_neither_hash_nor_path_present() {
    // Defensive: empty-string sentinels must not cause spurious
    // remaps across unrelated rows that happen to lack hash + path.
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[row_with_id_hash("s1", "tr_old", "", "")])
        .unwrap();
    let stats = repo
        .upsert_batch_with_remap(&[row_with_id_hash("s1", "tr_new", "", "")], true)
        .unwrap();
    assert!(stats.remapped.is_empty());
    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM track", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(count, 2, "both rows kept; identity-less rows can't shadow");
}

#[test]
fn remap_lookup_uses_partial_indexes_not_full_scan() {
    // Regression: the §6.9 remap lookup must hit
    // idx_track_remap_hash / idx_track_remap_path. The prior
    // `OR`-based query fell back to a full `track` scan on every
    // incoming row → O(rows × catalog) stalls on large libraries
    // (`upsert_batch_remap exec_ms=162001` on a ~200k-track Navidrome sync).
    let store = LibraryStore::open_in_memory();
    let plan = |sql: &str| -> String {
        store
            .with_conn("misc", |c| {
                let mut stmt = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let rows: rusqlite::Result<Vec<String>> = stmt
                    .query_map(params!["s1", "v", "id"], |r| r.get::<_, String>(3))?
                    .collect();
                rows
            })
            .unwrap()
            .join("\n")
    };

    let hash_plan = plan(REMAP_LOOKUP_BY_HASH_SQL);
    assert!(
        hash_plan.contains("idx_track_remap_hash"),
        "hash lookup must use idx_track_remap_hash, got: {hash_plan}"
    );
    assert!(
        !hash_plan.contains("SCAN"),
        "hash lookup must not full-scan track, got: {hash_plan}"
    );

    let path_plan = plan(REMAP_LOOKUP_BY_PATH_SQL);
    assert!(
        path_plan.contains("idx_track_remap_path"),
        "path lookup must use idx_track_remap_path, got: {path_plan}"
    );
    assert!(
        !path_plan.contains("SCAN"),
        "path lookup must not full-scan track, got: {path_plan}"
    );
}

#[test]
fn remap_is_noop_when_new_id_matches_existing_id() {
    // Standard delta-sync: same id, same hash. Must not trigger
    // remap (SELECT excludes id = T.id).
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[row_with_id_hash("s1", "tr_1", "h", "/p")])
        .unwrap();
    let stats = repo
        .upsert_batch_with_remap(&[row_with_id_hash("s1", "tr_1", "h", "/p")], true)
        .unwrap();
    assert!(stats.remapped.is_empty());
}

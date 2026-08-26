use rusqlite::params;
use serde_json::json;

use super::super::remap::{REMAP_LOOKUP_BY_HASH_SQL, REMAP_LOOKUP_BY_PATH_SQL};
use super::super::retarget::retarget_track_references;
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
fn sparse_remap_merges_from_resolved_old_row_before_deleting_it() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);

    let mut old = row_with_id_hash("s1", "tr_old", "deadbeef", "/path/x.flac");
    old.raw_json = json!({
        "id": "tr_old",
        "artist": "FOVOS, Max Cardona",
        "artists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ],
        "albumArtists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ],
        "displayArtist": "FOVOS, Max Cardona"
    })
    .to_string();
    repo.upsert_batch(&[old]).unwrap();

    let mut incoming = row_with_id_hash("s1", "tr_new", "deadbeef", "/path/x.flac");
    incoming.raw_json = json!({
        "id": "tr_new",
        "artist": "FOVOS, Someone Else",
        "artists": [
            { "id": "fovos", "name": "FOVOS" },
            { "id": "someone-else", "name": "Someone Else" }
        ],
        "displayArtist": "FOVOS, Someone Else"
    })
    .to_string();

    let stats = repo
        .upsert_sparse_batch_with_remap(&[incoming], true)
        .unwrap();
    assert_eq!(stats.remapped.len(), 1);

    let raw: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 'tr_new'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();

    // Present current credits replace the old array and display value.
    assert_eq!(
        raw["artists"],
        json!([
            { "id": "fovos", "name": "FOVOS" },
            { "id": "someone-else", "name": "Someone Else" }
        ])
    );
    assert_eq!(raw["displayArtist"], json!("FOVOS, Someone Else"));
    // Truly absent rich fields survive from the old id across the remap.
    assert_eq!(
        raw["albumArtists"],
        json!([
            { "id": "fovos", "name": "FOVOS" },
            { "id": "max-cardona", "name": "Max Cardona" }
        ])
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

#[test]
fn retarget_merges_colliding_preserved_references_without_dropping_history() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[
        row_with_id_hash("s1", "tr_old", "same", "/music/x.flac"),
        row_with_id_hash("s1", "tr_new", "same", "/music/x.flac"),
    ])
    .unwrap();
    store
        .with_conn("test.seed_retarget_collisions", |conn| {
            conn.execute_batch(
                "INSERT INTO canonical_track(id, created_at, updated_at) VALUES ('canonical-1', 1, 1);
                 INSERT INTO track_canonical_link(server_id, track_id, canonical_id, match_method, confidence, linked_at)
                   VALUES ('s1', 'tr_old', 'canonical-1', 'path', 0.8, 2),
                          ('s1', 'tr_new', 'canonical-1', 'isrc', 0.9, 1);
                 INSERT INTO entity_user_rating(server_id, entity_kind, entity_id, rating, fetched_at)
                   VALUES ('s1', 'track', 'tr_old', 5, 20),
                          ('s1', 'track', 'tr_new', 3, 10);
                 INSERT INTO play_session(server_id, track_id, started_at_ms, listened_sec,
                   position_max_sec, completion, end_reason)
                   VALUES ('s1', 'tr_old', 1, 1, 1, 'full', 'ended'),
                          ('s1', 'tr_new', 2, 1, 1, 'full', 'ended');
                 INSERT INTO track_id_history(server_id, old_id, new_id, remapped_at)
                   VALUES ('s1', 'older', 'tr_old', 1);",
            )?;
            Ok(())
        })
        .unwrap();

    store
        .with_conn_mut("test.retarget_collisions", |conn| {
            let tx = conn.transaction()?;
            retarget_track_references(
                &tx,
                "s1",
                "tr_old",
                "tr_new",
                Some("same"),
                Some("/music/x.flac"),
                30,
            )?;
            tx.commit()
        })
        .unwrap();

    store
        .with_conn("test.verify_retarget_collisions", |conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM play_session WHERE server_id = 's1' AND track_id = 'tr_new'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                2
            );
            assert_eq!(
                conn.query_row(
                    "SELECT rating FROM entity_user_rating WHERE server_id = 's1' AND entity_kind = 'track' AND entity_id = 'tr_new'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                5
            );
            assert_eq!(
                conn.query_row(
                    "SELECT new_id FROM track_id_history WHERE server_id = 's1' AND old_id = 'older'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
                "tr_new"
            );
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = 's1' AND id = 'tr_old'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn retarget_rolls_back_conflicting_canonical_identity() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[
        row_with_id_hash("s1", "tr_old", "same", "/music/x.flac"),
        row_with_id_hash("s1", "tr_new", "same", "/music/x.flac"),
    ])
    .unwrap();
    store
        .with_conn("test.seed_retarget_conflict", |conn| {
            conn.execute_batch(
                "INSERT INTO canonical_track(id, created_at, updated_at) VALUES
                   ('canonical-1', 1, 1), ('canonical-2', 1, 1);
                 INSERT INTO track_canonical_link(server_id, track_id, canonical_id, match_method, confidence, linked_at)
                   VALUES ('s1', 'tr_old', 'canonical-1', 'path', 0.8, 1),
                          ('s1', 'tr_new', 'canonical-2', 'isrc', 0.9, 1);",
            )?;
            Ok(())
        })
        .unwrap();

    let error = store
        .with_conn_mut("test.retarget_conflict", |conn| {
            let tx = conn.transaction()?;
            retarget_track_references(
                &tx,
                "s1",
                "tr_old",
                "tr_new",
                Some("same"),
                Some("/music/x.flac"),
                2,
            )?;
            tx.commit()
        })
        .unwrap_err();
    assert!(error.contains("canonical track link conflict"));
    assert_eq!(
        store
            .with_conn("test.verify_retarget_rollback", |conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track WHERE server_id = 's1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .unwrap(),
        2
    );
}

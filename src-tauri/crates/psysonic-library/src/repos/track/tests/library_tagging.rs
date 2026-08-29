use psysonic_integration::subsonic::AlbumSummary;
use rusqlite::params;
use serde_json::json;

use super::*;

fn album_summary(id: &str, version: Option<&str>) -> AlbumSummary {
    serde_json::from_value(json!({
        "id": id,
        "name": "Album",
        "version": version,
    }))
    .unwrap()
}

#[test]
fn apply_album_list_page_fills_only_empty_library_rows() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut tagged = row("s1", "t1", "First");
    tagged.library_id = Some("9".into());
    tagged.album_id = Some("al1".into());
    let mut empty = row("s1", "t2", "Second");
    empty.album_id = Some("al1".into());
    empty.library_id = None;
    let mut other_album = row("s1", "t3", "Third");
    other_album.album_id = Some("al2".into());
    other_album.library_id = None;
    repo.upsert_batch(&[tagged, empty, other_album]).unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    let n = repo
        .apply_album_list_page(
            "s1",
            "1",
            &[album_summary("al1", None), album_summary("al2", None)],
        )
        .unwrap();
    assert_eq!(n, 2);

    let read = |id: &str| -> Option<String> {
        store
            .with_read_conn(|c| {
                c.query_row(
                    "SELECT library_id FROM track WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };
    assert_eq!(read("t1").as_deref(), Some("9"));
    assert_eq!(read("t2").as_deref(), Some("1"));
    assert_eq!(read("t3").as_deref(), Some("1"));

    let (empty_projection, tagged_projection, identity_tagged, genre_tagged): (i64, i64, i64, i64) =
        store
            .with_read_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM album_browse_projection WHERE library_id = ''",
                        [],
                        |r| r.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM album_browse_projection WHERE library_id = '1'",
                        [],
                        |r| r.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM cluster.track_cluster_key \
                     WHERE track_id IN ('t2', 't3') AND library_id = '1'",
                        [],
                        |r| r.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM track_genre \
                     WHERE track_id IN ('t2', 't3') AND library_id = '1'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
    assert_eq!(empty_projection, 0);
    assert_eq!(tagged_projection, 2);
    assert_eq!(identity_tagged, 2);
    assert_eq!(genre_tagged, 2);
}

#[test]
fn apply_album_list_page_with_no_new_metadata_is_write_free() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut tagged = row("s1", "t1", "First");
    tagged.library_id = Some("1".into());
    tagged.album_id = Some("al1".into());
    repo.upsert_batch(&[tagged]).unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();
    let before = store
        .with_conn("test.total_changes", |conn| Ok(conn.total_changes()))
        .unwrap();

    let changed = repo
        .apply_album_list_page("s1", "1", &[album_summary("al1", None)])
        .unwrap();

    let after = store
        .with_conn("test.total_changes", |conn| Ok(conn.total_changes()))
        .unwrap();
    assert_eq!(changed, 0);
    assert_eq!(after, before);
}

#[test]
fn apply_album_list_page_preserves_album_version_and_invalidates_identity() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut track = row("s1", "t1", "First");
    track.album_id = Some("al1".into());
    track.raw_json = r#"{"replayGain":{"trackGain":-1.2}}"#.into();
    repo.upsert_batch(&[track]).unwrap();
    store
        .with_conn_mut("test.seed_album_version", |conn| {
            conn.execute(
                "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                 VALUES ( \
                   's1', 'al1', 'An Album', 1, \
                   '{\"version\":\"Standard\",\"_psysonicAlbumVersionFromList\":true}' \
                 )",
                [],
            )
        })
        .unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    repo.apply_album_list_page(
        "s1",
        "1",
        &[album_summary("al1", Some("Deluxe Edition"))],
    )
    .unwrap();

    let (raw, album_raw, pending): (String, String, i64) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't1'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM identity_invalidation \
                     WHERE server_id = 's1' AND kind = 'album' AND entity_id = 'al1'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let album_raw: serde_json::Value = serde_json::from_str(&album_raw).unwrap();
    assert_eq!(raw["albumVersion"], json!("Deluxe Edition"));
    assert_eq!(raw["replayGain"]["trackGain"], json!(-1.2));
    assert_eq!(album_raw["version"], json!("Deluxe Edition"));
    assert_eq!(pending, 1);

    store
        .with_conn_mut("test.clear_album_version_invalidation", |conn| {
            conn.execute("DELETE FROM identity_invalidation", [])
        })
        .unwrap();
    repo.apply_album_list_page("s1", "1", &[album_summary("al1", None)])
        .unwrap();
    let (raw, album_raw, pending): (String, String, i64) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't1'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM identity_invalidation \
                     WHERE server_id = 's1' AND kind = 'album' AND entity_id = 'al1'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let album_raw: serde_json::Value = serde_json::from_str(&album_raw).unwrap();
    assert!(raw.get("albumVersion").is_none());
    assert!(album_raw.get("version").is_none());
    assert_eq!(pending, 1);
}

#[test]
fn absent_summary_version_keeps_richer_unmarked_track_metadata() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut track = row("s1", "t1", "First");
    track.album_id = Some("al1".into());
    track.raw_json = r#"{"albumVersion":"From getAlbum"}"#.into();
    repo.upsert_batch(&[track]).unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    repo.apply_album_list_page("s1", "1", &[album_summary("al1", None)])
        .unwrap();
    repo.apply_album_list_page(
        "s1",
        "1",
        &[album_summary("al1", Some("Different summary"))],
    )
    .unwrap();

    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(raw["albumVersion"], json!("From getAlbum"));
}

#[test]
fn sparse_authoritative_versions_clear_list_provenance() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut top_level = row("s1", "top", "Top");
    top_level.album_id = Some("al1".into());
    let mut tag_only = row("s1", "tag", "Tag");
    tag_only.album_id = Some("al2".into());
    repo.upsert_batch(&[top_level, tag_only]).unwrap();
    repo.apply_album_list_page(
        "s1",
        "1",
        &[
            album_summary("al1", Some("From list")),
            album_summary("al2", Some("From list")),
        ],
    )
    .unwrap();

    let mut top_level = row("s1", "top", "Top");
    top_level.album_id = Some("al1".into());
    top_level.raw_json = json!({
        "id": "top",
        "albumVersion": "Authoritative top"
    })
    .to_string();
    let mut tag_only = row("s1", "tag", "Tag");
    tag_only.album_id = Some("al2".into());
    tag_only.raw_json = json!({
        "id": "tag",
        "tags": { "albumversion": ["Authoritative tag"] }
    })
    .to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[top_level, tag_only], None)
        .unwrap();

    repo.apply_album_list_page(
        "s1",
        "1",
        &[
            album_summary("al1", Some("Changed list")),
            album_summary("al2", Some("Changed list")),
        ],
    )
    .unwrap();
    repo.apply_album_list_page(
        "s1",
        "1",
        &[album_summary("al1", None), album_summary("al2", None)],
    )
    .unwrap();

    let raw = |id: &str| -> serde_json::Value {
        let raw: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT raw_json FROM track WHERE server_id = 's1' AND id = ?1",
                    [id],
                    |row| row.get(0),
                )
            })
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    let top_level = raw("top");
    assert_eq!(top_level["albumVersion"], json!("Authoritative top"));
    assert!(top_level.get("_psysonicAlbumVersionFromList").is_none());
    assert!(top_level
        .get("_psysonicAlbumVersionNeedsListRefresh")
        .is_none());
    let tag_only = raw("tag");
    assert_eq!(tag_only["albumVersion"], json!("Authoritative tag"));
    assert_eq!(
        tag_only["tags"]["albumversion"][0],
        json!("Authoritative tag")
    );
    assert!(tag_only.get("_psysonicAlbumVersionFromList").is_none());
}

#[test]
fn authoritative_tracks_outrank_list_marked_album_rows_for_identity() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut top_level = row("s1", "top", "Top");
    top_level.album_id = Some("al1".into());
    top_level.raw_json = json!({ "albumVersion": "Authoritative top" }).to_string();
    let mut tag_only = row("s1", "tag", "Tag");
    tag_only.album_id = Some("al2".into());
    tag_only.raw_json = json!({
        "tags": { "albumversion": ["Authoritative tag"] }
    })
    .to_string();
    repo.upsert_batch(&[top_level, tag_only]).unwrap();
    store
        .with_conn_mut("test.seed_list_album_rows", |conn| {
            for album_id in ["al1", "al2"] {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                     VALUES ( \
                       's1', ?1, 'An Album', 1, \
                       '{\"version\":\"From list\",\"_psysonicAlbumVersionFromList\":true}' \
                     )",
                    [album_id],
                )?;
            }
            Ok(())
        })
        .unwrap();

    repo.apply_album_list_page(
        "s1",
        "lib-1",
        &[
            album_summary("al1", Some("Changed list")),
            album_summary("al2", Some("Changed list")),
        ],
    )
    .unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    let key = |track_id: &str| -> String {
        store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT album_key FROM cluster.track_cluster_key \
                     WHERE server_id = 's1' AND track_id = ?1",
                    [track_id],
                    |row| row.get(0),
                )
            })
            .unwrap()
    };
    assert_eq!(
        key("top"),
        crate::identity::build_album_key_with_version(
            Some("The Artist"),
            "An Album",
            Some("Authoritative top")
        )
        .unwrap()
    );
    assert_eq!(
        key("tag"),
        crate::identity::build_album_key_with_version(
            Some("The Artist"),
            "An Album",
            Some("Authoritative tag")
        )
        .unwrap()
    );

    repo.apply_album_list_page(
        "s1",
        "lib-1",
        &[album_summary("al1", None), album_summary("al2", None)],
    )
    .unwrap();
    crate::identity::ensure_cluster_keys_built(&store, "s1").unwrap();
    assert_eq!(
        key("top"),
        crate::identity::build_album_key_with_version(
            Some("The Artist"),
            "An Album",
            Some("Authoritative top")
        )
        .unwrap()
    );
    assert_eq!(
        key("tag"),
        crate::identity::build_album_key_with_version(
            Some("The Artist"),
            "An Album",
            Some("Authoritative tag")
        )
        .unwrap()
    );
}

#[test]
fn absent_summary_preserves_unmarked_get_album_metadata() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut track = row("s1", "t1", "First");
    track.synced_at = 10;
    repo.upsert_batch(&[track]).unwrap();
    store
        .with_conn_mut("test.seed_get_album_version", |conn| {
            conn.execute(
                "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                 VALUES ('s1', 'al1', 'An Album', 1, '{\"version\":\"getAlbum only\"}')",
                [],
            )
        })
        .unwrap();

    repo.apply_album_list_page("s1", "lib-1", &[album_summary("al1", None)])
        .unwrap();

    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&raw).unwrap()["version"],
        json!("getAlbum only")
    );
}

#[test]
fn sparse_omission_is_healed_by_the_next_album_list_page() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut track = row("s1", "t1", "First");
    track.album_id = Some("al1".into());
    track.raw_json = json!({
        "tags": { "albumversion": ["", "Stale"] }
    })
    .to_string();
    repo.upsert_batch(&[track]).unwrap();

    let mut sparse = row("s1", "t1", "First");
    sparse.album_id = Some("al1".into());
    sparse.raw_json = json!({ "id": "t1", "title": "First" }).to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[sparse], None)
        .unwrap();

    repo.apply_album_list_page("s1", "1", &[album_summary("al1", Some("Fresh"))])
        .unwrap();
    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(raw["albumVersion"], json!("Fresh"));
    assert_eq!(raw["_psysonicAlbumVersionFromList"], json!(true));
    assert!(raw
        .get("_psysonicAlbumVersionNeedsListRefresh")
        .is_none());

    repo.apply_album_list_page("s1", "1", &[album_summary("al1", None)])
        .unwrap();
    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(raw.get("albumVersion").is_none());
    assert!(raw.get("_psysonicAlbumVersionFromList").is_none());
}

#[test]
fn authoritative_top_level_clear_removes_stale_tag_fallback() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut track = row("s1", "t1", "First");
    track.raw_json = json!({
        "tags": { "albumversion": ["Stale tag"] },
        "_psysonicAlbumVersionNeedsListRefresh": true
    })
    .to_string();
    repo.upsert_batch(&[track]).unwrap();

    let mut cleared = row("s1", "t1", "First");
    cleared.raw_json = json!({
        "id": "t1",
        "albumVersion": null,
        "tags": { "albumversion": ["Incoming fallback"] }
    })
    .to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[cleared], None)
        .unwrap();

    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(raw.get("albumVersion").is_none());
    assert!(raw.pointer("/tags/albumversion").is_none());
    assert!(raw
        .get("_psysonicAlbumVersionNeedsListRefresh")
        .is_none());

    let mut newly_inserted = row("s1", "t2", "Second");
    newly_inserted.raw_json = json!({
        "id": "t2",
        "albumVersion": null,
        "tags": { "albumversion": ["Incoming fallback"] }
    })
    .to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[newly_inserted], None)
        .unwrap();
    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT raw_json FROM track WHERE server_id = 's1' AND id = 't2'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(raw.get("albumVersion").is_none());
    assert!(raw.pointer("/tags/albumversion").is_none());
}

#[test]
fn absent_summary_ignores_malformed_json_in_related_rows() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    store
        .with_conn_mut("test.seed_malformed_album_version", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, album_id, synced_at, raw_json) \
                 VALUES ('s1', 't1', 'Track', 'al1', 2, 'not-json')",
                [],
            )?;
            conn.execute(
                "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                 VALUES ( \
                   's1', 'al1', 'Album', 1, \
                   '{\"version\":\"List\",\"_psysonicAlbumVersionFromList\":true}' \
                 )",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    repo.apply_album_list_page("s1", "1", &[album_summary("al1", None)])
        .unwrap();

    let (track_raw, album_raw): (String, String) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT raw_json FROM track WHERE id = 't1'", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT raw_json FROM album WHERE id = 'al1'", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .unwrap();
    assert_eq!(track_raw, "not-json");
    assert!(serde_json::from_str::<serde_json::Value>(&album_raw)
        .unwrap()
        .get("version")
        .is_none());
}

#[test]
fn versioned_summary_repairs_malformed_json_without_aborting() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    store
        .with_conn_mut("test.seed_malformed_version_rows", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, album_id, synced_at, raw_json) \
                 VALUES ('s1', 't1', 'Track', 'al1', 2, 'not-json')",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album_id, synced_at, raw_json) \
                 VALUES ('s1', 't2', 'Track', 'al2', 2, 'null')",
                [],
            )?;
            conn.execute(
                "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                 VALUES ('s1', 'al1', 'Album', 1, 'not-json')",
                [],
            )?;
            conn.execute(
                "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                 VALUES ('s1', 'al2', 'Album', 1, '[]')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    repo.apply_album_list_page(
        "s1",
        "1",
        &[
            album_summary("al1", Some("Repaired")),
            album_summary("al2", Some("Repaired")),
        ],
    )
    .unwrap();

    let (track_raw, album_raw): (String, String) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT raw_json FROM track WHERE id = 't1'", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT raw_json FROM album WHERE id = 'al1'", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&track_raw).unwrap()["albumVersion"],
        json!("Repaired")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&album_raw).unwrap()["version"],
        json!("Repaired")
    );
    let (track_raw, album_raw): (String, String) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT raw_json FROM track WHERE id = 't2'", [], |row| {
                    row.get(0)
                })?,
                conn.query_row("SELECT raw_json FROM album WHERE id = 'al2'", [], |row| {
                    row.get(0)
                })?,
            ))
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&track_raw).unwrap()["albumVersion"],
        json!("Repaired")
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&album_raw).unwrap()["version"],
        json!("Repaired")
    );
}

#[test]
fn count_untagged_tracks_excludes_deleted_and_populated_rows() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut tagged = row("s1", "t1", "First");
    tagged.library_id = Some("1".into());
    let mut empty = row("s1", "t2", "Second");
    empty.library_id = None;
    let mut deleted = row("s1", "t3", "Third");
    deleted.library_id = None;
    deleted.deleted = true;
    repo.upsert_batch(&[tagged, empty, deleted]).unwrap();
    assert_eq!(repo.count_untagged_tracks("s1").unwrap(), 1);
}

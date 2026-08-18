use std::sync::Arc;

use crate::repos::TrackRepository;
use crate::runtime::LibraryRuntime;
use crate::store::LibraryStore;

use super::{
    apply_album_patch, catalog_year_bounds_for_server, genre_album_counts_for_server,
    overlay_album_artist_links, overlay_album_level_starred_at, reconcile_album_stars,
    StarredAlbumReconcileItem,
};
use crate::dto::LibraryAlbumDto;

fn make_row(server: &str, id: &str, album_id: &str, track: i64) -> crate::repos::TrackRow {
    crate::repos::TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: format!("T{id}"),
        title_sort: None,
        artist: Some("A".into()),
        artist_id: Some("ar".into()),
        album: album_id.into(),
        album_id: Some(album_id.into()),
        album_artist: None,
        duration_sec: 200,
        track_number: Some(track),
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

fn runtime(store: Arc<LibraryStore>) -> LibraryRuntime {
    LibraryRuntime::new(store)
}

#[test]
fn apply_album_patch_sets_and_clears_starred_at() {
    let store = Arc::new(LibraryStore::open_in_memory());
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', NULL, 1, '{}')",
                [],
            )
        })
        .unwrap();
    let rt = runtime(store.clone());
    apply_album_patch(&rt, "s1", "al1", &serde_json::json!({ "starredAt": 1700 })).unwrap();
    let starred: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(starred, Some(1700));

    apply_album_patch(&rt, "s1", "al1", &serde_json::json!({ "starredAt": null })).unwrap();
    let cleared: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(cleared, None);
    let raw: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(!raw.contains("starred"));
}

#[test]
fn apply_album_patch_clears_stale_starred_in_raw_json() {
    let store = Arc::new(LibraryStore::open_in_memory());
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', 100, 1, \
                     '{\"id\":\"al1\",\"starred\":\"2024-01-01T00:00:00Z\"}')",
                [],
            )
        })
        .unwrap();
    let rt = runtime(store.clone());
    apply_album_patch(&rt, "s1", "al1", &serde_json::json!({ "starredAt": null })).unwrap();
    let raw: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(parsed.get("starred").is_none());
}

#[test]
fn overlay_album_level_starred_at_ignores_track_stars() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[make_row("s1", "tr_1", "al1", 1)])
        .unwrap();
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE track SET starred_at = 999 WHERE server_id = 's1' AND id = 'tr_1'",
                [],
            )?;
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', NULL, 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let mut albums = vec![LibraryAlbumDto {
        server_id: "s1".into(),
        id: "al1".into(),
        name: "Album".into(),
        artist: None,
        artist_id: None,
        song_count: Some(1),
        duration_sec: Some(200),
        year: None,
        genre: None,
        cover_art_id: None,
        starred_at: Some(999),
        synced_at: 1,
        raw_json: serde_json::Value::Null,
    }];
    overlay_album_level_starred_at(&store, "s1", &mut albums).unwrap();
    assert_eq!(albums[0].starred_at, None);

    apply_album_patch(
        &runtime(store.clone()),
        "s1",
        "al1",
        &serde_json::json!({ "starredAt": 1700 }),
    )
    .unwrap();
    overlay_album_level_starred_at(&store, "s1", &mut albums).unwrap();
    assert_eq!(albums[0].starred_at, Some(1700));
}

#[test]
fn reconcile_album_stars_clears_stale_and_sets_existing_rows() {
    let store = Arc::new(LibraryStore::open_in_memory());
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al_old', 'Old', 1, 1, '{}'), \
                            ('s1', 'al_keep', 'Keep', 1, 1, '{}'), \
                            ('s1', 'al_new', 'New', NULL, 1, '{}')",
                [],
            )
        })
        .unwrap();
    let rt = runtime(store.clone());
    reconcile_album_stars(
        &rt,
        "s1",
        &[StarredAlbumReconcileItem {
            id: "al_keep".into(),
            starred_at: 99,
        }],
    )
    .unwrap();
    let old: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al_old'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let keep: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al_keep'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    let new: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al_new'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(old.is_none());
    assert_eq!(keep, Some(99));
    assert!(new.is_none());
}

#[test]
fn catalog_year_bounds_from_indexed_tracks() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut old = make_row("s1", "t1", "al1", 1);
    old.year = Some(1985);
    let mut recent = make_row("s1", "t2", "al2", 1);
    recent.year = Some(2018);
    TrackRepository::new(&store)
        .upsert_batch(&[old, recent])
        .unwrap();
    let bounds = catalog_year_bounds_for_server(&store, "s1").unwrap();
    assert_eq!(bounds.min_year, Some(1985));
    assert_eq!(bounds.max_year, Some(2018));
}

#[test]
fn genre_album_counts_group_distinct_albums_per_genre() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut rock_one: Vec<_> = (0..3)
        .map(|i| {
            let mut t = make_row("s1", &format!("r{i}"), "al_rock_one", i + 1);
            t.genre = Some("Rock".into());
            t
        })
        .collect();
    let mut rock_two = make_row("s1", "r3", "al_rock_two", 1);
    rock_two.genre = Some("Rock".into());
    let mut jazz = make_row("s1", "j1", "al_jazz", 1);
    jazz.genre = Some("Jazz".into());
    rock_one.push(rock_two);
    rock_one.push(jazz);
    TrackRepository::new(&store)
        .upsert_batch(&rock_one)
        .unwrap();

    let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
    assert_eq!(counts.len(), 2);
    assert_eq!(counts[0].value, "Rock");
    assert_eq!(counts[0].album_count, 2);
    assert_eq!(counts[0].song_count, 4);
    assert_eq!(counts[1].value, "Jazz");
    assert_eq!(counts[1].album_count, 1);
    assert_eq!(counts[1].song_count, 1);
}

#[test]
fn genre_album_counts_respect_library_scope() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut scoped = make_row("s1", "r1", "al_a", 1);
    scoped.genre = Some("Rock".into());
    scoped.library_id = Some("lib1".into());
    let mut other = make_row("s1", "r2", "al_b", 1);
    other.genre = Some("Rock".into());
    other.library_id = Some("lib2".into());
    TrackRepository::new(&store)
        .upsert_batch(&[scoped, other])
        .unwrap();

    let counts = genre_album_counts_for_server(&store, "s1", &[String::from("lib1")]).unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].value, "Rock");
    assert_eq!(counts[0].album_count, 1);
    assert_eq!(counts[0].song_count, 1);
}

#[test]
fn genre_album_counts_scope_reads_library_id_from_track_raw_json() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut scoped = make_row("s1", "r1", "al_a", 1);
    scoped.genre = Some("Rock".into());
    scoped.library_id = Some("lib1".into());
    let mut other = make_row("s1", "r2", "al_b", 1);
    other.genre = Some("Rock".into());
    other.library_id = Some("lib2".into());
    TrackRepository::new(&store)
        .upsert_batch(&[scoped, other])
        .unwrap();

    let counts = genre_album_counts_for_server(&store, "s1", &[String::from("lib1")]).unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].album_count, 1);
}

#[test]
fn genre_album_counts_multi_library_scope_in_one_query() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut lib1 = make_row("s1", "r1", "al_a", 1);
    lib1.genre = Some("Rock".into());
    lib1.library_id = Some("lib1".into());
    let mut lib2 = make_row("s1", "r2", "al_b", 1);
    lib2.genre = Some("Pop".into());
    lib2.library_id = Some("lib2".into());
    TrackRepository::new(&store)
        .upsert_batch(&[lib1, lib2])
        .unwrap();

    let counts =
        genre_album_counts_for_server(&store, "s1", &[String::from("lib1"), String::from("lib2")])
            .unwrap();
    assert_eq!(counts.len(), 2);
    // Equal album_count → ORDER BY tg.genre COLLATE NOCASE ASC: "Pop" before "Rock".
    assert_eq!(counts[0].value, "Pop");
    assert_eq!(counts[1].value, "Rock");
}

#[test]
fn genre_album_counts_drop_genre_after_track_retag() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut track = make_row("s1", "t1", "al1", 1);
    track.genre = Some("ruspop".into());
    TrackRepository::new(&store)
        .upsert_batch(&[track.clone()])
        .unwrap();
    let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].value, "ruspop");

    track.genre = Some("Pop".into());
    TrackRepository::new(&store).upsert_batch(&[track]).unwrap();
    let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].value, "Pop");
}

#[test]
fn genre_album_counts_ignore_orphan_track_genre_rows() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut live = make_row("s1", "live", "al1", 1);
    live.genre = Some("Rock".into());
    let mut stale = make_row("s1", "gone", "al_stale", 1);
    stale.genre = Some("ruspop".into());
    TrackRepository::new(&store)
        .upsert_batch(&[live, stale])
        .unwrap();
    store
        .with_conn("test", |conn| {
            conn.execute(
                "UPDATE track SET deleted = 1 WHERE server_id = 's1' AND id = 'gone'",
                [],
            )
        })
        .unwrap();

    let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].value, "Rock");
}

#[test]
fn reconcile_album_stars_clears_all_when_server_list_empty() {
    let store = Arc::new(LibraryStore::open_in_memory());
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'A', 5, 1, '{}')",
                [],
            )
        })
        .unwrap();
    let rt = runtime(store.clone());
    reconcile_album_stars(&rt, "s1", &[]).unwrap();
    let starred_at: Option<i64> = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert!(starred_at.is_none());
}

fn album_dto(server: &str, album_id: &str) -> LibraryAlbumDto {
    LibraryAlbumDto {
        server_id: server.into(),
        id: album_id.into(),
        name: "Album".into(),
        artist: None,
        artist_id: None,
        song_count: None,
        duration_sec: None,
        year: None,
        genre: None,
        cover_art_id: None,
        starred_at: None,
        synced_at: 1,
        raw_json: serde_json::Value::Null,
    }
}

fn track_added_at(
    server: &str,
    id: &str,
    album_id: &str,
    track: i64,
    created_ms: i64,
) -> crate::repos::TrackRow {
    let mut row = make_row(server, id, album_id, track);
    row.server_created_at = Some(created_ms);
    row
}

#[test]
fn overlay_album_size_and_added_fills_totals_and_arrival_date() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[
            track_added_at("s1", "tr_1", "al1", 1, 1_000),
            track_added_at("s1", "tr_2", "al1", 2, 5_000),
        ])
        .unwrap();
    let mut albums = vec![album_dto("s1", "al1")];
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .unwrap();

    assert_eq!(albums[0].song_count, Some(2));
    // `make_row` gives every track 200 s.
    assert_eq!(albums[0].duration_sec, Some(400));
    // The oldest track decides: the column reports when the album arrived, so a
    // later addition must not move the date forward.
    assert_eq!(albums[0].raw_json.get("createdMs").and_then(|v| v.as_i64()), Some(1_000));
}

// A release from years back that gains one track today — a late rip, or a re-tag
// that made the server recreate the row — still arrived years back. Dating it to
// the new track would also light up the "new" badge on every grid showing it.
#[test]
fn overlay_album_size_and_added_keeps_the_arrival_date_when_a_track_lands_later() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[
            track_added_at("s1", "tr_1", "al1", 1, 1_000),
            track_added_at("s1", "tr_2", "al1", 2, 9_999_000),
        ])
        .unwrap();
    let mut albums = vec![album_dto("s1", "al1")];
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .unwrap();

    assert_eq!(albums[0].raw_json.get("createdMs").and_then(|v| v.as_i64()), Some(1_000));
}

// A row whose `raw_json` is neither absent nor an object carries a shape this
// overlay does not understand; replacing it with a one-field object would lose
// more than the date adds.
#[test]
fn overlay_album_size_and_added_leaves_a_non_object_raw_json_alone() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[track_added_at("s1", "tr_1", "al1", 1, 1_000)])
        .unwrap();
    let mut albums = vec![album_dto("s1", "al1")];
    albums[0].raw_json = serde_json::json!("unexpected");
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .unwrap();

    assert_eq!(albums[0].raw_json, serde_json::json!("unexpected"));
}

// A query that could count did so under its own semantics — a genre-filtered
// browse counts the matching tracks on purpose. The overlay must not replace it.
#[test]
fn overlay_album_size_and_added_keeps_values_the_query_computed() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[
            track_added_at("s1", "tr_1", "al1", 1, 1_000),
            track_added_at("s1", "tr_2", "al1", 2, 5_000),
        ])
        .unwrap();
    let mut albums = vec![album_dto("s1", "al1")];
    albums[0].song_count = Some(1);
    albums[0].duration_sec = Some(200);
    albums[0].raw_json = serde_json::json!({ "createdMs": 42 });
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .unwrap();

    assert_eq!(albums[0].song_count, Some(1));
    assert_eq!(albums[0].duration_sec, Some(200));
    assert_eq!(albums[0].raw_json.get("createdMs").and_then(|v| v.as_i64()), Some(42));
}

#[test]
fn overlay_album_size_and_added_keeps_other_raw_json_fields() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[track_added_at("s1", "tr_1", "al1", 1, 7_000)])
        .unwrap();
    let mut albums = vec![album_dto("s1", "al1")];
    albums[0].raw_json = serde_json::json!({ "releaseTypes": ["Album"] });
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .unwrap();

    assert_eq!(albums[0].raw_json.get("createdMs").and_then(|v| v.as_i64()), Some(7_000));
    assert!(albums[0].raw_json.get("releaseTypes").is_some());
}

// Deleted tracks are tombstones, not content: an album whose rows are all gone
// must not come back as "0 songs, 0:00" — it should stay untouched.
#[test]
fn overlay_album_size_and_added_leaves_an_emptied_album_alone() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let mut row = track_added_at("s1", "tr_1", "al1", 1, 1_000);
    row.deleted = true;
    TrackRepository::new(&store).upsert_batch(&[row]).unwrap();
    let mut albums = vec![album_dto("s1", "al1")];
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, &mut albums);
            Ok(())
        })
        .unwrap();

    assert_eq!(albums[0].song_count, None);
    assert_eq!(albums[0].duration_sec, None);
    assert!(albums[0].raw_json.get("createdMs").is_none());
}

use rusqlite::params;

use super::*;

#[test]
fn tag_library_by_album_ids_fills_only_empty_rows_and_chunks() {
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
        .tag_library_by_album_ids("s1", "1", &["al1".into(), "al2".into()])
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
fn tag_library_by_album_ids_with_no_empty_rows_is_write_free() {
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
        .tag_library_by_album_ids("s1", "1", &["al1".into()])
        .unwrap();

    let after = store
        .with_conn("test.total_changes", |conn| Ok(conn.total_changes()))
        .unwrap();
    assert_eq!(changed, 0);
    assert_eq!(after, before);
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

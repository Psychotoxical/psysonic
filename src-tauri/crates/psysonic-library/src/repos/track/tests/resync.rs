use super::*;

#[test]
fn count_resync_generation_counts_only_live_rows_of_that_run() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch_initial_ingest_timed(&[row("s1", "a", "A"), row("s1", "b", "B")], Some(2))
        .unwrap();
    repo.upsert_batch_initial_ingest_timed(&[row("s1", "old", "Old")], Some(1))
        .unwrap();

    assert_eq!(repo.count_resync_generation("s1", "", 2).unwrap(), 2);
    assert_eq!(repo.count_resync_generation("s1", "", 1).unwrap(), 1);
}

#[test]
fn tombstone_albums_batches_live_rows_and_stale_projection_cleanup() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let first = row("s1", "t1", "One");
    let mut second = row("s1", "t2", "Two");
    second.album_id = Some("al2".into());
    repo.upsert_batch(&[first, second]).unwrap();
    store
        .with_conn_mut("test.stale_album_projection", |conn| {
            conn.execute(
                "INSERT INTO album_browse_projection \
                 (server_id, library_id, album_id, name, song_count, duration_sec, \
                  synced_at, representative_track_id) \
                 VALUES ('s1', '', 'stale', 'Stale', 0, 0, 1, 'missing')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let outcome = repo
        .tombstone_albums("s1", &["al1".into(), "al2".into(), "stale".into()])
        .unwrap();

    assert_eq!(outcome, (2, 1));
    let live: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM track WHERE deleted = 0", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(live, 0);
    let projections: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM album_browse_projection", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(projections, 0);
    let genre_rows: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM track_genre", [], |row| row.get(0))
        })
        .unwrap();
    assert_eq!(genre_rows, 0);
}

#[test]
fn resync_upsert_stamps_generation_and_sweep_deletes_stale_rows() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch_initial_ingest_timed(&[row("s1", "seen", "Seen")], Some(2))
        .unwrap();
    store
        .with_conn_mut("misc", |c| {
            c.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, resync_gen) \
                 VALUES ('s1', 'orphan', 'Orphan', 'Al', 1, 0, 1, '{}', 1)",
                [],
            )
        })
        .unwrap();

    assert_eq!(repo.sweep_resync_orphans("s1", "", 2).unwrap(), 1);

    let live: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = 's1' AND deleted = 0",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(live, 1);

    let orphan_deleted: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT deleted FROM track WHERE id = 'orphan'", [], |r| {
                r.get(0)
            })
        })
        .unwrap();
    assert_eq!(orphan_deleted, 1);
}

#[test]
fn resync_sweep_with_no_orphans_does_not_rewrite_derived_state() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch_initial_ingest_timed(&[row("s1", "seen", "Seen")], Some(2))
        .unwrap();
    let before = store
        .with_conn("test.total_changes", |conn| Ok(conn.total_changes()))
        .unwrap();

    assert_eq!(repo.sweep_resync_orphans("s1", "", 2).unwrap(), 0);

    let after = store
        .with_conn("test.total_changes", |conn| Ok(conn.total_changes()))
        .unwrap();
    assert_eq!(after, before);
}

#[test]
fn scoped_resync_sweep_preserves_other_library_and_refreshes_derived_rows() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut lib_a = row("s1", "a-stale", "A stale");
    lib_a.library_id = Some("lib-a".into());
    lib_a.album_id = Some("album-a".into());
    let mut lib_b = row("s1", "b-keep", "B keep");
    lib_b.library_id = Some("lib-b".into());
    lib_b.album_id = Some("album-b".into());
    repo.upsert_batch_initial_ingest_timed(&[lib_a, lib_b], Some(1))
        .unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    assert_eq!(repo.sweep_resync_orphans("s1", "lib-a", 2).unwrap(), 1);

    let (a_deleted, b_deleted, projection_a, projection_b, identity_a, identity_b): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row("SELECT deleted FROM track WHERE id = 'a-stale'", [], |r| {
                    r.get(0)
                })?,
                conn.query_row("SELECT deleted FROM track WHERE id = 'b-keep'", [], |r| {
                    r.get(0)
                })?,
                conn.query_row(
                    "SELECT COUNT(*) FROM album_browse_projection \
                     WHERE server_id = 's1' AND library_id = 'lib-a'",
                    [],
                    |r| r.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM album_browse_projection \
                     WHERE server_id = 's1' AND library_id = 'lib-b'",
                    [],
                    |r| r.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key \
                     WHERE server_id = 's1' AND track_id = 'a-stale'",
                    [],
                    |r| r.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key \
                     WHERE server_id = 's1' AND track_id = 'b-keep'",
                    [],
                    |r| r.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(a_deleted, 1);
    assert_eq!(b_deleted, 0);
    assert_eq!(projection_a, 0);
    assert_eq!(projection_b, 1);
    assert_eq!(identity_a, 0);
    assert_eq!(identity_b, 1);
}

#[test]
fn resync_does_not_clobber_playback_content_hash() {
    // E2 safety property: a sync (which passes content_hash = None) must
    // never wipe the playback-derived md5 written via patch / the bridge.
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);

    let mut initial = row("s1", "t1", "First");
    initial.content_hash = None;
    repo.upsert_batch(&[initial]).unwrap();

    // Playback records the content fingerprint.
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE track SET content_hash = 'playback-md5' WHERE server_id='s1' AND id='t1'",
                [],
            )
        })
        .unwrap();

    let read = |store: &LibraryStore| -> Option<String> {
        store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT content_hash FROM track WHERE server_id='s1' AND id='t1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };

    // Resync with a NULL hash preserves the playback value.
    let mut resync = row("s1", "t1", "First (resynced)");
    resync.content_hash = None;
    repo.upsert_batch(&[resync]).unwrap();
    assert_eq!(read(&store).as_deref(), Some("playback-md5"));

    // A non-empty incoming hash still wins.
    let mut with_hash = row("s1", "t1", "First");
    with_hash.content_hash = Some("server-hash".into());
    repo.upsert_batch(&[with_hash]).unwrap();
    assert_eq!(read(&store).as_deref(), Some("server-hash"));
}

#[test]
fn resync_does_not_clobber_library_id_when_incoming_is_empty() {
    // P20: a Navidrome-native / scoped sync tags a track with library_id, then
    // a whole-server OpenSubsonic resync (no libraryId) must not wipe it — that
    // is what silently emptied multi-library scope on large servers.
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);

    let mut tagged = row("s1", "t1", "First");
    tagged.library_id = Some("1".into());
    repo.upsert_batch(&[tagged]).unwrap();

    let read = |store: &LibraryStore| -> Option<String> {
        store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT library_id FROM track WHERE server_id='s1' AND id='t1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap()
    };

    // OpenSubsonic resync carries no library membership.
    let mut none_scope = row("s1", "t1", "First (resynced, no lib)");
    none_scope.library_id = None;
    repo.upsert_batch(&[none_scope]).unwrap();
    assert_eq!(read(&store).as_deref(), Some("1"));

    // Empty-string is treated the same as NULL.
    let mut empty_scope = row("s1", "t1", "First (resynced, empty lib)");
    empty_scope.library_id = Some(String::new());
    repo.upsert_batch(&[empty_scope]).unwrap();
    assert_eq!(read(&store).as_deref(), Some("1"));

    // A genuine library move (non-empty id) still wins.
    let mut moved = row("s1", "t1", "First");
    moved.library_id = Some("2".into());
    repo.upsert_batch(&[moved]).unwrap();
    assert_eq!(read(&store).as_deref(), Some("2"));
}

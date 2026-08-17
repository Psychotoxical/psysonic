use super::*;
use crate::repos::artist::ArtistRepository;
use psysonic_integration::subsonic::{ArtistIndex, ArtistRef, IndexBucket};

#[test]
fn incremental_track_change_refreshes_the_physical_album_closure_once() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_artist", |conn| {
            conn.execute(
                "INSERT INTO artist(server_id, id, name, synced_at) \
                 VALUES ('s1', 'artist-1', 'Canonical Artist', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let first = physical_album_track_row(
        "s1", "t1", "First", "Alias", "artist-1", "Album", "album-1", "Alias", "lib",
    );
    let second = physical_album_track_row(
        "s1", "t2", "Second", "Alias", "artist-1", "Album", "album-1", "Alias", "lib",
    );
    TrackRepository::new(&store)
        .upsert_batch(&[first.clone(), second])
        .unwrap();
    rebuild_cluster_keys(&store, Some("s1")).unwrap();
    let before = store
        .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
        .unwrap()
        .unwrap();

    let mut changed = first;
    changed.title = "Updated".into();
    TrackRepository::new(&store)
        .upsert_batch(&[changed])
        .unwrap();
    assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 2);

    let after = store
        .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
        .unwrap()
        .unwrap();
    let pending: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM identity_invalidation WHERE server_id = 's1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_ne!(before.0, after.0);
    assert_eq!(pending, 0);
}

#[test]
fn incremental_tombstone_recomputes_remaining_album_identity() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_artists", |conn| {
            conn.execute_batch(
                "INSERT INTO artist(server_id, id, name, synced_at) VALUES \
                   ('s1', 'artist-1', 'Artist One', 1), \
                   ('s1', 'artist-2', 'Artist Two', 1);",
            )
        })
        .unwrap();
    TrackRepository::new(&store)
        .upsert_batch(&[
            physical_album_track_row(
                "s1",
                "t1",
                "First",
                "Artist One",
                "artist-1",
                "Album",
                "album-1",
                "Artist One",
                "lib",
            ),
            physical_album_track_row(
                "s1",
                "t2",
                "Second",
                "Artist Two",
                "artist-2",
                "Album",
                "album-1",
                "Artist Two",
                "lib",
            ),
        ])
        .unwrap();
    rebuild_cluster_keys(&store, Some("s1")).unwrap();
    let fallback = concrete_physical_album_key("s1", "album-1");
    assert_eq!(
        store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap()
            .1
            .as_deref(),
        Some(fallback.as_str())
    );

    TrackRepository::new(&store)
        .apply_tombstone_results("s1", "", &[], &["t2".into()])
        .unwrap();
    assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 1);

    let expected = build_album_key(Some("Artist One"), "Album").unwrap();
    let remaining = store
        .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
        .unwrap()
        .unwrap();
    let (deleted_key_count, projection_identity): (i64, String) = store
        .with_read_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key \
                     WHERE server_id = 's1' AND track_id = 't2'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT identity_key FROM album_browse_projection \
                     WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'album-1'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .unwrap();
    assert_eq!(remaining.1.as_deref(), Some(expected.as_str()));
    assert_eq!(deleted_key_count, 0);
    assert_eq!(projection_identity, expected);
}

#[test]
fn incremental_artist_rename_updates_tracks_and_album_projection() {
    let store = LibraryStore::open_in_memory();
    let artist_index = |name: &str| ArtistIndex {
        last_modified_ms: Some(1),
        ignored_articles: None,
        index: vec![IndexBucket {
            name: "A".into(),
            artist: vec![ArtistRef {
                id: "artist-1".into(),
                name: name.into(),
                album_count: Some(1),
                cover_art: None,
            }],
        }],
    };
    ArtistRepository::new(&store)
        .upsert_index("s1", &artist_index("Old Name"), 1)
        .unwrap();
    TrackRepository::new(&store)
        .upsert_batch(&[physical_album_track_row(
            "s1", "t1", "Track", "Alias", "artist-1", "Album", "album-1", "Alias", "lib",
        )])
        .unwrap();
    rebuild_cluster_keys(&store, Some("s1")).unwrap();

    ArtistRepository::new(&store)
        .upsert_index("s1", &artist_index("New Name"), 2)
        .unwrap();
    assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 1);

    let row = store
        .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
        .unwrap()
        .unwrap();
    let expected_album = build_album_key(Some("New Name"), "Album").unwrap();
    let projection_identity: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT identity_key FROM album_browse_projection \
                 WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'album-1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(row.2.as_deref(), norm_part("New Name").as_deref());
    assert_eq!(row.1.as_deref(), Some(expected_album.as_str()));
    assert_eq!(projection_identity, expected_album);
}

#[test]
fn incremental_track_remap_prunes_old_identity_and_album_scope() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_artist", |conn| {
            conn.execute(
                "INSERT INTO artist(server_id, id, name, synced_at) \
                 VALUES ('s1', 'artist-1', 'Artist', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let mut old = physical_album_track_row(
        "s1",
        "old",
        "Track",
        "Artist",
        "artist-1",
        "Old Album",
        "old-album",
        "Artist",
        "lib",
    );
    old.content_hash = Some("stable-hash".into());
    TrackRepository::new(&store).upsert_batch(&[old]).unwrap();
    rebuild_cluster_keys(&store, Some("s1")).unwrap();

    let mut replacement = physical_album_track_row(
        "s1",
        "new",
        "Track",
        "Artist",
        "artist-1",
        "New Album",
        "new-album",
        "Artist",
        "lib",
    );
    replacement.content_hash = Some("stable-hash".into());
    let remap = TrackRepository::new(&store)
        .upsert_batch_with_remap(&[replacement], true)
        .unwrap();
    assert_eq!(remap.remapped.len(), 1);
    assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 1);

    let (old_key_count, new_key_count, old_album_count, new_album_count): (i64, i64, i64, i64) =
        store
            .with_read_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM cluster.track_cluster_key \
                         WHERE server_id = 's1' AND track_id = 'old'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM cluster.track_cluster_key \
                         WHERE server_id = 's1' AND track_id = 'new'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM album_browse_projection \
                         WHERE server_id = 's1' AND album_id = 'old-album'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM album_browse_projection \
                         WHERE server_id = 's1' AND album_id = 'new-album'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
    assert_eq!((old_key_count, new_key_count), (0, 1));
    assert_eq!((old_album_count, new_album_count), (0, 1));
}

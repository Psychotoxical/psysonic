#[test]
fn scope_list_album_star_uses_album_row_not_track_aggregate() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[track(
            "s1",
            "t1",
            "Song",
            Some("Artist"),
            "Album",
            "alb1",
            Some("art1"),
            200,
            "lib-a",
            None,
            None,
            None,
        )],
    );
    store
        .with_conn("test", |c| {
            c.execute(
                "UPDATE track SET starred_at = 999 WHERE server_id = 's1' AND id = 't1'",
                [],
            )?;
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'alb1', 'Album', 1700, 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let req = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-a")],
        sort: None,
        limit: Some(10),
        offset: None,
    };
    let albums = list_albums(&store, &req).unwrap();
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0].starred_at, Some(1700));

    store
        .with_conn("test", |c| {
            c.execute(
                "UPDATE album SET starred_at = NULL WHERE server_id = 's1' AND id = 'alb1'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let albums = list_albums(&store, &req).unwrap();
    assert_eq!(albums[0].starred_at, None);
}

#[test]
fn album_detail_star_reads_priority_owner_album_id() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "t-a1",
                "Song",
                Some("Artist"),
                "Album",
                "alb-a",
                Some("art1"),
                200,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t-b1",
                "Song",
                Some("Artist"),
                "Album",
                "alb-b",
                Some("art1"),
                200,
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    store
        .with_conn("test", |c| {
            c.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'alb-a', 'Album', 1111, 1, '{}'), \
                            ('s1', 'alb-b', 'Album', 2222, 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            album_id: "alb-b".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(detail.album.id, "alb-a");
    assert_eq!(detail.album.starred_at, Some(1111));
}

#[test]
fn album_detail_preserves_priority_owner_raw_json() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "t-a1",
                "Song",
                Some("Artist"),
                "Album",
                "alb-a",
                Some("art1"),
                200,
                "lib-a",
                Some(2001),
                None,
                None,
            ),
            track(
                "s2",
                "t-b1",
                "Song",
                Some("Artist"),
                "Album",
                "alb-b",
                Some("art2"),
                200,
                "lib-b",
                Some(2002),
                Some("Jazz"),
                Some("cov-b"),
            ),
        ],
    );
    store
            .with_conn("test", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, artist, artist_id, year, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'alb-a', 'Album', 'Artist', 'art1', 2001, 1111, 1, \
                             '{\"recordLabel\":\"Primary Records\"}'), \
                            ('s2', 'alb-b', 'Album', 'Artist', 'art2', 2002, 2222, 1, \
                             '{\"recordLabel\":\"Secondary Records\"}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            album_id: "alb-b".into(),
            server_id: "s2".into(),
        },
    )
    .unwrap();

    assert_eq!(detail.album.server_id, "s1");
    assert_eq!(detail.album.id, "alb-a");
    assert_eq!(detail.album.starred_at, Some(1111));
    assert_eq!(detail.album.raw_json["recordLabel"], "Primary Records");
}

#[test]
fn list_artists_collapses_collaboration_track_names_for_one_artist_id() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "Song 1",
                Some("Andromida • Daedric"),
                "Album 1",
                "album-1",
                Some("artist-1"),
                200,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t2",
                "Song 2",
                Some("Andromida • Nevertel"),
                "Album 2",
                "album-2",
                Some("artist-1"),
                220,
                "lib-a",
                None,
                None,
                None,
            ),
        ])
        .unwrap();
    store
            .with_conn_mut("test.canonical_artist_scope", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES ('s1', 'artist-1', 'Andromida', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    rebuild_cluster_keys(&store, Some("s1")).unwrap();

    let artists = list_artists(
        &store,
        &LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            sort: Some("name".into()),
            limit: Some(50),
            offset: Some(0),
        },
    )
    .unwrap();

    assert_eq!(
        artists
            .iter()
            .filter(|artist| artist.id == "artist-1")
            .count(),
        1
    );
}

#[test]
fn album_merge_preserves_same_server_track_multiplicity_and_priority_winner_flips() {
    let store = LibraryStore::open_in_memory();
    let rows = [
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
            Some("Rock"),
            Some("cover-a"),
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
            Some(1999),
            Some("Pop"),
            Some("cover-b"),
        ),
    ];
    seed_and_rebuild(&store, &rows);

    let req_a_first = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
        sort: None,
        limit: Some(50),
        offset: Some(0),
    };
    let albums_a = list_albums(&store, &req_a_first).unwrap();
    assert_eq!(albums_a.len(), 1);
    assert_eq!(albums_a[0].id, "alb-a");
    assert_eq!(albums_a[0].year, Some(2001));
    assert_eq!(albums_a[0].genre.as_deref(), Some("Rock"));
    assert_eq!(albums_a[0].song_count, Some(2));
    assert_eq!(albums_a[0].duration_sec, Some(400));

    let req_b_first = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-b"), scope_pair("s1", "lib-a")],
        sort: None,
        limit: Some(50),
        offset: Some(0),
    };
    let albums_b = list_albums(&store, &req_b_first).unwrap();
    assert_eq!(albums_b.len(), 1);
    assert_eq!(albums_b[0].id, "alb-b");
    assert_eq!(albums_b[0].year, Some(1999));
    assert_eq!(albums_b[0].song_count, Some(2));
    assert_eq!(albums_b[0].duration_sec, Some(400));
}

#[test]
fn null_album_key_stays_individual() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "t1",
                "No Artist",
                None,
                "Al1",
                "alb1",
                None,
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t2",
                "Also None",
                None,
                "Al2",
                "alb2",
                None,
                100,
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    let req = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
        sort: None,
        limit: Some(50),
        offset: None,
    };
    let albums = list_albums(&store, &req).unwrap();
    assert_eq!(albums.len(), 2);
}

#[test]
fn duration_guard_splits_cluster_key_group() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "t-short",
                "Same",
                Some("A"),
                "Al",
                "alb1",
                Some("ar1"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t-long",
                "Same",
                Some("A"),
                "Al",
                "alb2",
                Some("ar1"),
                200,
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    let req = LibraryScopeSearchRequest {
        scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
        query: "Same".into(),
        limit: Some(10),
    };
    let hits = search_tracks(&store, &req).unwrap();
    assert_eq!(hits.len(), 2);
}

#[test]
fn same_server_occurrences_survive_and_cross_server_sources_pair_by_rank() {
    let store = LibraryStore::open_in_memory();
    let mut rows = vec![
        track(
            "s1",
            "a1",
            "Tyrion",
            Some("Narrator"),
            "Book",
            "album-a",
            Some("narrator"),
            300,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s1",
            "a2",
            "Tyrion",
            Some("Narrator"),
            "Book",
            "album-a",
            Some("narrator"),
            300,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "b1",
            "Tyrion",
            Some("Narrator"),
            "Book",
            "album-b",
            Some("narrator"),
            300,
            "lib-b",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "b2",
            "Tyrion",
            Some("Narrator"),
            "Book",
            "album-b",
            Some("narrator"),
            300,
            "lib-b",
            None,
            None,
            None,
        ),
        track(
            "s3",
            "c1",
            "Tyrion",
            Some("Narrator"),
            "Book",
            "album-c",
            Some("narrator"),
            300,
            "lib-c",
            None,
            None,
            None,
        ),
    ];
    for (index, row) in rows.iter_mut().enumerate() {
        row.track_number = Some((index % 2 + 1) as i64);
        row.server_path = Some(format!("chapter-{}.mp3", index % 2 + 1));
    }
    seed_and_rebuild(&store, &rows);
    let scopes = vec![whole_scope("s1"), whole_scope("s2"), whole_scope("s3")];

    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: scopes.clone(),
            album_id: "album-a".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(
        detail
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a1", "a2"]
    );

    for (anchor_id, expected_ids) in [("a1", vec!["a1", "b1", "c1"]), ("a2", vec!["a2", "b2"])] {
        let sources = resolve_entity_sources(
            &store,
            &LibraryResolveEntitySourcesRequest {
                entity_type: LibrarySourceEntityType::Track,
                anchor_server_id: "s1".into(),
                anchor_id: anchor_id.into(),
                scopes: scopes.clone(),
            },
        )
        .unwrap();
        assert_eq!(
            sources
                .iter()
                .map(|source| source.id.as_str())
                .collect::<Vec<_>>(),
            expected_ids
        );
    }
}

#[test]
fn single_scope_returns_correct_album() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[track(
            "s1",
            "t1",
            "Only",
            Some("A"),
            "Solo",
            "alb-solo",
            Some("ar1"),
            180,
            "lib-a",
            None,
            None,
            None,
        )],
    );
    let req = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-a")],
        sort: None,
        limit: Some(10),
        offset: None,
    };
    let albums = list_albums(&store, &req).unwrap();
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0].id, "alb-solo");
}

#[test]
fn pagination_and_order_stable() {
    let store = LibraryStore::open_in_memory();
    let rows = [
        track(
            "s1",
            "t1",
            "A",
            Some("X"),
            "Zebra",
            "alb-z",
            Some("ar1"),
            100,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s1",
            "t2",
            "B",
            Some("X"),
            "Alpha",
            "alb-a",
            Some("ar1"),
            100,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s1",
            "t3",
            "C",
            Some("X"),
            "Middle",
            "alb-m",
            Some("ar1"),
            100,
            "lib-a",
            None,
            None,
            None,
        ),
    ];
    seed_and_rebuild(&store, &rows);
    let req = LibraryScopeListRequest {
        scopes: vec![scope_pair("s1", "lib-a")],
        sort: None,
        limit: Some(2),
        offset: Some(1),
    };
    let page = list_albums(&store, &req).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].name, "Middle");
    assert_eq!(page[1].name, "Zebra");
}

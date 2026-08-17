#[test]
fn canonical_artist_album_key_merges_discography_and_preserves_track_owners() {
    let store = LibraryStore::open_in_memory();
    let mut s1_shared = track(
        "s1",
        "s1-shared",
        "Shared",
        Some("Metallica"),
        "S&M2",
        "s1-album",
        Some("s1-artist"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    s1_shared.album_artist = Some("Metallica & San Francisco Symphony".into());
    let s2_shared = track(
        "s2",
        "s2-shared",
        "Shared",
        Some("Metallica"),
        "S&M2",
        "s2-album",
        Some("s2-artist"),
        200,
        "lib-b",
        Some(2020),
        None,
        None,
    );
    let s2_unique = track(
        "s2",
        "s2-unique",
        "Unique",
        Some("Metallica"),
        "S&M2",
        "s2-album",
        Some("s2-artist"),
        240,
        "lib-b",
        Some(2020),
        None,
        None,
    );
    seed_and_rebuild(&store, &[s1_shared, s2_shared, s2_unique]);
    store
        .with_conn_mut("test.stale_album_identity", |conn| {
            conn.execute(
                "UPDATE cluster.track_cluster_key \
                     SET album_key = CASE server_id \
                       WHEN 's1' THEN 'metallicasymphony-old' ELSE 'metallica-old' END",
                [],
            )?;
            conn.execute(
                "UPDATE cluster.cluster_meta SET value = 'stale' WHERE key = 'norm_version'",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let scopes = vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")];
    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: scopes.clone(),
            album_id: "s1-album".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(detail.album.server_id, "s1");
    assert_eq!(detail.album.id, "s1-album");
    assert_eq!(
        detail
            .tracks
            .iter()
            .map(|track| (track.server_id.as_str(), track.id.as_str()))
            .collect::<Vec<_>>(),
        vec![("s1", "s1-shared"), ("s2", "s2-unique")]
    );

    let artist = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes,
            artist_id: "s1-artist".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    assert_eq!(artist.albums.len(), 1);
    assert_eq!(artist.albums[0].server_id, "s1");
    assert_eq!(artist.albums[0].id, "s1-album");
    assert_eq!(artist.albums[0].song_count, Some(2));

    let reverse = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s2", "lib-b"), scope_pair("s1", "lib-a")],
            album_id: "s2-album".into(),
            server_id: "s2".into(),
        },
    )
    .unwrap();
    assert_eq!(reverse.album.server_id, "s2");
    assert_eq!(reverse.album.id, "s2-album");
    assert_eq!(
        reverse
            .tracks
            .iter()
            .map(|track| (track.server_id.as_str(), track.id.as_str()))
            .collect::<Vec<_>>(),
        vec![("s2", "s2-shared"), ("s2", "s2-unique")]
    );
}

#[test]
fn ambiguous_physical_albums_stay_separate_but_open_all_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut rows = vec![
        track(
            "s1",
            "s1-a",
            "One",
            Some("Artist A"),
            "Split",
            "s1-album",
            Some("s1-artist-a"),
            200,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s1",
            "s1-b",
            "Two",
            Some("Artist B"),
            "Split",
            "s1-album",
            Some("s1-artist-b"),
            210,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "s2-a",
            "One",
            Some("Artist A"),
            "Split",
            "s2-album",
            Some("s2-artist-a"),
            200,
            "lib-b",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "s2-c",
            "Three",
            Some("Artist C"),
            "Split",
            "s2-album",
            Some("s2-artist-c"),
            220,
            "lib-b",
            None,
            None,
            None,
        ),
    ];
    for row in &mut rows {
        row.album_artist = Some("Various Artists".into());
    }
    seed_and_rebuild(&store, &rows);

    let scopes = vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")];
    let artist = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: scopes.clone(),
            artist_id: "s1-artist-a".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    // Both "Split" albums carry a Various Artists credit, so they are albums the
    // artist appears on, not part of the main discography — but they still stay
    // as two separate physical albums (see album_detail below).
    assert!(artist.albums.is_empty());
    assert_eq!(artist.appears_on_albums.len(), 2);

    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes,
            album_id: "s1-album".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(detail.tracks.len(), 2);
    assert!(detail.tracks.iter().all(|track| track.server_id == "s1"));
}

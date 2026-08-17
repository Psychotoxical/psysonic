#[test]
fn artist_detail_appears_on_credit_follows_scope_priority_across_servers() {
    // The viewed artist guests on the same album on two servers, which disagree on
    // the album-artist. The credit and link must come from the priority winner —
    // the same copy the card representative is built from — not from whichever
    // track happens to have the lowest id (finding 5). Reversing the scope order
    // reverses the winner.
    let seed = || {
        let store = LibraryStore::open_in_memory();
        let mut g1 = track(
            "s1",
            "g1",
            "Verse",
            Some("Guest"),
            "Split Record",
            "s1-rec",
            Some("guest-id"),
            190,
            "lib-a",
            Some(2021),
            None,
            None,
        );
        g1.album_artist = None;
        let mut h1 = track(
            "s1",
            "h1",
            "Title",
            Some("Head One"),
            "Split Record",
            "s1-rec",
            Some("p1"),
            200,
            "lib-a",
            Some(2021),
            None,
            None,
        );
        h1.album_artist = Some("Head One".into());
        h1.raw_json = r#"{"albumArtistId":"head-1"}"#.into();
        let mut g2 = track(
            "s2",
            "g2",
            "Verse",
            Some("Guest"),
            "Split Record",
            "s2-rec",
            Some("guest-id"),
            190,
            "lib-b",
            Some(2021),
            None,
            None,
        );
        g2.album_artist = None;
        let mut h2 = track(
            "s2",
            "h2",
            "Title",
            Some("Head Two"),
            "Split Record",
            "s2-rec",
            Some("p2"),
            200,
            "lib-b",
            Some(2021),
            None,
            None,
        );
        h2.album_artist = Some("Head Two".into());
        h2.raw_json = r#"{"albumArtistId":"head-2"}"#.into();
        seed_and_rebuild(&store, &[g1, h1, g2, h2]);
        // Force the two physical copies into one deduped album. Conflicting
        // album-artist tags would otherwise cluster them apart, but the finding is
        // precisely about a *deduped* album whose copies disagree — so pin a shared
        // album key on the viewed artist's rows (the ones that drive `album_dedup`).
        store
            .with_conn_mut("test.force_shared_album_key", |conn| {
                conn.execute(
                    "UPDATE cluster.track_cluster_key SET album_key = 'shared-rec' \
                         WHERE track_id IN ('g1', 'g2')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        store
    };

    let appears_credit = |scopes: Vec<LibraryScopePair>, server: &str| {
        let store = seed();
        let response = artist_detail(
            &store,
            &LibraryScopeArtistDetailRequest {
                scopes,
                artist_id: "guest-id".into(),
                server_id: server.into(),
                include_tracks: false,
                top_tracks_limit: None,
            },
        )
        .unwrap();
        let a = response
            .appears_on_albums
            .into_iter()
            .find(|a| a.name == "Split Record")
            .expect("guested album present");
        (a.artist, a.artist_id)
    };

    // s1 first → s1's credit wins.
    assert_eq!(
        appears_credit(
            vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            "s1"
        ),
        (Some("Head One".to_string()), Some("head-1".to_string())),
    );
    // Reverse the scope order → s2's credit wins.
    assert_eq!(
        appears_credit(
            vec![scope_pair("s2", "lib-b"), scope_pair("s1", "lib-a")],
            "s2"
        ),
        (Some("Head Two".to_string()), Some("head-2".to_string())),
    );
}

#[test]
fn artist_detail_album_count_matches_the_rendered_grid() {
    // Own releases on two servers with no appears-on: the header count must be the
    // size of the rendered union, not the priority server's local count (finding 4).
    let store = LibraryStore::open_in_memory();
    let s1 = track(
        "s1",
        "s1a",
        "One",
        Some("Solo"),
        "Album One",
        "s1-alb1",
        Some("s1-art"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    let s2 = track(
        "s2",
        "s2a",
        "Two",
        Some("Solo"),
        "Album Two",
        "s2-alb2",
        Some("s2-art"),
        200,
        "lib-b",
        Some(2021),
        None,
        None,
    );
    seed_and_rebuild(&store, &[s1, s2]);

    let response = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            artist_id: "s1-art".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();

    // Two distinct own albums across the two servers, no appears-on.
    assert_eq!(response.albums.len(), 2);
    assert!(response.appears_on_albums.is_empty());
    // The header count reflects the rendered union, not one server's local count.
    assert_eq!(response.artist.album_count, Some(2));
}

#[test]
fn artist_detail_bounds_top_tracks_and_selects_broadest_server() {
    let store = LibraryStore::open_in_memory();
    let mut rows = vec![
        track(
            "s1",
            "s1-low",
            "Local Low",
            Some("Artist"),
            "One",
            "s1-alb",
            Some("s1-art"),
            180,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s1",
            "s1-mid",
            "Local Mid",
            Some("Artist"),
            "One",
            "s1-alb",
            Some("s1-art"),
            181,
            "lib-a",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "s2-top",
            "Global Top",
            Some("Artist"),
            "Two",
            "s2-alb",
            Some("s2-art"),
            182,
            "lib-b",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "s2-second",
            "Global Second",
            Some("Artist"),
            "Two",
            "s2-alb",
            Some("s2-art"),
            183,
            "lib-b",
            None,
            None,
            None,
        ),
        track(
            "s2",
            "s2-low",
            "Global Low",
            Some("Artist"),
            "Two",
            "s2-alb",
            Some("s2-art"),
            184,
            "lib-b",
            None,
            None,
            None,
        ),
    ];
    for (row, play_count) in rows.iter_mut().zip([5, 10, 100, 50, 1]) {
        row.play_count = Some(play_count);
    }
    seed_and_rebuild(&store, &rows);

    let response = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            artist_id: "s1-art".into(),
            server_id: "s1".into(),
            include_tracks: true,
            top_tracks_limit: Some(2),
        },
    )
    .unwrap();

    assert_eq!(response.top_tracks_server_id.as_deref(), Some("s2"));
    let fingerprint = response.top_tracks_fingerprint.clone().unwrap();
    assert_eq!(response.tracks.len(), 2);
    assert_eq!(response.tracks[0].id, "s2-top");
    assert_eq!(response.tracks[1].id, "s2-second");

    seed_and_rebuild(
        &store,
        &[track(
            "s2",
            "s2-new",
            "New Track",
            Some("Artist"),
            "Two",
            "s2-alb",
            Some("s2-art"),
            185,
            "lib-b",
            None,
            None,
            None,
        )],
    );
    let updated = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            artist_id: "s1-art".into(),
            server_id: "s1".into(),
            include_tracks: true,
            top_tracks_limit: Some(2),
        },
    )
    .unwrap();
    assert_ne!(
        updated.top_tracks_fingerprint.as_deref(),
        Some(fingerprint.as_str())
    );
}

#[test]
fn new_releases_are_globally_ordered_and_exclude_null_created_at() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t-old", "Old", "a-old", "l1", Some(100)),
            track("s2", "t-new", "New", "a-new", "l2", Some(300)),
            track("s1", "t-mid", "Mid", "a-mid", "l1", Some(200)),
            track("s2", "t-null", "Unknown", "a-null", "l2", None),
        ])
        .unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1"), scope("s2", "l2")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    assert_eq!(
        response
            .albums
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>(),
        vec!["New", "Mid", "Old"]
    );
    assert_eq!(response.albums[0].raw_json["createdMs"], 300);
}

#[test]
fn new_release_va_card_links_to_the_album_artist_not_a_performer() {
    // Reported on the mainstage: clicking "Various Artists" on a New Releases card
    // opened a random performer from the compilation. The card credit is the
    // album-artist, so the linked id must follow it (album-artist id from
    // raw_json.albumArtistId), not the representative track's performer id.
    let store = LibraryStore::open_in_memory();
    let mut t = track("s1", "t1", "Christmas Comp", "comp1", "l1", Some(300));
    t.artist = Some("A Guest Performer".into());
    t.artist_id = Some("perf1".into());
    t.album_artist = Some("Various Artists".into());
    t.raw_json = r#"{"albumArtistId":"va"}"#.into();
    TrackRepository::new(&store).upsert_batch(&[t]).unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    let card = response.albums.iter().find(|a| a.id == "comp1").unwrap();
    assert_eq!(card.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        card.artist_id.as_deref(),
        Some("va"),
        "the VA card must link to the album-artist entity, not a track performer"
    );
}

#[test]
fn new_release_va_card_recovers_the_album_artist_id_from_a_sibling_track() {
    // Realistic partial tagging: the representative track (smallest ALBUM_PICK_KEY)
    // carries no albumArtistId, a sibling carries "va". The card must still link to
    // the VA entity (recovered via `MAX(...) OVER (PARTITION BY album_dedup)`), not
    // go unlinked. The window is not a GROUP BY aggregate, so the credit *name*,
    // cover and year still come from the single-MIN(_pick) representative row.
    let store = LibraryStore::open_in_memory();
    let mut t1 = track("s1", "t1", "Comp", "comp1", "l1", Some(300));
    t1.artist = Some("Performer One".into());
    t1.artist_id = Some("perf1".into());
    t1.album_artist = Some("Various Artists".into());
    t1.raw_json = "{}".into(); // representative: no album-artist id
    let mut t2 = track("s1", "t2", "Comp", "comp1", "l1", Some(300));
    t2.artist = Some("Performer Two".into());
    t2.artist_id = Some("perf2".into());
    t2.album_artist = Some("Various Artists".into());
    t2.raw_json = r#"{"albumArtistId":"va"}"#.into();
    TrackRepository::new(&store)
        .upsert_batch(&[t1, t2])
        .unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    let card = response.albums.iter().find(|a| a.id == "comp1").unwrap();
    // Credit name comes from the representative (t1); the link is recovered.
    assert_eq!(card.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        card.artist_id.as_deref(),
        Some("va"),
        "the VA link must be recovered from a sibling when the representative lacks it"
    );
}

#[test]
fn whole_server_new_releases_include_empty_library_rows() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t-empty", "Empty", "a-empty", "", Some(100)),
            track("s1", "t-tagged", "Tagged", "a-tagged", "lib-b", Some(200)),
        ])
        .unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![whole_scope("s1")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    assert_eq!(
        response
            .albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a-tagged", "a-empty"]
    );
}

#[test]
fn recently_played_does_not_expose_play_time_as_catalog_created_at() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "Album", "a1", "l1", Some(100))])
        .unwrap();
    play(&store, "s1", "t1", 999);

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1")],
            LibraryMainstageAlbumFeed::RecentlyPlayed,
        ),
    )
    .unwrap();

    assert_eq!(response.albums[0].raw_json, serde_json::Value::Null);
}

#[test]
fn only_selected_libraries_contribute() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t-selected", "Selected", "a1", "wanted", Some(100)),
            track("s1", "t-hidden", "Hidden", "a2", "other", Some(999)),
        ])
        .unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "wanted")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    assert_eq!(response.albums.len(), 1);
    assert_eq!(response.albums[0].name, "Selected");
}

#[test]
fn genre_filter_and_counts_stay_within_dated_selected_release_scope() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "rock", "Rock release", "a-rock", "l1", Some(200)),
            track("s2", "jazz", "Jazz release", "a-jazz", "l2", Some(300)),
            track("s1", "missing-date", "Undated", "a-undated", "l1", None),
            track("s1", "outside", "Outside", "a-outside", "other", Some(400)),
        ])
        .unwrap();
    store
            .with_conn_mut("test.mainstage_genres", |conn| {
                for (server, track_id, genre) in [
                    ("s1", "rock", "Rock"),
                    ("s2", "jazz", "Jazz"),
                    ("s1", "missing-date", "Ambient"),
                    ("s1", "outside", "Metal"),
                ] {
                    conn.execute(
                        "INSERT INTO track_genre (server_id, track_id, genre, album_id, library_id) \
                         VALUES (?1, ?2, ?3, (SELECT album_id FROM track WHERE server_id = ?1 AND id = ?2), \
                                 (SELECT library_id FROM track WHERE server_id = ?1 AND id = ?2))",
                        rusqlite::params![server, track_id, genre],
                    )?;
                }
                Ok(())
            })
            .unwrap();

    let mut req = request(
        vec![scope("s1", "l1"), scope("s2", "l2")],
        LibraryMainstageAlbumFeed::NewReleases,
    );
    req.genres = vec!["rock".into()];
    let response = list_mainstage_albums(&store, &req).unwrap();

    assert_eq!(
        response
            .albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        ["a-rock"]
    );
    assert_eq!(
        response
            .genre_counts
            .iter()
            .map(|row| (row.value.as_str(), row.album_count))
            .collect::<Vec<_>>(),
        [("Jazz", 1), ("Rock", 1)],
    );
}

#[test]
fn home_feed_skips_genre_counts_when_not_requested() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track(
            "s1",
            "rock",
            "Rock release",
            "a-rock",
            "l1",
            Some(200),
        )])
        .unwrap();
    store
        .with_conn_mut("test.mainstage_skip_genres", |conn| {
            conn.execute(
                "INSERT INTO track_genre (server_id, track_id, genre, album_id, library_id) \
                     VALUES ('s1', 'rock', 'Rock', 'a-rock', 'l1')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let mut req = request(
        vec![scope("s1", "l1")],
        LibraryMainstageAlbumFeed::NewReleases,
    );
    req.include_genre_counts = false;
    let response = list_mainstage_albums(&store, &req).unwrap();

    assert_eq!(response.albums.len(), 1);
    assert!(response.genre_counts.is_empty());
}

#[test]
fn recently_played_collapses_repeated_sessions_and_uses_latest_global_time() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t-a", "Album A", "a", "l1", Some(1)),
            track("s2", "t-b", "Album B", "b", "l2", Some(1)),
        ])
        .unwrap();
    play(&store, "s1", "t-a", 100);
    play(&store, "s1", "t-a", 400);
    play(&store, "s2", "t-b", 300);

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1"), scope("s2", "l2")],
            LibraryMainstageAlbumFeed::RecentlyPlayed,
        ),
    )
    .unwrap();
    assert_eq!(response.albums.len(), 2);
    assert_eq!(response.albums[0].name, "Album A");
    assert_eq!(response.albums[1].name, "Album B");
}

#[test]
fn duplicate_album_uses_priority_owner_but_global_feed_timestamp() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t-priority", "Shared", "priority-id", "l1", Some(100)),
            track("s2", "t-later", "Shared", "later-id", "l2", Some(500)),
        ])
        .unwrap();
    insert_artist(&store, "s1");
    insert_artist(&store, "s2");
    ensure_cluster_keys_built(&store, "s1").unwrap();
    ensure_cluster_keys_built(&store, "s2").unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1"), scope("s2", "l2")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    assert_eq!(response.albums.len(), 1);
    assert_eq!(response.albums[0].server_id, "s1");
    assert_eq!(response.albums[0].id, "priority-id");
}

#[test]
fn missing_cluster_keys_use_non_merge_fallback_without_rebuild() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "Shared", "a1", "l1", Some(200)),
            track("s2", "t2", "Shared", "a2", "l2", Some(100)),
        ])
        .unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1"), scope("s2", "l2")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    assert_eq!(response.albums.len(), 2);

    let key_count: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM cluster.track_cluster_key",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        key_count, 0,
        "latency-sensitive browse must not rebuild keys"
    );
}

#[test]
fn pagination_fetches_one_extra_for_has_more() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "One", "a1", "l1", Some(300)),
            track("s1", "t2", "Two", "a2", "l1", Some(200)),
            track("s1", "t3", "Three", "a3", "l1", Some(100)),
        ])
        .unwrap();
    let mut req = request(
        vec![scope("s1", "l1")],
        LibraryMainstageAlbumFeed::NewReleases,
    );
    req.limit = Some(2);

    let first = list_mainstage_albums(&store, &req).unwrap();
    assert_eq!(first.albums.len(), 2);
    assert!(first.has_more);

    req.offset = Some(2);
    let second = list_mainstage_albums(&store, &req).unwrap();
    assert_eq!(second.albums.len(), 1);
    assert!(!second.has_more);
}

#[test]
fn candidate_window_expands_when_one_album_dominates_newest_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut tracks = (0..220)
        .map(|n| {
            track(
                "s1",
                &format!("shared-{n}"),
                "Shared",
                "shared",
                "l1",
                Some(1_000 - n),
            )
        })
        .collect::<Vec<_>>();
    tracks.push(track("s1", "other", "Other", "other", "l1", Some(700)));
    TrackRepository::new(&store).upsert_batch(&tracks).unwrap();

    let mut req = request(
        vec![scope("s1", "l1")],
        LibraryMainstageAlbumFeed::NewReleases,
    );
    req.limit = Some(2);
    let response = list_mainstage_albums(&store, &req).unwrap();

    assert_eq!(response.albums.len(), 2);
    assert_eq!(response.albums[0].name, "Shared");
    assert_eq!(response.albums[1].name, "Other");
}

#[test]
fn candidate_window_expands_when_one_album_dominates_recent_sessions() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "shared", "Shared", "shared", "l1", Some(1)),
            track("s1", "other", "Other", "other", "l1", Some(1)),
        ])
        .unwrap();
    for started_at_ms in 1..=220 {
        play(&store, "s1", "shared", 1_000 + started_at_ms);
    }
    play(&store, "s1", "other", 700);

    let mut req = request(
        vec![scope("s1", "l1")],
        LibraryMainstageAlbumFeed::RecentlyPlayed,
    );
    req.limit = Some(2);
    let response = list_mainstage_albums(&store, &req).unwrap();

    assert_eq!(response.albums.len(), 2);
    assert_eq!(response.albums[0].name, "Shared");
    assert_eq!(response.albums[1].name, "Other");
}

#[test]
fn feed_and_response_serialize_with_ipc_camel_case() {
    assert_eq!(
        serde_json::to_value(LibraryMainstageAlbumFeed::NewReleases).unwrap(),
        "newReleases"
    );
    assert_eq!(
        serde_json::to_value(LibraryMainstageAlbumFeed::RecentlyPlayed).unwrap(),
        "recentlyPlayed"
    );
    let response = LibraryMainstageAlbumsResponse {
        albums: Vec::new(),
        has_more: true,
        genre_counts: Vec::new(),
    };
    assert_eq!(serde_json::to_value(response).unwrap()["hasMore"], true);
}

#[test]
fn album_star_overlay_uses_priority_representative_album_row() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t-priority", "Shared", "priority-id", "l1", Some(100)),
            track("s2", "t-later", "Shared", "later-id", "l2", Some(500)),
        ])
        .unwrap();
    insert_artist(&store, "s1");
    insert_artist(&store, "s2");
    ensure_cluster_keys_built(&store, "s1").unwrap();
    ensure_cluster_keys_built(&store, "s2").unwrap();
    store
        .with_conn("test.mainstage_star", |conn| {
            conn.execute(
                "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'priority-id', 'Shared', 1234, 1, '{}'), \
                            ('s2', 'later-id', 'Shared', 5678, 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

    let response = list_mainstage_albums(
        &store,
        &request(
            vec![scope("s1", "l1"), scope("s2", "l2")],
            LibraryMainstageAlbumFeed::NewReleases,
        ),
    )
    .unwrap();
    assert_eq!(response.albums[0].server_id, "s1");
    assert_eq!(response.albums[0].starred_at, Some(1234));
}

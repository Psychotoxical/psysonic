#[test]
fn live_search_prefix_matches_partial_artist_name() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "Enter Sandman",
                "Metallica",
                "Metallica",
                "al1",
                "ar_meta",
            ),
            track(
                "s1",
                "t2",
                "Other",
                "Other Artist",
                "Other Album",
                "al2",
                "ar2",
            ),
        ])
        .unwrap();
    let resp = run_live_search(&store, "s1", "metal", None, None, 5, 5, 10).unwrap();
    assert!(
        resp.artists.iter().any(|a| a.name == "Metallica"),
        "expected Metallica from prefix query metal"
    );
    assert!(resp
        .tracks
        .iter()
        .any(|t| t.artist.as_deref() == Some("Metallica")));
}

#[test]
fn live_search_returns_songs_albums_artists_from_scoped_fts() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "Aurora Song",
                "Aurora Quartet",
                "Aurora Nights",
                "al1",
                "ar1",
            ),
            track(
                "s1",
                "t2",
                "Other",
                "Other Artist",
                "Other Album",
                "al2",
                "ar2",
            ),
        ])
        .unwrap();
    let resp = run_live_search(&store, "s1", "aurora", None, None, 5, 5, 10).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al1");
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar1");
    assert!(resp.tracks[0].raw_json.is_null());
}

#[test]
fn live_search_does_not_surface_artist_from_unrelated_track_hit() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "Battle Hymn",
                "Arch Enemy",
                "Manowar Covers Vol 1",
                "al1",
                "ar_arch",
            ),
            track(
                "s1",
                "t2",
                "Heart Of Steel",
                "Manowar",
                "Fighting the World",
                "al2",
                "ar_mano",
            ),
        ])
        .unwrap();
    let resp = run_live_search(&store, "s1", "manowar", None, None, 5, 5, 10).unwrap();
    assert!(
        resp.artists.iter().any(|a| a.name == "Manowar"),
        "expected Manowar artist"
    );
    assert!(
        !resp.artists.iter().any(|a| a.name == "Arch Enemy"),
        "Arch Enemy must not appear when only the album title mentions Manowar"
    );
    assert!(resp.albums.iter().any(|a| a.name.contains("Manowar")));
}

#[test]
fn live_search_short_query_returns_empty_without_scanning() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "Аура", "Artist", "Album", "al1", "ar1")])
        .unwrap();
    let resp = run_live_search(&store, "s1", "а", None, None, 5, 5, 10).unwrap();
    assert!(resp.tracks.is_empty());
    assert!(resp.artists.is_empty());
    assert!(resp.albums.is_empty());
}

#[test]
fn live_search_library_scope_narrows_results() {
    let store = LibraryStore::open_in_memory();
    let mut in_lib = track(
        "s1",
        "t1",
        "Scoped Song",
        "Scoped Artist",
        "Scoped Album",
        "al1",
        "ar1",
    );
    in_lib.library_id = Some("lib1".into());
    let mut other = track(
        "s1",
        "t2",
        "Scoped Song",
        "Other Artist",
        "Other Album",
        "al2",
        "ar2",
    );
    other.library_id = Some("lib2".into());
    TrackRepository::new(&store)
        .upsert_batch(&[in_lib, other])
        .unwrap();
    let resp = run_live_search(&store, "s1", "scoped", Some("lib1"), None, 5, 5, 10).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].name, "Scoped Artist");
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].name, "Scoped Album");
}

#[test]
fn live_search_library_scope_narrows_multi_id() {
    let store = LibraryStore::open_in_memory();
    let mut in_lib1 = track(
        "s1",
        "t1",
        "Scoped Song",
        "Scoped Artist",
        "Scoped Album",
        "al1",
        "ar1",
    );
    in_lib1.library_id = Some("lib1".into());
    let mut in_lib2 = track(
        "s1",
        "t2",
        "Scoped Song",
        "Other Artist",
        "Other Album",
        "al2",
        "ar2",
    );
    in_lib2.library_id = Some("lib2".into());
    let mut in_lib3 = track(
        "s1",
        "t3",
        "Scoped Song",
        "Third Artist",
        "Third Album",
        "al3",
        "ar3",
    );
    in_lib3.library_id = Some("lib3".into());
    TrackRepository::new(&store)
        .upsert_batch(&[in_lib1, in_lib2, in_lib3])
        .unwrap();
    let resp = run_live_search(&store, "s1", "scoped", Some("lib1"), None, 5, 5, 10).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn live_search_fts_scoped_to_server_not_global_bm25() {
    let store = LibraryStore::open_in_memory();
    let mut batch = Vec::new();
    for i in 0..20 {
        batch.push(track(
            "s_big",
            &format!("t{i}"),
            "Song",
            "Nightblaze",
            "Album",
            &format!("al{i}"),
            "ar_nightblaze",
        ));
    }
    batch.push(track(
        "s_small",
        "t_nw",
        "Ghost Love Score",
        "Nightwish",
        "Once",
        "al_nw",
        "ar_nw",
    ));
    TrackRepository::new(&store).upsert_batch(&batch).unwrap();
    let resp = run_live_search(&store, "s_small", "night", None, None, 5, 5, 10).unwrap();
    assert!(
        resp.artists.iter().any(|a| a.name == "Nightwish"),
        "expected Nightwish on s_small; global bm25 must not crowd out the active server"
    );
}

#[test]
fn live_search_returns_distinct_artists_not_one_per_many_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut batch = Vec::new();
    for i in 0..12 {
        batch.push(track(
            "s1",
            &format!("t_m{i}"),
            "Song",
            "Metallica",
            "Album",
            &format!("al_m{i}"),
            "ar_meta",
        ));
    }
    for (id, name, artist_id) in [
        ("ar_metal1", "Metallica Tribute", "ar_t1"),
        ("ar_metal2", "Metallium", "ar_t2"),
        ("ar_metal3", "Metalloid", "ar_t3"),
    ] {
        batch.push(track(
            "s1",
            &format!("t_{artist_id}"),
            "One",
            name,
            "Other",
            id,
            artist_id,
        ));
    }
    TrackRepository::new(&store).upsert_batch(&batch).unwrap();
    let resp = run_live_search(&store, "s1", "metall", None, None, 5, 5, 10).unwrap();
    assert!(
        resp.artists.len() >= 3,
        "expected distinct metall* artists, got {} ({:?})",
        resp.artists.len(),
        resp.artists
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
    );
}

#[test]
fn live_search_equals_query_returns_no_false_positives() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "Intro",
                "Smith & Myers",
                "Volume 1 & 2",
                "al_vol",
                "ar1",
            ),
            track("s1", "t2", "Hello", "Adele", "25", "al_25", "ar2"),
            track("s1", "t3", "Track", "Y.O.M.C.", "Single", "al_yo", "ar3"),
        ])
        .unwrap();
    for q in ["1=2", "1=1", "M=c"] {
        let resp = run_live_search(&store, "s1", q, None, None, 5, 5, 10).unwrap();
        assert!(
            resp.tracks.is_empty() && resp.albums.is_empty() && resp.artists.is_empty(),
            "query {q:?} must not fuzzy-match unrelated library rows"
        );
    }
}

#[test]
fn live_search_censorship_stars_in_title_is_searchable() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "***Flawless",
                "Beyoncé",
                "BEYONCÉ",
                "al1",
                "ar1",
            ),
            track("s1", "t2", "Other Song", "Artist", "Album", "al2", "ar2"),
        ])
        .unwrap();
    let resp = run_live_search(&store, "s1", "***Flawless", None, None, 5, 5, 10).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].title, "***Flawless");
}

#[test]
fn live_search_multiword_album_matches_any_token_not_only_first() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track(
                "s1",
                "t1",
                "Intro",
                "Artist",
                "Supreme Ballads",
                "al_supreme",
                "ar1",
            ),
            track("s1", "t2", "Other", "Artist", "Unrelated", "al2", "ar1"),
        ])
        .unwrap();
    let resp = run_live_search(&store, "s1", "love supreme", None, None, 5, 5, 10).unwrap();
    assert!(
        resp.albums.iter().any(|a| a.name == "Supreme Ballads"),
        "second token supreme must match album title; AND-all-tokens would miss this album"
    );
}

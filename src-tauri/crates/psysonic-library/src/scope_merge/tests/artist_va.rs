#[test]
fn artist_detail_various_artists_albums_link_to_the_va_entity() {
    // The VA artist page listed album cards whose displayed credit was "Various
    // Artists" while `artist_id` still held a representative track performer, so
    // the card's artist link and the "go to artist" action opened that guest.
    let store = LibraryStore::open_in_memory();
    let c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
    let c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp Two", "comp2", "va");
    // A compilation whose tracks carry no album-artist id at all: linking to the
    // performer under a VA credit would be worse than not linking.
    let mut unlinked = va_comp_track(
        "c3",
        "Song C",
        "Perf Three",
        "p3",
        "Comp Three",
        "comp3",
        "va",
    );
    unlinked.raw_json = String::new();
    seed_and_rebuild(&store, &[c1, c2, unlinked]);
    seed_artist_row(&store, "s1", "va", "Various Artists");

    let va = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "va".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    assert_eq!(va.albums.len(), 3);
    for album in &va.albums {
        assert_eq!(
            album.artist.as_deref(),
            Some("Various Artists"),
            "album {} lost its VA credit",
            album.id
        );
    }
    // Exact per-album expectations: a blanket "va or nothing" assertion would
    // also accept a mapper that returns None for every card.
    let mut linked: Vec<(&str, Option<&str>)> = va
        .albums
        .iter()
        .map(|a| (a.id.as_str(), a.artist_id.as_deref()))
        .collect();
    // The query orders by album *name* ("Comp One", "Comp Three", "Comp Two");
    // sort by id so the expectation reads in album order.
    linked.sort_unstable_by_key(|(id, _)| *id);
    assert_eq!(
        linked,
        vec![
            ("comp1", Some("va")),
            ("comp2", Some("va")),
            // No album-artist id anywhere on this album — stay unlinked rather
            // than opening a guest performer under a Various Artists credit.
            ("comp3", None),
        ],
        "VA cards must open the VA entity, and only the id-less one stays unlinked"
    );
}

/// Inserts an artist row directly, for VA entities that have no track tagged
/// with their id (pure label-linked compilations — the common shape on servers
/// where every track carries its own performer).
fn seed_artist_row(store: &LibraryStore, server: &str, id: &str, name: &str) {
    store
        .with_conn_mut("test.seed_artist_row", |conn| {
            conn.execute(
                "INSERT INTO artist (server_id, id, name, synced_at) VALUES (?1, ?2, ?3, 1) \
                     ON CONFLICT(server_id, id) DO UPDATE SET name = excluded.name",
                rusqlite::params![server, id, name],
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn artist_detail_various_artists_pure_label_compilations() {
    // Bug A, no-id-tagged variant: a VA entity whose compilations link *only*
    // through `album_artist` and no track carries the VA performer id. The
    // `artist_key` source is then empty, so `va_mode` must come from the artist
    // row itself (not the track-derived header) and the label arm alone must
    // surface every compilation via the non-keyed detail path.
    let store = LibraryStore::open_in_memory();
    let c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
    let c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp Two", "comp2", "va");
    seed_and_rebuild(&store, &[c1, c2]);
    // The VA row exists on the server but no track is tagged with its id.
    seed_artist_row(&store, "s1", "va", "Various Artists");

    let va = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "va".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    let mut ids: Vec<&str> = va.albums.iter().map(|a| a.id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec!["comp1", "comp2"]);
    // The albums alone are not enough: the frontend loader discards the whole
    // payload when the artist header has no id (`!response.artist?.id`), and the
    // artist hook does not fall back once the multi-scope branch is taken. So an
    // empty header makes these albums unreachable in the app even though the
    // query found them.
    assert_eq!(
        va.artist.id, "va",
        "header must carry the anchor id, or the frontend drops the response"
    );
    assert_eq!(va.artist.server_id, "s1");
    assert_eq!(va.artist.name, "Various Artists");
    // The seeded header must carry a derived sort key, like every other candidate
    // builder — not None, which would reach the frontend without a `nameSort`.
    assert_eq!(
        va.artist.name_sort.as_deref(),
        Some(sort_key_for_display_name("Various Artists", DEFAULT_IGNORED_ARTICLES).as_str()),
        "seeded VA header must derive its sort key from the name"
    );
    // The stored VA `artist.album_count` is 0 (no track tags its id); the seeded
    // header must report the compilations actually returned, not contradict the grid.
    assert_eq!(
        va.artist.album_count,
        Some(2),
        "seeded VA header count must match the returned album grid"
    );
}

#[test]
fn artist_detail_non_va_track_less_artist_is_not_seeded() {
    // A real (non-VA) artist that has an `artist` row but no track in the current
    // scope must NOT be seeded: the header must stay empty so the frontend loader
    // discards the payload and takes its network fallback. Only the VA label shape
    // is seeded. (Guards against reviving a populated-but-album-less page.)
    let store = LibraryStore::open_in_memory();
    // Some unrelated track so the store isn't empty, but nothing tagged "ra".
    let other = track(
        "s1",
        "o1",
        "Song",
        Some("Other"),
        "Other Album",
        "oalb",
        Some("other"),
        200,
        "lib-a",
        Some(2000),
        None,
        None,
    );
    seed_and_rebuild(&store, &[other]);
    seed_artist_row(&store, "s1", "ra", "Real Artist");

    let detail = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "ra".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    assert_eq!(
        detail.artist.id, "",
        "a non-VA track-less artist must keep an empty header for the frontend fallback"
    );
    assert!(detail.albums.is_empty());
}

#[test]
fn artist_detail_various_artists_union_does_not_double_count() {
    // A track that qualifies under *both* arms (tagged with the VA id AND
    // labelled "Various Artists") must be counted once. The union is UNION ALL,
    // so such a track appears twice in `base`; the dedup pipeline
    // (`track_dedup`) must collapse it, or the card `song_count` doubles.
    let store = LibraryStore::open_in_memory();
    let mut both1 = va_comp_track(
        "both1",
        "Song A",
        "Various Artists",
        "va",
        "Both",
        "both",
        "va",
    );
    // Tagged with the VA performer id *and* labelled VA.
    both1.artist = Some("Various Artists".into());
    let mut both2 = va_comp_track(
        "both2",
        "Song B",
        "Various Artists",
        "va",
        "Both",
        "both",
        "va",
    );
    both2.artist = Some("Various Artists".into());
    seed_and_rebuild(&store, &[both1, both2]);

    let va = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "va".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    assert_eq!(va.albums.len(), 1);
    assert_eq!(
        va.albums[0].song_count,
        Some(2),
        "two distinct tracks must not be counted four times by the UNION ALL"
    );
}

#[test]
fn album_detail_album_artist_id_tolerates_malformed_raw_json() {
    // The album-artist id is read with JSON1 (`json_type`/`json_extract`), which
    // raise `malformed JSON` on invalid text. One badly-stored track must not
    // abort the whole album_detail query — the guard makes it contribute no id,
    // and a later valid track still resolves the VA link. (Mirror of the #1329
    // release-types malformed guard for the hero-id path.)
    let store = LibraryStore::open_in_memory();
    let mut bad = va_comp_track("aa-bad", "Broken", "Perf One", "p1", "Comp", "comp1", "va");
    bad.raw_json = "{not valid json".into();
    let good = va_comp_track("zz-good", "Fine", "Perf Two", "p2", "Comp", "comp1", "va");
    seed_and_rebuild(&store, &[bad, good]);

    let comp = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "comp1".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(comp.album.artist_id.as_deref(), Some("va"));
}

#[test]
fn artist_detail_name_uses_canonical_artist_not_feature_track_credit() {
    // Regression: a single guest-feature track in a discography carries a
    // per-track "feat." credit while sharing the artist's `artist_id`. The
    // header name must stay the canonical `artist.name`, not `MAX(t.artist)`
    // which would pick the lexicographically-larger "… feat. …" string and
    // rename the whole artist. Mirrors the browse list (reads `artist.name`).
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            // Plain credit first so the seeded `artist.name` is canonical.
            track(
                "s1",
                "t-plain",
                "A Plain Song",
                Some("Skyclad"),
                "Album One",
                "alb1",
                Some("skyclad"),
                200,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s1",
                "t-feat",
                "A Guest Song",
                Some("Skyclad feat. Ten Pole Tudor"),
                "Album Two",
                "alb2",
                Some("skyclad"),
                201,
                "lib-a",
                None,
                None,
                None,
            ),
        ],
    );

    let response = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "skyclad".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();

    assert_eq!(response.artist.name, "Skyclad");
}

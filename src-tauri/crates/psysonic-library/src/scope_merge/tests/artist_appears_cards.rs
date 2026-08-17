#[test]
fn artist_detail_splits_own_releases_from_appears_on() {
    // The track-derived album set mixes the artist's own releases with albums
    // they only appear on. `albums` carries own releases — where the artist is the
    // album artist, *including their own best-of compilations* (which the frontend
    // then groups under "Compilation"); Various Artists / other-artist releases the
    // artist only guests on belong in `appears_on_albums`. The split keys off the
    // album artist, so it is ingest-path agnostic and multi-server aware without
    // any network search.
    let store = LibraryStore::open_in_memory();
    // Own release: the helper defaults `album_artist` to the track artist.
    let own_a = track(
        "s1",
        "own1",
        "One",
        Some("The Band"),
        "Own Album",
        "alb-own",
        Some("art1"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    let own_b = track(
        "s1",
        "own2",
        "Two",
        Some("The Band"),
        "Own Album",
        "alb-own",
        Some("art1"),
        210,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    // The artist's own best-of: a compilation, but album_artist credits the artist,
    // so it stays in the main discography (Option B) rather than appears-on.
    let mut own_comp = track(
        "s1",
        "ownc1",
        "Best Cut",
        Some("The Band"),
        "Own Best-Of",
        "alb-owncomp",
        Some("art1"),
        205,
        "lib-a",
        Some(2022),
        None,
        None,
    );
    own_comp.album_artist = Some("The Band".into());
    own_comp.raw_json = r#"{"compilation":true}"#.into();
    // Various Artists compilation with a single track by the artist.
    let mut comp = track(
        "s1",
        "comp1",
        "Comp Cut",
        Some("The Band"),
        "A Compilation",
        "alb-comp",
        Some("art1"),
        180,
        "lib-a",
        Some(2019),
        None,
        None,
    );
    comp.album_artist = Some("Various Artists".into());
    // OpenSubsonic/S2 compilation: the flat album_artist is empty and the only
    // compilation signal lives in raw_json — must still count as appears-on.
    let mut s2comp = track(
        "s1",
        "s2c1",
        "S2 Comp Cut",
        Some("The Band"),
        "An S2 Compilation",
        "alb-s2comp",
        Some("art1"),
        170,
        "lib-a",
        Some(2018),
        None,
        None,
    );
    s2comp.album_artist = None;
    s2comp.raw_json = r#"{"compilation":true}"#.into();
    // Another artist's album the artist only guests on.
    let mut guest = track(
        "s1",
        "guest1",
        "Guest Spot",
        Some("The Band"),
        "Someone Else's Album",
        "alb-guest",
        Some("art1"),
        190,
        "lib-a",
        Some(2021),
        None,
        None,
    );
    guest.album_artist = Some("Another Artist".into());
    seed_and_rebuild(&store, &[own_a, own_b, own_comp, comp, s2comp, guest]);

    let response = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "art1".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();

    let own_ids: Vec<&str> = response.albums.iter().map(|a| a.id.as_str()).collect();
    let appears_ids: Vec<&str> = response
        .appears_on_albums
        .iter()
        .map(|a| a.id.as_str())
        .collect();
    assert_eq!(own_ids, ["alb-own", "alb-owncomp"]);
    assert_eq!(appears_ids, ["alb-comp", "alb-s2comp", "alb-guest"]);
}

#[test]
fn artist_detail_appears_on_card_credits_the_headliner_not_the_guest() {
    // The viewed artist guests on an album with an *untagged* row (no
    // `album_artist`); another track on the same album carries the headliner and
    // its `albumArtistId`. The album must land in appears-on, and its card must
    // show and link the headliner — not the viewed artist's guest-track performer,
    // which is the row the album representative is built from (findings 2 & 5).
    let store = LibraryStore::open_in_memory();
    // The viewed artist's guest track: explicitly untagged album-artist.
    let mut guest = track(
        "s1",
        "g1",
        "Guest Verse",
        Some("The Band"),
        "Someone's Record",
        "alb-feat",
        Some("art1"),
        190,
        "lib-a",
        Some(2021),
        None,
        None,
    );
    guest.album_artist = None;
    // Another performer's row on the same album carries the album-artist tag and
    // the server's albumArtistId. It is not one of the viewed artist's rows, so it
    // only reaches the query through the whole-album scan.
    let mut head = track(
        "s1",
        "h1",
        "Title Track",
        Some("Headliner"),
        "Someone's Record",
        "alb-feat",
        Some("perf2"),
        200,
        "lib-a",
        Some(2021),
        None,
        None,
    );
    head.album_artist = Some("Headliner".into());
    head.raw_json = r#"{"albumArtistId":"head-id"}"#.into();
    // Give the artist one plain own release so the page is not appears-on-only.
    let own = track(
        "s1",
        "o1",
        "Own",
        Some("The Band"),
        "Own Album",
        "alb-own",
        Some("art1"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    seed_and_rebuild(&store, &[guest, head, own]);

    let response = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "art1".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();

    let feat = response
        .appears_on_albums
        .iter()
        .find(|a| a.id == "alb-feat")
        .expect("guested album is an appears-on entry");
    assert_eq!(feat.artist.as_deref(), Some("Headliner"));
    assert_eq!(feat.artist_id.as_deref(), Some("head-id"));
}

#[test]
fn artist_detail_appears_on_card_recovers_the_id_from_a_sibling_track() {
    // Partial album credit: the representative row *does* carry the album-artist
    // label, but the server only tagged `albumArtistId` on a sibling track. The
    // card must still link to the album-artist entity — the name alone is not a
    // link, and falling back to the guest performer's id would open the wrong
    // artist under a correct-looking credit.
    //
    // Distinct from `..._credits_the_headliner_not_the_guest`, where the
    // representative row is untagged: there the label itself has to be recovered,
    // so a fix that only reads the label would pass it. Here the label is already
    // right and only the id is missing, which is exactly the case a query-local
    // recovery gets wrong and `overlay_album_artist_links` gets right.
    let store = LibraryStore::open_in_memory();
    // The viewed artist's only row on this album: tagged, but no id in raw_json.
    let mut guest = track(
        "s1",
        "p1",
        "Guest Spot",
        Some("The Band"),
        "Partial Credit",
        "alb-partial",
        Some("art1"),
        190,
        "lib-a",
        Some(2022),
        None,
        None,
    );
    guest.album_artist = Some("Headliner".into());
    // A sibling the viewed artist has no part in — reachable only through the
    // whole-album read, and the sole carrier of the album-artist id.
    let mut sibling = track(
        "s1",
        "p2",
        "Title Track",
        Some("Headliner"),
        "Partial Credit",
        "alb-partial",
        Some("perf2"),
        200,
        "lib-a",
        Some(2022),
        None,
        None,
    );
    sibling.album_artist = Some("Headliner".into());
    sibling.raw_json = r#"{"albumArtistId":"head-id"}"#.into();
    let own = track(
        "s1",
        "o1",
        "Own",
        Some("The Band"),
        "Own Album",
        "alb-own",
        Some("art1"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    seed_and_rebuild(&store, &[guest, sibling, own]);

    let response = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "art1".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();

    let feat = response
        .appears_on_albums
        .iter()
        .find(|a| a.id == "alb-partial")
        .expect("guested album is an appears-on entry");
    assert_eq!(feat.artist.as_deref(), Some("Headliner"));
    assert_eq!(
        feat.artist_id.as_deref(),
        Some("head-id"),
        "the id must come from the sibling row, not the guest performer",
    );
}

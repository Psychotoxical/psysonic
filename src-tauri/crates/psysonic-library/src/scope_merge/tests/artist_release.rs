#[test]
fn artist_detail_can_skip_tracks_for_discography_only_callers() {
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
            Some(2024),
            Some("Rock"),
            None,
        )],
    );

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

    assert_eq!(response.artist.id, "art1");
    assert_eq!(response.albums.len(), 1);
    assert!(response.tracks.is_empty());

    let with_tracks = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "art1".into(),
            server_id: "s1".into(),
            include_tracks: true,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    assert_eq!(with_tracks.tracks.len(), 1);
    assert_eq!(with_tracks.tracks[0].id, "t1");
}

#[test]
fn artist_detail_albums_carry_release_types_for_grouping() {
    // Regression (#1326): the artist page groups a discography into Albums /
    // Singles / EPs / Live / Compilations from each album's `releaseTypes`. The
    // multi-scope pipeline builds albums from tracks and keeps album `raw_json`
    // NULL, so the release types must come from the tracks' raw JSON (order
    // preserved), or grouping goes flat. Two ingest paths store them differently
    // and both must work: Navidrome-native `raw_json.tags.releasetype` and the
    // OpenSubsonic/S2 top-level `raw_json.releaseTypes`
    // (`merge_album_open_subsonic_track_raw`). Albums with neither stay null.
    let store = LibraryStore::open_in_memory();
    // Native Navidrome shape.
    let mut native = track(
        "s1",
        "t1",
        "Song",
        Some("Artist"),
        "A Live EP",
        "alb1",
        Some("art1"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    native.raw_json = r#"{"tags":{"releasetype":["Single","Live"]}}"#.into();
    // OpenSubsonic/S2 shape: album-level array copied onto the track top-level.
    let mut s2 = track(
        "s1",
        "t2",
        "Song",
        Some("Artist"),
        "B Compilation EP",
        "alb2",
        Some("art1"),
        200,
        "lib-a",
        Some(2021),
        None,
        None,
    );
    s2.raw_json = r#"{"releaseTypes":["EP"]}"#.into();
    // Neither representation → default (null) group.
    let plain = track(
        "s1",
        "t3",
        "Song",
        Some("Artist"),
        "C Plain Album",
        "alb3",
        Some("art1"),
        200,
        "lib-a",
        Some(2022),
        None,
        None,
    );
    seed_and_rebuild(&store, &[native, s2, plain]);

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

    assert_eq!(response.albums.len(), 3);
    let by_id = |id: &str| {
        response
            .albums
            .iter()
            .find(|a| a.id == id)
            .unwrap_or_else(|| panic!("album {id} missing"))
    };
    // Native tag order preserved.
    assert_eq!(by_id("alb1").raw_json["releaseTypes"][0], "Single");
    assert_eq!(by_id("alb1").raw_json["releaseTypes"][1], "Live");
    // S2 top-level array surfaced.
    assert_eq!(by_id("alb2").raw_json["releaseTypes"][0], "EP");
    // No release types anywhere → null raw_json, so grouping falls back cleanly.
    assert!(by_id("alb3").raw_json.is_null());
}

#[test]
fn artist_detail_release_types_reject_unusable_candidates() {
    // Release-type candidates must be validated (non-empty array of strings)
    // before precedence and before the representative-track `LIMIT 1`, or bad
    // server metadata leaves valid albums ungrouped and can crash the artist page.
    let store = LibraryStore::open_in_memory();
    // (1) Empty top-level array must not suppress the valid nested value.
    let mut empty_top = track(
        "s1",
        "et1",
        "Song",
        Some("Artist"),
        "Empty Top",
        "alb-empty",
        Some("art1"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    empty_top.raw_json = r#"{"releaseTypes":[],"tags":{"releasetype":["EP"]}}"#.into();
    // (2) An unusable earlier track must not hide a valid later track on the same
    // album. `hid1` sorts before `hid2`; only `hid2` carries a usable array.
    let mut hidden_bad = track(
        "s1",
        "hid1",
        "First",
        Some("Artist"),
        "Hidden",
        "alb-hidden",
        Some("art1"),
        200,
        "lib-a",
        Some(2021),
        None,
        None,
    );
    hidden_bad.raw_json = r#"{"releaseTypes":[]}"#.into();
    let mut hidden_good = track(
        "s1",
        "hid2",
        "Second",
        Some("Artist"),
        "Hidden",
        "alb-hidden",
        Some("art1"),
        210,
        "lib-a",
        Some(2021),
        None,
        None,
    );
    hidden_good.raw_json = r#"{"tags":{"releasetype":["Album","Live"]}}"#.into();
    // (3a) Non-string members with no usable fallback → no release types at all.
    let mut nonstring = track(
        "s1",
        "ns1",
        "Song",
        Some("Artist"),
        "Non String",
        "alb-nonstring",
        Some("art1"),
        200,
        "lib-a",
        Some(2022),
        None,
        None,
    );
    nonstring.raw_json = r#"{"releaseTypes":["EP",null]}"#.into();
    // (3b) Non-string top-level → fall back to the valid nested value.
    let mut nonstring_fallback = track(
        "s1",
        "nsf1",
        "Song",
        Some("Artist"),
        "Non String Fallback",
        "alb-nsfb",
        Some("art1"),
        200,
        "lib-a",
        Some(2023),
        None,
        None,
    );
    nonstring_fallback.raw_json =
        r#"{"releaseTypes":["Live",1],"tags":{"releasetype":["Album"]}}"#.into();
    seed_and_rebuild(
        &store,
        &[
            empty_top,
            hidden_bad,
            hidden_good,
            nonstring,
            nonstring_fallback,
        ],
    );

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
    let by_id = |id: &str| {
        response
            .albums
            .iter()
            .find(|a| a.id == id)
            .unwrap_or_else(|| panic!("album {id} missing"))
    };
    // Empty top-level did not suppress the nested value.
    assert_eq!(by_id("alb-empty").raw_json["releaseTypes"][0], "EP");
    // The valid later track won over the unusable earlier one, order preserved.
    assert_eq!(by_id("alb-hidden").raw_json["releaseTypes"][0], "Album");
    assert_eq!(by_id("alb-hidden").raw_json["releaseTypes"][1], "Live");
    // Non-string members with no fallback → null (never reaches the frontend).
    assert!(by_id("alb-nonstring").raw_json.is_null());
    // Non-string top-level fell back to the valid nested array.
    assert_eq!(by_id("alb-nsfb").raw_json["releaseTypes"][0], "Album");
}

#[test]
fn artist_detail_release_types_tolerate_malformed_raw_json() {
    // `track.raw_json` is unconstrained text and the library tolerates invalid
    // JSON (from_row → Value::Null). The release-type lookup must not let a
    // malformed row raise `malformed JSON` and abort the whole artist-detail
    // query: the bad row contributes nothing and a later valid track still wins.
    let store = LibraryStore::open_in_memory();
    // Malformed row sorts before the valid one, so an unguarded query would hit
    // it first and error out.
    let mut bad = track(
        "s1",
        "aa-bad",
        "Broken",
        Some("Artist"),
        "Mixed",
        "alb-mixed",
        Some("art1"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    bad.raw_json = "{not valid json".into();
    let mut good = track(
        "s1",
        "zz-good",
        "Fine",
        Some("Artist"),
        "Mixed",
        "alb-mixed",
        Some("art1"),
        210,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    good.raw_json = r#"{"tags":{"releasetype":["EP"]}}"#.into();
    seed_and_rebuild(&store, &[bad, good]);

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

    let album = response
        .albums
        .iter()
        .find(|a| a.id == "alb-mixed")
        .expect("album missing");
    assert_eq!(album.raw_json["releaseTypes"][0], "EP");
}

/// Builds a compilation track: `album_artist` = "Various Artists", the track
/// credited to a real performer, and `raw_json.albumArtistId` = the VA entity id.
/// This is the shape that links a compilation to VA only through the label —
/// every track keeps its own performer `artist_id`.
#[allow(clippy::too_many_arguments)]
fn va_comp_track(
    id: &str,
    title: &str,
    performer: &str,
    performer_id: &str,
    album: &str,
    album_id: &str,
    va_id: &str,
) -> TrackRow {
    let mut row = track(
        "s1",
        id,
        title,
        Some(performer),
        album,
        album_id,
        Some(performer_id),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    row.album_artist = Some("Various Artists".into());
    row.raw_json = format!(r#"{{"albumArtistId":"{va_id}"}}"#);
    row
}

#[test]
fn artist_detail_various_artists_includes_album_artist_compilations() {
    // Bug A: "Various Artists" is not a real performer — its compilations attach
    // through the `album_artist` label while each track keeps its own performer
    // `artist_id`. The `artist_key` source alone finds only tracks literally
    // tagged with the VA id (here one Fat-Wreck-style album), so the page showed
    // "a handful" instead of every compilation. The VA union arm must add the
    // label-linked compilations, and a normal artist must stay unaffected.
    let store = LibraryStore::open_in_memory();
    // Two compilations linked to VA only through `album_artist`.
    let c1a = va_comp_track("c1a", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
    let c1b = va_comp_track("c1b", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
    let c2a = va_comp_track(
        "c2a",
        "Song C",
        "Perf Three",
        "p3",
        "Comp Two",
        "comp2",
        "va",
    );
    // A track literally tagged with the VA performer id but with an *empty*
    // album_artist: creates the "Various Artists" artist row and exercises the
    // `artist_key` arm, which the union must not drop.
    let mut vatag = track(
        "s1",
        "vatag",
        "Punk Track",
        Some("Various Artists"),
        "Punk Comp",
        "punk1",
        Some("va"),
        200,
        "lib-a",
        Some(2019),
        None,
        None,
    );
    vatag.album_artist = Some(String::new());
    // A normal solo artist that must NOT absorb the compilations.
    let solo = track(
        "s1",
        "solo1",
        "Solo Song",
        Some("Solo Artist"),
        "Solo Album",
        "soloalb",
        Some("solo"),
        200,
        "lib-a",
        Some(2022),
        None,
        None,
    );
    seed_and_rebuild(&store, &[c1a, c1b, c2a, vatag, solo]);

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
    // Label-linked compilations (comp1, comp2) plus the id-tagged album (punk1).
    assert_eq!(ids, vec!["comp1", "comp2", "punk1"]);

    // A normal artist page must not gain compilations from the VA label match.
    let solo_detail = artist_detail(
        &store,
        &LibraryScopeArtistDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            artist_id: "solo".into(),
            server_id: "s1".into(),
            include_tracks: false,
            top_tracks_limit: None,
        },
    )
    .unwrap();
    let solo_ids: Vec<&str> = solo_detail.albums.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(solo_ids, vec!["soloalb"]);
}

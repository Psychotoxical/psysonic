use super::*;

#[test]
fn various_artists_label_is_word_boundary_matched() {
    assert!(various_artists_label("Various Artists"));
    assert!(various_artists_label("  various artists  "));
    assert!(various_artists_label("VA / Various Artists"));
    assert!(various_artists_label("Various Artists!"));
    // Word-boundary, mirroring the frontend regex: an alnum-adjacent occurrence
    // is not the label. These are exactly the strings a substring match would
    // have disagreed with the frontend on.
    assert!(!various_artists_label("various artistsX"));
    assert!(!various_artists_label("Xvarious artists"));
    assert!(!various_artists_label("Metallica"));
    assert!(!various_artists_label(""));
}

#[test]
fn sql_mentions_json_paths() {
    let sql = compilation_raw_json_sql("t");
    assert!(sql.contains("$.compilation"));
    assert!(sql.contains("$.releaseTypes"));
    assert!(sql.contains("$.tags.releasetype"));
}

#[test]
fn compilation_raw_json_sql_recognizes_every_representation() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE t (raw_json TEXT)", []).unwrap();
    let sql = format!("SELECT {} FROM t", compilation_raw_json_sql("t"));

    // (raw_json, expected-compilation)
    let cases: &[(&str, bool)] = &[
        (r#"{"compilation":1}"#, true),
        (r#"{"compilation":"true"}"#, true),
        (r#"{"isCompilation":true}"#, true),
        (r#"{"releaseTypes":["Album","Compilation"]}"#, true),
        // Navidrome-native nested tag — the representation the fix adds.
        (r#"{"tags":{"releasetype":["Compilation"]}}"#, true),
        (r#"{"tags":{"releasetype":["compilation"]}}"#, true),
        // Not a compilation.
        (r#"{"tags":{"releasetype":["Album"]}}"#, false),
        (r#"{"releaseTypes":["Album"]}"#, false),
        (r#"{"albumArtist":"Someone"}"#, false),
        // A scalar (not an array) must not match, and malformed JSON must not
        // abort — it takes the guarded fallback and simply doesn't match.
        (r#"{"tags":{"releasetype":"Compilation"}}"#, false),
        ("{not valid json", false),
    ];

    for (raw, expected) in cases {
        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t (raw_json) VALUES (?1)", [raw])
            .unwrap();
        let got: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(got == 1, *expected, "raw_json={raw}");
    }
}

#[test]
fn predicate_includes_artist_columns() {
    let sql = compilation_predicate_sql("t", Some("t.artist"), Some("t.album_artist"));
    assert!(sql.contains("t.artist"));
    assert!(sql.contains("t.album_artist"));
    assert!(sql.contains("$.displayArtist"));
}

#[test]
fn album_credits_artist_matches_self_and_led_collaborations() {
    // Exact and case/space-insensitive self credit.
    assert!(album_credits_artist(Some("Metallica"), "Metallica"));
    assert!(album_credits_artist(Some("  metallica "), "Metallica"));
    // Collaboration the artist leads keeps the album as their own.
    assert!(album_credits_artist(
        Some("Metallica & San Francisco Symphony"),
        "Metallica"
    ));
    assert!(album_credits_artist(
        Some("Bela B. feat. Smokestack"),
        "Bela B."
    ));
    // Bracketed credit — the dominant OpenSubsonic `displayArtist` convention.
    assert!(album_credits_artist(
        Some("Some Artist (feat. A Guest)"),
        "Some Artist"
    ));
    // ...but a bracket alone is not a credit: a qualifier must not count.
    assert!(!album_credits_artist(
        Some("Some Artist (Live)"),
        "Some Artist"
    ));
    // A band name that itself contains the separator matches by equality.
    assert!(album_credits_artist(
        Some("Mumford & Sons"),
        "Mumford & Sons"
    ));
    // Non-ASCII names fold correctly.
    assert!(album_credits_artist(Some("Чиж & Co"), "Чиж"));
    // Diacritics and punctuation fold through the same normalization that built
    // the cluster key, so two servers spelling the name differently still match.
    assert!(album_credits_artist(Some("Royksopp"), "Röyksopp"));
    assert!(album_credits_artist(Some("AC-DC"), "AC/DC"));
    // A leading article on either side is not a different artist: servers commonly
    // tag `albumartist = Beatles` for the entity "The Beatles".
    assert!(album_credits_artist(Some("Beatles"), "The Beatles"));
    assert!(album_credits_artist(Some("The Beatles"), "Beatles"));
}

#[test]
fn album_credits_artist_rejects_others_and_partial_names() {
    assert!(!album_credits_artist(Some("Various Artists"), "Metallica"));
    assert!(!album_credits_artist(Some("Another Artist"), "The Band"));
    // A separator is required after the name, so a longer name is not credited.
    assert!(!album_credits_artist(Some("Metallican"), "Metallica"));
    // A different band whose name merely *extends* this one is not credited: the
    // join marker has to be whitespace-separated, and a bare conjunction word is
    // not a join marker at all. Without this the whole catalogue of the longer
    // band would be filed into this artist's discography.
    assert!(!album_credits_artist(Some("Air Supply"), "Air"));
    assert!(!album_credits_artist(Some("Earth, Wind & Fire"), "Earth"));
    assert!(!album_credits_artist(Some("Death Cab for Cutie"), "Death"));
    assert!(!album_credits_artist(Some("Belle and Sebastian"), "Belle"));
    // The artist must lead the credit, not merely appear in it.
    assert!(!album_credits_artist(
        Some("San Francisco Symphony & Metallica"),
        "Metallica"
    ));
    assert!(!album_credits_artist(None, "Metallica"));
    assert!(!album_credits_artist(Some("Metallica"), ""));
}

#[test]
fn pick_album_group_artist_prefers_nonempty_album_artist() {
    assert_eq!(
        pick_album_group_artist(Some("Alice".into()), Some("Various Artists".into())),
        Some("Various Artists".to_string())
    );
    assert_eq!(
        pick_album_group_artist(Some("Groove Armada".into()), Some("Underworld".into())),
        Some("Underworld".to_string())
    );
    assert_eq!(
        pick_album_group_artist(Some("Alice".into()), Some("Bob".into())),
        Some("Bob".to_string())
    );
}

#[test]
fn pick_album_group_artist_falls_back_to_track_artist() {
    assert_eq!(
        pick_album_group_artist(Some("Alice".into()), None),
        Some("Alice".to_string())
    );
    assert_eq!(
        pick_album_group_artist(Some("Alice".into()), Some("".into())),
        Some("Alice".to_string())
    );
    assert_eq!(pick_album_group_artist(None, None), None);
}

#[test]
fn pick_album_group_artist_id_mirrors_name_side() {
    // Named album-artist with an id → link to that album-artist entity, even
    // though the representative track performer differs (the VA / collaboration
    // case: display credit and link stay on the same entity).
    assert_eq!(
        pick_album_group_artist_id(
            Some("track-performer".into()),
            Some("Various Artists"),
            Some("va-id".into()),
        ),
        Some("va-id".to_string())
    );
    // Named "Various Artists" but the server gave no album-artist id → leave the
    // link empty. The track performer is provably not the album artist here, so
    // linking to it would open one guest under a Various Artists credit.
    assert_eq!(
        pick_album_group_artist_id(
            Some("track-performer".into()),
            Some("Various Artists"),
            None
        ),
        None
    );
    // Any other named album-artist without an id keeps the track id, so credit
    // and link stay on the same entity rather than going blank.
    assert_eq!(
        pick_album_group_artist_id(Some("track-performer".into()), Some("Alice"), None),
        Some("track-performer".to_string())
    );
    // Blank album-artist must not count as named → fall back to the track id,
    // ignoring any stray album-artist id.
    assert_eq!(
        pick_album_group_artist_id(Some("solo".into()), Some("   "), Some("ignored".into())),
        Some("solo".to_string())
    );
    assert_eq!(
        pick_album_group_artist_id(Some("solo".into()), None, None),
        Some("solo".to_string())
    );
    // Nothing usable anywhere.
    assert_eq!(
        pick_album_group_artist_id(None, Some("Various Artists"), Some("  ".into())),
        None
    );
}

#[test]
fn sql_track_group_display_artist_matches_pick_album_group_artist() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE la (artist TEXT, album_artist TEXT)", [])
        .unwrap();
    let sql = format!("SELECT {} FROM la", sql_track_group_display_artist("la"));

    let cases: [(&str, &str); 7] = [
        ("Groove Armada", "Underworld"),
        ("Alice", ""),
        ("", "Various Artists"),
        ("Alice", "Bob"),
        ("  ", "Bob"),
        ("Alice", "   "),
        ("", ""),
    ];

    for (track, album) in cases {
        conn.execute("DELETE FROM la", []).unwrap();
        conn.execute(
            "INSERT INTO la (artist, album_artist) VALUES (?1, ?2)",
            rusqlite::params![track, album],
        )
        .unwrap();
        let sql_out: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).ok();
        let rust_out = pick_album_group_artist(
            (!track.is_empty()).then(|| track.to_string()),
            (!album.is_empty()).then(|| album.to_string()),
        );
        assert_eq!(sql_out, rust_out, "track={track:?} album={album:?}");
    }
}

/// Same parity, but for the **aggregate** form the grouped album browse sorts on.
///
/// `map_album_from_tracks` builds a row's display artist as
/// `pick_album_group_artist(MAX(artist), MAX(album_artist))`, so the sort key
/// must be `sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)")` over
/// the same aggregates — anything else sorts the album under a name the row does
/// not show (#1217). The multi-row groups here are the point: a single row cannot
/// tell an aggregate apart from a bare column.
#[test]
fn sql_display_artist_from_aggregates_matches_pick_album_group_artist() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute("CREATE TABLE t (artist TEXT, album_artist TEXT)", [])
        .unwrap();
    let sql = format!(
        "SELECT {} FROM t",
        sql_display_artist_from("MAX(t.artist)", "MAX(t.album_artist)"),
    );

    // Each case is one album's worth of tracks — album_artist deliberately sparse.
    let groups: [&[(&str, Option<&str>)]; 5] = [
        // Featured guest on one track only; the album artist is what shows.
        &[("Alpha", Some("Alpha")), ("Alpha feat. Zulu", None)],
        // Album artist on the *second* track — MAX still has to find it.
        &[("Alpha feat. Zulu", None), ("Alpha", Some("Alpha"))],
        // No album artist anywhere: falls back to the track credit.
        &[("Alpha", None), ("Alpha feat. Zulu", None)],
        // Blank strings must not count as an album artist.
        &[("Alice", Some("   ")), ("Alice feat. Bob", Some(""))],
        // Compilation: every track carries the same album artist.
        &[
            ("Alice", Some("Various Artists")),
            ("Bob", Some("Various Artists")),
        ],
    ];

    for rows in groups {
        conn.execute("DELETE FROM t", []).unwrap();
        for (artist, album_artist) in rows {
            conn.execute(
                "INSERT INTO t (artist, album_artist) VALUES (?1, ?2)",
                rusqlite::params![artist, album_artist],
            )
            .unwrap();
        }
        let sql_out: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).unwrap();

        // The Rust side of the same decision, over the same aggregates.
        let max_artist = rows.iter().map(|(a, _)| *a).max().map(str::to_string);
        let max_album_artist = rows
            .iter()
            .filter_map(|(_, aa)| *aa)
            .max()
            .map(str::to_string);
        let rust_out = pick_album_group_artist(max_artist, max_album_artist);

        assert_eq!(sql_out, rust_out, "rows={rows:?}");
    }
}

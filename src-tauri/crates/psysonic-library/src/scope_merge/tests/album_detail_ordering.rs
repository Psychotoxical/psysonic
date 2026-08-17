#[test]
fn album_detail_keeps_priority_owner_metadata_coherent() {
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
                Some("Jazz"),
                Some("cov-b"),
            ),
        ],
    );
    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")],
            album_id: "alb-a".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(detail.album.year, Some(2001));
    assert_eq!(detail.album.genre, None);
    assert_eq!(detail.album.cover_art_id, None);
    assert_eq!(detail.tracks.len(), 2);
}

#[test]
fn album_detail_orders_tracks_disc_then_track() {
    // A multi-disc album must play disc 1 in full before disc 2 — ordered by
    // (disc_number, track_number). Ordering by track_number first interleaves
    // the discs (D1T1, D2T1, D1T2, D2T2), which is what the Play-All queue did.
    // A missing disc number is treated as disc 1 (matching the UI's
    // `discNumber ?? 1`), so an untagged track stays in the disc-1 group and
    // precedes disc 2 rather than sorting after every explicit disc. `id` is the
    // final tie-break, so duplicate disc/track metadata is still deterministic.
    let store = LibraryStore::open_in_memory();
    // Unique title per id, so nothing dedups by title.
    let mk = |id: &str, disc: Option<i64>, trk: i64| {
        let mut t = track(
            "s1",
            id,
            id,
            Some("Artist"),
            "Double Album",
            "alb-2disc",
            Some("art1"),
            200,
            "lib-a",
            Some(2000),
            None,
            None,
        );
        t.disc_number = disc;
        t.track_number = Some(trk);
        t
    };
    // Seeded scrambled; ids deliberately don't match the target order.
    // `u-null-t3` has no disc number and must land in the disc-1 group; `b`/`z`
    // share disc 2 / track 2 and must fall back to id order.
    seed_and_rebuild(
        &store,
        &[
            mk("z-d2t2", Some(2), 2),
            mk("q-d1t1", Some(1), 1),
            mk("b-d2t2", Some(2), 2),
            mk("u-null-t3", None, 3),
            mk("a-d2t1", Some(2), 1),
            mk("m-d1t2", Some(1), 2),
        ],
    );

    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "alb-2disc".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();

    let ids: Vec<&str> = detail.tracks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "q-d1t1",
            "m-d1t2",
            "u-null-t3",
            "a-d2t1",
            "b-d2t2",
            "z-d2t2"
        ]
    );
}

#[test]
fn album_detail_disc_order_tie_break_is_total_across_servers() {
    // The scoped loader merges a cross-server album, so a server-local `id` is
    // not a total tie-break: two surviving tracks from different servers can
    // share disc, track number, and id. `server_id` is the final key, which
    // makes the Play-All order deterministic. The contract is *lexical*
    // `server_id` order, not scope priority — only the dedup inside `ranked`
    // is priority-driven.
    //
    // The fixture deliberately opposes the incidental row order so the
    // assertion cannot pass without that final key: `s2` is seeded first and
    // its tied track sorts before `s1`'s by title/dedup key. Removing
    // `server_id ASC` from the production query must turn this test red.
    let store = LibraryStore::open_in_memory();
    let disc1 = |mut t: TrackRow, trk: i64| {
        t.disc_number = Some(1);
        t.track_number = Some(trk);
        t
    };
    // Matching anchor tracks (same title + duration) de-duplicate and merge the
    // album across the two servers.
    let s1_anchor = disc1(
        track(
            "s1",
            "s1-anchor",
            "Anchor",
            Some("Band"),
            "Tie Album",
            "s1-tie",
            Some("band"),
            100,
            "lib-a",
            Some(2020),
            None,
            None,
        ),
        1,
    );
    let s2_anchor = disc1(
        track(
            "s2",
            "s2-anchor",
            "Anchor",
            Some("Band"),
            "Tie Album",
            "s2-tie",
            Some("band"),
            100,
            "lib-b",
            Some(2020),
            None,
            None,
        ),
        1,
    );
    // Same id / disc / track on both servers, but distinct title + duration so
    // the two rows do not de-duplicate and both survive the merge — tying on
    // every key except server_id. The titles are chosen so the dedup key of the
    // `s1` row sorts AFTER the `s2` one: any incidental ordering by title or
    // dedup key therefore yields s2 → s1, the reverse of the asserted order.
    let s1_dup = disc1(
        track(
            "s1",
            "dup",
            "Zulu",
            Some("Band"),
            "Tie Album",
            "s1-tie",
            Some("band"),
            200,
            "lib-a",
            Some(2020),
            None,
            None,
        ),
        2,
    );
    let s2_dup = disc1(
        track(
            "s2",
            "dup",
            "Alpha",
            Some("Band"),
            "Tie Album",
            "s2-tie",
            Some("band"),
            300,
            "lib-b",
            Some(2020),
            None,
            None,
        ),
        2,
    );
    // Seeded s2-first so insertion/rowid order also opposes the assertion.
    seed_and_rebuild(&store, &[s2_anchor, s2_dup, s1_anchor, s1_dup]);

    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            album_id: "s1-tie".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();

    let seq: Vec<(&str, &str)> = detail
        .tracks
        .iter()
        .map(|t| (t.server_id.as_str(), t.id.as_str()))
        .collect();
    // The anchor merges to the priority server (that part is `pr`-driven inside
    // `ranked`). The tied `dup` rows are then ordered by the final lexical
    // `server_id` key — s1 before s2 — against the fixture's own s2-first bias.
    assert_eq!(seq, [("s1", "s1-anchor"), ("s1", "dup"), ("s2", "dup")]);
}

#[test]
fn album_detail_various_artists_hero_links_to_album_artist() {
    // Bug B: a compilation's hero shows the album-artist credit ("Various
    // Artists") but linked to a representative track's performer id, because the
    // DTO took `artist_id` from `MAX(t.artist_id)`. The id must follow the same
    // choice as the displayed name — the album-artist entity (`albumArtistId`).
    let store = LibraryStore::open_in_memory();
    let c1a = va_comp_track("c1a", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
    let c1b = va_comp_track("c1b", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
    // Ensure the VA row exists (album-artist entity being linked to).
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
    seed_and_rebuild(&store, &[c1a, c1b, vatag, solo]);

    let comp = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "comp1".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        comp.album.artist_id.as_deref(),
        Some("va"),
        "compilation hero must link to the VA entity, not a track performer"
    );

    // A solo album (no album-artist id in raw_json) keeps the track artist id.
    let solo_detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "soloalb".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(solo_detail.album.artist_id.as_deref(), Some("solo"));
}

#[test]
fn live_search_albums_links_va_card_to_the_album_artist() {
    // A compilation surfaced in live search must credit "Various Artists" and
    // link `artist_id` to the album-artist entity — recovered from a sibling
    // track even when the best-ranked (representative) track carries no
    // `albumArtistId`. The dedup collapses siblings, so recovery has to run on
    // the per-track scan (window), not after the group.
    let store = LibraryStore::open_in_memory();
    // The best-ranked (representative) track matches the query in *both* title
    // and album, so it deterministically wins the group — yet it lacks the
    // album-artist id. Without cross-sibling recovery the card would render
    // unlinked; the window must lift "va" from the sibling.
    let mut c1 = va_comp_track(
        "c1",
        "Comp Anthem",
        "Perf One",
        "p1",
        "Comp One",
        "comp1",
        "va",
    );
    c1.raw_json = "{}".into();
    // ... its sibling carries the id but matches only via the album title.
    let c2 = va_comp_track("c2", "Bravo", "Perf Two", "p2", "Comp One", "comp1", "va");
    // A solo album keeps its own performer id (no album-artist entity).
    let solo = track(
        "s1",
        "solo1",
        "Comp Solo",
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
    seed_and_rebuild(&store, &[c1, c2, solo]);

    let albums = live_search_albums(&store, &[scope_pair("s1", "lib-a")], "Comp*", 20).unwrap();
    let comp = albums
        .iter()
        .find(|a| a.id == "comp1")
        .expect("comp missing");
    assert_eq!(comp.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        comp.artist_id.as_deref(),
        Some("va"),
        "VA card must link to the album-artist entity, recovered from a sibling"
    );
    let solo_dto = albums
        .iter()
        .find(|a| a.id == "soloalb")
        .expect("solo missing");
    assert_eq!(solo_dto.artist_id.as_deref(), Some("solo"));
}

/// Inserts the standalone `album` row that a normal S2/`getAlbum` sync writes.
/// `upsert_album_from_get_album` persists the *legacy* `artistId`, which on a
/// compilation is a representative performer — the value that must not win over
/// the resolved album-artist.
fn seed_album_row(
    store: &LibraryStore,
    server: &str,
    id: &str,
    name: &str,
    artist: &str,
    artist_id: &str,
    raw_json: &str,
) {
    store
        .with_conn_mut("test.seed_album_row", |conn| {
            conn.execute(
                "INSERT INTO album (server_id, id, name, artist, artist_id, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6) \
                     ON CONFLICT(server_id, id) DO UPDATE SET \
                       artist = excluded.artist, artist_id = excluded.artist_id, \
                       raw_json = excluded.raw_json",
                rusqlite::params![server, id, name, artist, artist_id, raw_json],
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn album_detail_album_artist_id_survives_the_album_row_overlay() {
    // Bug B, durable variant: the corrected album-artist id was computed in
    // `fetch_album_candidates` and then overwritten by `overlay_priority_album_row`,
    // which copied `album.artist_id` from the standalone album row. That row holds
    // the legacy performer id (the sync `Album` type maps no `albumArtistId`), so a
    // normally synced compilation relinked its "Various Artists" hero to a guest.
    let store = LibraryStore::open_in_memory();
    let c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
    let c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
    seed_and_rebuild(&store, &[c1, c2]);
    // What a normal getAlbum sync leaves behind: legacy performer credit in the
    // hot columns, the real album-artist only in the raw payload.
    seed_album_row(
        &store,
        "s1",
        "comp1",
        "Comp One",
        "Perf One",
        "p1",
        r#"{"artistId":"p1","albumArtist":"Various Artists","albumArtistId":"va"}"#,
    );

    let comp = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "comp1".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(
        comp.album.artist_id.as_deref(),
        Some("va"),
        "the album row's legacy performer id must not overwrite the album-artist"
    );
    assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
}

#[test]
fn album_detail_overlay_unlinks_va_when_the_row_has_no_album_artist_id() {
    // Overlay path, VA-unlink: a compilation with no `albumArtistId` anywhere —
    // not on the tracks, not on the standalone album row — whose row credits
    // "Various Artists" (name) but holds a legacy performer id. The id must
    // resolve to None; pointing the link at the legacy performer under a VA
    // credit is the bug being fixed.
    let store = LibraryStore::open_in_memory();
    let mut c1 = va_comp_track("c1", "Song A", "Perf One", "p1", "Comp One", "comp1", "va");
    c1.raw_json = String::new();
    let mut c2 = va_comp_track("c2", "Song B", "Perf Two", "p2", "Comp One", "comp1", "va");
    c2.raw_json = String::new();
    seed_and_rebuild(&store, &[c1, c2]);
    seed_album_row(
        &store,
        "s1",
        "comp1",
        "Comp One",
        "Various Artists",
        "p1",
        r#"{"artistId":"p1"}"#,
    );

    let comp = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "comp1".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        comp.album.artist_id, None,
        "a VA credit with no album-artist id must stay unlinked, not open a guest"
    );
}

#[test]
fn album_detail_overlay_unlinks_va_sourced_only_from_the_album_row() {
    // The VA identity lives *only* on the standalone album row (raw `albumArtist`
    // = "Various Artists", no `albumArtistId`); the tracks carry no album-artist
    // label and their own performer id. The candidate is then a performer, so its
    // id must NOT survive under the album row's VA header — the final id must be
    // re-decided against the resolved name and stay unlinked.
    let store = LibraryStore::open_in_memory();
    let mut t1 = track(
        "s1",
        "t1",
        "Song A",
        Some("Perf One"),
        "Comp",
        "comp1",
        Some("p1"),
        200,
        "lib-a",
        Some(2000),
        None,
        None,
    );
    t1.album_artist = None;
    let mut t2 = track(
        "s1",
        "t2",
        "Song B",
        Some("Perf Two"),
        "Comp",
        "comp1",
        Some("p2"),
        200,
        "lib-a",
        Some(2000),
        None,
        None,
    );
    t2.album_artist = None;
    seed_and_rebuild(&store, &[t1, t2]);
    seed_album_row(
        &store,
        "s1",
        "comp1",
        "Comp",
        "Perf One",
        "p1",
        r#"{"albumArtist":"Various Artists","artistId":"p1"}"#,
    );

    let comp = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "comp1".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(comp.album.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        comp.album.artist_id, None,
        "a track performer id must not survive under an album-row VA header"
    );
}

#[test]
fn album_detail_overlay_keeps_clean_album_artist_over_feat_tracks() {
    // Overlay path, feat regression guard: the standalone album row holds a clean
    // album-artist name and id, while the tracks carry a "feat." credit. The
    // overlay must keep the clean row name — an earlier precedence let the
    // track-derived candidate win and resurfaced the feat-polluted header.
    let store = LibraryStore::open_in_memory();
    let mut t1 = track(
        "s1",
        "t1",
        "Song A",
        Some("Metallica feat. Guest"),
        "Album",
        "alb1",
        Some("m-id"),
        200,
        "lib-a",
        Some(2000),
        None,
        None,
    );
    t1.album_artist = None;
    let mut t2 = track(
        "s1",
        "t2",
        "Song B",
        Some("Metallica"),
        "Album",
        "alb1",
        Some("m-id"),
        200,
        "lib-a",
        Some(2000),
        None,
        None,
    );
    t2.album_artist = None;
    seed_and_rebuild(&store, &[t1, t2]);
    seed_album_row(&store, "s1", "alb1", "Album", "Metallica", "m-id", "{}");

    let detail = album_detail(
        &store,
        &LibraryScopeAlbumDetailRequest {
            scopes: vec![scope_pair("s1", "lib-a")],
            album_id: "alb1".into(),
            server_id: "s1".into(),
        },
    )
    .unwrap();
    assert_eq!(
        detail.album.artist.as_deref(),
        Some("Metallica"),
        "the clean album-artist column must not be demoted below a feat. track credit"
    );
    assert_eq!(detail.album.artist_id.as_deref(), Some("m-id"));
}

/// Seeds one compilation on two servers with *different* server-local VA ids and
/// forces them into one cluster, so the dedup has to choose an owner.
fn seed_cross_server_compilation(store: &LibraryStore) {
    let mut s1 = va_comp_track(
        "c1",
        "Song A",
        "Perf One",
        "p1",
        "Shared Comp",
        "comp-a",
        "va-a",
    );
    s1.library_id = Some("lib-a".into());
    let mut s2 = va_comp_track(
        "c2",
        "Song B",
        "Perf Two",
        "p2",
        "Shared Comp",
        "comp-b",
        "va-z",
    );
    s2.server_id = "s2".into();
    s2.library_id = Some("lib-b".into());
    seed_and_rebuild(store, &[s1, s2]);
    store
        .with_conn_mut("test.force_shared_album_key", |conn| {
            conn.execute(
                "UPDATE cluster.track_cluster_key SET album_key = 'shared-comp' \
                     WHERE track_id IN ('c1', 'c2')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn album_grid_links_the_winning_server_own_va_id_across_servers() {
    // Artist ids are server-local while `album_dedup` merges the same compilation
    // across servers. Recovering the id from the merged group can hand the
    // priority winner (`s1`) the *other* server's lexically larger id (`va-z`),
    // producing a `(server_id, artist_id)` pair no server can resolve.
    let store = LibraryStore::open_in_memory();
    seed_cross_server_compilation(&store);

    let albums = list_albums(
        &store,
        &LibraryScopeListRequest {
            scopes: vec![scope_pair("s1", "lib-a"), scope_pair("s2", "lib-b")],
            sort: None,
            limit: Some(50),
            offset: Some(0),
        },
    )
    .unwrap();
    let comp = albums
        .iter()
        .find(|a| a.name == "Shared Comp")
        .expect("comp missing");
    assert_eq!(
        comp.server_id, "s1",
        "the first scope owns the representative"
    );
    assert_eq!(comp.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        comp.artist_id.as_deref(),
        Some("va-a"),
        "the link must be the winning server's own VA id, not the other server's"
    );
}

#[test]
fn artist_detail_va_union_recovers_the_id_from_a_sibling_of_both_arms() {
    // Under `va_mode` a VA-labelled track tagged with the VA id itself qualifies for
    // both the keyed arm and the label arm. Recovery computed per compound-select
    // arm cannot see across them, so a duplicate carrying no `albumArtistId` can win
    // the representative tie and leave the card unlinked.
    let store = LibraryStore::open_in_memory();
    // Lowest track id wins the representative tie: a guest performer's row, carrying
    // no `albumArtistId`. Reached through the label arm only.
    let mut representative = va_comp_track("a1", "Song A", "Perf One", "p1", "Comp", "comp1", "va");
    representative.raw_json = "{}".into();
    // Present in *both* arms (tagged with the VA artist id and VA-labelled) and the
    // only row that supplies the album-artist id.
    let mut both_arms = track(
        "s1",
        "b1",
        "Song B",
        Some("Various Artists"),
        "Comp",
        "comp1",
        Some("va"),
        200,
        "lib-a",
        Some(2020),
        None,
        None,
    );
    both_arms.album_artist = Some("Various Artists".into());
    both_arms.raw_json = r#"{"albumArtistId":"va"}"#.into();
    seed_and_rebuild(&store, &[representative, both_arms]);

    let detail = artist_detail(
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
    let comp = detail
        .albums
        .iter()
        .find(|a| a.id == "comp1")
        .expect("comp missing");
    assert_eq!(
        comp.artist_id.as_deref(),
        Some("va"),
        "the id must survive the union, whichever duplicate wins the tie"
    );
}

use super::support::{clause, req, scope_pair, scoped_track, seed_and_rebuild};
use crate::advanced_search::run_advanced_search;
use crate::filter::{EntityKind, FilterOp};
use crate::repos::TrackRepository;
use crate::store::LibraryStore;
use serde_json::json;

#[test]
fn multi_scope_track_browse_without_cluster_keys_returns_scoped_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut t1 = scoped_track(
        "s1", "t-a", "Song A", "Artist", "Alb", "alb-a", "lib-a", None, None, None,
    );
    t1.title = "Song A".into();
    let mut t2 = scoped_track(
        "s1", "t-b", "Song B", "Artist", "Alb2", "alb-b", "lib-b", None, None, None,
    );
    t2.title = "Song B".into();
    TrackRepository::new(&store)
        .upsert_batch(&[t1, t2])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 2);
}

#[test]
fn multi_scope_album_browse_without_cluster_keys_returns_scoped_albums() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            scoped_track(
                "s1", "t-a", "Song", "Artist", "Album A", "alb-a", "lib-a", None, None, None,
            ),
            scoped_track(
                "s1", "t-b", "Song", "Artist", "Album B", "alb-b", "lib-b", None, None, None,
            ),
        ])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 2);
}

#[test]
fn multi_scope_genre_filter_dedupes_albums() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            scoped_track(
                "s1",
                "t-a",
                "Song",
                "Artist",
                "Album",
                "alb-a",
                "lib-a",
                Some("Rock"),
                Some(2001),
                None,
            ),
            scoped_track(
                "s1",
                "t-b",
                "Song",
                "Artist",
                "Album",
                "alb-b",
                "lib-b",
                Some("Rock"),
                Some(1999),
                None,
            ),
        ],
    );
    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.filters = vec![clause("genre", FilterOp::Eq, Some(json!("Rock")), None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "alb-a");
}

#[test]
fn multi_scope_year_between_dedupes_albums() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            scoped_track(
                "s1",
                "t-a",
                "Song",
                "Artist",
                "Album",
                "alb-a",
                "lib-a",
                None,
                Some(2022),
                None,
            ),
            scoped_track(
                "s1",
                "t-b",
                "Song",
                "Artist",
                "Album",
                "alb-b",
                "lib-b",
                None,
                Some(1990),
                None,
            ),
        ],
    );
    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.filters = vec![clause(
        "year",
        FilterOp::Between,
        Some(json!(2020)),
        Some(json!(2024)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].year, Some(2022));
}

#[test]
fn multi_scope_text_fts_preserves_same_server_track_occurrences() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            scoped_track(
                "s1", "t-a", "Aurora", "Anna", "Skylines", "alb-a", "lib-a", None, None, None,
            ),
            scoped_track(
                "s1", "t-b", "Aurora", "Anna", "Skylines", "alb-b", "lib-b", None, None, None,
            ),
        ],
    );
    let mut r = req("s1", &[EntityKind::Track]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.query = Some("aurora".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 2);
    assert_eq!(resp.tracks[0].id, "t-a");
    assert_eq!(resp.tracks[1].id, "t-b");
}

#[test]
fn multi_scope_starred_only_dedupes_albums() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            scoped_track(
                "s1",
                "t-a",
                "Song",
                "Artist",
                "Album",
                "alb-a",
                "lib-a",
                None,
                None,
                Some(1),
            ),
            scoped_track(
                "s1", "t-b", "Song", "Artist", "Album", "alb-b", "lib-b", None, None, None,
            ),
        ],
    );
    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.starred_only = Some(true);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "alb-a");
}

#[test]
fn multi_scope_totals_count_distinct_merged_groups() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            scoped_track(
                "s1", "t-a1", "One", "Artist", "Album", "alb-a", "lib-a", None, None, None,
            ),
            scoped_track(
                "s1", "t-b1", "Two", "Artist", "Album", "alb-b", "lib-b", None, None, None,
            ),
            scoped_track(
                "s1", "t-a2", "Three", "Other", "Solo", "alb-solo", "lib-a", None, None, None,
            ),
        ],
    );
    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 2);
    assert_eq!(resp.totals.albums, 2);
}

#[test]
fn single_pair_library_scopes_matches_legacy_library_scope() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            scoped_track(
                "s1", "t1", "Only", "A", "Solo", "alb-solo", "lib-a", None, None, None,
            ),
            scoped_track(
                "s1",
                "t2",
                "Other",
                "B",
                "Other",
                "alb-other",
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    let mut legacy = req("s1", &[EntityKind::Album]);
    legacy.library_scope = Some("lib-a".into());
    let legacy_resp = run_advanced_search(&store, &legacy).unwrap();

    let mut scoped = req("s1", &[EntityKind::Album]);
    scoped.library_scopes = Some(vec![scope_pair("s1", "lib-a")]);
    let scoped_resp = run_advanced_search(&store, &scoped).unwrap();

    assert_eq!(legacy_resp.albums, scoped_resp.albums);
    assert_eq!(legacy_resp.totals, scoped_resp.totals);
}

use super::support::{req, scope_pair, scoped_track, track};
use crate::advanced_search::run_advanced_search;
use crate::advanced_search::sql::{is_fast_random_track_sample, random_rowid_pivot};
use crate::dto::{LibraryScopePair, LibrarySortClause, SortDir};
use crate::filter::EntityKind;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

#[test]
fn unfiltered_random_track_request_uses_bounded_sample_path() {
    let store = LibraryStore::open_in_memory();
    let tracks = (0..12)
        .map(|index| {
            track(
                "s1",
                &format!("t-{index:02}"),
                &format!("Song {index}"),
                "Artist",
                "Album",
            )
        })
        .collect::<Vec<_>>();
    TrackRepository::new(&store).upsert_batch(&tracks).unwrap();

    let mut r = req("s1", &[EntityKind::Track]);
    r.sort = vec![LibrarySortClause {
        field: "random".into(),
        dir: SortDir::Asc,
    }];
    r.limit = 4;
    r.skip_totals = true;
    r.library_scopes = Some(vec![LibraryScopePair {
        server_id: "s1".into(),
        library_id: None,
    }]);

    assert!(is_fast_random_track_sample(&r, None, &[], 0));
    let response = run_advanced_search(&store, &r).unwrap();
    assert_eq!(response.tracks.len(), 4);
    assert_eq!(response.totals.tracks, 0);

    r.offset = 1;
    assert!(!is_fast_random_track_sample(&r, None, &[], 1));
}

#[test]
fn random_rowid_pivot_stays_inside_bounds() {
    assert_eq!(random_rowid_pivot(7, 7), 7);
    assert!((10..=25).contains(&random_rowid_pivot(10, 25)));
}

#[test]
fn scoped_random_track_request_uses_bounded_sample_path() {
    let store = LibraryStore::open_in_memory();
    let tracks = (0..12)
        .map(|index| {
            scoped_track(
                "s1",
                &format!("t-{index:02}"),
                &format!("Song {index}"),
                "Artist",
                "Album",
                "album",
                if index % 2 == 0 { "lib-a" } else { "lib-b" },
                None,
                None,
                None,
            )
        })
        .collect::<Vec<_>>();
    TrackRepository::new(&store).upsert_batch(&tracks).unwrap();

    let mut r = req("s1", &[EntityKind::Track]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib-a"), scope_pair("s1", "lib-b")]);
    r.sort = vec![LibrarySortClause {
        field: "random".into(),
        dir: SortDir::Asc,
    }];
    r.limit = 4;
    r.skip_totals = true;

    let response = run_advanced_search(&store, &r).unwrap();
    assert_eq!(response.tracks.len(), 4);
    assert_eq!(response.totals.tracks, 0);
}

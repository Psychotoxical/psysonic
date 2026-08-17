use super::support::{req, scope_pair, scoped_track, track};
use crate::advanced_search::{
    album_order_from_track_groups, deduped_album_order_sql, grouped_album_order_sql,
    run_advanced_search,
};
use crate::dto::{LibrarySortClause, SortDir};
use crate::filter::EntityKind;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

/// #1217: the album browse sorted by `MAX(t.artist)` — the raw *track* artist —
/// while the row displays the *album* artist. On an album with featured guests
/// the two differ ("Alpha feat. Zulu" vs "Alpha"), so the album sorted under a
/// name nobody could see and fell out of its artist's year run, landing after a
/// completely different artist.
#[test]
fn album_artist_year_sort_keeps_featured_guest_albums_with_their_artist() {
    let store = LibraryStore::open_in_memory();

    // Same album artist "Alpha" throughout; only the middle album carries a
    // featured-guest track credit.
    let mut solo_early = track("s1", "t1", "One", "Alpha", "Early");
    solo_early.year = Some(2000);

    let mut feat = track("s1", "t2", "Two", "Alpha feat. Zulu", "Featured");
    feat.album_artist = Some("Alpha".into());
    feat.year = Some(2001);

    let mut solo_late = track("s1", "t3", "Three", "Alpha", "Late");
    solo_late.year = Some(2002);

    // A second artist that sorts between "Alpha" and "Alpha feat. Zulu".
    let mut other = track("s1", "t4", "Four", "Alpha Beta", "Other");
    other.year = Some(1999);

    TrackRepository::new(&store)
        .upsert_batch(&[solo_early, feat, solo_late, other])
        .unwrap();

    let mut r = req("s1", &[EntityKind::Album]);
    r.sort = vec![
        LibrarySortClause {
            field: "artist".into(),
            dir: SortDir::Asc,
        },
        LibrarySortClause {
            field: "year".into(),
            dir: SortDir::Asc,
        },
    ];
    let resp = run_advanced_search(&store, &r).unwrap();
    let names: Vec<&str> = resp.albums.iter().map(|a| a.name.as_str()).collect();

    // Alpha's three albums stay together in year order; the other artist follows.
    // Before the fix the featured album sorted last, behind "Alpha Beta".
    assert_eq!(names, vec!["Early", "Featured", "Late", "Other"]);
}

#[test]
fn album_sorts_order_by_the_displayed_artist_in_both_query_shapes() {
    let sort = vec![LibrarySortClause {
        field: "artist".into(),
        dir: SortDir::Asc,
    }];

    let grouped = album_order_from_track_groups(&sort).unwrap();
    assert!(
        grouped.contains("MAX(t.album_artist)"),
        "grouped: {grouped}"
    );

    let deduped = deduped_album_order_sql(&sort);
    assert!(deduped.contains("album_artist"), "deduped: {deduped}");
    // The dedup shape has no aggregates to reference.
    assert!(!deduped.contains("MAX("), "deduped: {deduped}");
}

/// The `GROUP BY t.album_id` shapes must never receive a sort key that leaves a
/// bare column behind.
///
/// SQLite substitutes a result alias into ORDER BY **only when the whole term is
/// a plain identifier** — `ORDER BY artist COLLATE NOCASE` does bind to
/// `MAX(t.artist) AS artist`, but the same name *inside* our display-artist
/// `CASE` resolves against `track` instead, and a bare column in a grouped query
/// is read from an arbitrary row of the group. Aliasing the select list (the
/// first attempt at this) therefore does not fix the `CASE` form: the album's
/// sort key silently depends on which row SQLite happens to pick.
///
/// This is the deterministic guard. The behavioural tests below can pass by luck
/// when that arbitrary row happens to be a favourable one; this one cannot.
#[test]
fn grouped_album_order_key_carries_the_aggregates_and_leaves_no_bare_column() {
    let sort = vec![LibrarySortClause {
        field: "artist".into(),
        dir: SortDir::Asc,
    }];
    let grouped = grouped_album_order_sql(&sort);

    assert!(
        grouped.contains("MAX(t.album_artist)"),
        "grouped: {grouped}"
    );
    assert!(grouped.contains("MAX(t.artist)"), "grouped: {grouped}");
    // The deduped form's bare names — the exact thing that must not reach a
    // grouped query.
    assert!(
        !grouped.contains("coalesce(album_artist"),
        "bare column left in a grouped sort key: {grouped}",
    );
    assert!(
        !grouped.contains("coalesce(artist"),
        "bare column left in a grouped sort key: {grouped}",
    );
}

/// Same defect, other query path: with a library scope selected, the browse
/// runs through `scope_merge`, whose `GROUP BY` shapes now get the grouped sort
/// key (aggregates inside the CASE) while only the dedup subquery, which really
/// does project plain columns, gets the deduped one.
#[test]
fn scoped_album_artist_year_sort_also_keeps_featured_guest_albums_in_place() {
    let store = LibraryStore::open_in_memory();

    let mut solo_early = scoped_track(
        "s1",
        "t1",
        "One",
        "Alpha",
        "Early",
        "al_early",
        "lib1",
        None,
        Some(2000),
        None,
    );
    solo_early.album_artist = Some("Alpha".into());

    let mut feat = scoped_track(
        "s1",
        "t2",
        "Two",
        "Alpha feat. Zulu",
        "Featured",
        "al_feat",
        "lib1",
        None,
        Some(2001),
        None,
    );
    feat.album_artist = Some("Alpha".into());

    let mut solo_late = scoped_track(
        "s1",
        "t3",
        "Three",
        "Alpha",
        "Late",
        "al_late",
        "lib1",
        None,
        Some(2002),
        None,
    );
    solo_late.album_artist = Some("Alpha".into());

    let mut other = scoped_track(
        "s1",
        "t4",
        "Four",
        "Alpha Beta",
        "Other",
        "al_other",
        "lib1",
        None,
        Some(1999),
        None,
    );
    other.album_artist = Some("Alpha Beta".into());

    TrackRepository::new(&store)
        .upsert_batch(&[solo_early, feat, solo_late, other])
        .unwrap();

    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib1")]);
    r.sort = vec![
        LibrarySortClause {
            field: "artist".into(),
            dir: SortDir::Asc,
        },
        LibrarySortClause {
            field: "year".into(),
            dir: SortDir::Asc,
        },
    ];
    let resp = run_advanced_search(&store, &r).unwrap();
    let names: Vec<&str> = resp.albums.iter().map(|a| a.name.as_str()).collect();

    assert_eq!(names, vec!["Early", "Featured", "Late", "Other"]);
}

/// The featured album carries **two** tracks and `album_artist` on only one
/// of them — the shape the single-track tests above cannot reach.
///
/// With one row per group, a bare `artist` / `album_artist` in the ORDER BY
/// is indistinguishable from the `MAX()` aggregate, so an ORDER BY that
/// resolves those names to table columns still sorts correctly by accident.
/// Two rows split them: `MAX(t.album_artist)` is "Alpha" (the display
/// artist), while the group also holds a row whose `album_artist` is NULL
/// and whose `artist` is the feat credit. An ORDER BY reading the bare
/// column can pick that row and sort the album under "Alpha feat. Zulu",
/// tearing it out of Alpha's year run — #1217 all over again, on the
/// scoped path.
#[test]
fn scoped_album_artist_year_sort_handles_sparse_album_artist_within_an_album() {
    let store = LibraryStore::open_in_memory();

    let mut solo_early = scoped_track(
        "s1",
        "t1",
        "One",
        "Alpha",
        "Early",
        "al_early",
        "lib1",
        None,
        Some(2000),
        None,
    );
    solo_early.album_artist = Some("Alpha".into());

    // Same album, two tracks: the album-artist row first, the feat row second
    // (and without an album_artist at all).
    let mut feat_titled = scoped_track(
        "s1",
        "t2a",
        "Two",
        "Alpha",
        "Featured",
        "al_feat",
        "lib1",
        None,
        Some(2001),
        None,
    );
    feat_titled.album_artist = Some("Alpha".into());

    let mut feat_guest = scoped_track(
        "s1",
        "t2b",
        "Three",
        "Alpha feat. Zulu",
        "Featured",
        "al_feat",
        "lib1",
        None,
        Some(2001),
        None,
    );
    feat_guest.album_artist = None;

    let mut solo_late = scoped_track(
        "s1",
        "t3",
        "Four",
        "Alpha",
        "Late",
        "al_late",
        "lib1",
        None,
        Some(2002),
        None,
    );
    solo_late.album_artist = Some("Alpha".into());

    let mut other = scoped_track(
        "s1",
        "t4",
        "Five",
        "Alpha Beta",
        "Other",
        "al_other",
        "lib1",
        None,
        Some(1999),
        None,
    );
    other.album_artist = Some("Alpha Beta".into());

    TrackRepository::new(&store)
        .upsert_batch(&[solo_early, feat_titled, feat_guest, solo_late, other])
        .unwrap();

    let mut r = req("s1", &[EntityKind::Album]);
    r.library_scopes = Some(vec![scope_pair("s1", "lib1")]);
    r.sort = vec![
        LibrarySortClause {
            field: "artist".into(),
            dir: SortDir::Asc,
        },
        LibrarySortClause {
            field: "year".into(),
            dir: SortDir::Asc,
        },
    ];
    let resp = run_advanced_search(&store, &r).unwrap();
    let names: Vec<&str> = resp.albums.iter().map(|a| a.name.as_str()).collect();

    // "Featured" displays as Alpha, so it belongs inside Alpha's year run —
    // not after "Other" under the feat credit.
    assert_eq!(names, vec!["Early", "Featured", "Late", "Other"]);
}

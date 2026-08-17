use super::support::{clause, insert_album, req, track};
use crate::advanced_search::run_advanced_search;
use crate::filter::{EntityKind, FilterOp};
use crate::repos::{TrackRepository, TrackRow};
use crate::store::LibraryStore;
use serde_json::json;

#[test]
fn genre_filter_is_case_insensitive() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.genre = Some("Ambient".into());
    let mut b = track("s1", "t2", "B", "X", "Alb");
    b.genre = Some("Techno".into());
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause("genre", FilterOp::Eq, Some(json!("ambient")), None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
    assert!(resp.applied_filters.contains(&"genre".to_string()));
}

#[test]
fn grouped_album_totals_count_distinct_albums_not_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut rows: Vec<TrackRow> = Vec::new();
    for i in 0..6 {
        let mut t = track("s1", &format!("t{i}"), &format!("Song {i}"), "X", "Alb One");
        t.genre = Some("Rock".into());
        rows.push(t);
    }
    for i in 6..10 {
        let mut t = track("s1", &format!("t{i}"), &format!("Song {i}"), "Y", "Alb Two");
        t.genre = Some("Rock".into());
        rows.push(t);
    }
    TrackRepository::new(&store).upsert_batch(&rows).unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("genre", FilterOp::Eq, Some(json!("rock")), None)];
    r.limit = 1;
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1, "page is capped by limit");
    assert_eq!(
        resp.totals.albums, 2,
        "total must be distinct album groups, not matching track rows"
    );
    assert_eq!(resp.totals.tracks, 0);
}

#[test]
fn year_between_is_inclusive() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.year = Some(2000);
    let mut b = track("s1", "t2", "B", "X", "Alb");
    b.year = Some(2010);
    let mut c = track("s1", "t3", "C", "X", "Alb");
    c.year = Some(2011);
    TrackRepository::new(&store)
        .upsert_batch(&[a, b, c])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause(
        "year",
        FilterOp::Between,
        Some(json!(2000)),
        Some(json!(2010)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["t1", "t2"]);
}

#[test]
fn year_only_branch_runs_without_fts() {
    // Genre/year-only (no query) must not require an FTS join (§5.13.7).
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.year = Some(1999);
    TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause("year", FilterOp::Gte, Some(json!(1999)), None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert!(!resp.applied_filters.contains(&"text".to_string()));
}

#[test]
fn starred_only_filters_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.starred_at = Some(123);
    let b = track("s1", "t2", "B", "X", "Alb");
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.starred_only = Some(true);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn normal_album_browse_uses_track_catalog_when_album_table_is_sparse() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al_stub", "Starred Stub", None, None);
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE album SET starred_at = 100 WHERE server_id = 's1' AND id = 'al_stub'",
                [],
            )
        })
        .unwrap();
    let mut a = track("s1", "t1", "A", "X", "Album A");
    a.album_id = Some("al_a".into());
    let mut b = track("s1", "t2", "B", "Y", "Album B");
    b.album_id = Some("al_b".into());
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let r = req("s1", &[EntityKind::Album]);
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.albums.iter().map(|a| a.id.as_str()).collect();
    assert!(ids.contains(&"al_a"));
    assert!(ids.contains(&"al_b"));
    assert!(!ids.contains(&"al_stub"));
}

#[test]
fn starred_only_album_entity_uses_album_star_not_track_star() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al_star", "Starred Album", None, None);
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE album SET starred_at = 100 WHERE server_id = 's1' AND id = 'al_star'",
                [],
            )
        })
        .unwrap();
    let mut track_star = track("s1", "t1", "T", "X", "TrackStar Alb");
    track_star.album_id = Some("al_track_only".into());
    track_star.starred_at = Some(200);
    TrackRepository::new(&store)
        .upsert_batch(&[track_star])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.starred_only = Some(true);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_star");
}

// #1252: an album-table row synced without a cover id must surface its first
// track cover in the browse DTO so random/browse tiles resolve the same art
// the detail page does. `starred_only` forces the album-table path here.
#[test]
fn album_table_cover_falls_back_to_track_cover() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al_nocover", "No Cover", None, None);
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE album SET starred_at = 100 WHERE server_id = 's1' AND id = 'al_nocover'",
                [],
            )
        })
        .unwrap();
    let mut t = track("s1", "t1", "Song", "Artist", "No Cover");
    t.album_id = Some("al_nocover".into());
    t.cover_art_id = Some("mf-track-cover".into());
    TrackRepository::new(&store).upsert_batch(&[t]).unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.starred_only = Some(true);
    let resp = run_advanced_search(&store, &r).unwrap();
    let al = resp
        .albums
        .iter()
        .find(|a| a.id == "al_nocover")
        .expect("album-table row present");
    assert_eq!(al.cover_art_id.as_deref(), Some("mf-track-cover"));
}

#[test]
fn starred_only_with_lossless_uses_album_star_not_track_star() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al_star", "Starred Lossless", None, None);
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE album SET starred_at = 100 WHERE server_id = 's1' AND id = 'al_star'",
                [],
            )
        })
        .unwrap();
    let mut track_star = track("s1", "t1", "T", "X", "TrackStar Alb");
    track_star.album_id = Some("al_track_only".into());
    track_star.starred_at = Some(200);
    track_star.suffix = Some("flac".into());
    TrackRepository::new(&store)
        .upsert_batch(&[track_star])
        .unwrap();
    let mut flac_star = track("s1", "t2", "T2", "X", "Starred Lossless");
    flac_star.album_id = Some("al_star".into());
    flac_star.suffix = Some("flac".into());
    TrackRepository::new(&store)
        .upsert_batch(&[flac_star])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.starred_only = Some(true);
    r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_star");
}

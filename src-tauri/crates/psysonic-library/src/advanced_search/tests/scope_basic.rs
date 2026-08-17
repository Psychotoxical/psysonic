use super::support::{insert_album, insert_artist, req, track};
use crate::advanced_search::run_advanced_search;
use crate::advanced_search::sql::{scoped_fts_pick_join_sql, scoped_fts_rowid_subquery_sql};
use crate::dto::{LibrarySortClause, SortDir};
use crate::filter::EntityKind;
use crate::repos::{TrackRepository, TrackRow};
use crate::store::LibraryStore;

#[test]
fn library_scope_narrows_artist_table_browse() {
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "a1", "Alpha");
    insert_artist(&store, "s1", "a2", "Beta");
    let mut in_scope = track("s1", "t1", "Song", "Alpha", "Alb");
    in_scope.artist_id = Some("a1".into());
    in_scope.library_id = Some("lib1".into());
    let mut out_scope = track("s1", "t2", "Song", "Beta", "Alb");
    out_scope.artist_id = Some("a2".into());
    out_scope.library_id = Some("lib2".into());
    TrackRepository::new(&store)
        .upsert_batch(&[in_scope, out_scope])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scope = Some("lib1".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "a1");
}

#[test]
fn library_scope_artist_browse_uses_sargable_library_id_column() {
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "a1", "Alpha");
    let mut t = track("s1", "t1", "Song", "Alpha", "Alb");
    t.artist_id = Some("a1".into());
    t.library_id = Some("3".into());
    TrackRepository::new(&store).upsert_batch(&[t]).unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.library_scope = Some("3".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "a1");
}

#[test]
fn library_scope_narrows_track_results() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.library_id = Some("lib1".into());
    let mut b = track("s1", "t2", "B", "X", "Alb");
    b.library_id = Some("lib2".into());
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.library_scope = Some("lib1".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn library_scope_track_browse_uses_sargable_library_id_column() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.library_id = Some("3".into());
    TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.library_scope = Some("3".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn library_scope_narrows_fts_track_search() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "Aurora", "X", "Alb");
    a.library_id = Some("lib1".into());
    let mut b = track("s1", "t2", "Aurora", "X", "Alb");
    b.library_id = Some("lib2".into());
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.query = Some("aurora".into());
    r.library_scope = Some("lib1".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(
        resp.tracks.len(),
        1,
        "FTS search must honor the library scope"
    );
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn scoped_fts_sql_is_fts_first_exists_and_sargable() {
    let sql = scoped_fts_rowid_subquery_sql(256, Some("lib1"));
    assert!(
        sql.contains("EXISTS (SELECT 1 FROM track"),
        "FTS-first EXISTS: {sql}"
    );
    assert!(
        !sql.contains("JOIN track"),
        "must not JOIN track before bm25: {sql}"
    );
    assert!(
        sql.contains("t_fts.library_id = ?"),
        "sargable scope: {sql}"
    );
    assert!(sql.contains("ORDER BY bm25(track_fts)"));

    let pick = scoped_fts_pick_join_sql(256, Some("lib1"));
    assert!(
        pick.contains("EXISTS (SELECT 1 FROM track"),
        "FTS-first EXISTS: {pick}"
    );
    assert!(
        !pick.contains("JOIN track t_fts"),
        "inner must not JOIN track: {pick}"
    );
    assert!(
        pick.contains("t_fts.library_id = ?"),
        "sargable scope: {pick}"
    );
}

#[test]
fn totals_reflect_full_match_count_not_page_size() {
    let store = LibraryStore::open_in_memory();
    let rows: Vec<TrackRow> = (0..10)
        .map(|i| track("s1", &format!("t{i}"), "Common Title", "X", "Alb"))
        .collect();
    TrackRepository::new(&store).upsert_batch(&rows).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.query = Some("common".into());
    r.limit = 3;
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 3, "page is capped by limit");
    assert_eq!(resp.totals.tracks, 10, "total is the full match count");
}

#[test]
fn offset_pages_through_results() {
    let store = LibraryStore::open_in_memory();
    let rows: Vec<TrackRow> = (0..5)
        .map(|i| track("s1", &format!("t{i}"), &format!("Title {i}"), "X", "Alb"))
        .collect();
    TrackRepository::new(&store).upsert_batch(&rows).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.sort = vec![LibrarySortClause {
        field: "title".into(),
        dir: SortDir::Asc,
    }];
    r.limit = 2;
    r.offset = 2;
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["t2", "t3"]);
    assert_eq!(resp.totals.tracks, 5);
}

#[test]
fn unrequested_entities_are_empty() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
        .unwrap();
    insert_album(&store, "s1", "al1", "Alb", None, None);
    let resp = run_advanced_search(&store, &req("s1", &[EntityKind::Track])).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert!(resp.albums.is_empty());
    assert!(resp.artists.is_empty());
    assert_eq!(resp.totals.albums, 0);
}

#[test]
fn sort_desc_orders_results() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.year = Some(2000);
    let mut b = track("s1", "t2", "B", "X", "Alb");
    b.year = Some(2020);
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.sort = vec![LibrarySortClause {
        field: "year".into(),
        dir: SortDir::Desc,
    }];
    let resp = run_advanced_search(&store, &r).unwrap();
    let ids: Vec<&str> = resp.tracks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["t2", "t1"]);
}

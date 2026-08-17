use super::support::{clause, insert_album_raw, req, track};
use crate::advanced_search::run_advanced_search;
use crate::filter::{EntityKind, FilterOp};
use crate::repos::TrackRepository;
use crate::store::LibraryStore;
use serde_json::json;

#[test]
fn compilation_filter_only_returns_compilation_albums() {
    let store = LibraryStore::open_in_memory();
    insert_album_raw(
        &store,
        "s1",
        "al_comp",
        "Greatest Hits",
        r#"{"compilation":true}"#,
    );
    insert_album_raw(&store, "s1", "al_regular", "Studio", "{}");
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("compilation", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_comp");
}

#[test]
fn compilation_filter_matches_va_album_artist_on_track_groups() {
    let store = LibraryStore::open_in_memory();
    let mut comp = track("s1", "t_comp", "Hit", "Alice", "Comp Album");
    comp.album_id = Some("al_comp".into());
    comp.album_artist = Some("Various Artists".into());
    comp.raw_json = "{}".into();
    let mut reg = track("s1", "t_reg", "Song", "Band", "Studio");
    reg.album_id = Some("al_reg".into());
    reg.raw_json = "{}".into();
    TrackRepository::new(&store)
        .upsert_batch(&[comp, reg])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("compilation", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_comp");
    assert_eq!(resp.albums[0].artist.as_deref(), Some("Various Artists"));
}

#[test]
fn track_grouped_album_browse_prefers_album_artist_over_track_artist() {
    let store = LibraryStore::open_in_memory();
    let mut t1 = track("s1", "t1", "Anthem", "Groove Armada", "Back to Mine");
    t1.album_id = Some("al_mix".into());
    t1.album_artist = Some("Underworld".into());
    let mut t2 = track("s1", "t2", "Zebra", "UNKLE", "Back to Mine");
    t2.album_id = Some("al_mix".into());
    t2.album_artist = Some("Underworld".into());
    TrackRepository::new(&store)
        .upsert_batch(&[t1, t2])
        .unwrap();
    let r = req("s1", &[EntityKind::Album]);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].artist.as_deref(), Some("Underworld"));
}

#[test]
fn compilation_filter_on_track_grouped_album_browse() {
    let store = LibraryStore::open_in_memory();
    let mut comp = track("s1", "t_comp", "Hit", "VA", "Comp Album");
    comp.album_id = Some("al_comp".into());
    comp.raw_json = r#"{"compilation":true}"#.into();
    let mut reg = track("s1", "t_reg", "Song", "Band", "Studio");
    reg.album_id = Some("al_reg".into());
    reg.raw_json = "{}".into();
    TrackRepository::new(&store)
        .upsert_batch(&[comp, reg])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("compilation", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_comp");
    assert!(resp.applied_filters.contains(&"compilation".to_string()));
}

#[test]
fn compilation_eq_false_hides_compilations() {
    let store = LibraryStore::open_in_memory();
    insert_album_raw(
        &store,
        "s1",
        "al_comp",
        "Greatest Hits",
        r#"{"releaseTypes":["Compilation"]}"#,
    );
    insert_album_raw(&store, "s1", "al_regular", "Studio", "{}");
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause(
        "compilation",
        FilterOp::Eq,
        Some(json!(false)),
        None,
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_regular");
}

#[test]
fn planned_but_unbuilt_field_is_an_error() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    // `suffix` is registered (Planned) but has no v1 SQL builder.
    r.filters = vec![clause("suffix", FilterOp::Eq, Some(json!("flac")), None)];
    let err = run_advanced_search(&store, &r).unwrap_err();
    assert!(err.contains("not queryable"), "got: {err}");
}

#[test]
fn undeclared_op_for_known_field_is_an_error() {
    let store = LibraryStore::open_in_memory();
    let mut r = req("s1", &[EntityKind::Track]);
    // `genre` only declares `eq`.
    r.filters = vec![clause("genre", FilterOp::Gte, Some(json!("rock")), None)];
    let err = run_advanced_search(&store, &r).unwrap_err();
    assert!(err.contains("not supported"), "got: {err}");
}

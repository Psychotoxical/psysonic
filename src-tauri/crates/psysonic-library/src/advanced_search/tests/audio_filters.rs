use super::support::{clause, insert_album, insert_artist, req, track};
use crate::advanced_search::run_advanced_search;
use crate::dto::LibrarySortClause;
use crate::filter::{EntityKind, FilterOp};
use crate::repos::TrackRepository;
use crate::store::LibraryStore;
use serde_json::json;

#[test]
fn bpm_filter_matches_hot_column() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.bpm = Some(125);
    let mut b = track("s1", "t2", "B", "X", "Alb");
    b.bpm = Some(90);
    TrackRepository::new(&store).upsert_batch(&[a, b]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause(
        "bpm",
        FilterOp::Between,
        Some(json!(120)),
        Some(json!(130)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn bpm_filter_falls_back_to_track_fact() {
    let store = LibraryStore::open_in_memory();
    // No hot `bpm`; an analysis fact carries it instead.
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "A", "X", "Alb")])
        .unwrap();
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO track_fact \
                 (server_id, track_id, fact_kind, value_int, source_kind, source_id, confidence, fetched_at) \
                 VALUES ('s1', 't1', 'bpm', 128, 'analysis', 'seed', 1.0, 1)",
                [],
            )
        })
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause(
        "bpm",
        FilterOp::Between,
        Some(json!(125)),
        Some(json!(130)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(
        resp.tracks.len(),
        1,
        "bpm should resolve via track_fact fallback"
    );
    assert_eq!(resp.tracks[0].bpm, Some(128));
    assert_eq!(resp.tracks[0].bpm_source.as_deref(), Some("analysis"));
}

#[test]
fn bpm_filter_prefers_analysis_fact_over_hot_tag() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.bpm = Some(90);
    TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO track_fact \
                 (server_id, track_id, fact_kind, value_int, source_kind, source_id, confidence, fetched_at) \
                 VALUES ('s1', 't1', 'bpm', 128, 'analysis', 'oximedia-60s-center', 1.0, 1)",
                [],
            )
        })
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause(
        "bpm",
        FilterOp::Between,
        Some(json!(125)),
        Some(json!(130)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].bpm, Some(128));
    assert_eq!(resp.tracks[0].bpm_source.as_deref(), Some("analysis"));
}

#[test]
fn bpm_source_is_tag_when_only_hot_column_set() {
    let store = LibraryStore::open_in_memory();
    let mut a = track("s1", "t1", "A", "X", "Alb");
    a.bpm = Some(125);
    TrackRepository::new(&store).upsert_batch(&[a]).unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause(
        "bpm",
        FilterOp::Between,
        Some(json!(120)),
        Some(json!(130)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].bpm_source.as_deref(), Some("tag"));
}

fn insert_mood_tag(store: &LibraryStore, server: &str, track: &str, tag: &str) {
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO track_fact \
                 (server_id, track_id, fact_kind, value_text, source_kind, source_id, confidence, fetched_at) \
                 VALUES (?1, ?2, 'mood_tag', ?3, 'analysis', ?4, 1.0, 1)",
                rusqlite::params![server, track, tag, format!("oximedia-60s-center:{tag}")],
            )
        })
        .unwrap();
}

#[test]
fn mood_group_joy_matches_happy_mood_tag() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "A", "X", "Alb"),
            track("s1", "t2", "B", "X", "Alb"),
        ])
        .unwrap();
    insert_mood_tag(&store, "s1", "t1", "happy");
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause("mood_group", FilterOp::Eq, Some(json!("joy")), None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn mood_groups_overlap_work_and_romance_on_calm_peaceful_track() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "Calm", "X", "Alb")])
        .unwrap();
    insert_mood_tag(&store, "s1", "t1", "calm");
    insert_mood_tag(&store, "s1", "t1", "peaceful");
    for group in ["work", "romance"] {
        let mut r = req("s1", &[EntityKind::Track]);
        r.filters = vec![clause("mood_group", FilterOp::Eq, Some(json!(group)), None)];
        let resp = run_advanced_search(&store, &r).unwrap();
        assert_eq!(
            resp.tracks.len(),
            1,
            "group `{group}` should match calm/peaceful"
        );
    }
}

#[test]
fn mood_group_in_joy_matches_happy_tag() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "A", "X", "Alb"),
            track("s1", "t2", "B", "X", "Alb"),
        ])
        .unwrap();
    insert_mood_tag(&store, "s1", "t1", "happy");
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause(
        "mood_group",
        FilterOp::In,
        Some(json!(["joy"])),
        None,
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
}

#[test]
fn mood_tag_eq_calm_matches_calm_fact() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "A", "X", "Alb"),
            track("s1", "t2", "B", "X", "Alb"),
        ])
        .unwrap();
    insert_mood_tag(&store, "s1", "t2", "calm");
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause("mood_tag", FilterOp::Eq, Some(json!("calm")), None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t2");
}

#[test]
fn track_only_filter_is_ignored_for_album_entity_no_error() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al1", "Some Album", Some(2001), None);
    let mut r = req("s1", &[EntityKind::Album]);
    // bpm is track-only; for an album query it must be skipped, not error.
    r.filters = vec![clause(
        "bpm",
        FilterOp::Between,
        Some(json!(120)),
        Some(json!(130)),
    )];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert!(!resp.applied_filters.contains(&"bpm".to_string()));
}

#[test]
fn unknown_field_is_an_error() {
    let store = LibraryStore::open_in_memory();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause("nope", FilterOp::Eq, Some(json!("x")), None)];
    let err = run_advanced_search(&store, &r).unwrap_err();
    assert!(err.contains("unknown filter field"), "got: {err}");
}

#[test]
fn lossless_filter_returns_only_lossless_tracks() {
    let store = LibraryStore::open_in_memory();
    let mut flac = track("s1", "t1", "A", "X", "Alb");
    flac.suffix = Some("flac".into());
    let mut mp3 = track("s1", "t2", "B", "X", "Alb");
    mp3.suffix = Some("mp3".into());
    TrackRepository::new(&store)
        .upsert_batch(&[flac, mp3])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
    assert!(resp.applied_filters.contains(&"lossless".to_string()));
}

#[test]
fn lossless_filter_on_album_entity_requires_lossless_track() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al1", "Lossless Album", None, None);
    insert_album(&store, "s1", "al2", "Lossy Album", None, None);
    let mut flac = track("s1", "t1", "A", "X", "Alb");
    flac.album_id = Some("al1".into());
    flac.suffix = Some("flac".into());
    let mut mp3 = track("s1", "t2", "B", "Y", "Alb2");
    mp3.album_id = Some("al2".into());
    mp3.suffix = Some("mp3".into());
    TrackRepository::new(&store)
        .upsert_batch(&[flac, mp3])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al1");
}

#[test]
fn restrict_album_ids_intersects_with_lossless_filter() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al_fav_lossless", "Fav Lossless", None, None);
    insert_album(&store, "s1", "al_fav_lossy", "Fav Lossy", None, None);
    insert_album(
        &store,
        "s1",
        "al_other_lossless",
        "Other Lossless",
        None,
        None,
    );
    let mut flac_fav = track("s1", "t1", "A", "X", "Alb");
    flac_fav.album_id = Some("al_fav_lossless".into());
    flac_fav.suffix = Some("flac".into());
    let mut mp3_fav = track("s1", "t2", "B", "Y", "Alb2");
    mp3_fav.album_id = Some("al_fav_lossy".into());
    mp3_fav.suffix = Some("mp3".into());
    let mut flac_other = track("s1", "t3", "C", "Z", "Alb3");
    flac_other.album_id = Some("al_other_lossless".into());
    flac_other.suffix = Some("flac".into());
    TrackRepository::new(&store)
        .upsert_batch(&[flac_fav, mp3_fav, flac_other])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
    r.restrict_album_ids = Some(vec!["al_fav_lossless".into(), "al_fav_lossy".into()]);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_fav_lossless");
    assert!(resp.applied_filters.contains(&"albumIds".to_string()));
}

#[test]
fn lossless_and_year_filters_use_track_year_when_album_table_differs() {
    let store = LibraryStore::open_in_memory();
    insert_album(&store, "s1", "al1", "Hi-Res Album", Some(1990), None);
    let mut flac = track("s1", "t1", "Track", "Art", "Alb");
    flac.album_id = Some("al1".into());
    flac.suffix = Some("flac".into());
    flac.year = Some(2022);
    TrackRepository::new(&store).upsert_batch(&[flac]).unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![
        clause(
            "year",
            FilterOp::Between,
            Some(json!(2020)),
            Some(json!(2024)),
        ),
        clause("lossless", FilterOp::IsTrue, None, None),
    ];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al1");
}

#[test]
fn lossless_album_browse_with_name_sort_returns_rows() {
    let store = LibraryStore::open_in_memory();
    let mut flac = track("s1", "t1", "Track", "Art", "Zebra Album");
    flac.suffix = Some("flac".into());
    TrackRepository::new(&store).upsert_batch(&[flac]).unwrap();
    let mut r = req("s1", &[EntityKind::Album]);
    r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
    r.sort = vec![LibrarySortClause {
        field: "name".into(),
        dir: crate::dto::SortDir::Asc,
    }];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
}

#[test]
fn lossless_filter_on_artist_entity_requires_lossless_track() {
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "ar1", "Lossless Artist");
    insert_artist(&store, "s1", "ar2", "Lossy Artist");
    let mut flac = track("s1", "t1", "A", "Lossless Artist", "Alb");
    flac.artist_id = Some("ar1".into());
    flac.suffix = Some("flac".into());
    let mut mp3 = track("s1", "t2", "B", "Lossy Artist", "Alb2");
    mp3.artist_id = Some("ar2".into());
    mp3.suffix = Some("mp3".into());
    TrackRepository::new(&store)
        .upsert_batch(&[flac, mp3])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.filters = vec![clause("lossless", FilterOp::IsTrue, None, None)];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar1");
}

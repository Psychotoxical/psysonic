use super::*;

#[test]
fn insert_rejects_short_sessions() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 200);
    let repo = PlaySessionRepository::new(&store);
    let input = PlaySessionInputDto {
        server_id: "s1".into(),
        track_id: "t1".into(),
        started_at_ms: 1_000,
        listened_sec: 10.0,
        position_max_sec: 50.0,
        end_reason: "ended".into(),
        duration_sec_hint: None,
    };
    assert!(repo.insert(&input).is_err());
}

#[test]
fn insert_fails_when_track_missing() {
    let store = LibraryStore::open_in_memory();
    let repo = PlaySessionRepository::new(&store);
    assert!(repo.insert(&sample_input("s1", "missing")).is_err());
}

#[test]
fn insert_full_vs_partial_completion() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 100);
    let repo = PlaySessionRepository::new(&store);

    repo.insert(&PlaySessionInputDto {
        server_id: "s1".into(),
        track_id: "t1".into(),
        started_at_ms: 1_000,
        listened_sec: 80.0,
        position_max_sec: 75.0,
        end_reason: "ended".into(),
        duration_sec_hint: None,
    })
    .expect("insert full");

    repo.insert(&PlaySessionInputDto {
        server_id: "s1".into(),
        track_id: "t1".into(),
        started_at_ms: 2_000,
        listened_sec: 30.0,
        position_max_sec: 40.0,
        end_reason: "skip".into(),
        duration_sec_hint: None,
    })
    .expect("insert partial");

    let summary = repo.year_summary(1970).expect("summary");
    assert_eq!(summary.track_play_count, 2);
    assert_eq!(summary.session_count, 1);
    assert_eq!(summary.unique_track_count, 1);
    assert_eq!(summary.listening_day_count, 1);
    assert_eq!(summary.full_count, 1);
    assert_eq!(summary.partial_count, 1);
}

#[test]
fn zero_index_duration_uses_hint_and_stays_partial() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 0);
    let repo = PlaySessionRepository::new(&store);
    repo.insert(&PlaySessionInputDto {
        server_id: "s1".into(),
        track_id: "t1".into(),
        started_at_ms: 1_000,
        listened_sec: 45.0,
        position_max_sec: 40.0,
        end_reason: "skip".into(),
        duration_sec_hint: Some(300),
    })
    .expect("insert");

    let detail = repo.day_detail("1970-01-01").expect("detail");
    assert_eq!(detail.tracks[0].completion, "partial");
}

#[test]
fn zero_duration_without_hint_is_partial_not_full() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 0);
    let repo = PlaySessionRepository::new(&store);
    repo.insert(&PlaySessionInputDto {
        server_id: "s1".into(),
        track_id: "t1".into(),
        started_at_ms: 1_000,
        listened_sec: 45.0,
        position_max_sec: 40.0,
        end_reason: "skip".into(),
        duration_sec_hint: None,
    })
    .expect("insert");

    let detail = repo.day_detail("1970-01-01").expect("detail");
    assert_eq!(detail.tracks[0].completion, "partial");
}

#[test]
fn corrupt_short_db_duration_prefers_player_hint() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 1);
    let repo = PlaySessionRepository::new(&store);
    repo.insert(&PlaySessionInputDto {
        server_id: "s1".into(),
        track_id: "t1".into(),
        started_at_ms: 1_000,
        listened_sec: 45.0,
        position_max_sec: 40.0,
        end_reason: "skip".into(),
        duration_sec_hint: Some(300),
    })
    .expect("insert");

    let detail = repo.day_detail("1970-01-01").expect("detail");
    assert_eq!(detail.tracks[0].completion, "partial");
}

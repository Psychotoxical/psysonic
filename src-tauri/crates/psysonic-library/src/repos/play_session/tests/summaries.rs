use super::*;

#[test]
fn listening_sessions_cluster_by_idle_gap() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 200);
    seed_track(&store, "s1", "t2", 200);
    seed_track(&store, "s1", "t3", 200);
    let repo = PlaySessionRepository::new(&store);
    let base = 1_700_000_000_000_i64;
    let insert = |offset_ms: i64, track_id: &str| {
        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: track_id.into(),
            started_at_ms: base + offset_ms,
            listened_sec: 120.0,
            position_max_sec: 100.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        })
        .expect("insert");
    };
    insert(0, "t1");
    insert(5 * 60 * 1000, "t2");
    insert(10 * 60 * 1000, "t3");
    insert(45 * 60 * 1000, "t1");

    let year = repo
        .year_bounds()
        .expect("bounds")
        .max_year
        .expect("year with data");
    let summary = repo.year_summary(year).expect("summary");
    assert_eq!(summary.track_play_count, 4);
    assert_eq!(summary.session_count, 2);
    assert_eq!(summary.unique_track_count, 3);
    assert_eq!(summary.listening_day_count, 1);

    let heat = repo.heatmap(year).expect("heatmap");
    assert_eq!(heat.len(), 1);
    assert_eq!(heat[0].track_play_count, 4);

    let days = repo.recent_days(10).expect("recent");
    assert_eq!(days[0].track_play_count, 4);
    assert_eq!(days[0].session_count, 2);
}

#[test]
fn year_bounds_empty_and_populated() {
    let store = LibraryStore::open_in_memory();
    let repo = PlaySessionRepository::new(&store);
    let empty = repo.year_bounds().expect("empty bounds");
    assert_eq!(empty.min_year, None);
    assert_eq!(empty.max_year, None);

    seed_track(&store, "s1", "t1", 200);
    seed_track(&store, "s1", "t2", 200);
    let insert = |started_at_ms: i64, track_id: &str| {
        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: track_id.into(),
            started_at_ms,
            listened_sec: 20.0,
            position_max_sec: 15.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        })
        .expect("insert");
    };
    insert(1_577_836_800_000, "t1");
    insert(1_609_459_200_000, "t2");

    let bounds = repo.year_bounds().expect("bounds");
    assert_eq!(bounds.min_year, Some(2020));
    assert_eq!(bounds.max_year, Some(2021));
}

#[test]
fn recent_days_newest_first_with_limit() {
    let store = LibraryStore::open_in_memory();
    let repo = PlaySessionRepository::new(&store);
    seed_track(&store, "s1", "t1", 200);
    seed_track(&store, "s1", "t2", 200);
    let insert = |started_at_ms: i64, track_id: &str| {
        repo.insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: track_id.into(),
            started_at_ms,
            listened_sec: 20.0,
            position_max_sec: 15.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        })
        .expect("insert");
    };
    insert(1_577_836_800_000, "t1");
    insert(1_609_459_200_000, "t2");

    let days = repo.recent_days(30).expect("recent");
    assert_eq!(days.len(), 2);
    assert_eq!(days[0].date, "2021-01-01");
    assert_eq!(days[1].date, "2020-01-01");
    assert_eq!(days[0].session_count, 1);
    assert_eq!(days[0].track_play_count, 1);
}

#[test]
fn day_detail_rejects_invalid_date() {
    let store = LibraryStore::open_in_memory();
    let repo = PlaySessionRepository::new(&store);
    assert!(repo.day_detail("2025-13-40").is_err());
    assert!(repo.day_detail("not-a-date").is_err());
}

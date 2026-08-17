use super::*;

#[test]
fn remap_updates_play_session_track_id() {
    let store = LibraryStore::open_in_memory();
    let track_repo = TrackRepository::new(&store);
    track_repo
        .upsert_batch(&[row_with_id_hash(
            "s1",
            "tr_old",
            "deadbeef",
            "/music/a.flac",
        )])
        .expect("seed old");

    let play_repo = PlaySessionRepository::new(&store);
    play_repo
        .insert(&PlaySessionInputDto {
            server_id: "s1".into(),
            track_id: "tr_old".into(),
            started_at_ms: 1_000,
            listened_sec: 30.0,
            position_max_sec: 20.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        })
        .expect("insert play");

    let stats = track_repo
        .upsert_batch_with_remap(
            &[row_with_id_hash(
                "s1",
                "tr_new",
                "deadbeef",
                "/music/a.flac",
            )],
            true,
        )
        .expect("remap");
    assert_eq!(stats.remapped.len(), 1);
    assert_eq!(stats.remapped[0].old_id, "tr_old");
    assert_eq!(stats.remapped[0].new_id, "tr_new");

    let track_id: String = store
        .with_conn("test.read_play_session", |conn| {
            conn.query_row(
                "SELECT track_id FROM play_session WHERE server_id = ?1",
                rusqlite::params!["s1"],
                |row| row.get(0),
            )
        })
        .expect("read play_session");
    assert_eq!(track_id, "tr_new");
}

#[test]
fn purge_deletes_play_session_rows_for_server() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 200);
    seed_track(&store, "s2", "t2", 200);
    let repo = PlaySessionRepository::new(&store);
    repo.insert(&sample_input("s1", "t1")).expect("s1 play");
    repo.insert(&sample_input("s2", "t2")).expect("s2 play");

    purge_play_sessions_for_server(&store, "s1");

    let s1_count: i64 = store
        .with_conn("test.count_s1", |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM play_session WHERE server_id = ?1",
                rusqlite::params!["s1"],
                |row| row.get(0),
            )
        })
        .expect("count s1");
    let s2_count: i64 = store
        .with_conn("test.count_s2", |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM play_session WHERE server_id = ?1",
                rusqlite::params!["s2"],
                |row| row.get(0),
            )
        })
        .expect("count s2");
    assert_eq!(s1_count, 0);
    assert_eq!(s2_count, 1);
}

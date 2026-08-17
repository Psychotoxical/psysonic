use super::*;

#[test]
fn recent_plays_returns_newest_first_and_respects_limit() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 200);
    seed_track(&store, "s1", "t2", 200);
    seed_track(&store, "s2", "t3", 200);
    let repo = PlaySessionRepository::new(&store);
    for (sid, tid, ms) in [
        ("s1", "t1", 1_000_i64),
        ("s1", "t2", 2_000),
        ("s2", "t3", 3_000),
    ] {
        repo.insert(&PlaySessionInputDto {
            server_id: sid.into(),
            track_id: tid.into(),
            started_at_ms: ms,
            listened_sec: 20.0,
            position_max_sec: 15.0,
            end_reason: "ended".into(),
            duration_sec_hint: None,
        })
        .expect("insert");
    }
    let rows = repo.recent_plays(2, None).expect("recent");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].track_id, "t3");
    assert_eq!(rows[1].track_id, "t2");
}

#[test]
fn recent_plays_excludes_deleted_tracks() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 200);
    let repo = PlaySessionRepository::new(&store);
    repo.insert(&sample_input("s1", "t1")).expect("insert");
    store
        .with_conn_mut("test.soft_delete", |conn| {
            conn.execute(
                "UPDATE track SET deleted = 1 WHERE server_id = ?1 AND id = ?2",
                rusqlite::params!["s1", "t1"],
            )?;
            Ok(())
        })
        .expect("soft delete");
    let rows = repo.recent_plays(10, None).expect("recent");
    assert!(rows.is_empty());
}

#[test]
fn recent_plays_includes_album_cover_metadata() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[TrackRow {
            server_id: "s1".into(),
            id: "t1".into(),
            title: "Song".into(),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: None,
            album: "Album Name".into(),
            album_id: Some("al-1".into()),
            album_artist: None,
            duration_sec: 200,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: Some("al-1".into()),
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }])
        .expect("seed track");
    let repo = PlaySessionRepository::new(&store);
    repo.insert(&sample_input("s1", "t1")).expect("insert");
    let rows = repo.recent_plays(1, None).expect("recent");
    assert_eq!(rows[0].album.as_deref(), Some("Album Name"));
    assert_eq!(rows[0].album_id.as_deref(), Some("al-1"));
    assert_eq!(rows[0].cover_art_id.as_deref(), Some("al-1"));
}

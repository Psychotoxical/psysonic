use super::*;
use crate::dto::PlaySessionInputDto;
use crate::repos::{TrackRepository, TrackRow};

fn seed_track(store: &LibraryStore, server_id: &str, track_id: &str, duration_sec: i64) {
    TrackRepository::new(store)
        .upsert_batch(&[TrackRow {
            server_id: server_id.into(),
            id: track_id.into(),
            title: "Test".into(),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: None,
            album: "Album".into(),
            album_id: None,
            album_artist: None,
            duration_sec,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
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
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }])
        .expect("seed track");
}

fn row_with_id_hash(server: &str, id: &str, hash: &str, path: &str) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: "Title".into(),
        title_sort: None,
        artist: None,
        artist_id: None,
        album: "Album".into(),
        album_id: None,
        album_artist: None,
        duration_sec: 200,
        track_number: None,
        disc_number: None,
        year: None,
        genre: None,
        suffix: None,
        bit_rate: None,
        size_bytes: None,
        cover_art_id: None,
        starred_at: None,
        user_rating: None,
        play_count: None,
        played_at: None,
        server_path: if path.is_empty() {
            None
        } else {
            Some(path.into())
        },
        library_id: None,
        isrc: None,
        mbid_recording: None,
        bpm: None,
        replay_gain_track_db: None,
        replay_gain_album_db: None,
        content_hash: if hash.is_empty() {
            None
        } else {
            Some(hash.into())
        },
        server_updated_at: None,
        server_created_at: None,
        deleted: false,
        synced_at: 1,
        raw_json: "{}".into(),
    }
}

fn sample_input(server_id: &str, track_id: &str) -> PlaySessionInputDto {
    PlaySessionInputDto {
        server_id: server_id.into(),
        track_id: track_id.into(),
        started_at_ms: 1_000,
        listened_sec: 20.0,
        position_max_sec: 15.0,
        end_reason: "ended".into(),
        duration_sec_hint: None,
    }
}

fn purge_play_sessions_for_server(store: &LibraryStore, server_id: &str) {
    store
        .with_conn_mut("test.purge_play_session", |conn| {
            conn.execute(
                "DELETE FROM play_session WHERE server_id = ?1",
                rusqlite::params![server_id],
            )?;
            Ok(())
        })
        .expect("purge play_session");
}

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

#[test]
fn remap_updates_play_session_track_id() {
    let store = LibraryStore::open_in_memory();
    let track_repo = TrackRepository::new(&store);
    track_repo
        .upsert_batch(&[row_with_id_hash("s1", "tr_old", "deadbeef", "/music/a.flac")])
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
            &[row_with_id_hash("s1", "tr_new", "deadbeef", "/music/a.flac")],
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

#[test]
fn recent_plays_returns_newest_first_and_respects_limit() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "s1", "t1", 200);
    seed_track(&store, "s1", "t2", 200);
    seed_track(&store, "s2", "t3", 200);
    let repo = PlaySessionRepository::new(&store);
    for (sid, tid, ms) in [("s1", "t1", 1_000_i64), ("s1", "t2", 2_000), ("s2", "t3", 3_000)] {
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

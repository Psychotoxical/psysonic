use std::sync::Arc;

use super::*;
use crate::commands::test_support::{make_row, runtime};
use crate::dto::local_tracks_max_updated_ms;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

// The command functions take `tauri::State` which we can't easily
// construct in unit tests without a Tauri runtime. The tests below
// exercise the underlying logic by calling the equivalent
// `LibraryRuntime` + repo paths directly. Integration coverage with
// a real Tauri app lives outside this crate (PR-5c devtools test).

#[test]
fn get_status_returns_defaults_when_no_row_exists() {
    let store = Arc::new(LibraryStore::open_in_memory());
    let rt = runtime(store);
    // Simulate command body — same logic as `library_get_status`.
    let local_max = local_tracks_max_updated_ms(&rt.store, "s1").unwrap();
    assert!(local_max.is_none());
}

#[test]
fn library_track_dto_from_row_preserves_hot_columns() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[make_row("s1", "tr_1", "al_1", 5)])
        .unwrap();
    let found = TrackRepository::new(&store)
        .find_one("s1", "tr_1")
        .unwrap()
        .unwrap();
    let dto = LibraryTrackDto::from_row(&found);
    assert_eq!(dto.id, "tr_1");
    assert_eq!(dto.album_id.as_deref(), Some("al_1"));
    assert_eq!(dto.track_number, Some(5));
}

#[test]
fn api_song_upsert_stamps_epoch_milliseconds() {
    let store = LibraryStore::open_in_memory();
    let before = super::super::now_unix_ms();
    let inserted = upsert_songs_from_api(
        &store,
        "s1",
        vec![serde_json::json!({
            "id": "tr_1",
            "title": "Track",
            "album": "Album",
            "albumId": "al_1",
            "duration": 120
        })],
    )
    .unwrap();
    let after = super::super::now_unix_ms();

    let synced_at: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT synced_at FROM track WHERE server_id = 's1' AND id = 'tr_1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(inserted, 1);
    assert!(synced_at >= before && synced_at <= after);
    assert!(
        synced_at > 1_000_000_000_000,
        "timestamp must be milliseconds"
    );
}

#[test]
fn find_by_album_orders_by_disc_then_track_then_id() {
    let store = Arc::new(LibraryStore::open_in_memory());
    // A missing disc number is treated as disc 1 (matching the album UI's
    // `discNumber ?? 1`), then track number, then a stable `id` tie-break for
    // duplicate disc/track positions.
    let with_disc = |id: &str, album: &str, disc: Option<i64>, trk: i64| {
        let mut r = make_row("s1", id, album, trk);
        r.disc_number = disc;
        r
    };
    TrackRepository::new(&store)
        .upsert_batch(&[
            with_disc("tr_dup_z", "al_1", Some(2), 2),
            with_disc("tr_a", "al_1", Some(1), 1),
            with_disc("tr_dup_b", "al_1", Some(2), 2),
            with_disc("tr_null", "al_1", None, 3),
            with_disc("tr_d2t1", "al_1", Some(2), 1),
            with_disc("tr_m", "al_1", Some(1), 2),
            make_row("s1", "tr_c", "al_2", 1),
        ])
        .unwrap();
    let album1 = TrackRepository::new(&store)
        .find_by_album("s1", "al_1")
        .unwrap();
    let ids: Vec<&str> = album1.iter().map(|r| r.id.as_str()).collect();
    // disc 1: tr_a (t1), tr_m (t2), tr_null (untagged -> disc 1, t3);
    // disc 2: tr_d2t1 (t1), then the tr_dup_b/tr_dup_z tie (t2) by id.
    assert_eq!(
        ids,
        vec!["tr_a", "tr_m", "tr_null", "tr_d2t1", "tr_dup_b", "tr_dup_z"]
    );
}

#[test]
fn find_batch_preserves_input_order_and_drops_unknowns() {
    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[
            make_row("s1", "tr_1", "al_1", 1),
            make_row("s1", "tr_2", "al_1", 2),
        ])
        .unwrap();
    let pairs = vec![
        ("s1".to_string(), "tr_2".to_string()),
        ("s1".to_string(), "tr_missing".to_string()),
        ("s1".to_string(), "tr_1".to_string()),
    ];
    let rows = TrackRepository::new(&store).find_batch(&pairs).unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, vec!["tr_2", "tr_1"]);
}

#[test]
fn batch_limit_constant_matches_spec_cap() {
    assert_eq!(TRACKS_BATCH_LIMIT, 100);
}

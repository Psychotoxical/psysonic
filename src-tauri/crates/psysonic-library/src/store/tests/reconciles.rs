use rusqlite::params;

use super::super::reconciles::{
    maybe_reconcile_artist_name_fold, maybe_reconcile_artist_name_sort,
    maybe_reconcile_duration_sec_backfill, maybe_reconcile_library_id_backfill,
    maybe_reconcile_orphan_browse_rows, ARTIST_NAME_FOLD_RECONCILE_ID,
    ARTIST_NAME_SORT_RECONCILE_ID, DURATION_SEC_BACKFILL_RECONCILE_ID,
    LIBRARY_ID_BACKFILL_RECONCILE_ID, ORPHAN_BROWSE_RECONCILE_ID,
};
use super::super::LibraryStore;

#[test]
fn migration_022_backfills_unicode_artist_name_fold() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn("test", |conn| {
            conn.execute(
                "INSERT INTO artist (server_id, id, name, name_fold, synced_at) \
                 VALUES ('s1', 'ar-kino', 'КИНО-пробы', NULL, 1)",
                [],
            )?;
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![ARTIST_NAME_FOLD_RECONCILE_ID],
            )?;
            maybe_reconcile_artist_name_fold(conn)
        })
        .unwrap();
    let name_fold: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT name_fold FROM artist WHERE server_id = 's1' AND id = 'ar-kino'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(name_fold, "кино-пробы");
}

#[test]
fn artist_name_sort_reconcile_runs_once_and_sets_name_sort() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_artist", |conn| {
            conn.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                 VALUES ('s1', 'ar1', 'The Beatles', 'the beatles', 1)",
                [],
            )?;
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![ARTIST_NAME_SORT_RECONCILE_ID],
            )?;
            Ok(())
        })
        .expect("seed artist");

    store
        .with_conn("test.reconcile", maybe_reconcile_artist_name_sort)
        .expect("reconcile");

    let name_sort: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT name_sort FROM artist WHERE server_id = 's1' AND id = 'ar1'",
                [],
                |r| r.get(0),
            )
        })
        .expect("read name_sort");
    assert_eq!(name_sort, "beatles");

    let completed_before: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT completed_at FROM library_data_migration WHERE id = ?1",
                params![ARTIST_NAME_SORT_RECONCILE_ID],
                |r| r.get(0),
            )
        })
        .expect("reconcile marker");
    assert!(completed_before > 0);

    store
        .with_conn("test.reconcile_again", maybe_reconcile_artist_name_sort)
        .expect("reconcile again");

    let name_sort_after: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT name_sort FROM artist WHERE server_id = 's1' AND id = 'ar1'",
                [],
                |r| r.get(0),
            )
        })
        .expect("read name_sort again");
    assert_eq!(name_sort_after, "beatles");
}

#[test]
fn library_id_backfill_reconcile_populates_from_raw_json() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_tracks", |conn| {
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                 VALUES ('s1', 't1', 'A', 'Al', 1, 0, 1, '{\"libraryId\":\"lib-a\"}', '')",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                 VALUES ('s1', 't2', 'B', 'Al', 1, 0, 1, '{\"library_id\":\"lib-b\"}', NULL)",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                 VALUES ('s1', 't3', 'C', 'Al', 1, 0, 1, '{\"musicFolderId\":\"lib-c\"}', '')",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                 VALUES ('s1', 't4', 'D', 'Al', 1, 0, 1, '{}', 'already-set')",
                [],
            )?;
            Ok(())
        })
        .expect("seed tracks");

    store
        .with_conn("test.reconcile", maybe_reconcile_library_id_backfill)
        .expect("reconcile");

    let lib_a: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't1'",
                [],
                |r| r.get(0),
            )
        })
        .expect("t1 library_id");
    assert_eq!(lib_a, "lib-a");

    let lib_b: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't2'",
                [],
                |r| r.get(0),
            )
        })
        .expect("t2 library_id");
    assert_eq!(lib_b, "lib-b");

    let lib_c: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't3'",
                [],
                |r| r.get(0),
            )
        })
        .expect("t3 library_id");
    assert_eq!(lib_c, "lib-c");

    let unchanged: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't4'",
                [],
                |r| r.get(0),
            )
        })
        .expect("t4 library_id");
    assert_eq!(unchanged, "already-set");
}

#[test]
fn orphan_browse_reconcile_prunes_ghosts_once() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed", |conn| {
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![ORPHAN_BROWSE_RECONCILE_ID],
            )?;
            // Confirmed-this-pass artist with a live track → keep.
            conn.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                 VALUES ('s1', 'ar_new', 'New', 'new', 100)",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, artist_id, album, album_id, \
                   duration_sec, deleted, synced_at, raw_json) \
                 VALUES ('s1', 'tr_1', 'S', 'ar_new', 'Al', 'al_live', 1, 0, 1, '{}')",
                [],
            )?;
            // Renamed-away ghost: stale synced_at, no live track → prune.
            conn.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                 VALUES ('s1', 'ar_old', 'Old', 'old', 1)",
                [],
            )?;
            Ok(())
        })
        .expect("seed");

    store
        .with_conn("test.reconcile", maybe_reconcile_orphan_browse_rows)
        .expect("reconcile");

    let artists: i64 = store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM artist WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(artists, 1, "ghost artist pruned, live kept");

    // Re-running with the marker set is a no-op even if a new ghost appears.
    store
        .with_conn_mut("test.seed_more_ghosts", |conn| {
            conn.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, synced_at) \
                 VALUES ('s1', 'ar_old2', 'Old2', 'old2', 1)",
                [],
            )
        })
        .unwrap();
    store
        .with_conn("test.reconcile_again", maybe_reconcile_orphan_browse_rows)
        .expect("reconcile again");
    let artists_after: i64 = store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM artist WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        artists_after, 2,
        "guarded: does not re-run after completion"
    );
}

#[test]
fn library_id_backfill_reconcile_is_idempotent() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_track", |conn| {
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json, library_id) \
                 VALUES ('s1', 't1', 'A', 'Al', 1, 0, 1, '{\"libraryId\":\"lib-a\"}', '')",
                [],
            )?;
            Ok(())
        })
        .expect("seed track");

    store
        .with_conn("test.reconcile", maybe_reconcile_library_id_backfill)
        .expect("reconcile");

    let completed_before: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT completed_at FROM library_data_migration WHERE id = ?1",
                params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
                |r| r.get(0),
            )
        })
        .expect("reconcile marker");
    assert!(completed_before > 0);

    store
        .with_conn_mut("test.clear_library_id", |conn| {
            conn.execute(
                "UPDATE track SET library_id = '' WHERE server_id = 's1' AND id = 't1'",
                [],
            )?;
            Ok(())
        })
        .expect("clear library_id");

    store
        .with_conn("test.reconcile_again", maybe_reconcile_library_id_backfill)
        .expect("reconcile again");

    let library_id_after: String = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT library_id FROM track WHERE server_id = 's1' AND id = 't1'",
                [],
                |r| r.get(0),
            )
        })
        .expect("library_id after second reconcile");
    assert_eq!(library_id_after, "");
}

#[test]
fn duration_sec_backfill_rounds_decimal_raw_duration_once() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_duration_backfill", |conn| {
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                 VALUES ('s1', 'decimal', 'Decimal', 'Al', 0, 0, 1, '{\"duration\":229.85}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                 VALUES ('s1', 'zero', 'Zero', 'Al', 0, 0, 1, '{\"duration\":0}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, duration_sec, deleted, synced_at, raw_json) \
                 VALUES ('s1', 'set', 'Set', 'Al', 100, 0, 1, '{\"duration\":200}')",
                [],
            )?;
            Ok(())
        })
        .expect("seed tracks");

    store
        .with_conn(
            "test.duration_backfill",
            maybe_reconcile_duration_sec_backfill,
        )
        .expect("duration backfill");

    let durations: Vec<(String, i64)> = store
        .with_read_conn(|conn| {
            conn.prepare("SELECT id, duration_sec FROM track WHERE server_id = 's1' ORDER BY id")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect()
        })
        .expect("backfilled durations");
    assert_eq!(
        durations,
        vec![
            ("decimal".into(), 230),
            ("set".into(), 100),
            ("zero".into(), 0)
        ]
    );

    store
        .with_conn_mut("test.clear_decimal_duration", |conn| {
            conn.execute("UPDATE track SET duration_sec = 0 WHERE id = 'decimal'", [])
        })
        .expect("clear duration");
    store
        .with_conn(
            "test.duration_backfill_again",
            maybe_reconcile_duration_sec_backfill,
        )
        .expect("guarded duration backfill");
    let duration_after: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT duration_sec FROM track WHERE id = 'decimal'",
                [],
                |row| row.get(0),
            )
        })
        .expect("duration after guarded re-run");
    assert_eq!(duration_after, 0);
}

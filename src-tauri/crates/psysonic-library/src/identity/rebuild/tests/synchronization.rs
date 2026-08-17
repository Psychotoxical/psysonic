use super::*;

#[test]
fn concurrent_ensures_rebuild_a_dirty_server_once() {
    use std::sync::{Arc, Barrier};

    let store = Arc::new(LibraryStore::open_in_memory());
    let rows = (0..2_000)
        .map(|index| {
            track_row(
                "s1",
                &format!("t{index}"),
                &format!("Title {index}"),
                Some("Artist"),
                &format!("Album {}", index / 10),
                None,
                180,
                "lib",
            )
        })
        .collect::<Vec<_>>();
    TrackRepository::new(&store).upsert_batch(&rows).unwrap();
    rebuild_cluster_keys(&store, None).unwrap();

    let mut changed = rows[0].clone();
    changed.title = "Updated title".into();
    TrackRepository::new(&store)
        .upsert_batch(&[changed])
        .unwrap();

    let worker_count = 6;
    let barrier = Arc::new(Barrier::new(worker_count));
    let workers = (0..worker_count)
        .map(|_| {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                ensure_cluster_keys_built(&store, "s1").unwrap()
            })
        })
        .collect::<Vec<_>>();
    let rebuilt = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(rebuilt.iter().filter(|count| **count > 0).count(), 1);
    assert_eq!(rebuilt.into_iter().sum::<u64>(), 1);
}

#[test]
fn clean_identity_ensure_does_not_wait_for_writer_lock() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[track_row(
            "s1",
            "t1",
            "Title",
            Some("Artist"),
            "Album",
            None,
            180,
            "lib",
        )])
        .unwrap();
    rebuild_cluster_keys(&store, None).unwrap();
    let (writer_started_tx, writer_started_rx) = mpsc::channel();
    let (release_writer_tx, release_writer_rx) = mpsc::channel();
    let writer_store = Arc::clone(&store);
    let writer = std::thread::spawn(move || {
        writer_store
            .with_conn_mut("test.hold_writer", |_conn| {
                writer_started_tx.send(()).unwrap();
                release_writer_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
    });
    writer_started_rx.recv().unwrap();

    let (ensure_tx, ensure_rx) = mpsc::channel();
    let ensure_store = Arc::clone(&store);
    let ensure = std::thread::spawn(move || {
        ensure_tx
            .send(ensure_cluster_keys_built(&ensure_store, "s1"))
            .unwrap();
    });
    let result = ensure_rx.recv_timeout(Duration::from_secs(2));
    release_writer_tx.send(()).unwrap();
    writer.join().unwrap();
    ensure.join().unwrap();

    assert_eq!(
        result
            .expect("clean identity preflight blocked on writer")
            .unwrap(),
        0
    );
}

#[test]
fn repeated_forced_rebuild_skips_unchanged_derived_rows() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track_row(
            "s1",
            "t1",
            "Title",
            Some("Artist"),
            "Album",
            None,
            180,
            "lib",
        )])
        .unwrap();
    rebuild_cluster_keys(&store, None).unwrap();

    let changed = store
        .with_conn_mut("test.rebuild_noop_writes", |conn| {
            let before = conn.total_changes();
            assert_eq!(rebuild_cluster_keys_on_conn(conn, Some("s1"))?, 1);
            Ok(conn.total_changes().saturating_sub(before))
        })
        .unwrap();

    assert!(
        changed <= 2,
        "only the two cluster_meta stamps may change, got {changed} writes"
    );
}

#[test]
fn cluster_attach_visible_on_read_connection() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track_row("s1", "t1", "T", Some("A"), "Al", None, 42, "lib")])
        .unwrap();
    rebuild_cluster_keys(&store, None).unwrap();

    let count: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM cluster.track_cluster_key WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 1);
}

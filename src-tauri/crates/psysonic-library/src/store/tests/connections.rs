use std::sync::mpsc;
use std::time::Duration;

use super::super::LibraryStore;

#[test]
fn read_conn_sees_committed_writes_from_write_conn() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO sync_state (server_id, library_scope, sync_phase) \
                 VALUES ('s1', '', 'ready')",
                [],
            )
        })
        .unwrap();
    let phase: String = store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT sync_phase FROM sync_state WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(phase, "ready");
}

#[test]
fn mainstage_reader_does_not_block_the_shared_browse_reader() {
    let store = std::sync::Arc::new(LibraryStore::open_in_memory());
    let (started_tx, started_rx) = mpsc::channel();
    let mainstage_store = std::sync::Arc::clone(&store);
    let mainstage = std::thread::spawn(move || {
        mainstage_store
            .with_mainstage_read_conn_timed(|_| {
                started_tx.send(()).expect("signal mainstage read start");
                std::thread::sleep(Duration::from_millis(100));
                Ok(())
            })
            .unwrap();
    });
    started_rx.recv().expect("wait for mainstage read");

    let started_at = std::time::Instant::now();
    let value: i64 = store
        .with_read_conn(|conn| conn.query_row("SELECT 1", [], |row| row.get(0)))
        .unwrap();

    assert_eq!(value, 1);
    assert!(
        started_at.elapsed() < Duration::from_millis(50),
        "shared read was blocked by the mainstage reader"
    );
    mainstage.join().expect("mainstage reader thread");
}

#[test]
fn scope_detail_reader_does_not_block_the_shared_browse_reader() {
    let store = std::sync::Arc::new(LibraryStore::open_in_memory());
    let (started_tx, started_rx) = mpsc::channel();
    let detail_store = std::sync::Arc::clone(&store);
    let detail = std::thread::spawn(move || {
        detail_store
            .with_scope_detail_read_conn(|_| {
                started_tx.send(()).expect("signal scope detail read start");
                std::thread::sleep(Duration::from_millis(100));
                Ok(())
            })
            .unwrap();
    });
    started_rx.recv().expect("wait for scope detail read");

    let started_at = std::time::Instant::now();
    let value: i64 = store
        .with_read_conn(|conn| conn.query_row("SELECT 1", [], |row| row.get(0)))
        .unwrap();

    assert_eq!(value, 1);
    assert!(
        started_at.elapsed() < Duration::from_millis(50),
        "shared read was blocked by the scope detail reader"
    );
    detail.join().expect("scope detail reader thread");
}

#[test]
fn read_conn_recovers_after_closure_panic() {
    let store = LibraryStore::open_in_memory();
    let first: Result<i64, String> = store.with_read_conn(|_conn| {
        panic!("simulated read panic");
    });
    assert!(first.is_err());

    let ok: i64 = store
        .with_read_conn(|conn| conn.query_row("SELECT 1", [], |r| r.get(0)))
        .expect("read after panic recovery");
    assert_eq!(ok, 1);
}

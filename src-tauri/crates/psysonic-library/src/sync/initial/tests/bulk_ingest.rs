use super::support::*;

#[test]
fn explicit_bulk_finalization_restores_captured_pragmas() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn("test.set_bulk_pragmas", |conn| {
            conn.pragma_update(None, "synchronous", "FULL")?;
            conn.pragma_update(None, "wal_autocheckpoint", 37)?;
            conn.pragma_update(None, "cache_size", -4096)
        })
        .unwrap();
    let before = current_bulk_pragmas(&store);

    let bulk = BulkIngestGuard::begin(&store).unwrap();
    assert!(store.bulk_ingest_active());
    assert_eq!(current_bulk_pragmas(&store).cache_size, -128_000);
    store
        .with_conn_mut("test.bulk_track", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, album, album_id, artist_id, \
                 duration_sec, deleted, synced_at, raw_json) \
                 VALUES ('s1', 't1', 'T', 'Al', 'al1', 'ar1', 1, 0, 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    bulk.finish().unwrap();

    let after = current_bulk_pragmas(&store);
    assert_eq!(after.synchronous, before.synchronous);
    assert_eq!(after.wal_autocheckpoint, before.wal_autocheckpoint);
    assert_eq!(after.cache_size, before.cache_size);
    assert!(!store.bulk_ingest_active());
    let album_index_stat: String = store
        .with_conn("test.bulk_track_stats", |conn| {
            conn.query_row(
                "SELECT stat FROM sqlite_stat1 \
                 WHERE tbl = 'track' AND idx = 'idx_track_album'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(album_index_stat.split_whitespace().next(), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn finalization_failure_keeps_cursor_in_ingest_and_sync_not_ready() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "searchResult3": {} }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.remove_fts", |conn| {
            conn.execute_batch("DROP TABLE track_fts")
        })
        .unwrap();
    let before = current_bulk_pragmas(&store);

    let error = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_sleep_disabled()
    .run()
    .await
    .unwrap_err();
    assert!(matches!(error, SyncError::Storage(message) if message.contains("track_fts")));

    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(
        sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("initial_sync")
    );
    let cursor: InitialSyncCursor = serde_json::from_value(
        sync_state
            .get_initial_sync_cursor("s1", "")
            .unwrap()
            .expect("cursor remains persisted"),
    )
    .unwrap();
    assert_eq!(cursor.phase, CursorPhase::Ingest);
    assert!(
        store.bulk_ingest_active(),
        "failed emergency cleanup must keep scheduler and guarded reads blocked"
    );

    let after = current_bulk_pragmas(&store);
    assert_eq!(after.synchronous, before.synchronous);
    assert_eq!(after.wal_autocheckpoint, before.wal_autocheckpoint);
    assert_eq!(after.cache_size, before.cache_size);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_still_runs_explicit_bulk_finalization() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    let cancel = Arc::new(AtomicBool::new(true));
    let before = current_bulk_pragmas(&store);

    let error = InitialSyncRunner::new(
        &store,
        &test_subsonic(&server.uri()),
        "s1",
        "",
        flags(CapabilityFlags::SUBSONIC_SEARCH3_BULK),
    )
    .with_cancellation(cancel)
    .with_sleep_disabled()
    .run()
    .await
    .unwrap_err();
    assert!(matches!(error, SyncError::Cancelled));
    assert!(!store.bulk_ingest_active());

    let after = current_bulk_pragmas(&store);
    assert_eq!(after.synchronous, before.synchronous);
    assert_eq!(after.wal_autocheckpoint, before.wal_autocheckpoint);
    assert_eq!(after.cache_size, before.cache_size);
}

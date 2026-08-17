use super::*;

#[test]
fn ensure_creates_row_with_default_cursor() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.ensure("s1", "").unwrap();

    let cursor = repo.get_initial_sync_cursor("s1", "").unwrap();
    assert_eq!(
        cursor,
        Some(json!({})),
        "DEFAULT must read back as empty object"
    );
}

#[test]
fn ensure_is_idempotent() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.ensure("s1", "").unwrap();
    repo.ensure("s1", "").unwrap();

    let count: i64 = store
        .with_conn("misc", |c| {
            c.query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0))
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn get_returns_none_for_missing_row() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    assert_eq!(repo.get_initial_sync_cursor("absent", "").unwrap(), None);
}

#[test]
fn set_roundtrips_nested_cursor_value() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    let cursor = json!({
        "phase": "ingest_tracks",
        "offset": 12_500,
        "last_seen_id": "tr_abc",
        "filters": { "library_id": "lib-1" },
    });
    repo.set_initial_sync_cursor("s1", "", &cursor).unwrap();
    let got = repo.get_initial_sync_cursor("s1", "").unwrap();
    assert_eq!(got, Some(cursor));
}

#[test]
fn set_overwrites_prior_cursor() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_initial_sync_cursor("s1", "", &json!({"offset": 1}))
        .unwrap();
    repo.set_initial_sync_cursor("s1", "", &json!({"offset": 2}))
        .unwrap();
    let got = repo.get_initial_sync_cursor("s1", "").unwrap();
    assert_eq!(got, Some(json!({"offset": 2})));
}

#[test]
fn set_preserves_other_columns_on_upsert() {
    // The ON CONFLICT clause must only touch the cursor column. Other
    // DEFAULT-backed fields stay at their initial values across upserts.
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_initial_sync_cursor("s1", "", &json!({"x": 1}))
        .unwrap();

    // Mutate a sibling column out-of-band to detect any accidental reset.
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE sync_state SET sync_phase = 'ingesting' WHERE server_id = 's1'",
                [],
            )
        })
        .unwrap();

    // Second cursor write must not touch sync_phase.
    repo.set_initial_sync_cursor("s1", "", &json!({"x": 2}))
        .unwrap();
    let phase: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT sync_phase FROM sync_state WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(phase, "ingesting");
}

#[test]
fn library_scope_separates_rows_per_server() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_initial_sync_cursor("s1", "", &json!({"all": true}))
        .unwrap();
    repo.set_initial_sync_cursor("s1", "lib-1", &json!({"lib": "one"}))
        .unwrap();

    assert_eq!(
        repo.get_initial_sync_cursor("s1", "").unwrap(),
        Some(json!({"all": true}))
    );
    assert_eq!(
        repo.get_initial_sync_cursor("s1", "lib-1").unwrap(),
        Some(json!({"lib": "one"}))
    );
}

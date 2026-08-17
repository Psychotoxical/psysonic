use super::*;

#[test]
fn capability_flags_roundtrip() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.ensure("s1", "").unwrap();
    assert_eq!(repo.get_capability_flags("s1", "").unwrap(), Some(0));
    repo.set_capability_flags("s1", "", 0x002 | 0x010).unwrap();
    assert_eq!(repo.get_capability_flags("s1", "").unwrap(), Some(0x012));
}

#[test]
fn capability_flags_returns_none_for_missing_row() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    assert_eq!(repo.get_capability_flags("absent", "").unwrap(), None);
}

#[test]
fn capability_flags_set_creates_row_with_other_defaults() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_capability_flags("s1", "", 0x008).unwrap();
    // sync_phase defaulted to 'idle' on the implicit insert.
    assert_eq!(
        repo.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("idle")
    );
}

#[test]
fn n1_bulk_unreliable_defaults_false_and_roundtrips() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.ensure("s1", "").unwrap();
    // DEFAULT 0 reads back as Some(false); existing servers stay N1-eligible.
    assert_eq!(repo.get_n1_bulk_unreliable("s1", "").unwrap(), Some(false));
    assert_eq!(repo.get_n1_bulk_unreliable("absent", "").unwrap(), None);

    repo.set_n1_bulk_unreliable("s1", "", true).unwrap();
    assert_eq!(repo.get_n1_bulk_unreliable("s1", "").unwrap(), Some(true));
    repo.set_n1_bulk_unreliable("s1", "", false).unwrap();
    assert_eq!(repo.get_n1_bulk_unreliable("s1", "").unwrap(), Some(false));
}

#[test]
fn n1_bulk_unreliable_set_does_not_clobber_cursor() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_initial_sync_cursor("s1", "", &json!({"offset": 7}))
        .unwrap();
    repo.set_n1_bulk_unreliable("s1", "", true).unwrap();
    assert_eq!(
        repo.get_initial_sync_cursor("s1", "").unwrap(),
        Some(json!({"offset": 7}))
    );
}

#[test]
fn capability_flags_set_does_not_clobber_cursor() {
    // Cross-check: setting flags must not reset
    // `initial_sync_cursor_json` back to '{}'.
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_initial_sync_cursor("s1", "", &json!({"offset": 42}))
        .unwrap();
    repo.set_capability_flags("s1", "", 0x002).unwrap();
    assert_eq!(
        repo.get_initial_sync_cursor("s1", "").unwrap(),
        Some(json!({"offset": 42}))
    );
}

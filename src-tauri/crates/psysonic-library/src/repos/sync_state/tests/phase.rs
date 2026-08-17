use super::*;

#[test]
fn sync_phase_default_is_idle_after_ensure() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.ensure("s1", "").unwrap();
    assert_eq!(
        repo.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("idle")
    );
}

#[test]
fn sync_phase_transitions_through_state_machine_values() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    for phase in ["probing", "initial_sync", "ready", "error", "idle"] {
        repo.set_sync_phase("s1", "", phase).unwrap();
        assert_eq!(
            repo.get_sync_phase("s1", "").unwrap().as_deref(),
            Some(phase)
        );
    }
}

#[test]
fn sync_phase_conditional_transition_only_updates_expected_phase() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.ensure("s1", "").unwrap();

    assert!(!repo
        .set_sync_phase_if("s1", "", "ready", "probing")
        .unwrap());
    assert_eq!(
        repo.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("idle")
    );

    assert!(repo.set_sync_phase_if("s1", "", "idle", "probing").unwrap());
    assert_eq!(
        repo.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("probing")
    );
}

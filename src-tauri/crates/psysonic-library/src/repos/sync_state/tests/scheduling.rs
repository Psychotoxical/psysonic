use super::*;

#[test]
fn library_tier_roundtrip() {
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_library_tier("s1", "", "huge").unwrap();
    let tier: String = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT library_tier FROM sync_state WHERE server_id = 's1'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(tier, "huge");
}

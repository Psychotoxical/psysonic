use super::*;

#[test]
fn watermark_setters_preserve_each_other() {
    // Each setter must scope its `ON CONFLICT … DO UPDATE` to its own
    // column. Set three and read all three back unchanged.
    let store = LibraryStore::open_in_memory();
    let repo = SyncStateRepository::new(&store);
    repo.set_server_last_scan_iso("s1", "", Some("2026-05-01T12:00:00Z"))
        .unwrap();
    repo.set_indexes_last_modified_ms("s1", "", 1_700_000_000_000)
        .unwrap();
    repo.set_artists_last_modified_ms("s1", "", 1_700_000_500_000)
        .unwrap();

    let (iso, idx_ms, art_ms): (Option<String>, Option<i64>, Option<i64>) = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT server_last_scan_iso, indexes_last_modified_ms, artists_last_modified_ms \
                 FROM sync_state WHERE server_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(iso.as_deref(), Some("2026-05-01T12:00:00Z"));
    assert_eq!(idx_ms, Some(1_700_000_000_000));
    assert_eq!(art_ms, Some(1_700_000_500_000));
}

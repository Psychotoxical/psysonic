use super::*;

#[test]
fn list_track_ids_after_pages_in_id_order() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    for id in ["a1", "b2", "c3"] {
        let mut r = row("s1", id, id);
        r.content_hash = None;
        repo.upsert_batch(&[r]).unwrap();
    }
    let first = repo.list_track_ids_after("s1", None, 2).unwrap();
    assert_eq!(first, vec!["a1", "b2"]);
    let second = repo.list_track_ids_after("s1", Some("b2"), 2).unwrap();
    assert_eq!(second, vec!["c3"]);
}

#[test]
fn list_analysis_candidate_ids_skips_tracks_with_bpm_fact() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut needs = row("s1", "needs", "Needs");
    needs.content_hash = None;
    repo.upsert_batch(&[needs, row("s1", "done", "Done")])
        .unwrap();
    store
        .with_conn_mut("misc", |c| {
            c.execute(
                "INSERT INTO track_fact (server_id, track_id, fact_kind, source_kind, source_id, confidence, fetched_at) \
                 VALUES ('s1', 'done', 'bpm', 'analysis', 'oximedia-60s-center', 1.0, 1)",
                [],
            )
        })
        .unwrap();
    let ids = repo
        .list_analysis_candidate_ids_after("s1", None, 10)
        .unwrap();
    assert_eq!(ids, vec!["needs"]);
}

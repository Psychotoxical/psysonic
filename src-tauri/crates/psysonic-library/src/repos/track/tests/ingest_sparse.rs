use rusqlite::params;

use super::*;

/// `search3` — the bulk path every library above the large-library
/// threshold takes — returns neither `albumArtist` nor `sortName`. Without
/// the COALESCE guards a whole-server pass blanks both on every row a
/// richer path had already filled in.
fn album_credit_and_sort(store: &LibraryStore, id: &str) -> (Option<String>, Option<String>) {
    store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT album_artist, title_sort FROM track WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        })
        .unwrap()
}

fn enriched_row(id: &str) -> TrackRow {
    let mut enriched = row("s1", id, "Track");
    enriched.title_sort = Some("Track, A".into());
    enriched
}

fn bulk_row_without_credit(id: &str) -> TrackRow {
    let mut bulk = row("s1", id, "Track");
    bulk.album_artist = None;
    bulk.title_sort = None;
    bulk
}

#[test]
fn a_bulk_pass_that_omits_the_album_credit_does_not_erase_it() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[enriched_row("t1")]).unwrap();

    repo.upsert_sparse_batch_initial_ingest_timed(&[bulk_row_without_credit("t1")], None)
        .unwrap();

    let (credit, sort) = album_credit_and_sort(&store, "t1");
    assert_eq!(credit.as_deref(), Some("The Artist"));
    assert_eq!(sort.as_deref(), Some("Track, A"));
}

#[test]
fn the_resync_upsert_preserves_the_album_credit_as_well() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[enriched_row("t1")]).unwrap();

    repo.upsert_sparse_batch_initial_ingest_timed(&[bulk_row_without_credit("t1")], Some(2))
        .unwrap();

    let (credit, sort) = album_credit_and_sort(&store, "t1");
    assert_eq!(credit.as_deref(), Some("The Artist"));
    assert_eq!(sort.as_deref(), Some("Track, A"));
}

#[test]
fn a_credit_the_server_actually_sends_still_wins() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[enriched_row("t1")]).unwrap();

    let mut retagged = row("s1", "t1", "Track");
    retagged.album_artist = Some("Various Artists".into());
    retagged.title_sort = Some("Track, The".into());
    repo.upsert_batch(&[retagged]).unwrap();

    let (credit, sort) = album_credit_and_sort(&store, "t1");
    assert_eq!(credit.as_deref(), Some("Various Artists"));
    assert_eq!(sort.as_deref(), Some("Track, The"));
}

#[test]
fn an_authoritative_payload_clears_credit_but_keeps_unobserved_sync_fields() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut enriched = enriched_row("t1");
    enriched.server_updated_at = Some(1_700_000_000_000);
    enriched.raw_json = serde_json::json!({
        "id": "t1",
        "albumArtist": "The Artist",
        "sortTitle": "Track, A",
        "updatedAt": "2023-11-14T22:13:20Z"
    })
    .to_string();
    repo.upsert_batch(&[enriched]).unwrap();

    let mut authoritative = bulk_row_without_credit("t1");
    authoritative.server_updated_at = None;
    authoritative.raw_json = serde_json::json!({ "id": "t1", "title": "Track" }).to_string();
    repo.upsert_batch(&[authoritative]).unwrap();

    let values: (Option<String>, Option<String>, Option<i64>) = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT album_artist, title_sort, server_updated_at FROM track WHERE id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(
        values,
        (None, Some("Track, A".into()), Some(1_700_000_000_000))
    );
}

#[test]
fn authoritative_explicit_nulls_clear_sort_and_watermark() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut enriched = enriched_row("t1");
    enriched.server_updated_at = Some(1_700_000_000_000);
    enriched.raw_json = serde_json::json!({
        "id": "t1",
        "sortTitle": "Track, A",
        "updatedAt": "2023-11-14T22:13:20Z"
    })
    .to_string();
    repo.upsert_batch(&[enriched]).unwrap();

    let mut cleared = bulk_row_without_credit("t1");
    cleared.server_updated_at = None;
    cleared.raw_json = serde_json::json!({
        "id": "t1",
        "sortTitle": null,
        "updatedAt": null
    })
    .to_string();
    repo.upsert_batch(&[cleared]).unwrap();

    let values: (Option<String>, Option<i64>) = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT title_sort, server_updated_at FROM track WHERE id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap();
    assert_eq!(values, (None, None));
}

#[test]
fn a_sparse_payload_keeps_raw_fields_it_did_not_observe() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut enriched = enriched_row("t1");
    enriched.raw_json = serde_json::json!({
        "id": "t1",
        "albumArtist": "The Artist",
        "sortTitle": "Track, A",
        "updatedAt": "2023-11-14T22:13:20Z",
        "tags": { "mood": ["Calm"] }
    })
    .to_string();
    repo.upsert_batch(&[enriched]).unwrap();

    let mut sparse = bulk_row_without_credit("t1");
    sparse.server_updated_at = None;
    sparse.raw_json = serde_json::json!({ "id": "t1", "title": "Track" }).to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[sparse], None)
        .unwrap();

    let raw: String = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT raw_json FROM track WHERE id = 't1'", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    let raw: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(raw["albumArtist"], "The Artist");
    assert_eq!(raw["sortTitle"], "Track, A");
    assert_eq!(raw["tags"]["mood"], serde_json::json!(["Calm"]));
}

#[test]
fn sparse_merge_keeps_genre_projection_aligned_with_the_committed_row() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut enriched = enriched_row("t1");
    enriched.raw_json = serde_json::json!({
        "id": "t1",
        "genres": [{ "name": "Ambient" }, { "name": "Drone" }]
    })
    .to_string();
    repo.upsert_batch(&[enriched]).unwrap();

    let mut sparse = bulk_row_without_credit("t1");
    sparse.genre = None;
    sparse.library_id = None;
    sparse.raw_json = serde_json::json!({ "id": "t1", "title": "Track" }).to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[sparse], None)
        .unwrap();

    let genres: Vec<(String, Option<String>)> = store
        .with_read_conn(|conn| {
            conn.prepare(
                "SELECT genre, library_id FROM track_genre \
                 WHERE server_id = 's1' AND track_id = 't1' ORDER BY genre",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(
        genres,
        vec![
            ("Ambient".into(), Some("lib-1".into())),
            ("Drone".into(), Some("lib-1".into())),
        ]
    );
}

#[test]
fn explicit_nulls_clear_preserved_sparse_fields() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    let mut enriched = enriched_row("t1");
    enriched.raw_json = serde_json::json!({
        "id": "t1",
        "albumArtist": "The Artist",
        "sortTitle": "Track, A",
        "updatedAt": "2023-11-14T22:13:20Z"
    })
    .to_string();
    repo.upsert_batch(&[enriched]).unwrap();

    let mut cleared = bulk_row_without_credit("t1");
    cleared.server_updated_at = None;
    cleared.raw_json = serde_json::json!({
        "id": "t1",
        "albumArtist": null,
        "sortTitle": null,
        "updatedAt": null
    })
    .to_string();
    repo.upsert_sparse_batch_initial_ingest_timed(&[cleared], None)
        .unwrap();

    let values: (Option<String>, Option<String>, Option<i64>) = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT album_artist, title_sort, server_updated_at FROM track WHERE id = 't1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap();
    assert_eq!(values, (None, None, None));
}

/// `MAX(server_updated_at)` is where the native delta resumes reading. A
/// bulk pass that does not carry the timestamp must not erase it, on either
/// upsert shape — a resync that blanks it strands the delta.
#[test]
fn a_bulk_pass_does_not_erase_the_delta_watermark() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[enriched_row("t1")]).unwrap();

    let mut bulk = bulk_row_without_credit("t1");
    bulk.server_updated_at = None;
    repo.upsert_sparse_batch_initial_ingest_timed(&[bulk.clone()], None)
        .unwrap();
    assert_eq!(delta_watermark(&store, "t1"), Some(1_700_000_000));

    repo.upsert_sparse_batch_initial_ingest_timed(&[bulk], Some(2))
        .unwrap();
    assert_eq!(
        delta_watermark(&store, "t1"),
        Some(1_700_000_000),
        "the resync path must preserve it too"
    );
}

fn delta_watermark(store: &LibraryStore, id: &str) -> Option<i64> {
    store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT server_updated_at FROM track WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
        })
        .unwrap()
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::*;
use crate::commands::test_support::{make_row, runtime};
use crate::repos::TrackRepository;
use crate::runtime::CurrentJob;

fn populate_server_scoped_tables(store: &LibraryStore, server_id: &str) {
    let canonical_id = format!("canonical-{server_id}");
    let artist_id = format!("artist-{server_id}");
    let album_id = format!("album-{server_id}");
    let track_id = format!("track-{server_id}");
    store
        .with_conn("test.populate_server_scopes", |conn| {
            conn.execute_batch(&format!(
                "INSERT INTO canonical_track(id, created_at, updated_at) VALUES ('{canonical_id}', 1, 1);
                 INSERT INTO sync_state(server_id, library_scope) VALUES ('{server_id}', '');
                 INSERT INTO artist(server_id, id, name, synced_at) VALUES ('{server_id}', '{artist_id}', 'Artist', 1);
                 INSERT INTO album(server_id, id, name, synced_at) VALUES ('{server_id}', '{album_id}', 'Album', 1);
                 INSERT INTO track(server_id, id, title, album, duration_sec, synced_at, raw_json)
                   VALUES ('{server_id}', '{track_id}', 'Track', 'Album', 1, 1, '{{}}');
                 INSERT INTO track_extension(server_id, track_id, kind, payload, updated_at)
                   VALUES ('{server_id}', '{track_id}', 'waveform', X'01', 1);
                 INSERT INTO track_fact(server_id, track_id, fact_kind, source_kind, source_id, fetched_at)
                   VALUES ('{server_id}', '{track_id}', 'bpm', 'server', 'source', 1);
                 INSERT INTO track_artifact(server_id, track_id, artifact_kind, format, source_kind, source_id, fetched_at)
                   VALUES ('{server_id}', '{track_id}', 'lyrics', 'text', 'server', 'source', 1);
                 INSERT INTO track_canonical_link(server_id, track_id, canonical_id, match_method, confidence, linked_at)
                   VALUES ('{server_id}', '{track_id}', '{canonical_id}', 'isrc', 1.0, 1);
                 INSERT INTO track_id_history(server_id, old_id, new_id, remapped_at)
                   VALUES ('{server_id}', 'old-{track_id}', '{track_id}', 1);
                 INSERT INTO play_session(server_id, track_id, started_at_ms, listened_sec, position_max_sec, completion, end_reason)
                   VALUES ('{server_id}', '{track_id}', 1, 1.0, 1.0, 'full', 'ended');
                 INSERT INTO track_offline(server_id, track_id, local_path, cached_at)
                   VALUES ('{server_id}', '{track_id}', '/tmp/{track_id}', 1);
                 INSERT INTO track_genre(server_id, track_id, genre, album_id)
                   VALUES ('{server_id}', '{track_id}', 'Rock', '{album_id}');
                 INSERT INTO artist_artwork_lookup(server_id, artist_id, surface_kind, status, updated_at)
                   VALUES ('{server_id}', '{artist_id}', 'fanart', 'hit', 1);
                  INSERT INTO library_tag_state(server_id, folders_hash, completed_at)
                    VALUES ('{server_id}', 'hash', 1);
                  INSERT INTO library_tag_cursor(server_id, folders_hash, next_folder_id, updated_at)
                    VALUES ('{server_id}', 'hash', 'folder-1', 1);
                 INSERT INTO entity_user_rating(server_id, entity_kind, entity_id, rating, fetched_at)
                   VALUES ('{server_id}', 'track', '{track_id}', 5, 1);
                 INSERT INTO album_browse_projection(
                   server_id, library_id, album_id, name, song_count, duration_sec, synced_at, representative_track_id
                 ) VALUES ('{server_id}', '', '{album_id}', 'Album', 1, 1, 1, '{track_id}');
                 INSERT INTO canonical_enrichment_link(
                   canonical_id, enrichment_kind, owner_server_id, owner_track_id, linked_at
                 ) VALUES ('{canonical_id}', 'lyrics', '{server_id}', '{track_id}', 1);"
            ))?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn purge_removes_every_target_scope_and_preserves_optional_offline_rows() {
    let store = Arc::new(LibraryStore::open_in_memory());
    populate_server_scoped_tables(&store, "s1");
    populate_server_scoped_tables(&store, "s2");
    let runtime = runtime(Arc::clone(&store));

    let report = purge_server_data(&runtime, "s1", false).unwrap();
    assert_eq!(report.tracks_deleted, 1);
    assert_eq!(report.albums_deleted, 1);
    assert_eq!(report.artists_deleted, 1);
    assert_eq!(report.offline_rows_deleted, 0);

    let scopes = [
        ("track_extension", "server_id"),
        ("track_fact", "server_id"),
        ("track_artifact", "server_id"),
        ("track_canonical_link", "server_id"),
        ("track_id_history", "server_id"),
        ("play_session", "server_id"),
        ("track_genre", "server_id"),
        ("artist_artwork_lookup", "server_id"),
        ("library_tag_state", "server_id"),
        ("library_tag_cursor", "server_id"),
        ("entity_user_rating", "server_id"),
        ("album_browse_projection", "server_id"),
        ("canonical_enrichment_link", "owner_server_id"),
        ("track", "server_id"),
        ("album", "server_id"),
        ("artist", "server_id"),
        ("sync_state", "server_id"),
    ];
    store
        .with_conn("test.assert_purge_scopes", |conn| {
            for (table, column) in scopes {
                let target: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {column} = 's1'"),
                    [],
                    |row| row.get(0),
                )?;
                let other: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {column} = 's2'"),
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(target, 0, "target rows remain in {table}.{column}");
                assert_eq!(other, 1, "other-server row removed from {table}.{column}");
            }
            let preserved_offline: i64 = conn.query_row(
                "SELECT COUNT(*) FROM track_offline WHERE server_id = 's1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(preserved_offline, 1);
            let foreign_key_errors: i64 =
                conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(foreign_key_errors, 0);
            Ok(())
        })
        .unwrap();

    let second = purge_server_data(&runtime, "s1", true).unwrap();
    assert_eq!(second.offline_rows_deleted, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn purge_drains_http_waiting_job_before_deleting_rows() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/in-flight"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(200))
                .set_body_string("ok"),
        )
        .mount(&server)
        .await;

    let store = Arc::new(LibraryStore::open_in_memory());
    TrackRepository::new(&store)
        .upsert_batch(&[make_row("s1", "before", "al_1", 1)])
        .unwrap();
    let runtime = Arc::new(runtime(Arc::clone(&store)));
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(tokio::sync::Notify::new());
    let job_id = "http-writer".to_string();
    runtime
        .install_current_job(CurrentJob {
            job_id: job_id.clone(),
            server_id: "s1".into(),
            kind: "delta_sync".into(),
            cancel: Arc::clone(&cancel),
            abort_handle: None,
            done: Arc::clone(&done),
        })
        .unwrap();

    let runtime_for_job = Arc::clone(&runtime);
    let request_url = format!("{}/in-flight", server.uri());
    let writer = tokio::spawn(async move {
        reqwest::get(request_url)
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        // Model a response already in flight: even if cancellation was set,
        // this late write must finish before the purge transaction starts.
        TrackRepository::new(&runtime_for_job.store)
            .upsert_batch(&[make_row("s1", "late", "al_1", 2)])
            .unwrap();
        runtime_for_job.complete_current_job(&job_id, &done);
    });

    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if server
                .received_requests()
                .await
                .expect("requests captured")
                .is_empty()
            {
                tokio::task::yield_now().await;
            } else {
                break;
            }
        }
    })
    .await
    .expect("HTTP request did not start");

    let barrier = runtime
        .cancel_and_drain_sync(None, Some("s1"))
        .await
        .unwrap();
    assert!(cancel.load(Ordering::SeqCst));
    let report = purge_server_data(&runtime, "s1", false).unwrap();
    drop(barrier);
    writer.await.unwrap();

    assert_eq!(report.tracks_deleted, 2);
    assert!(TrackRepository::new(&store)
        .find_one("s1", "late")
        .unwrap()
        .is_none());
}

#[test]
fn multi_scope_live_search_dedupes_album_and_artist_but_preserves_tracks() {
    use crate::dto::LibraryScopePair;
    use crate::identity::rebuild_cluster_keys;

    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            {
                let mut t = track(
                    "s1",
                    "t-a",
                    "Shared Song",
                    "Shared Artist",
                    "Shared Album",
                    "alb-a",
                    "ar-a",
                );
                t.library_id = Some("lib-a".into());
                t
            },
            {
                let mut t = track(
                    "s1",
                    "t-b",
                    "Shared Song",
                    "Shared Artist",
                    "Shared Album",
                    "alb-b",
                    "ar-b",
                );
                t.library_id = Some("lib-b".into());
                t
            },
        ])
        .unwrap();
    store
        .with_conn_mut("test.multi_scope_artists", |conn| {
            conn.execute(
                "INSERT INTO artist (server_id, id, name, synced_at) VALUES \
                     ('s1', 'ar-a', 'Shared Artist', 1), \
                     ('s1', 'ar-b', 'Shared Artist', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    rebuild_cluster_keys(&store, None).unwrap();

    let scopes = vec![
        LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some("lib-a".into()),
        },
        LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some("lib-b".into()),
        },
    ];
    let resp = run_live_search(&store, "s1", "shared", None, Some(&scopes), 5, 5, 10).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar-a");
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "alb-a");
    assert_eq!(resp.tracks.len(), 2);
    assert_eq!(resp.tracks[0].id, "t-a");
    assert_eq!(resp.tracks[1].id, "t-b");
}

/// Manual: `cargo test -p psysonic-library bench_disk_live_search --release -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_disk_live_search() {
    use std::path::PathBuf;
    use std::time::Instant;

    let path: PathBuf = std::env::var("HOME")
        .map(|h| {
            PathBuf::from(h)
                .join(".local/share/dev.psysonic.player/databases/library/library.sqlite")
        })
        .expect("HOME");
    if !path.exists() {
        eprintln!("skip: no db at {}", path.display());
        return;
    }
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open db");
    conn.pragma_update(None, "cache_size", -64000).unwrap();

    let server_id = std::env::var("PSYSONIC_BENCH_SERVER_ID").unwrap_or_else(|_| {
        conn.query_row(
            "SELECT server_id FROM track WHERE deleted = 0 LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .expect("server_id")
    });

    for q in ["manowar", "metallica", "arch enemy", "metal", "meta"] {
        let t0 = Instant::now();
        let songs = query_songs(&conn, q, &server_id, &[], 10).unwrap();
        let t1 = Instant::now();
        let artists = query_artists(&conn, q, &server_id, &[], 5).unwrap();
        let t2 = Instant::now();
        let albums = query_albums(&conn, q, &server_id, &[], 5).unwrap();
        let t3 = Instant::now();
        eprintln!(
            "{q:?}: songs={} ({:.1}ms) artists={} ({:.1}ms) albums={} ({:.1}ms) total={:.1}ms",
            songs.len(),
            t1.duration_since(t0).as_secs_f64() * 1000.0,
            artists.len(),
            t2.duration_since(t1).as_secs_f64() * 1000.0,
            albums.len(),
            t3.duration_since(t2).as_secs_f64() * 1000.0,
            t3.duration_since(t0).as_secs_f64() * 1000.0,
        );
    }
}

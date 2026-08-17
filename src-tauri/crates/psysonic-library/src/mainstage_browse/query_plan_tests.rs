fn query_plan(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    feed: LibraryMainstageAlbumFeed,
) -> Vec<String> {
    let (sql, binds) = build_mainstage_query(scopes, feed, &[], candidate_limit(0, 31), 0, 31);
    store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let plan = stmt
                .query_map(params_from_iter(binds.iter()), |row| row.get(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(plan)
        })
        .unwrap()
}

#[test]
fn mainstage_query_plans_use_bounded_feed_indexes() {
    let store = LibraryStore::open_in_memory();
    let scopes = vec![scope("s1", "l1"), scope("s2", "l2")];

    let releases = query_plan(&store, &scopes, LibraryMainstageAlbumFeed::NewReleases);
    assert!(
        releases
            .iter()
            .any(|line| line.contains("idx_track_library_created_album")),
        "New Releases plan did not use created index: {releases:#?}"
    );
    assert!(
        !releases
            .iter()
            .any(|line| line == "SCAN t" || line.contains("SCAN track")),
        "New Releases plan contains an unindexed track scan: {releases:#?}"
    );

    let recent = query_plan(&store, &scopes, LibraryMainstageAlbumFeed::RecentlyPlayed);
    assert!(
        recent
            .iter()
            .any(|line| line.contains("idx_play_session_started")),
        "Recently Played plan did not drive from newest sessions: {recent:#?}"
    );
    assert!(
        recent
            .iter()
            .any(|line| line.contains("sqlite_autoindex_track_1")),
        "Recently Played plan did not use the track primary key: {recent:#?}"
    );
}

#[test]
fn large_scoped_feeds_stay_bounded() {
    const TRACKS: i64 = 214_000;
    const SESSIONS: i64 = 40_000;
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("test.seed_mainstage_perf", |conn| {
            conn.execute_batch(
                "DROP TRIGGER track_ai; DROP TRIGGER track_ad; DROP TRIGGER track_au;",
            )?;
            let tx = conn.transaction()?;
            {
                let mut insert_track = tx.prepare(
                    "INSERT INTO track (server_id, id, title, artist, artist_id, album, \
                         album_id, album_artist, duration_sec, year, genre, cover_art_id, \
                         library_id, server_created_at, deleted, synced_at, raw_json) \
                         VALUES (?1, ?2, ?3, 'Artist', 'artist', ?4, ?5, 'Artist', 180, \
                                 2026, 'Rock', ?6, ?7, ?8, 0, 1, '{}')",
                )?;
                for n in 0..TRACKS {
                    let server = if n % 2 == 0 { "s1" } else { "s2" };
                    let library = if n % 2 == 0 { "l1" } else { "l2" };
                    let album = n / 10;
                    insert_track.execute(params![
                        server,
                        format!("track-{n}"),
                        format!("Track {n}"),
                        format!("Album {album}"),
                        format!("album-{album}"),
                        format!("cover-{album}"),
                        library,
                        n,
                    ])?;
                }
            }
            {
                let mut insert_session = tx.prepare(
                    "INSERT INTO play_session \
                         (server_id, track_id, started_at_ms, listened_sec, position_max_sec, \
                          completion, end_reason) \
                         VALUES (?1, ?2, ?3, 20.0, 20.0, 'partial', 'skip')",
                )?;
                for n in 0..SESSIONS {
                    let track_number = TRACKS - 1 - n;
                    let server = if track_number % 2 == 0 { "s1" } else { "s2" };
                    insert_session.execute(params![server, format!("track-{track_number}"), n,])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .unwrap();

    let scopes = vec![scope("s1", "l1"), scope("s2", "l2")];
    let release_request = request(scopes.clone(), LibraryMainstageAlbumFeed::NewReleases);
    let started = Instant::now();
    let releases = list_mainstage_albums(&store, &release_request).unwrap();
    let release_elapsed = started.elapsed();

    let recent_request = request(scopes, LibraryMainstageAlbumFeed::RecentlyPlayed);
    let started = Instant::now();
    let recent = list_mainstage_albums(&store, &recent_request).unwrap();
    let recent_elapsed = started.elapsed();

    eprintln!("mainstage 214k fixture: releases={release_elapsed:?}, recent={recent_elapsed:?}");
    assert_eq!(releases.albums.len(), 30);
    assert_eq!(recent.albums.len(), 30);
    assert!(releases
        .albums
        .iter()
        .all(|album| album.song_count.is_none()));
    assert!(
        release_elapsed < Duration::from_millis(500),
        "New Releases regressed to an unbounded query: {release_elapsed:?}"
    );
    assert!(
        recent_elapsed < Duration::from_millis(500),
        "Recently Played regressed to an unbounded query: {recent_elapsed:?}"
    );
}

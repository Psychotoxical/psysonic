#[tokio::test(flavor = "multi_thread")]
async fn an_album_the_server_lost_is_removed_after_confirmation() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    for index in 0..10 {
        seed_album(
            &store,
            &format!("al-{index}"),
            &[&format!("t-{index}")],
            100,
        );
    }
    // The server still lists nine of the ten.
    let listed: Vec<_> = (0..9)
        .map(|i| album_summary(&format!("al-{i}"), 1, 100))
        .collect();
    mount_album_list(&server, listed).await;
    mount_album_gone(&server, "al-9").await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(report.albums_removed, 1);
    assert_eq!(live_rows(&store, "al-9"), 0);
    assert_eq!(live_rows(&store, "al-0"), 1, "the rest is untouched");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_album_missing_from_the_page_run_but_still_there_is_not_touched() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    for index in 0..10 {
        seed_album(
            &store,
            &format!("al-{index}"),
            &[&format!("t-{index}")],
            100,
        );
    }
    let listed: Vec<_> = (0..9)
        .map(|i| album_summary(&format!("al-{i}"), 1, 100))
        .collect();
    mount_album_list(&server, listed).await;
    // The enumeration skipped it, but the album is alive and well.
    mount_album_present(&server, "al-9", &["t-9"]).await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(report.albums_removed, 0);
    assert_eq!(
        live_rows(&store, "al-9"),
        1,
        "a shifted page must never delete music"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_enumeration_is_no_answer_at_all() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-1", &["t-1"], 100);
    mount_album_list(&server, Vec::new()).await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(report.server_albums, 0);
    assert_eq!(report.albums_removed, 0);
    assert_eq!(live_rows(&store, "al-1"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wholesale_purge_is_refused_before_a_single_request() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    for index in 0..20 {
        seed_album(
            &store,
            &format!("al-{index}"),
            &[&format!("t-{index}")],
            100,
        );
    }
    // Only one album survives the enumeration — nineteen of twenty exceeds
    // both the percentage cap and the small-library floor.
    mount_album_list(&server, vec![album_summary("al-0", 1, 100)]).await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert!(report.removal_refused);
    assert_eq!(report.albums_removed, 0);
    assert_eq!(live_rows(&store, "al-19"), 1);
}

/// The existing cap test has no gaps, so it never exercises the split. With
/// work on both sides and an odd cap, `div_ceil` hands the spare unit to
/// each half and the run spends one request more than the constant allows.
#[tokio::test(flavor = "multi_thread")]
async fn an_odd_probe_cap_is_still_a_cap_when_both_halves_have_work() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    for index in 0..20 {
        seed_album(
            &store,
            &format!("al-{index:03}"),
            &[&format!("t-{index}")],
            100,
        );
    }
    // Two removals and two gaps, against a cap of three.
    let mut listed: Vec<_> = (2..20)
        .map(|i| album_summary(&format!("al-{i:03}"), 1, 100))
        .collect();
    listed.push(album_summary("al-new-0", 1, 100));
    listed.push(album_summary("al-new-1", 1, 100));
    mount_album_list(&server, listed).await;
    for index in 0..2 {
        mount_album_gone(&server, &format!("al-{index:03}")).await;
    }
    mount_album_present(&server, "al-new-0", &["t-new-0"]).await;
    mount_album_present(&server, "al-new-1", &["t-new-1"]).await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .with_probe_cap(3)
        .run()
        .await
        .unwrap();

    assert_eq!(
        report.albums_removed + report.gaps_filled,
        3,
        "a cap of three means three probes, not four"
    );
    assert_eq!(
        report.deferred, 1,
        "the fourth candidate is named, not spent"
    );
}

/// An album the server itself reports as empty can never produce a track
/// row, so fetching it changes nothing and leaves the gap open. Because the
/// gap list is sorted, that album takes the same slot from a real gap on
/// every run, for the life of the install.
#[tokio::test(flavor = "multi_thread")]
async fn an_album_the_server_reports_as_empty_is_not_treated_as_a_gap() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    seed_album(&store, "al-have", &["t-have"], 100);
    mount_album_list(
        &server,
        vec![
            album_summary("al-have", 1, 100),
            album_summary("al-empty", 0, 0),
        ],
    )
    .await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(report.gaps_filled, 0);
    assert_eq!(
        report.deferred, 0,
        "not deferred either — it is not work, and reporting it as pending \
             would keep pulling the next run forward"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_probe_cap_bounds_one_run_and_reports_the_rest() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    for index in 0..100 {
        seed_album(
            &store,
            &format!("al-{index:03}"),
            &[&format!("t-{index}")],
            100,
        );
    }
    // Ten of a hundred are gone: well inside the removal cap, well above
    // the probe cap this run is given.
    let listed: Vec<_> = (10..100)
        .map(|i| album_summary(&format!("al-{i:03}"), 1, 100))
        .collect();
    mount_album_list(&server, listed).await;
    for index in 0..10 {
        mount_album_gone(&server, &format!("al-{index:03}")).await;
    }

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .with_probe_cap(3)
        .run()
        .await
        .unwrap();

    assert!(
        !report.removal_refused,
        "ten of a hundred is an ordinary cleanup"
    );
    assert_eq!(report.albums_removed, 3, "one run spends its cap and stops");
    assert_eq!(
        report.deferred, 7,
        "the rest is named, not silently dropped"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stale_projection_row_is_dropped_rather_than_counted() {
    let server = MockServer::start().await;
    let store = LibraryStore::open_in_memory();
    mark_ready(&store);
    for index in 0..9 {
        seed_album(
            &store,
            &format!("al-{index}"),
            &[&format!("t-{index}")],
            100,
        );
    }
    // An album row with no live tracks behind it: nothing to tombstone.
    seed_album(&store, "al-stale", &[], 0);
    let listed: Vec<_> = (0..9)
        .map(|i| album_summary(&format!("al-{i}"), 1, 100))
        .collect();
    mount_album_list(&server, listed).await;
    mount_album_gone(&server, "al-stale").await;

    let report = AlbumCensusRunner::new(&store, &test_subsonic(&server.uri()), "s1")
        .with_sleep_disabled()
        .run()
        .await
        .unwrap();

    assert_eq!(
        report.albums_removed, 0,
        "nothing was retired, so nothing may be reported as retired"
    );
    assert_eq!(report.stale_projections_dropped, 1);
    assert!(
        report.changed_index(),
        "the album left the browse surfaces, so the UI has to hear about it"
    );
    let left: i64 = store
        .with_conn("misc", |c| {
            c.query_row(
                "SELECT COUNT(*) FROM album_browse_projection WHERE album_id = 'al-stale'",
                [],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(left, 0, "or the same album is probed again on every run");
}

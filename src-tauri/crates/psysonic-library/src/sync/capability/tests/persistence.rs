// ── probe_and_persist round-trip ──────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn probe_and_persist_writes_flags_and_resets_phase_to_idle() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;

    let store = LibraryStore::open_in_memory();
    let result = super::probe_and_persist(
        &store,
        &test_subsonic_client(&server.uri()),
        None,
        None,
        "s1",
        "",
    )
    .await
    .unwrap();

    let sync_state = SyncStateRepository::new(&store);
    let flags = sync_state.get_capability_flags("s1", "").unwrap().unwrap();
    assert_eq!(flags, result.flags.bits());
    assert!(flags & CapabilityFlags::OPEN_SUBSONIC != 0);
    assert!(flags & CapabilityFlags::UNSTABLE_TRACK_IDS != 0);

    // Fresh server ends at `idle` so the caller can transition to
    // `initial_sync` / `ready` based on whether a sync is needed.
    assert_eq!(
        sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("idle")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_and_persist_preserves_ready_phase_on_rebind() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_sync_phase("s1", "", "ready").unwrap();

    super::probe_and_persist(
        &store,
        &test_subsonic_client(&server.uri()),
        None,
        None,
        "s1",
        "",
    )
    .await
    .unwrap();

    assert_eq!(
        sync_state.get_sync_phase("s1", "").unwrap().as_deref(),
        Some("ready")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_probe_and_persist_restores_ready_phase() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 40, "message": "Wrong credentials" }
            }
        })))
        .mount(&server)
        .await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("failed-s1", "").unwrap();
    sync_state.set_sync_phase("failed-s1", "", "ready").unwrap();

    let error = super::probe_and_persist(
        &store,
        &test_subsonic_client(&server.uri()),
        None,
        None,
        "failed-s1",
        "",
    )
    .await
    .unwrap_err();

    assert!(matches!(error, SubsonicError::Api { code: 40, .. }));
    assert_eq!(
        sync_state
            .get_sync_phase("failed-s1", "")
            .unwrap()
            .as_deref(),
        Some("ready")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn overlapping_probe_phase_guards_do_not_serialize_network_or_clobber_sync() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let store = Arc::new(LibraryStore::open_in_memory());
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("overlap-s1", "").unwrap();

    let first_started = Arc::new(tokio::sync::Notify::new());
    let first_release = Arc::new(tokio::sync::Notify::new());
    let first = {
        let store = Arc::clone(&store);
        let started = Arc::clone(&first_started);
        let release = Arc::clone(&first_release);
        tokio::spawn(async move {
            super::with_probing_phase(&store, "overlap-s1", "", async move {
                started.notify_one();
                release.notified().await;
                Ok::<(), SubsonicError>(())
            })
            .await
        })
    };

    first_started.notified().await;
    assert_eq!(
        sync_state
            .get_sync_phase("overlap-s1", "")
            .unwrap()
            .as_deref(),
        Some("probing")
    );

    let second_attempting = Arc::new(tokio::sync::Notify::new());
    let second_started = Arc::new(tokio::sync::Notify::new());
    let second_release = Arc::new(tokio::sync::Notify::new());
    let second = {
        let store = Arc::clone(&store);
        let attempting = Arc::clone(&second_attempting);
        let started = Arc::clone(&second_started);
        let release = Arc::clone(&second_release);
        tokio::spawn(async move {
            attempting.notify_one();
            super::with_probing_phase(&store, "overlap-s1", "", async move {
                started.notify_one();
                release.notified().await;
                Ok::<(), SubsonicError>(())
            })
            .await
        })
    };

    second_attempting.notified().await;
    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        second_started.notified(),
    )
    .await
    .expect("overlapping probes must not hold a process-global network mutex");

    // A sync runner advances the phase while the first bind is deferred.
    // Neither the stale first snapshot nor the queued second bind may leave
    // the row downgraded after both probes finish.
    sync_state
        .set_sync_phase("overlap-s1", "", "initial_sync")
        .unwrap();
    first_release.notify_one();
    second_release.notify_one();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();

    assert_eq!(
        sync_state
            .get_sync_phase("overlap-s1", "")
            .unwrap()
            .as_deref(),
        Some("initial_sync")
    );
}

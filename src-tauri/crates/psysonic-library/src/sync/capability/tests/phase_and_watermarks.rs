#[tokio::test(flavor = "multi_thread")]
async fn probe_and_persist_promotes_idle_to_ready_when_full_sync_stamped() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    sync_state.ensure("s1", "").unwrap();
    sync_state.set_sync_phase("s1", "", "idle").unwrap();
    sync_state
        .set_last_full_sync_at("s1", "", 1_716_000_000_000)
        .unwrap();

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
async fn probe_captures_and_persists_scan_status_track_count() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let server = MockServer::start().await;
    // ping + search3 + getIndexes from the shared helper, then override
    // getScanStatus with a populated `count` (large library).
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "version": "1.16.1", "type": "navidrome" }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
            "searchResult3",
            json!({ "song": [{ "id": "x", "title": "y" }] }),
        )))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
            "scanStatus",
            json!({ "scanning": false, "count": 170_000 }),
        )))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getIndexes.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
            "indexes",
            json!({ "lastModified": 0, "ignoredArticles": "", "index": [] }),
        )))
        .mount(&server)
        .await;

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
    assert_eq!(result.server_track_count, Some(170_000));

    let sync_state = SyncStateRepository::new(&store);
    assert_eq!(
        sync_state.get_server_track_count("s1", "").unwrap(),
        Some(170_000)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_preserves_navidrome_native_bulk_when_no_token_supplied() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    // A prior bind (with a working bearer) already learned N1.
    sync_state
        .set_capability_flags("s1", "", CapabilityFlags::NAVIDROME_NATIVE_BULK)
        .unwrap();

    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;

    // Re-probe without a Navidrome token (transient /auth/login failure).
    // R7-15 Q3: the server still supports /api/song — the flag must stay.
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
    assert!(
        result
            .flags
            .contains(CapabilityFlags::NAVIDROME_NATIVE_BULK),
        "result must keep the previously-learned N1 capability"
    );
    let persisted = sync_state.get_capability_flags("s1", "").unwrap().unwrap();
    assert!(
        persisted & CapabilityFlags::NAVIDROME_NATIVE_BULK != 0,
        "persisted flags must keep N1 across a token-less probe"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_does_not_clobber_track_count_when_scan_status_omits_it() {
    use crate::repos::SyncStateRepository;
    use crate::store::LibraryStore;

    let store = LibraryStore::open_in_memory();
    let sync_state = SyncStateRepository::new(&store);
    // A prior run already learned the count.
    sync_state.set_server_track_count("s1", "", 52_000).unwrap();

    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await; // scanStatus has no count

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
    assert_eq!(result.server_track_count, None);
    // Watermark from the prior run survives the count-less probe.
    assert_eq!(
        sync_state.get_server_track_count("s1", "").unwrap(),
        Some(52_000)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_leaves_navidrome_native_bulk_clear_when_endpoint_404s() {
    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;

    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), Some(&nav), None, None)
        .await
        .unwrap();
    assert!(!result
        .flags
        .contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
}

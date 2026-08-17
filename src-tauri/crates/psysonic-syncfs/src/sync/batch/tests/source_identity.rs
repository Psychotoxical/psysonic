use super::*;

#[test]
fn source_identity_includes_server_type_and_raw_id() {
    let album = DeviceSyncSourcePayload {
        source_type: "album".into(),
        id: "shared".into(),
        name: Some("Album".into()),
        server_index_key: "https://server-a.test".into(),
    };
    let mut playlist = album.clone();
    playlist.source_type = "playlist".into();
    let mut other_server = album.clone();
    other_server.server_index_key = "https://server-b.test".into();

    assert_ne!(
        device_sync_source_key(&album),
        device_sync_source_key(&playlist)
    );
    assert_ne!(
        device_sync_source_key(&album),
        device_sync_source_key(&other_server)
    );
}

#[test]
fn source_owner_must_match_the_captured_auth_owner() {
    let source = DeviceSyncSourcePayload {
        source_type: "album".into(),
        id: "album-1".into(),
        name: Some("Album".into()),
        server_index_key: "server-a.test".into(),
    };

    assert!(
        validate_device_sync_source_owners(std::slice::from_ref(&source), "server-a.test").is_ok()
    );
    assert_eq!(
        validate_device_sync_source_owners(&[source], "server-b.test"),
        Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string()),
    );
}

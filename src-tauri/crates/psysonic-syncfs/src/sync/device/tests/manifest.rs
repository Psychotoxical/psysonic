use super::*;

#[test]
fn manifest_v3_persists_the_server_owner() {
    let dir = tempfile::tempdir().unwrap();
    let owner = "server.test";
    let sources = serde_json::json!([{
        "type": "album",
        "id": "album-1",
        "name": "Album",
        "serverIndexKey": owner,
    }]);

    write_device_manifest(
        dir.path().to_string_lossy().to_string(),
        owner.to_string(),
        sources.clone(),
    )
    .unwrap();

    let manifest = read_device_manifest(dir.path().to_string_lossy().to_string()).unwrap();
    assert_eq!(manifest["version"], 3);
    assert_eq!(manifest["ownerServerIndexKey"], owner);
    assert_eq!(manifest["sources"], sources);
}

#[test]
fn manifest_rejects_sources_from_another_server() {
    let dir = tempfile::tempdir().unwrap();
    let result = write_device_manifest(
        dir.path().to_string_lossy().to_string(),
        "server-a.test".to_string(),
        serde_json::json!([{
            "type": "album",
            "id": "album-1",
            "name": "Album",
            "serverIndexKey": "server-b.test",
        }]),
    );

    assert_eq!(result, Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string()));
}

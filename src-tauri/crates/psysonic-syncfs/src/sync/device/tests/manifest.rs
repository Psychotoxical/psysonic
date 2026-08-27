use super::*;

static MANIFEST_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn manifest_v3_persists_the_server_owner() {
    let _test_guard = MANIFEST_TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let owner = "server.test";
    let sources = serde_json::json!([{
        "type": "album",
        "id": "album-1",
        "name": "Album",
        "serverIndexKey": owner,
    }]);

    write_device_manifest_for_migration(
        dir.path().to_string_lossy().to_string(),
        owner.to_string(),
        sources.clone(),
        Some(1),
    )
    .unwrap();

    let manifest = read_device_manifest(dir.path().to_string_lossy().to_string()).unwrap();
    assert_eq!(manifest["version"], 3);
    assert_eq!(manifest["ownerServerIndexKey"], owner);
    assert_eq!(manifest["sources"], sources);
    assert_eq!(manifest["canonicalIdVersion"], 1);
}

#[tokio::test]
async fn manifest_rejects_sources_from_another_server() {
    let _test_guard = MANIFEST_TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let result = write_device_manifest_for_migration(
        dir.path().to_string_lossy().to_string(),
        "server-a.test".to_string(),
        serde_json::json!([{
            "type": "album",
            "id": "album-1",
            "name": "Album",
            "serverIndexKey": "server-b.test",
        }]),
        None,
    );

    assert_eq!(result, Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string()));
}

#[tokio::test]
async fn ordinary_manifest_write_rejects_a_host_directory() {
    let _test_guard = MANIFEST_TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let result = write_device_manifest(
        dir.path().to_string_lossy().to_string(),
        "server.test".to_string(),
        serde_json::json!([]),
        Some(1),
    )
    .await;

    assert_eq!(result, Err("NOT_MOUNTED_VOLUME".to_string()));
    assert!(!dir.path().join("psysonic-sync.json").exists());
}

#[test]
fn mount_containment_requires_a_path_component_boundary() {
    assert!(path_is_within_mount(
        std::path::Path::new("/media/usb/Music"),
        std::path::Path::new("/media/usb"),
    ));
    assert!(!path_is_within_mount(
        std::path::Path::new("/media/usb-backup"),
        std::path::Path::new("/media/usb"),
    ));
}

#[tokio::test]
async fn manifest_write_is_rejected_while_migration_is_active() {
    let _test_guard = MANIFEST_TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    crate::activate_filesystem_migration_generation(8_001)
        .await
        .unwrap();

    let result = write_device_manifest(
        dir.path().to_string_lossy().to_string(),
        "server.test".to_string(),
        serde_json::json!([{
            "type": "album",
            "id": "album-1",
            "name": "Album",
            "serverIndexKey": "server.test",
        }]),
        Some(1),
    )
    .await;
    crate::deactivate_filesystem_migration_generation(8_001).unwrap();

    assert!(result.unwrap_err().contains("migration generation 8001"));
    assert!(!dir.path().join("psysonic-sync.json").exists());
}

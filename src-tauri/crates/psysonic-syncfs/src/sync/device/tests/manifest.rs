use super::*;

static MANIFEST_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn manifest_v4_persists_the_server_owner_and_layout() {
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
    assert_eq!(manifest["version"], 4);
    assert_eq!(manifest["schema"], "fixed-v2");
    assert_eq!(manifest["ownerServerIndexKey"], owner);
    assert_eq!(manifest["sources"], sources);
    assert_eq!(manifest["canonicalIdVersion"], 1);
    assert_eq!(manifest["layoutMode"], "self-contained");
    assert_eq!(manifest["playlistPathMode"], "playlist-relative");
    assert!(manifest.get("files").is_none());
    assert!(manifest.get("playlists").is_none());
}

#[test]
fn manifest_v4_persists_the_materialized_shared_file_plan() {
    let dir = tempfile::tempdir().unwrap();
    let owner = "server.test";
    let sources = serde_json::json!([{
        "type": "playlist",
        "id": "playlist-1",
        "name": "Mix",
        "serverIndexKey": owner,
    }]);
    let files = serde_json::json!([{
        "trackId": "track-1",
        "relativePath": "Artist/Album/01 - Song.flac",
        "sourceKeys": [serde_json::to_string(&(owner, "playlist", "playlist-1")).unwrap()],
        "sizeBytes": 100,
    }]);
    let playlists = serde_json::json!([{
        "sourceKey": serde_json::to_string(&(owner, "playlist", "playlist-1")).unwrap(),
        "relativePath": "Playlists/Mix/Mix.m3u8",
    }]);

    write_device_manifest_payload(DeviceManifestWrite {
        dest_dir: dir.path().to_string_lossy().to_string(),
        owner_server_index_key: owner.to_string(),
        sources,
        canonical_id_version: Some(1),
        layout_mode: Some("shared-album-tree".to_string()),
        playlist_path_mode: Some("device-rooted".to_string()),
        files: Some(files.clone()),
        playlists: Some(playlists.clone()),
    })
    .unwrap();

    let manifest = read_device_manifest(dir.path().to_string_lossy().to_string()).unwrap();
    assert_eq!(manifest["layoutMode"], "shared-album-tree");
    assert_eq!(manifest["playlistPathMode"], "device-rooted");
    assert_eq!(manifest["files"], files);
    assert_eq!(manifest["playlists"], playlists);
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
        None,
        None,
        None,
        None,
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
        None,
        None,
        None,
        None,
    )
    .await;
    crate::deactivate_filesystem_migration_generation(8_001).unwrap();

    assert!(result.unwrap_err().contains("migration generation 8001"));
    assert!(!dir.path().join("psysonic-sync.json").exists());
}

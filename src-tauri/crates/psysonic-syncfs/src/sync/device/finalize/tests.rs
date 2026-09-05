use super::*;
use crate::sync::batch::{plan::prepare_device_sync_plan, SyncDeltaResult};

fn track() -> TrackSyncInfo {
    TrackSyncInfo {
        id: "track-1".to_string(),
        url: String::new(),
        suffix: "flac".to_string(),
        artist: "Artist".to_string(),
        album_artist: "Artist".to_string(),
        album: "Album".to_string(),
        title: "Song".to_string(),
        track_number: Some(1),
        duration: Some(60),
        playlist_name: None,
        playlist_id: None,
        playlist_index: None,
    }
}

fn payload(
    root: &Path,
    server_index_key: &str,
    delete_paths: Vec<String>,
) -> DeviceSyncFinalizePayload {
    let source_key = serde_json::to_string(&(server_index_key, "playlist", "playlist-1")).unwrap();
    let files = vec![DeviceSyncManifestFile {
        track_id: "track-1".to_string(),
        relative_path: "Artist/Album/01 - Song.flac".to_string(),
        source_keys: vec![source_key.clone()],
        size_bytes: 4,
    }];
    let manifest_playlists = vec![DeviceSyncManifestPlaylist {
        source_key: source_key.clone(),
        relative_path: "Playlists/Mix/Mix.m3u8".to_string(),
    }];
    let playlists = vec![DeviceSyncFinalizePlaylist {
        name: "Mix".to_string(),
        path_id: None,
        tracks: vec![track()],
        references: vec!["/Artist/Album/01 - Song.flac".to_string()],
    }];
    let planned_playlists = vec![crate::sync::batch::DeviceSyncPlannedPlaylist {
        source_key: source_key.clone(),
        name: "Mix".to_string(),
        path_id: None,
        relative_path: "Playlists/Mix/Mix.m3u8".to_string(),
        tracks: vec![serde_json::json!({ "id": "track-1" })],
        references: vec!["/Artist/Album/01 - Song.flac".to_string()],
    }];
    let mut result = SyncDeltaResult {
        plan_id: String::new(),
        device_id: "device-1".to_string(),
        add_bytes: 0,
        add_count: 0,
        del_bytes: 0,
        del_count: delete_paths.len() as u32,
        reclaimable_bytes: 0,
        available_bytes: 0,
        tracks: Vec::new(),
        delete_paths: delete_paths.clone(),
        deferred_delete_paths: Vec::new(),
        playlists: planned_playlists,
        manifest_files: files.clone(),
        manifest_playlists: manifest_playlists.clone(),
    };
    prepare_device_sync_plan(
        root,
        "device-1",
        "owner.test",
        vec![source_key],
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::DeviceRooted,
        &mut result,
        None,
    )
    .unwrap();
    DeviceSyncFinalizePayload {
        plan_id: result.plan_id,
        expected_device_id: "device-1".to_string(),
        owner_server_index_key: "owner.test".to_string(),
        sources: vec![DeviceSyncFinalizeSource {
            source_type: "playlist".to_string(),
            id: "playlist-1".to_string(),
            name: "Mix".to_string(),
            path_id: None,
            server_index_key: server_index_key.to_string(),
            artist: None,
        }],
        canonical_id_version: None,
        layout_mode: "shared-album-tree".to_string(),
        playlist_path_mode: "device-rooted".to_string(),
        files,
        manifest_playlists,
        playlists,
        deferred_delete_paths: delete_paths,
    }
}

#[test]
fn missing_replacement_keeps_old_file_and_manifest() {
    let root = tempfile::tempdir().unwrap();
    let old_track = root.path().join("Playlists/Mix/01 - Old.flac");
    std::fs::create_dir_all(old_track.parent().unwrap()).unwrap();
    std::fs::write(&old_track, b"old track").unwrap();
    let payload = payload(
        root.path(),
        "owner.test",
        vec![old_track.to_string_lossy().to_string()],
    );

    let error =
        finalize_device_sync_with_validator(root.path(), payload, |_, _| Ok(())).unwrap_err();

    assert!(error.starts_with("DEVICE_SYNC_REPLACEMENT_MISSING:"));
    assert!(old_track.exists());
    assert!(!root.path().join("psysonic-sync.json").exists());
}

#[test]
fn successful_manifest_commit_removes_only_planned_old_files() {
    let root = tempfile::tempdir().unwrap();
    let old_track = root.path().join("Playlists/Mix/01 - Old.flac");
    let new_track = root.path().join("Artist/Album/01 - Song.flac");
    let unrelated = root.path().join("DCIM/photo.jpg");
    std::fs::create_dir_all(old_track.parent().unwrap()).unwrap();
    std::fs::create_dir_all(new_track.parent().unwrap()).unwrap();
    std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
    std::fs::write(&old_track, b"old track").unwrap();
    std::fs::write(&new_track, b"new track").unwrap();
    std::fs::write(&unrelated, b"photo").unwrap();
    let payload = payload(
        root.path(),
        "owner.test",
        vec![old_track.to_string_lossy().to_string()],
    );

    let result = finalize_device_sync_with_validator(root.path(), payload, |_, _| Ok(())).unwrap();

    assert_eq!(result.deleted, 1);
    assert!(!result.cleanup_failed);
    assert!(!old_track.exists());
    assert!(new_track.exists());
    assert!(unrelated.exists());
    assert!(root.path().join("psysonic-sync.json").exists());
    assert!(!root.path().join(".psysonic-sync-plan.json").exists());
}

#[test]
fn finalizer_rejects_a_delete_path_not_issued_by_the_plan() {
    let root = tempfile::tempdir().unwrap();
    let new_track = root.path().join("Artist/Album/01 - Song.flac");
    let unrelated = root.path().join("DCIM/photo.jpg");
    std::fs::create_dir_all(new_track.parent().unwrap()).unwrap();
    std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
    std::fs::write(&new_track, b"new track").unwrap();
    std::fs::write(&unrelated, b"photo").unwrap();
    let mut payload = payload(root.path(), "owner.test", Vec::new());
    payload
        .deferred_delete_paths
        .push(unrelated.to_string_lossy().to_string());

    assert_eq!(
        finalize_device_sync_with_validator(root.path(), payload, |_, _| Ok(())).unwrap_err(),
        "DEVICE_SYNC_PENDING_PLAN_MISMATCH"
    );
    assert!(unrelated.exists());
}

#[cfg(unix)]
#[test]
fn finalizer_rejects_an_in_root_directory_symlink() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let private = root.path().join("Private/Album");
    std::fs::create_dir_all(&private).unwrap();
    std::fs::write(private.join("01 - Song.flac"), b"private").unwrap();
    symlink(root.path().join("Private"), root.path().join("Artist")).unwrap();
    let payload = payload(root.path(), "owner.test", Vec::new());

    assert_eq!(
        finalize_device_sync_with_validator(root.path(), payload, |_, _| Ok(())).unwrap_err(),
        "DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT"
    );
}

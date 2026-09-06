use super::super::payload::device_sync_source_key;
use super::super::planner::{
    build_sync_plan, build_sync_plan_with_resume, FetchedDeviceSyncSource,
};
use super::super::{
    DeviceSyncLayoutMode, DeviceSyncManifestFile, DeviceSyncManifestPlaylist,
    DeviceSyncPlaylistPathMode, DeviceSyncSourcePayload,
};

fn source(source_type: &str, id: &str, name: &str) -> DeviceSyncSourcePayload {
    DeviceSyncSourcePayload {
        source_type: source_type.to_string(),
        id: id.to_string(),
        name: Some(name.to_string()),
        path_id: None,
        server_index_key: "server.test".to_string(),
    }
}

fn track(id: &str, title: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "artist": "Artist",
        "albumArtist": "Album Artist",
        "album": "Album",
        "title": title,
        "track": 1,
        "suffix": "flac",
        "size": 100,
    })
}

fn write_manifest(
    device: &tempfile::TempDir,
    sources: &[DeviceSyncSourcePayload],
    layout_mode: DeviceSyncLayoutMode,
    files: &[DeviceSyncManifestFile],
    playlists: &[DeviceSyncManifestPlaylist],
) {
    let source_values = sources
        .iter()
        .map(|source| {
            serde_json::json!({
                "type": source.source_type,
                "id": source.id,
                "name": source.name,
                "pathId": source.path_id,
                "serverIndexKey": source.server_index_key,
            })
        })
        .collect::<Vec<_>>();
    std::fs::write(
        device.path().join("psysonic-sync.json"),
        serde_json::to_vec(&serde_json::json!({
            "version": 4,
            "schema": "fixed-v2",
            "ownerServerIndexKey": "server.test",
            "sources": source_values,
            "layoutMode": layout_mode,
            "playlistPathMode": "playlist-relative",
            "files": files,
            "playlists": playlists,
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn shared_layout_keeps_playlist_order_but_plans_one_physical_file() {
    let device = tempfile::tempdir().unwrap();
    let fetched = vec![FetchedDeviceSyncSource {
        source: source("playlist", "playlist-1", "Mix"),
        tracks: vec![track("track-1", "Song"), track("track-1", "Song")],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::DeviceRooted,
    )
    .unwrap();

    assert_eq!(plan.add_count, 1);
    assert_eq!(plan.manifest_files.len(), 1);
    assert_eq!(plan.playlists[0].tracks.len(), 2);
    assert_eq!(plan.playlists[0].references.len(), 2);
    assert_eq!(
        plan.playlists[0].references[0],
        "/Album Artist/Album/01 - Song.flac"
    );
    assert_eq!(
        plan.playlists[0].references[0],
        plan.playlists[0].references[1]
    );
}

#[test]
fn shared_layout_deduplicates_album_artist_and_playlist_sources() {
    let device = tempfile::tempdir().unwrap();
    let shared = track("track-1", "Song");
    let fetched = vec![
        FetchedDeviceSyncSource {
            source: source("album", "album-1", "Album"),
            tracks: vec![shared.clone()],
        },
        FetchedDeviceSyncSource {
            source: source("artist", "artist-1", "Artist"),
            tracks: vec![shared.clone()],
        },
        FetchedDeviceSyncSource {
            source: source("playlist", "playlist-1", "Mix"),
            tracks: vec![shared],
        },
    ];

    let plan = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert_eq!(plan.add_count, 1);
    assert_eq!(plan.add_bytes, 100);
    assert_eq!(plan.manifest_files[0].source_keys.len(), 3);
    assert_eq!(
        plan.playlists[0].references,
        vec!["../../Album Artist/Album/01 - Song.flac"]
    );
}

#[test]
fn shared_file_survives_removing_one_of_its_sources() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let playlist = source("playlist", "playlist-1", "Mix");
    let album_key = device_sync_source_key(&album);
    let playlist_key = device_sync_source_key(&playlist);
    let relative_path = "Album Artist/Album/01 - Song.flac";
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::write(device.path().join(relative_path), b"track").unwrap();
    write_manifest(
        &device,
        &[album.clone(), playlist.clone()],
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "track-1".to_string(),
            relative_path: relative_path.to_string(),
            source_keys: vec![album_key.clone(), playlist_key.clone()],
            size_bytes: 100,
        }],
        &[DeviceSyncManifestPlaylist {
            source_key: playlist_key.clone(),
            relative_path: "Playlists/Mix/Mix.m3u8".to_string(),
        }],
    );
    let shared = track("track-1", "Song");
    let fetched = vec![
        FetchedDeviceSyncSource {
            source: album,
            tracks: vec![shared.clone()],
        },
        FetchedDeviceSyncSource {
            source: playlist,
            tracks: vec![shared],
        },
    ];

    let plan = build_sync_plan(
        &fetched,
        &[album_key],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert!(plan.delete_paths.is_empty());
    assert!(plan.deferred_delete_paths.is_empty());
    assert_eq!(plan.manifest_files[0].source_keys, vec![playlist_key]);
}

#[test]
fn shared_file_survives_playlist_membership_change() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let playlist = source("playlist", "playlist-1", "Mix");
    let album_key = device_sync_source_key(&album);
    let playlist_key = device_sync_source_key(&playlist);
    let relative_path = "Album Artist/Album/01 - Song.flac";
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::write(device.path().join(relative_path), b"track").unwrap();
    write_manifest(
        &device,
        &[album.clone(), playlist.clone()],
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "track-1".to_string(),
            relative_path: relative_path.to_string(),
            source_keys: vec![album_key.clone(), playlist_key],
            size_bytes: 100,
        }],
        &[],
    );
    let fetched = vec![
        FetchedDeviceSyncSource {
            source: album,
            tracks: vec![track("track-1", "Song")],
        },
        FetchedDeviceSyncSource {
            source: playlist,
            tracks: Vec::new(),
        },
    ];

    let plan = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert_eq!(plan.add_count, 0);
    assert!(plan.delete_paths.is_empty());
    assert_eq!(plan.manifest_files[0].source_keys, vec![album_key]);
}

#[test]
fn self_contained_to_shared_migration_defers_the_only_existing_copy() {
    let device = tempfile::tempdir().unwrap();
    let playlist = source("playlist", "playlist-1", "Mix");
    let playlist_key = device_sync_source_key(&playlist);
    let old_path = "Playlists/Mix/01 - Artist - Song.flac";
    std::fs::create_dir_all(device.path().join("Playlists/Mix")).unwrap();
    std::fs::write(device.path().join(old_path), b"track").unwrap();
    write_manifest(
        &device,
        std::slice::from_ref(&playlist),
        DeviceSyncLayoutMode::SelfContained,
        &[DeviceSyncManifestFile {
            track_id: "track-1".to_string(),
            relative_path: old_path.to_string(),
            source_keys: vec![playlist_key.clone()],
            size_bytes: 100,
        }],
        &[DeviceSyncManifestPlaylist {
            source_key: playlist_key,
            relative_path: "Playlists/Mix/Mix.m3u8".to_string(),
        }],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: playlist,
        tracks: vec![track("track-1", "Song")],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert_eq!(plan.add_count, 1);
    assert!(plan.delete_paths.is_empty());
    assert_eq!(
        plan.deferred_delete_paths,
        vec![device.path().join(old_path).to_string_lossy().to_string()]
    );
    assert_eq!(plan.reclaimable_bytes, 0);
}

#[test]
fn active_plan_resumes_a_downloaded_file_not_yet_in_the_manifest() {
    let device = tempfile::tempdir().unwrap();
    let playlist = source("playlist", "playlist-1", "Mix");
    let playlist_key = device_sync_source_key(&playlist);
    let old_path = "Playlists/Mix/01 - Artist - Song.flac";
    let new_path = "Album Artist/Album/01 - Song.flac";
    std::fs::create_dir_all(device.path().join("Playlists/Mix")).unwrap();
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::write(device.path().join(old_path), b"track").unwrap();
    std::fs::write(device.path().join(new_path), b"track").unwrap();
    write_manifest(
        &device,
        std::slice::from_ref(&playlist),
        DeviceSyncLayoutMode::SelfContained,
        &[DeviceSyncManifestFile {
            track_id: "track-1".to_string(),
            relative_path: old_path.to_string(),
            source_keys: vec![playlist_key.clone()],
            size_bytes: 100,
        }],
        &[],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: playlist,
        tracks: vec![track("track-1", "Song")],
    }];
    let resume_files = vec![DeviceSyncManifestFile {
        track_id: "track-1".to_string(),
        relative_path: new_path.to_string(),
        source_keys: vec![playlist_key],
        size_bytes: 100,
    }];

    let plan = build_sync_plan_with_resume(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::DeviceRooted,
        Some(&resume_files),
    )
    .unwrap();

    assert_eq!(plan.add_count, 0);
    assert_eq!(
        plan.delete_paths,
        vec![device.path().join(old_path).to_string_lossy().to_string()]
    );
}

#[test]
fn removing_the_final_playlist_deletes_its_track_and_m3u() {
    let device = tempfile::tempdir().unwrap();
    let playlist = source("playlist", "playlist-1", "Mix");
    let playlist_key = device_sync_source_key(&playlist);
    let track_path = "Album Artist/Album/01 - Song.flac";
    let playlist_path = "Playlists/Mix/Mix.m3u8";
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::create_dir_all(device.path().join("Playlists/Mix")).unwrap();
    std::fs::write(device.path().join(track_path), b"track").unwrap();
    std::fs::write(device.path().join(playlist_path), b"#EXTM3U\n").unwrap();
    write_manifest(
        &device,
        std::slice::from_ref(&playlist),
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "track-1".to_string(),
            relative_path: track_path.to_string(),
            source_keys: vec![playlist_key.clone()],
            size_bytes: 100,
        }],
        &[DeviceSyncManifestPlaylist {
            source_key: playlist_key.clone(),
            relative_path: playlist_path.to_string(),
        }],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: playlist,
        tracks: vec![track("track-1", "Song")],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[playlist_key],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert_eq!(plan.del_count, 2);
    assert!(plan
        .delete_paths
        .contains(&device.path().join(track_path).to_string_lossy().to_string()));
    assert!(plan.delete_paths.contains(
        &device
            .path()
            .join(playlist_path)
            .to_string_lossy()
            .to_string()
    ));
    assert!(plan.manifest_files.is_empty());
    assert!(plan.manifest_playlists.is_empty());
}

#[test]
fn removing_a_legacy_source_derives_and_deletes_its_owned_files() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let album_key = device_sync_source_key(&album);
    let track_path = "Album Artist/Album/01 - Song.flac";
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::write(device.path().join(track_path), b"track").unwrap();
    std::fs::write(
        device.path().join("psysonic-sync.json"),
        serde_json::to_vec(&serde_json::json!({
            "version": 3,
            "schema": "fixed-v1",
            "ownerServerIndexKey": "server.test",
            "sources": [{
                "type": "album",
                "id": "album-1",
                "name": "Album",
                "serverIndexKey": "server.test",
            }],
        }))
        .unwrap(),
    )
    .unwrap();
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![track("track-1", "Song")],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[album_key],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert_eq!(
        plan.delete_paths,
        vec![device.path().join(track_path).to_string_lossy().to_string()]
    );
}

#[test]
fn manifest_cannot_nominate_an_unrelated_device_file_for_deletion() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let album_key = device_sync_source_key(&album);
    let unrelated_path = "Private/Documents/keep-me.txt";
    std::fs::create_dir_all(device.path().join("Private/Documents")).unwrap();
    std::fs::write(device.path().join(unrelated_path), b"private").unwrap();
    write_manifest(
        &device,
        std::slice::from_ref(&album),
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "track-1".to_string(),
            relative_path: unrelated_path.to_string(),
            source_keys: vec![album_key.clone()],
            size_bytes: 7,
        }],
        &[],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![track("track-1", "Song")],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[album_key],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert!(plan.delete_paths.is_empty());
    assert!(device.path().join(unrelated_path).exists());
}

#[test]
fn v4_manifest_does_not_delete_a_track_that_can_no_longer_be_derived() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let album_key = device_sync_source_key(&album);
    let old_path = "Album Artist/Album/01 - Removed.flac";
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::write(device.path().join(old_path), b"old").unwrap();
    write_manifest(
        &device,
        std::slice::from_ref(&album),
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "removed-track".to_string(),
            relative_path: old_path.to_string(),
            source_keys: vec![album_key],
            size_bytes: 3,
        }],
        &[],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert!(plan.delete_paths.is_empty());
    assert!(device.path().join(old_path).exists());
    assert_eq!(plan.manifest_files.len(), 1);
    assert_eq!(plan.manifest_files[0].track_id, "removed-track");
    assert_eq!(plan.manifest_files[0].relative_path, old_path);
}

#[test]
fn v4_manifest_drops_missing_unverifiable_ownership_from_the_replacement() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let album_key = device_sync_source_key(&album);
    let old_path = "Album Artist/Album/01 - Missing.flac";
    write_manifest(
        &device,
        std::slice::from_ref(&album),
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "missing-track".to_string(),
            relative_path: old_path.to_string(),
            source_keys: vec![album_key],
            size_bytes: 3,
        }],
        &[],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![],
    }];

    let plan = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )
    .unwrap();

    assert!(plan.delete_paths.is_empty());
    assert!(plan.manifest_files.is_empty());
}

#[test]
fn planner_rejects_a_different_track_at_an_owned_existing_path() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let album_key = device_sync_source_key(&album);
    let path = "Album Artist/Album/01 - Song.flac";
    std::fs::create_dir_all(device.path().join("Album Artist/Album")).unwrap();
    std::fs::write(device.path().join(path), b"old").unwrap();
    write_manifest(
        &device,
        std::slice::from_ref(&album),
        DeviceSyncLayoutMode::SharedAlbumTree,
        &[DeviceSyncManifestFile {
            track_id: "old-track".to_string(),
            relative_path: path.to_string(),
            source_keys: vec![album_key],
            size_bytes: 3,
        }],
        &[],
    );
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![track("new-track", "Song")],
    }];

    let result = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    );

    assert!(matches!(
        result,
        Err(error) if error.starts_with("DEVICE_SYNC_PATH_IDENTITY_COLLISION:")
    ));
}

#[test]
fn planner_rejects_case_insensitive_path_collisions() {
    let device = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    let upper = track("track-1", "Song");
    let mut lower = track("track-2", "Song");
    lower["albumArtist"] = serde_json::json!("album artist");
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![upper, lower],
    }];

    let result = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    );

    assert!(matches!(
        result,
        Err(error) if error.starts_with("DEVICE_SYNC_PATH_COLLISION:")
    ));
}

#[cfg(unix)]
#[test]
fn planner_rejects_an_existing_track_path_behind_a_symlink() {
    use std::os::unix::fs::symlink;

    let device = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    symlink(outside.path(), device.path().join("Album Artist")).unwrap();
    std::fs::create_dir_all(outside.path().join("Album")).unwrap();
    std::fs::write(outside.path().join("Album/01 - Song.flac"), b"track").unwrap();
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![track("track-1", "Song")],
    }];

    let result = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    );

    assert!(matches!(
        result,
        Err(error) if error == "DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT"
    ));
}

#[cfg(unix)]
#[test]
fn planner_rejects_a_missing_track_path_behind_a_symlink() {
    use std::os::unix::fs::symlink;

    let device = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let album = source("album", "album-1", "Album");
    symlink(outside.path(), device.path().join("Album Artist")).unwrap();
    let fetched = vec![FetchedDeviceSyncSource {
        source: album,
        tracks: vec![track("track-1", "Song")],
    }];

    let result = build_sync_plan(
        &fetched,
        &[],
        device.path().to_str().unwrap(),
        DeviceSyncLayoutMode::SharedAlbumTree,
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    );

    assert!(matches!(
        result,
        Err(error) if error == "DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT"
    ));
}

use std::sync::Arc;

use tauri::Manager;

use super::{
    estimate_track_size_bytes, fetch_subsonic_songs, inject_playlist_context,
    track_sync_info_from_subsonic_json, DeviceSyncSourcePayload, SubsonicAuthPayload,
    SyncDeltaResult,
};
use crate::file_transfer::{apply_server_http_get, subsonic_http_client};
use crate::sync::device::{build_track_path, get_removable_drives};

pub(super) fn device_sync_source_key(source: &DeviceSyncSourcePayload) -> String {
    serde_json::to_string(&(&source.server_index_key, &source.source_type, &source.id))
        .unwrap_or_default()
}

pub(super) fn validate_device_sync_source_owners(
    sources: &[DeviceSyncSourcePayload],
    owner_server_index_key: &str,
) -> Result<(), String> {
    if sources
        .iter()
        .any(|source| source.server_index_key != owner_server_index_key)
    {
        return Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string());
    }
    Ok(())
}

pub(super) async fn calculate_sync_payload_impl(
    sources: Vec<DeviceSyncSourcePayload>,
    deletion_ids: Vec<String>,
    auth: SubsonicAuthPayload,
    target_dir: String,
    app: tauri::AppHandle,
) -> Result<SyncDeltaResult, String> {
    validate_device_sync_source_owners(&sources, &auth.server_index_key)?;
    let client = subsonic_http_client(std::time::Duration::from_secs(30))?;
    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));

    let mut add_bytes = 0;
    let mut add_count = 0;
    let mut del_bytes = 0;
    let mut del_count = 0;

    let mut sync_tracks = Vec::new();
    let (mut del_sources, mut add_sources) = (Vec::new(), Vec::new());
    for source in sources {
        if deletion_ids.contains(&device_sync_source_key(&source)) {
            del_sources.push(source);
        } else {
            add_sources.push(source);
        }
    }

    let mut handles: Vec<(
        DeviceSyncSourcePayload,
        tokio::task::JoinHandle<Vec<serde_json::Value>>,
    )> = Vec::new();
    for source in add_sources {
        let auth_clone = auth.clone();
        let cli = client.clone();
        let reg_for_task = http_registry.clone();
        let source_snapshot = source.clone();
        let handle = tokio::spawn(async move {
            let registry = reg_for_task.as_deref();
            let mut res_tracks = Vec::new();
            if source.source_type == "album" {
                if let Ok(tracks) =
                    fetch_subsonic_songs(&cli, registry, &auth_clone, "getAlbum.view", &source.id)
                        .await
                {
                    res_tracks.extend(tracks);
                }
            } else if source.source_type == "playlist" {
                if let Ok(tracks) = fetch_subsonic_songs(
                    &cli,
                    registry,
                    &auth_clone,
                    "getPlaylist.view",
                    &source.id,
                )
                .await
                {
                    res_tracks.extend(tracks);
                }
            } else if source.source_type == "artist" {
                let url = format!("{}/getArtist.view", auth_clone.base_url);
                let query = vec![
                    ("u", auth_clone.u.as_str()),
                    ("t", auth_clone.t.as_str()),
                    ("s", auth_clone.s.as_str()),
                    ("v", auth_clone.v.as_str()),
                    ("c", auth_clone.c.as_str()),
                    ("f", auth_clone.f.as_str()),
                    ("id", &source.id),
                ];
                if let Ok(response) =
                    apply_server_http_get(&cli, registry, Some(&auth_clone.server_id), &url)
                        .query(&query)
                        .send()
                        .await
                {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        if let Some(root) = json
                            .get("subsonic-response")
                            .and_then(|response| response.get("artist"))
                            .and_then(|artist| artist.get("album"))
                        {
                            let albums = root.as_array().cloned().unwrap_or_else(|| {
                                root.as_object()
                                    .map(|album| vec![serde_json::Value::Object(album.clone())])
                                    .unwrap_or_default()
                            });
                            for album in albums {
                                if let Some(album_id) = album.get("id").and_then(|id| id.as_str()) {
                                    if let Ok(tracks) = fetch_subsonic_songs(
                                        &cli,
                                        registry,
                                        &auth_clone,
                                        "getAlbum.view",
                                        album_id,
                                    )
                                    .await
                                    {
                                        res_tracks.extend(tracks);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            res_tracks
        });
        handles.push((source_snapshot, handle));
    }

    let mut del_handles = Vec::new();
    for source in del_sources {
        let auth_clone = auth.clone();
        let cli = client.clone();
        let reg_for_task = http_registry.clone();
        del_handles.push(tokio::spawn(async move {
            let registry = reg_for_task.as_deref();
            let mut res_tracks = Vec::new();
            if source.source_type == "album" {
                if let Ok(tracks) =
                    fetch_subsonic_songs(&cli, registry, &auth_clone, "getAlbum.view", &source.id)
                        .await
                {
                    res_tracks.extend(tracks);
                }
            } else if source.source_type == "playlist" {
                if let Ok(tracks) = fetch_subsonic_songs(
                    &cli,
                    registry,
                    &auth_clone,
                    "getPlaylist.view",
                    &source.id,
                )
                .await
                {
                    res_tracks.extend(tracks);
                }
            }
            res_tracks
        }));
    }

    // Dedup key is (source_id, track_id) rather than just track_id — a track
    // appearing in both an album and a playlist needs to end up on the device
    // in both locations (album tree + playlist folder).
    let mut seen_by_source: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for (source, handle) in handles {
        if let Ok(tracks) = handle.await {
            let is_playlist = source.source_type == "playlist";
            let mut playlist_position: u32 = 0;
            for track in tracks {
                if let Some(track_id) = track.get("id").and_then(|id| id.as_str()) {
                    let key = (device_sync_source_key(&source), track_id.to_string());
                    if seen_by_source.contains(&key) {
                        continue;
                    }
                    seen_by_source.insert(key);
                    if is_playlist {
                        playlist_position += 1;
                    }
                    let playlist_name = if is_playlist {
                        source.name.clone()
                    } else {
                        None
                    };
                    let playlist_index = if is_playlist {
                        Some(playlist_position)
                    } else {
                        None
                    };

                    let sync_info = track_sync_info_from_subsonic_json(
                        &track,
                        track_id,
                        playlist_name.as_deref(),
                        playlist_index,
                    );
                    let already_exists = {
                        let relative = build_track_path(&sync_info);
                        let file_name = format!("{}.{}", relative, sync_info.suffix);
                        std::path::Path::new(&target_dir).join(&file_name).exists()
                    };
                    if !already_exists {
                        add_count += 1;
                        add_bytes += estimate_track_size_bytes(&track);
                        let mut track_with_ctx = track.clone();
                        inject_playlist_context(
                            &mut track_with_ctx,
                            playlist_name.as_deref(),
                            playlist_index,
                        );
                        sync_tracks.push(track_with_ctx);
                    }
                }
            }
        }
    }

    for handle in del_handles {
        if let Ok(tracks) = handle.await {
            for track in tracks {
                del_count += 1;
                del_bytes += estimate_track_size_bytes(&track);
            }
        }
    }

    let mut available_bytes = 0;
    for drive in get_removable_drives() {
        if target_dir.starts_with(&drive.mount_point) {
            available_bytes = drive.available_space;
            break;
        }
    }

    Ok(SyncDeltaResult {
        add_bytes,
        add_count,
        del_bytes,
        del_count,
        available_bytes,
        tracks: sync_tracks,
    })
}

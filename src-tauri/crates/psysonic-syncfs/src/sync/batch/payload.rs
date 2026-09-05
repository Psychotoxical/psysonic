use std::sync::Arc;

use tauri::Manager;

use super::{
    fetch_subsonic_songs, subsonic_response_root, DeviceSyncLayoutMode, DeviceSyncPlaylistPathMode,
    DeviceSyncSourcePayload, SubsonicAuthPayload, SyncDeltaResult,
};

type SourceFetchHandle = (
    DeviceSyncSourcePayload,
    tokio::task::JoinHandle<Result<Vec<serde_json::Value>, String>>,
);
use super::planner::{build_sync_plan, FetchedDeviceSyncSource};
use crate::file_transfer::{apply_server_http_get, subsonic_http_client};
use crate::sync::device::{get_removable_drives, playlist_collision_key};

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

pub(super) fn playlist_collision_source_keys(
    sources: &[DeviceSyncSourcePayload],
) -> std::collections::HashSet<String> {
    let mut name_counts = std::collections::HashMap::new();
    for source in sources {
        if source.source_type == "playlist" {
            *name_counts
                .entry(playlist_collision_key(source.name.as_deref().unwrap_or("")))
                .or_insert(0_u32) += 1;
        }
    }
    sources
        .iter()
        .filter(|source| {
            source.source_type == "playlist"
                && name_counts
                    .get(&playlist_collision_key(
                        source.name.as_deref().unwrap_or(""),
                    ))
                    .copied()
                    .unwrap_or_default()
                    > 1
        })
        .map(device_sync_source_key)
        .collect()
}

pub(super) async fn calculate_sync_payload_impl(
    sources: Vec<DeviceSyncSourcePayload>,
    deletion_ids: Vec<String>,
    auth: SubsonicAuthPayload,
    target_dir: String,
    layout_mode: DeviceSyncLayoutMode,
    playlist_path_mode: DeviceSyncPlaylistPathMode,
    app: tauri::AppHandle,
) -> Result<SyncDeltaResult, String> {
    validate_device_sync_source_owners(&sources, &auth.server_index_key)?;
    let deletion_keys = deletion_ids
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let client = subsonic_http_client(std::time::Duration::from_secs(30))?;
    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));

    let mut handles: Vec<SourceFetchHandle> = Vec::new();
    for source in sources {
        if deletion_keys.contains(&device_sync_source_key(&source)) {
            handles.push((source, tokio::spawn(async { Ok(Vec::new()) })));
            continue;
        }
        let auth_clone = auth.clone();
        let cli = client.clone();
        let reg_for_task = http_registry.clone();
        let source_snapshot = source.clone();
        let handle = tokio::spawn(async move {
            let registry = reg_for_task.as_deref();
            if source.source_type == "album" {
                fetch_subsonic_songs(&cli, registry, &auth_clone, "getAlbum.view", &source.id).await
            } else if source.source_type == "playlist" {
                fetch_subsonic_songs(&cli, registry, &auth_clone, "getPlaylist.view", &source.id)
                    .await
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
                let response =
                    apply_server_http_get(&cli, registry, Some(&auth_clone.server_id), &url)
                        .query(&query)
                        .send()
                        .await
                        .map_err(|error| error.to_string())?;
                if !response.status().is_success() {
                    return Err(format!("HTTP {}", response.status().as_u16()));
                }
                let json = response
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|error| error.to_string())?;
                let root = subsonic_response_root(&json)?
                    .get("artist")
                    .and_then(|artist| artist.get("album"));
                let albums = root
                    .and_then(|value| value.as_array().cloned())
                    .or_else(|| {
                        root.and_then(|value| value.as_object().cloned())
                            .map(|album| vec![serde_json::Value::Object(album)])
                    })
                    .unwrap_or_default();
                let mut tracks = Vec::new();
                for album in albums {
                    if let Some(album_id) = album.get("id").and_then(|id| id.as_str()) {
                        tracks.extend(
                            fetch_subsonic_songs(
                                &cli,
                                registry,
                                &auth_clone,
                                "getAlbum.view",
                                album_id,
                            )
                            .await?,
                        );
                    }
                }
                Ok(tracks)
            } else {
                Err(format!(
                    "DEVICE_SYNC_SOURCE_TYPE_INVALID:{}",
                    source.source_type
                ))
            }
        });
        handles.push((source_snapshot, handle));
    }

    let mut fetched = Vec::with_capacity(handles.len());
    for (source, handle) in handles {
        let tracks = handle
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| {
                format!(
                    "DEVICE_SYNC_SOURCE_FETCH_FAILED:{}:{error}",
                    device_sync_source_key(&source)
                )
            })?;
        fetched.push(FetchedDeviceSyncSource { source, tracks });
    }

    let mut result = build_sync_plan(
        &fetched,
        &deletion_ids,
        &target_dir,
        layout_mode,
        playlist_path_mode,
    )?;

    for drive in get_removable_drives() {
        if target_dir.starts_with(&drive.mount_point) {
            result.available_bytes = drive.available_space;
            break;
        }
    }
    Ok(result)
}

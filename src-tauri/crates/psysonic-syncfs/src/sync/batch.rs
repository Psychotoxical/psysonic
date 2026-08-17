use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::sync_cancel_flags;

use super::device::{
    build_track_path, get_removable_drives, is_path_on_mounted_volume, SyncBatchResult,
    TrackSyncInfo,
};
use crate::file_transfer::{
    apply_server_http_get, finalize_streamed_download, subsonic_http_client,
};

mod filesystem;
mod payload;

pub use filesystem::prune_empty_parents;
use filesystem::{delete_device_file_impl, delete_device_files_impl, list_device_dir_files_impl};
use payload::calculate_sync_payload_impl;
#[cfg(test)]
use payload::{device_sync_source_key, validate_device_sync_source_owners};

#[tauri::command]
#[specta::specta]
pub async fn list_device_dir_files(dir: String) -> Result<Vec<String>, String> {
    list_device_dir_files_impl(dir).await
}

/// Deletes a file from the device and prunes empty parent directories
/// (up to 2 levels: album folder, then artist folder).
#[tauri::command]
#[specta::specta]
pub async fn delete_device_file(path: String) -> Result<(), String> {
    delete_device_file_impl(path).await
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsonicAuthPayload {
    base_url: String,
    u: String,
    t: String,
    s: String,
    v: String,
    c: String,
    f: String,
    server_id: String,
    server_index_key: String,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncSourcePayload {
    #[serde(rename = "type")]
    source_type: String,
    id: String,
    /// Playlist display name — only present for playlist sources, used when
    /// computing the playlist-folder path on the device.
    #[serde(default)]
    name: Option<String>,
    server_index_key: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeltaResult {
    add_bytes: u64,
    add_count: u32,
    del_bytes: u64,
    del_count: u32,
    available_bytes: u64,
    tracks: Vec<serde_json::Value>,
}

pub async fn fetch_subsonic_songs(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    auth: &SubsonicAuthPayload,
    endpoint: &str,
    id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/{}", auth.base_url, endpoint);
    let query = vec![
        ("u", auth.u.as_str()),
        ("t", auth.t.as_str()),
        ("s", auth.s.as_str()),
        ("v", auth.v.as_str()),
        ("c", auth.c.as_str()),
        ("f", auth.f.as_str()),
        ("id", id),
    ];
    let res = apply_server_http_get(client, registry, Some(&auth.server_id), &url)
        .query(&query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    parse_subsonic_songs(&json, endpoint)
}

/// Estimate the byte size of a Subsonic song JSON. Prefer the explicit `size`
/// field; fall back to `duration * 320 kbps / 8` when missing. Returns 0 when
/// neither is present.
pub(crate) fn estimate_track_size_bytes(track: &serde_json::Value) -> u64 {
    track
        .get("size")
        .and_then(|s| s.as_u64())
        .unwrap_or_else(|| {
            track.get("duration").and_then(|d| d.as_u64()).unwrap_or(0) * 320_000 / 8
        })
}

/// Build a [`TrackSyncInfo`] from a Subsonic song JSON object. Optional
/// playlist context attaches `playlist_name` + `playlist_index` so playlist
/// tracks land under the `Playlists/<name>/` tree on the device. The
/// `albumArtist` field falls back to `artist` when missing or whitespace-only.
pub(crate) fn track_sync_info_from_subsonic_json(
    track: &serde_json::Value,
    track_id: &str,
    playlist_name: Option<&str>,
    playlist_index: Option<u32>,
) -> TrackSyncInfo {
    let suffix = track
        .get("suffix")
        .and_then(|s| s.as_str())
        .unwrap_or("mp3");
    let artist_raw = track.get("artist").and_then(|v| v.as_str()).unwrap_or("");
    let album_artist = track
        .get("albumArtist")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(artist_raw);
    TrackSyncInfo {
        id: track_id.to_string(),
        url: String::new(),
        suffix: suffix.to_string(),
        artist: artist_raw.to_string(),
        album_artist: album_artist.to_string(),
        album: track
            .get("album")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        title: track
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        track_number: track
            .get("track")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
        duration: track
            .get("duration")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
        playlist_name: playlist_name.map(|s| s.to_string()),
        playlist_index,
    }
}

/// Attach `_playlistName` / `_playlistIndex` keys to a Subsonic-track JSON so
/// the frontend can re-send the track to `sync_batch_to_device` without
/// re-deriving the playlist context. No-op when both args are `None`.
pub(crate) fn inject_playlist_context(
    track: &mut serde_json::Value,
    playlist_name: Option<&str>,
    playlist_index: Option<u32>,
) {
    if let Some(obj) = track.as_object_mut() {
        if let Some(name) = playlist_name {
            obj.insert(
                "_playlistName".to_string(),
                serde_json::Value::String(name.to_string()),
            );
        }
        if let Some(idx) = playlist_index {
            obj.insert(
                "_playlistIndex".to_string(),
                serde_json::Value::Number(idx.into()),
            );
        }
    }
}

/// Pure response-shape extraction for `getAlbum.view` / `getPlaylist.view` —
/// pulled out of [`fetch_subsonic_songs`] so it can be tested without an HTTP
/// roundtrip. Subsonic returns the song list either as an array (multiple
/// tracks) or as a single object (one track); both shapes are normalised to a
/// `Vec`. Other endpoints return an empty `Vec` rather than an error so the
/// caller can fan out across endpoint types without special-casing.
pub fn parse_subsonic_songs(
    json: &serde_json::Value,
    endpoint: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let root = json
        .get("subsonic-response")
        .ok_or_else(|| "No subsonic-response".to_string())?;
    let songs = if endpoint == "getAlbum.view" {
        root.get("album").and_then(|a| a.get("song"))
    } else if endpoint == "getPlaylist.view" {
        root.get("playlist").and_then(|p| p.get("entry"))
    } else {
        None
    };

    if let Some(arr) = songs.and_then(|s| s.as_array()) {
        return Ok(arr.clone());
    } else if let Some(obj) = songs.and_then(|s| s.as_object()) {
        return Ok(vec![serde_json::Value::Object(obj.clone())]);
    }
    Ok(vec![])
}

#[tauri::command]
pub async fn calculate_sync_payload(
    sources: Vec<DeviceSyncSourcePayload>,
    deletion_ids: Vec<String>,
    auth: SubsonicAuthPayload,
    target_dir: String,
    app: tauri::AppHandle,
) -> Result<SyncDeltaResult, String> {
    calculate_sync_payload_impl(sources, deletion_ids, auth, target_dir, app).await
}

/// Signals a running `sync_batch_to_device` job to stop after its current tracks finish.
#[tauri::command]
#[specta::specta]
pub fn cancel_device_sync(job_id: String, app: tauri::AppHandle) {
    if let Ok(flags) = sync_cancel_flags().lock() {
        if let Some(flag) = flags.get(&job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    let _ = app.emit(
        "device:sync:cancelled",
        serde_json::json!({ "jobId": job_id }),
    );
}

/// Downloads a batch of tracks to a USB/SD device with controlled concurrency.
/// At most 2 parallel writes run simultaneously to prevent I/O choking on USB.
/// Emits throttled `device:sync:progress` events (max once per 500ms) and a
/// final `device:sync:complete` event with the summary.
#[tauri::command]
#[specta::specta]
pub async fn sync_batch_to_device(
    tracks: Vec<TrackSyncInfo>,
    dest_dir: String,
    job_id: String,
    expected_bytes: u64,
    server_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<SyncBatchResult, String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};
    use tokio::sync::Mutex;

    let dest_root = std::path::PathBuf::from(&dest_dir);
    if !dest_root.exists() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    // Safety: verify dest_dir is on an actual mounted volume, not the root FS.
    // This catches the case where a USB drive was unmounted but the empty
    // mount-point directory still exists — writing there fills the root partition.
    if !is_path_on_mounted_volume(&dest_root) {
        return Err("NOT_MOUNTED_VOLUME".to_string());
    }

    // Safety: Ensure target logic hasn't exceeded physical volume capacities securely stopping dead bytes natively.
    let drives = get_removable_drives();
    let dest_canon = dest_root
        .canonicalize()
        .unwrap_or_else(|_| dest_root.clone());
    let dest_str = dest_canon.to_string_lossy();

    for drive in drives {
        if dest_str.starts_with(&drive.mount_point) {
            // Buffer of ~10 MB padding boundary natively mapped
            if expected_bytes > drive.available_space.saturating_sub(10_000_000) {
                return Err("NOT_ENOUGH_SPACE".to_string());
            }
            break;
        }
    }

    // Register a cancellation flag for this job.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut flags) = sync_cancel_flags().lock() {
        flags.insert(job_id.clone(), cancel_flag.clone());
    }

    // Shared reqwest client — reused across all downloads.
    let client = subsonic_http_client(Duration::from_secs(300))?;
    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));

    // Concurrency limiter: max 2 parallel USB writes.
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(2));

    // Counters.
    let done = std::sync::Arc::new(AtomicU32::new(0));
    let skipped = std::sync::Arc::new(AtomicU32::new(0));
    let failed = std::sync::Arc::new(AtomicU32::new(0));

    // Throttled event emission (max once per 500ms).
    let last_emit = std::sync::Arc::new(Mutex::new(Instant::now()));
    let total = tracks.len() as u32;

    let mut handles = Vec::with_capacity(tracks.len());

    for track in tracks {
        let sem = semaphore.clone();
        let cli = client.clone();
        let reg_for_task = http_registry.clone();
        let app2 = app.clone();
        let job = job_id.clone();
        let dest = dest_dir.clone();
        let d = done.clone();
        let s = skipped.clone();
        let f = failed.clone();
        let le = last_emit.clone();
        let cancel = cancel_flag.clone();
        let request_server_id = server_id.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");
            let registry = reg_for_task.as_deref();

            // Bail out if cancelled while waiting in the semaphore queue.
            if cancel.load(Ordering::Relaxed) {
                return;
            }

            let relative = build_track_path(&track);
            let file_name = format!("{}.{}", relative, track.suffix);
            let dest_path = std::path::Path::new(&dest).join(&file_name);
            let path_str = dest_path.to_string_lossy().to_string();

            let status;
            if dest_path.exists() {
                s.fetch_add(1, Ordering::Relaxed);
                status = "skipped";
            } else {
                // Ensure parent directories exist.
                if let Some(parent) = dest_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit(
                            "device:sync:progress",
                            serde_json::json!({
                                "jobId": job, "trackId": track.id, "status": "error",
                                "error": e.to_string(),
                            }),
                        );
                        return;
                    }
                }

                let response = match apply_server_http_get(
                    &cli,
                    registry,
                    request_server_id.as_deref(),
                    &track.url,
                )
                .send()
                .await
                {
                    Ok(r) if r.status().is_success() => r,
                    Ok(r) => {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit(
                            "device:sync:progress",
                            serde_json::json!({
                                "jobId": job, "trackId": track.id, "status": "error",
                                "error": format!("HTTP {}", r.status().as_u16()),
                            }),
                        );
                        return;
                    }
                    Err(e) => {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit(
                            "device:sync:progress",
                            serde_json::json!({
                                "jobId": job, "trackId": track.id, "status": "error",
                                "error": e.to_string(),
                            }),
                        );
                        return;
                    }
                };

                let part_path = dest_path.with_extension(format!("{}.part", track.suffix));
                if let Err(e) =
                    finalize_streamed_download(response, &dest_path, &part_path, None).await
                {
                    f.fetch_add(1, Ordering::Relaxed);
                    let _ = app2.emit(
                        "device:sync:progress",
                        serde_json::json!({
                            "jobId": job, "trackId": track.id, "status": "error",
                            "error": e,
                        }),
                    );
                    return;
                }

                d.fetch_add(1, Ordering::Relaxed);
                status = "done";
            }

            // Throttled progress event — max once per 500ms.
            let should_emit = {
                let mut guard = le.lock().await;
                if guard.elapsed() >= Duration::from_millis(500) {
                    *guard = Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_emit {
                let _ = app2.emit(
                    "device:sync:progress",
                    serde_json::json!({
                        "jobId": job, "trackId": track.id, "status": status, "path": path_str,
                        "done": d.load(Ordering::Relaxed),
                        "skipped": s.load(Ordering::Relaxed),
                        "failed": f.load(Ordering::Relaxed),
                        "total": total,
                    }),
                );
            }
        }));
    }

    // Wait for all tasks to complete.
    for handle in handles {
        let _ = handle.await;
    }

    // Clean up the cancellation flag.
    let was_cancelled = cancel_flag.load(Ordering::Relaxed);
    if let Ok(mut flags) = sync_cancel_flags().lock() {
        flags.remove(&job_id);
    }

    let result = SyncBatchResult {
        done: done.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
    };

    // Final event so the frontend always sees 100%.
    let _ = app.emit(
        "device:sync:complete",
        serde_json::json!({
            "jobId": job_id,
            "done": result.done,
            "skipped": result.skipped,
            "failed": result.failed,
            "total": total,
            "cancelled": was_cancelled,
        }),
    );

    Ok(result)
}

/// Deletes multiple files from the device in one call and prunes empty parent
/// directories. Returns the number of files successfully deleted.
#[tauri::command]
#[specta::specta]
pub async fn delete_device_files(paths: Vec<String>) -> Result<u32, String> {
    delete_device_files_impl(paths).await
}

#[cfg(test)]
mod tests;

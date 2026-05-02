use super::*;

#[tauri::command]
pub(crate) async fn list_device_dir_files(dir: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.exists() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    let mut files = Vec::new();
    let mut stack = vec![root];
    while let Some(current) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&current).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            // Skip hidden dirs (e.g. .Trash-1000, .Ventoy, .fseventsd)
            let is_hidden = path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false);
            if is_hidden { continue; }
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(files)
}

/// Deletes a file from the device and prunes empty parent directories
/// (up to 2 levels: album folder, then artist folder).
#[tauri::command]
pub(crate) async fn delete_device_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        tokio::fs::remove_file(&p).await.map_err(|e| e.to_string())?;
        prune_empty_parents(&p, 2).await;
    }
    Ok(())
}

/// Prune empty parent directories up to `levels` levels above `file_path`.
pub(crate) async fn prune_empty_parents(file_path: &std::path::Path, levels: usize) {
    let mut current = file_path.parent().map(|d| d.to_path_buf());
    for _ in 0..levels {
        let Some(dir) = current else { break };
        let is_empty = std::fs::read_dir(&dir)
            .map(|mut rd| rd.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = tokio::fs::remove_dir(&dir).await;
            current = dir.parent().map(|d| d.to_path_buf());
        } else {
            break;
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubsonicAuthPayload {
    base_url: String,
    u: String,
    t: String,
    s: String,
    v: String,
    c: String,
    f: String,
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct DeviceSyncSourcePayload {
    #[serde(rename = "type")]
    source_type: String,
    id: String,
    /// Playlist display name — only present for playlist sources, used when
    /// computing the playlist-folder path on the device.
    #[serde(default)]
    name: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncDeltaResult {
    add_bytes: u64,
    add_count: u32,
    del_bytes: u64,
    del_count: u32,
    available_bytes: u64,
    tracks: Vec<serde_json::Value>,
}

pub(crate) async fn fetch_subsonic_songs(
    client: &reqwest::Client,
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
    let res = client.get(&url).query(&query).send().await.map_err(|e| e.to_string())?;
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    
    let root = json.get("subsonic-response").ok_or("No subsonic-response".to_string())?;
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
pub(crate) async fn calculate_sync_payload(
    sources: Vec<DeviceSyncSourcePayload>,
    deletion_ids: Vec<String>,
    auth: SubsonicAuthPayload,
    target_dir: String,
) -> Result<SyncDeltaResult, String> {
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut add_bytes = 0;
    let mut add_count = 0;
    let mut del_bytes = 0;
    let mut del_count = 0;
    
    let mut sync_tracks = Vec::new();
    let (mut del_sources, mut add_sources) = (Vec::new(), Vec::new());
    for s in sources {
        if deletion_ids.contains(&s.id) {
            del_sources.push(s);
        } else {
            add_sources.push(s);
        }
    }
    
    let mut handles: Vec<(DeviceSyncSourcePayload, tokio::task::JoinHandle<Vec<serde_json::Value>>)> = Vec::new();
    for source in add_sources {
        let auth_clone = SubsonicAuthPayload {
            base_url: auth.base_url.clone(), u: auth.u.clone(), t: auth.t.clone(), s: auth.s.clone(),
            v: auth.v.clone(), c: auth.c.clone(), f: auth.f.clone(),
        };
        let cli = client.clone();
        let source_snapshot = source.clone();
        let handle = tokio::spawn(async move {
            let mut res_tracks = Vec::new();
            if source.source_type == "album" {
                if let Ok(ts) = fetch_subsonic_songs(&cli, &auth_clone, "getAlbum.view", &source.id).await { res_tracks.extend(ts); }
            } else if source.source_type == "playlist" {
                if let Ok(ts) = fetch_subsonic_songs(&cli, &auth_clone, "getPlaylist.view", &source.id).await { res_tracks.extend(ts); }
            } else if source.source_type == "artist" {
                let url = format!("{}/getArtist.view", auth_clone.base_url);
                let query = vec![("u", auth_clone.u.as_str()), ("t", auth_clone.t.as_str()), ("s", auth_clone.s.as_str()), ("v", auth_clone.v.as_str()), ("c", auth_clone.c.as_str()), ("f", auth_clone.f.as_str()), ("id", &source.id)];
                if let Ok(re) = cli.get(&url).query(&query).send().await {
                   if let Ok(js) = re.json::<serde_json::Value>().await {
                       if let Some(root) = js.get("subsonic-response").and_then(|r| r.get("artist")).and_then(|a| a.get("album")) {
                          let arr = root.as_array().map(|a| a.clone()).unwrap_or_else(|| {
                              root.as_object().map(|o| vec![serde_json::Value::Object(o.clone())]).unwrap_or_else(|| vec![])
                          });
                          for al in arr {
                              if let Some(aid) = al.get("id").and_then(|i| i.as_str()) {
                                  if let Ok(ts) = fetch_subsonic_songs(&cli, &auth_clone, "getAlbum.view", aid).await {
                                      res_tracks.extend(ts);
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
        let auth_clone = SubsonicAuthPayload {
            base_url: auth.base_url.clone(), u: auth.u.clone(), t: auth.t.clone(), s: auth.s.clone(),
            v: auth.v.clone(), c: auth.c.clone(), f: auth.f.clone(),
        };
        let cli = client.clone();
        del_handles.push(tokio::spawn(async move {
            let mut res_tracks = Vec::new();
            if source.source_type == "album" {
                if let Ok(ts) = fetch_subsonic_songs(&cli, &auth_clone, "getAlbum.view", &source.id).await { res_tracks.extend(ts); }
            } else if source.source_type == "playlist" {
                if let Ok(ts) = fetch_subsonic_songs(&cli, &auth_clone, "getPlaylist.view", &source.id).await { res_tracks.extend(ts); }
            }
            res_tracks
        }));
    }

    // Dedup key is (source_id, track_id) rather than just track_id — a track
    // appearing in both an album and a playlist needs to end up on the device
    // in both locations (album tree + playlist folder).
    let mut seen_by_source: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for (source, handle) in handles {
        if let Ok(ts) = handle.await {
            let is_playlist = source.source_type == "playlist";
            let mut playlist_position: u32 = 0;
            for track in ts {
                if let Some(tid) = track.get("id").and_then(|i| i.as_str()) {
                    let key = (source.id.clone(), tid.to_string());
                    if seen_by_source.contains(&key) { continue; }
                    seen_by_source.insert(key);
                    if is_playlist { playlist_position += 1; }
                    let pl_name = if is_playlist { source.name.clone() } else { None };
                    let pl_idx  = if is_playlist { Some(playlist_position) } else { None };

                    let already_exists = {
                        let suffix = track.get("suffix").and_then(|s| s.as_str()).unwrap_or("mp3");
                        let artist_raw = track.get("artist").and_then(|v| v.as_str()).unwrap_or("");
                        let album_artist = track.get("albumArtist")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or(artist_raw);
                        let sync_info = TrackSyncInfo {
                            id: tid.to_string(),
                            url: String::new(),
                            suffix: suffix.to_string(),
                            artist: artist_raw.to_string(),
                            album_artist: album_artist.to_string(),
                            album: track.get("album").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            title: track.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            track_number: track.get("track").and_then(|v| v.as_u64()).map(|n| n as u32),
                            duration: track.get("duration").and_then(|v| v.as_u64()).map(|n| n as u32),
                            playlist_name: pl_name.clone(),
                            playlist_index: pl_idx,
                        };
                        let relative = build_track_path(&sync_info);
                        let file_name = format!("{}.{}", relative, suffix);
                        std::path::Path::new(&target_dir).join(&file_name).exists()
                    };
                    if !already_exists {
                        add_count += 1;
                        let size = track.get("size").and_then(|s| s.as_u64()).unwrap_or_else(|| {
                            track.get("duration").and_then(|d| d.as_u64()).unwrap_or(0) * 320_000 / 8
                        });
                        add_bytes += size;
                        // Embed playlist context in the track JSON so the frontend
                        // can pass it back to sync_batch_to_device without re-computing it.
                        let mut track_with_ctx = track.clone();
                        if let Some(obj) = track_with_ctx.as_object_mut() {
                            if let Some(name) = &pl_name {
                                obj.insert("_playlistName".to_string(), serde_json::Value::String(name.clone()));
                            }
                            if let Some(idx) = pl_idx {
                                obj.insert("_playlistIndex".to_string(), serde_json::Value::Number(idx.into()));
                            }
                        }
                        sync_tracks.push(track_with_ctx);
                    }
                }
            }
        }
    }

    for handle in del_handles {
        if let Ok(ts) = handle.await {
            for track in ts {
                del_count += 1;
                let size = track.get("size").and_then(|s| s.as_u64()).unwrap_or_else(|| {
                    track.get("duration").and_then(|d| d.as_u64()).unwrap_or(0) * 320_000 / 8
                });
                del_bytes += size;
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
        add_bytes, add_count, del_bytes, del_count, available_bytes, tracks: sync_tracks,
    })
}

/// Signals a running `sync_batch_to_device` job to stop after its current tracks finish.
#[tauri::command]
pub(crate) fn cancel_device_sync(job_id: String, app: tauri::AppHandle) {
    if let Ok(flags) = sync_cancel_flags().lock() {
        if let Some(flag) = flags.get(&job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    let _ = app.emit("device:sync:cancelled", serde_json::json!({ "jobId": job_id }));
}

/// Downloads a batch of tracks to a USB/SD device with controlled concurrency.
/// At most 2 parallel writes run simultaneously to prevent I/O choking on USB.
/// Emits throttled `device:sync:progress` events (max once per 500ms) and a
/// final `device:sync:complete` event with the summary.
#[tauri::command]
pub(crate) async fn sync_batch_to_device(
    tracks: Vec<TrackSyncInfo>,
    dest_dir: String,
    job_id: String,
    expected_bytes: u64,
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
    let dest_canon = dest_root.canonicalize().unwrap_or_else(|_| dest_root.clone());
    let dest_str = dest_canon.to_string_lossy();
    
    for drive in drives {
        if dest_str.starts_with(&drive.mount_point) {
            // Buffer of ~10 MB padding boundary natively mapped
            if expected_bytes > drive.available_space.saturating_sub(10_000_000) {
                return Err(format!("NOT_ENOUGH_SPACE"));
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
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    // Concurrency limiter: max 2 parallel USB writes.
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(2));

    // Counters.
    let done    = std::sync::Arc::new(AtomicU32::new(0));
    let skipped = std::sync::Arc::new(AtomicU32::new(0));
    let failed  = std::sync::Arc::new(AtomicU32::new(0));

    // Throttled event emission (max once per 500ms).
    let last_emit = std::sync::Arc::new(Mutex::new(Instant::now()));
    let total = tracks.len() as u32;

    let mut handles = Vec::with_capacity(tracks.len());

    for track in tracks {
        let sem = semaphore.clone();
        let cli = client.clone();
        let app2 = app.clone();
        let job = job_id.clone();
        let dest = dest_dir.clone();
        let d = done.clone();
        let s = skipped.clone();
        let f = failed.clone();
        let le = last_emit.clone();
        let cancel = cancel_flag.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");

            // Bail out if cancelled while waiting in the semaphore queue.
            if cancel.load(Ordering::Relaxed) { return; }

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
                        let _ = app2.emit("device:sync:progress", serde_json::json!({
                            "jobId": job, "trackId": track.id, "status": "error",
                            "error": e.to_string(),
                        }));
                        return;
                    }
                }

                let response = match cli.get(&track.url).send().await {
                    Ok(r) if r.status().is_success() => r,
                    Ok(r) => {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit("device:sync:progress", serde_json::json!({
                            "jobId": job, "trackId": track.id, "status": "error",
                            "error": format!("HTTP {}", r.status().as_u16()),
                        }));
                        return;
                    }
                    Err(e) => {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit("device:sync:progress", serde_json::json!({
                            "jobId": job, "trackId": track.id, "status": "error",
                            "error": e.to_string(),
                        }));
                        return;
                    }
                };

                let part_path = dest_path.with_extension(format!("{}.part", track.suffix));
                if let Err(e) = stream_to_file(response, &part_path).await {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    f.fetch_add(1, Ordering::Relaxed);
                    let _ = app2.emit("device:sync:progress", serde_json::json!({
                        "jobId": job, "trackId": track.id, "status": "error",
                        "error": e,
                    }));
                    return;
                }
                if let Err(e) = tokio::fs::rename(&part_path, &dest_path).await {
                    let _ = tokio::fs::remove_file(&part_path).await;
                    f.fetch_add(1, Ordering::Relaxed);
                    let _ = app2.emit("device:sync:progress", serde_json::json!({
                        "jobId": job, "trackId": track.id, "status": "error",
                        "error": e.to_string(),
                    }));
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
                let _ = app2.emit("device:sync:progress", serde_json::json!({
                    "jobId": job, "trackId": track.id, "status": status, "path": path_str,
                    "done": d.load(Ordering::Relaxed),
                    "skipped": s.load(Ordering::Relaxed),
                    "failed": f.load(Ordering::Relaxed),
                    "total": total,
                }));
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
        done:    done.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        failed:  failed.load(Ordering::Relaxed),
    };

    // Final event so the frontend always sees 100%.
    let _ = app.emit("device:sync:complete", serde_json::json!({
        "jobId": job_id,
        "done": result.done,
        "skipped": result.skipped,
        "failed": result.failed,
        "total": total,
        "cancelled": was_cancelled,
    }));

    Ok(result)
}

/// Deletes multiple files from the device in one call and prunes empty parent
/// directories. Returns the number of files successfully deleted.
#[tauri::command]
pub(crate) async fn delete_device_files(paths: Vec<String>) -> Result<u32, String> {
    let mut deleted: u32 = 0;
    for path in &paths {
        let p = std::path::PathBuf::from(path);
        if p.exists() {
            if tokio::fs::remove_file(&p).await.is_ok() {
                deleted += 1;
                prune_empty_parents(&p, 2).await;
            }
        }
    }
    Ok(deleted)
}

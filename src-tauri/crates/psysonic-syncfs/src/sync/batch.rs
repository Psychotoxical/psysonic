use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Emitter;

use crate::sync_cancel_flags;

use crate::file_transfer::{finalize_streamed_download, subsonic_http_client};
use super::device::{
    build_track_path, get_removable_drives, is_path_on_mounted_volume, SyncBatchResult,
    TrackSyncInfo,
};

#[tauri::command]
pub async fn list_device_dir_files(dir: String) -> Result<Vec<String>, String> {
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
pub async fn delete_device_file(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if p.exists() {
        tokio::fs::remove_file(&p).await.map_err(|e| e.to_string())?;
        prune_empty_parents(&p, 2).await;
    }
    Ok(())
}

/// Prune empty parent directories up to `levels` levels above `file_path`.
pub async fn prune_empty_parents(file_path: &std::path::Path, levels: usize) {
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
pub struct SubsonicAuthPayload {
    base_url: String,
    u: String,
    t: String,
    s: String,
    v: String,
    c: String,
    f: String,
}

#[derive(serde::Deserialize, Clone)]
pub struct DeviceSyncSourcePayload {
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
    parse_subsonic_songs(&json, endpoint)
}

/// Estimate the byte size of a Subsonic song JSON. Prefer the explicit `size`
/// field; fall back to `duration * 320 kbps / 8` when missing. Returns 0 when
/// neither is present.
pub(crate) fn estimate_track_size_bytes(track: &serde_json::Value) -> u64 {
    track.get("size").and_then(|s| s.as_u64()).unwrap_or_else(|| {
        track
            .get("duration")
            .and_then(|d| d.as_u64())
            .unwrap_or(0)
            * 320_000
            / 8
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
    let suffix = track.get("suffix").and_then(|s| s.as_str()).unwrap_or("mp3");
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
        track_number: track.get("track").and_then(|v| v.as_u64()).map(|n| n as u32),
        duration: track.get("duration").and_then(|v| v.as_u64()).map(|n| n as u32),
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
) -> Result<SyncDeltaResult, String> {
    let client = subsonic_http_client(std::time::Duration::from_secs(30))?;

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
                          let arr = root.as_array().cloned().unwrap_or_else(|| {
                              root.as_object().map(|o| vec![serde_json::Value::Object(o.clone())]).unwrap_or_default()
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

                    let sync_info = track_sync_info_from_subsonic_json(
                        &track,
                        tid,
                        pl_name.as_deref(),
                        pl_idx,
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
                        inject_playlist_context(&mut track_with_ctx, pl_name.as_deref(), pl_idx);
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
        add_bytes, add_count, del_bytes, del_count, available_bytes, tracks: sync_tracks,
    })
}

/// Signals a running `sync_batch_to_device` job to stop after its current tracks finish.
#[tauri::command]
pub fn cancel_device_sync(job_id: String, app: tauri::AppHandle) {
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
pub async fn sync_batch_to_device(
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
                if let Err(e) = finalize_streamed_download(response, &dest_path, &part_path, None).await {
                    f.fetch_add(1, Ordering::Relaxed);
                    let _ = app2.emit("device:sync:progress", serde_json::json!({
                        "jobId": job, "trackId": track.id, "status": "error",
                        "error": e,
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
pub async fn delete_device_files(paths: Vec<String>) -> Result<u32, String> {
    let mut deleted: u32 = 0;
    for path in &paths {
        let p = std::path::PathBuf::from(path);
        if p.exists() && tokio::fs::remove_file(&p).await.is_ok() {
            deleted += 1;
            prune_empty_parents(&p, 2).await;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn write_file(path: &std::path::Path, contents: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    fn fake_auth(base_url: String) -> SubsonicAuthPayload {
        SubsonicAuthPayload {
            base_url,
            u: "user".into(),
            t: "abc".into(),
            s: "salt".into(),
            v: "1.16.1".into(),
            c: "psysonic".into(),
            f: "json".into(),
        }
    }

    // ── prune_empty_parents ───────────────────────────────────────────────────

    #[tokio::test]
    async fn prune_removes_one_empty_parent_when_levels_is_one() {
        let dir = tempfile::tempdir().unwrap();
        let leaf_dir = dir.path().join("a");
        std::fs::create_dir(&leaf_dir).unwrap();
        let file = leaf_dir.join("track.mp3");
        write_file(&file, b"x");
        std::fs::remove_file(&file).unwrap();
        prune_empty_parents(&file, 1).await;
        assert!(!leaf_dir.exists(), "level 1 prune must remove the empty parent");
    }

    #[tokio::test]
    async fn prune_walks_up_multiple_levels() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b").join("c");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("track.mp3");
        write_file(&file, b"x");
        std::fs::remove_file(&file).unwrap();
        prune_empty_parents(&file, 3).await;
        assert!(!dir.path().join("a").join("b").join("c").exists());
        assert!(!dir.path().join("a").join("b").exists());
        assert!(!dir.path().join("a").exists());
        assert!(dir.path().exists(), "tempdir root must survive");
    }

    #[tokio::test]
    async fn prune_stops_at_non_empty_parent() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("artist");
        let inner = parent.join("album");
        std::fs::create_dir_all(&inner).unwrap();
        let target = inner.join("track.mp3");
        let sibling = parent.join("notes.txt");
        write_file(&target, b"x");
        write_file(&sibling, b"y");
        std::fs::remove_file(&target).unwrap();
        prune_empty_parents(&target, 5).await;
        assert!(!inner.exists(), "empty leaf is pruned");
        assert!(parent.exists(), "non-empty parent must stay");
        assert!(sibling.exists(), "sibling file must stay");
    }

    #[tokio::test]
    async fn prune_with_zero_levels_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let leaf = dir.path().join("a");
        std::fs::create_dir(&leaf).unwrap();
        let file = leaf.join("track.mp3");
        write_file(&file, b"x");
        std::fs::remove_file(&file).unwrap();
        prune_empty_parents(&file, 0).await;
        assert!(leaf.exists(), "levels=0 must not remove anything");
    }

    // ── delete_device_files ───────────────────────────────────────────────────

    #[tokio::test]
    async fn delete_device_files_returns_count_of_existing_paths_removed() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mp3");
        let b = dir.path().join("b.mp3");
        write_file(&a, b"a");
        write_file(&b, b"b");
        let missing = dir.path().join("missing.mp3").to_string_lossy().to_string();
        let result = delete_device_files(vec![
            a.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
            missing,
        ])
        .await
        .unwrap();
        assert_eq!(result, 2, "missing paths are silently skipped");
        assert!(!a.exists());
        assert!(!b.exists());
    }

    #[tokio::test]
    async fn delete_device_files_prunes_two_levels_of_empty_parents() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("artist").join("album");
        std::fs::create_dir_all(&nested).unwrap();
        let track = nested.join("01 - track.mp3");
        write_file(&track, b"audio");
        let _ = delete_device_files(vec![track.to_string_lossy().to_string()])
            .await
            .unwrap();
        assert!(!track.exists());
        assert!(!nested.exists(), "level 1 (album) pruned");
        assert!(
            !dir.path().join("artist").exists(),
            "level 2 (artist) pruned",
        );
    }

    #[tokio::test]
    async fn delete_device_files_returns_zero_for_empty_input() {
        let result = delete_device_files(vec![]).await.unwrap();
        assert_eq!(result, 0);
    }

    // ── parse_subsonic_songs (pure) ───────────────────────────────────────────

    #[test]
    fn parse_returns_err_when_subsonic_response_missing() {
        let json = serde_json::json!({});
        let err = parse_subsonic_songs(&json, "getAlbum.view").unwrap_err();
        assert!(err.contains("No subsonic-response"));
    }

    #[test]
    fn parse_returns_empty_for_unknown_endpoint() {
        let json = serde_json::json!({
            "subsonic-response": { "status": "ok" }
        });
        let songs = parse_subsonic_songs(&json, "getOther.view").unwrap();
        assert!(songs.is_empty());
    }

    #[test]
    fn parse_album_extracts_song_array() {
        let json = serde_json::json!({
            "subsonic-response": {
                "album": {
                    "song": [
                        { "id": "1", "title": "First" },
                        { "id": "2", "title": "Second" }
                    ]
                }
            }
        });
        let songs = parse_subsonic_songs(&json, "getAlbum.view").unwrap();
        assert_eq!(songs.len(), 2);
        assert_eq!(songs[0].get("id").unwrap(), "1");
    }

    #[test]
    fn parse_album_normalises_single_song_object_to_vec() {
        // Some Subsonic servers return a single song as an object instead of a 1-element array.
        let json = serde_json::json!({
            "subsonic-response": {
                "album": { "song": { "id": "only", "title": "Solo" } }
            }
        });
        let songs = parse_subsonic_songs(&json, "getAlbum.view").unwrap();
        assert_eq!(songs.len(), 1);
        assert_eq!(songs[0].get("id").unwrap(), "only");
    }

    #[test]
    fn parse_playlist_extracts_entry_array() {
        let json = serde_json::json!({
            "subsonic-response": {
                "playlist": {
                    "entry": [{ "id": "p1" }, { "id": "p2" }, { "id": "p3" }]
                }
            }
        });
        let songs = parse_subsonic_songs(&json, "getPlaylist.view").unwrap();
        assert_eq!(songs.len(), 3);
    }

    #[test]
    fn parse_returns_empty_when_album_has_no_songs() {
        let json = serde_json::json!({
            "subsonic-response": {
                "album": { "id": "empty-album" }
            }
        });
        let songs = parse_subsonic_songs(&json, "getAlbum.view").unwrap();
        assert!(songs.is_empty());
    }

    // ── fetch_subsonic_songs against wiremock ─────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_subsonic_songs_roundtrips_album_via_wiremock() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/getAlbum.view"))
            .and(query_param("u", "user"))
            .and(query_param("id", "album-42"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "subsonic-response": {
                    "album": {
                        "song": [
                            { "id": "t1", "title": "Track 1" },
                            { "id": "t2", "title": "Track 2" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let client = crate::file_transfer::subsonic_http_client(std::time::Duration::from_secs(5))
            .unwrap();
        let auth = fake_auth(server.uri());
        let songs = fetch_subsonic_songs(&client, &auth, "getAlbum.view", "album-42")
            .await
            .unwrap();
        assert_eq!(songs.len(), 2);
        assert_eq!(songs[0].get("id").unwrap(), "t1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_subsonic_songs_returns_empty_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/getAlbum.view"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let client = crate::file_transfer::subsonic_http_client(std::time::Duration::from_secs(5))
            .unwrap();
        let auth = fake_auth(server.uri());
        let result = fetch_subsonic_songs(&client, &auth, "getAlbum.view", "missing").await;
        // 404 with HTML/empty body fails the JSON parse, surfacing as an Err — we
        // just assert the function does not panic and propagates an error string.
        assert!(result.is_err());
    }

    // ── estimate_track_size_bytes ────────────────────────────────────────────

    #[test]
    fn estimate_track_size_prefers_explicit_size_field() {
        let track = serde_json::json!({ "size": 12_345_u64, "duration": 200_u64 });
        assert_eq!(estimate_track_size_bytes(&track), 12_345);
    }

    #[test]
    fn estimate_track_size_falls_back_to_duration_at_320kbps() {
        // Duration in seconds → bytes at 320 kbps:
        //   bytes = duration * 320_000 / 8 = duration * 40_000
        let track = serde_json::json!({ "duration": 240_u64 });
        assert_eq!(estimate_track_size_bytes(&track), 240 * 40_000);
    }

    #[test]
    fn estimate_track_size_returns_zero_when_neither_size_nor_duration_present() {
        let track = serde_json::json!({ "title": "no metadata at all" });
        assert_eq!(estimate_track_size_bytes(&track), 0);
    }

    #[test]
    fn estimate_track_size_explicit_size_wins_even_when_duration_present() {
        // explicit size of 1 byte must NOT be replaced by duration-derived 8 MB.
        let track = serde_json::json!({ "size": 1_u64, "duration": 200_u64 });
        assert_eq!(estimate_track_size_bytes(&track), 1);
    }

    // ── track_sync_info_from_subsonic_json ───────────────────────────────────

    #[test]
    fn track_sync_info_from_json_uses_album_artist_when_present() {
        let track = serde_json::json!({
            "suffix": "flac",
            "artist": "Roger Waters",
            "albumArtist": "Pink Floyd",
            "album": "The Wall",
            "title": "Comfortably Numb",
            "track": 7,
            "duration": 380,
        });
        let info = track_sync_info_from_subsonic_json(&track, "abc", None, None);
        assert_eq!(info.id, "abc");
        assert_eq!(info.suffix, "flac");
        assert_eq!(info.artist, "Roger Waters");
        assert_eq!(info.album_artist, "Pink Floyd");
        assert_eq!(info.album, "The Wall");
        assert_eq!(info.title, "Comfortably Numb");
        assert_eq!(info.track_number, Some(7));
        assert_eq!(info.duration, Some(380));
        assert!(info.playlist_name.is_none() && info.playlist_index.is_none());
    }

    #[test]
    fn track_sync_info_falls_back_to_artist_when_album_artist_missing() {
        let track = serde_json::json!({
            "artist": "Some Artist",
            "title": "Solo",
        });
        let info = track_sync_info_from_subsonic_json(&track, "x", None, None);
        assert_eq!(info.album_artist, "Some Artist");
    }

    #[test]
    fn track_sync_info_treats_whitespace_only_album_artist_as_missing() {
        let track = serde_json::json!({
            "artist": "Real Artist",
            "albumArtist": "   ",
            "title": "T",
        });
        let info = track_sync_info_from_subsonic_json(&track, "x", None, None);
        assert_eq!(info.album_artist, "Real Artist");
    }

    #[test]
    fn track_sync_info_uses_mp3_default_suffix_when_missing() {
        let track = serde_json::json!({ "artist": "A", "title": "T" });
        let info = track_sync_info_from_subsonic_json(&track, "x", None, None);
        assert_eq!(info.suffix, "mp3");
    }

    #[test]
    fn track_sync_info_attaches_playlist_context_when_supplied() {
        let track = serde_json::json!({ "artist": "A", "title": "T" });
        let info = track_sync_info_from_subsonic_json(&track, "x", Some("My Mix"), Some(5));
        assert_eq!(info.playlist_name.as_deref(), Some("My Mix"));
        assert_eq!(info.playlist_index, Some(5));
    }

    // ── inject_playlist_context ──────────────────────────────────────────────

    #[test]
    fn inject_playlist_context_adds_both_keys_when_supplied() {
        let mut track = serde_json::json!({ "id": "t1", "title": "Song" });
        inject_playlist_context(&mut track, Some("Mix"), Some(3));
        assert_eq!(track.get("_playlistName").unwrap(), "Mix");
        assert_eq!(track.get("_playlistIndex").unwrap().as_u64().unwrap(), 3);
        // Original keys still intact.
        assert_eq!(track.get("id").unwrap(), "t1");
        assert_eq!(track.get("title").unwrap(), "Song");
    }

    #[test]
    fn inject_playlist_context_is_noop_when_both_args_none() {
        let mut track = serde_json::json!({ "id": "t1" });
        inject_playlist_context(&mut track, None, None);
        assert!(track.get("_playlistName").is_none());
        assert!(track.get("_playlistIndex").is_none());
    }

    #[test]
    fn inject_playlist_context_attaches_only_supplied_args() {
        let mut track = serde_json::json!({ "id": "t1" });
        inject_playlist_context(&mut track, Some("Mix"), None);
        assert_eq!(track.get("_playlistName").unwrap(), "Mix");
        assert!(track.get("_playlistIndex").is_none());
    }

    #[test]
    fn inject_playlist_context_skips_non_object_values() {
        // Defensive: if the JSON is somehow a non-object (shouldn't happen), no panic.
        let mut track = serde_json::json!("just a string");
        inject_playlist_context(&mut track, Some("Mix"), Some(3));
        assert_eq!(track, serde_json::json!("just a string"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn fetch_subsonic_songs_handles_single_song_object_shape() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/getPlaylist.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "subsonic-response": {
                    "playlist": {
                        "entry": { "id": "only", "title": "Lonely" }
                    }
                }
            })))
            .mount(&server)
            .await;

        let client = crate::file_transfer::subsonic_http_client(std::time::Duration::from_secs(5))
            .unwrap();
        let auth = fake_auth(server.uri());
        let songs = fetch_subsonic_songs(&client, &auth, "getPlaylist.view", "p1")
            .await
            .unwrap();
        assert_eq!(songs.len(), 1, "single-object response normalised to 1-element vec");
        assert_eq!(songs[0].get("id").unwrap(), "only");
    }
}

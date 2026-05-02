use super::*;

// ─── Device Sync ─────────────────────────────────────────────────────────────

/// Information about a single mounted removable drive.
#[derive(Clone, serde::Serialize)]
pub(crate) struct RemovableDrive {
    pub(crate) name: String,
    pub(crate) mount_point: String,
    pub(crate) available_space: u64,
    pub(crate) total_space: u64,
    pub(crate) file_system: String,
    pub(crate) is_removable: bool,
}

/// Returns all currently mounted removable drives.
/// On Linux these are typically USB sticks / SD cards under /media or /run/media.
/// On macOS they appear under /Volumes. On Windows they are separate drive letters.
#[tauri::command]
pub(crate) fn get_removable_drives() -> Vec<RemovableDrive> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|d| d.is_removable())
        .map(|d| RemovableDrive {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_string_lossy().to_string(),
            available_space: d.available_space(),
            total_space: d.total_space(),
            file_system: d.file_system().to_string_lossy().to_string(),
            is_removable: true,
        })
        .collect()
}

/// Writes a `psysonic-sync.json` manifest to the root of the target directory.
/// The file records which sources (albums/playlists/artists) are synced to this
/// device so that another machine can pick them up without relying on localStorage.
#[tauri::command]
pub(crate) fn write_device_manifest(dest_dir: String, sources: serde_json::Value) -> Result<(), String> {
    let path = std::path::Path::new(&dest_dir).join("psysonic-sync.json");
    // Manifest v2: fixed "{AlbumArtist}/{Album}/{TrackNum} - {Title}.{ext}" schema,
    // no user-configurable filename template. Readers still accept v1 manifests.
    let payload = serde_json::json!({
        "version": 2,
        "schema": "fixed-v1",
        "sources": sources
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Reads `psysonic-sync.json` from the target directory.
/// Returns the parsed JSON value, or null if the file doesn't exist.
#[tauri::command]
pub(crate) fn read_device_manifest(dest_dir: String) -> Option<serde_json::Value> {
    let path = std::path::Path::new(&dest_dir).join("psysonic-sync.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Per-entry result for `rename_device_files`.
#[derive(serde::Serialize)]
pub(crate) struct RenameResult {
    #[serde(rename = "oldPath")]
    old_path: String,
    #[serde(rename = "newPath")]
    new_path: String,
    ok: bool,
    error: Option<String>,
}

/// Atomically renames files on the device from their old path to the new fixed-
/// schema path. Intended for the migration flow when switching away from the
/// user-configurable template. All paths are relative to `target_dir`.
///
/// After renaming, removes any directories left empty under `target_dir`
/// (so stale `{OldArtist}/{OldAlbum}/` trees don't linger).
///
/// Returns a per-entry result so the UI can show which renames succeeded
/// and which failed. Does not roll back on partial failure — each `fs::rename`
/// is atomic, so nothing can be half-renamed.
#[tauri::command]
pub(crate) fn rename_device_files(
    target_dir: String,
    pairs: Vec<(String, String)>,
) -> Result<Vec<RenameResult>, String> {
    let root = std::path::PathBuf::from(&target_dir);
    if !root.exists() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    if !is_path_on_mounted_volume(&root) {
        return Err("NOT_MOUNTED_VOLUME".to_string());
    }

    let mut results = Vec::with_capacity(pairs.len());
    for (old_rel, new_rel) in pairs {
        let old_abs = root.join(&old_rel);
        let new_abs = root.join(&new_rel);

        let entry = if old_rel == new_rel {
            // Nothing to do, count as success so the UI can show "already correct".
            RenameResult { old_path: old_rel, new_path: new_rel, ok: true, error: None }
        } else if !old_abs.exists() {
            RenameResult {
                old_path: old_rel, new_path: new_rel,
                ok: false, error: Some("source not found".to_string()),
            }
        } else if new_abs.exists() {
            RenameResult {
                old_path: old_rel, new_path: new_rel,
                ok: false, error: Some("target already exists".to_string()),
            }
        } else {
            // Ensure target parent exists.
            if let Some(parent) = new_abs.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    results.push(RenameResult {
                        old_path: old_rel, new_path: new_rel,
                        ok: false, error: Some(format!("mkdir: {}", e)),
                    });
                    continue;
                }
            }
            match std::fs::rename(&old_abs, &new_abs) {
                Ok(_) => RenameResult { old_path: old_rel, new_path: new_rel, ok: true, error: None },
                Err(e) => RenameResult {
                    old_path: old_rel, new_path: new_rel,
                    ok: false, error: Some(e.to_string()),
                },
            }
        };
        results.push(entry);
    }

    // Clean up directories emptied by the renames. Walk depth-first and remove
    // any dir whose only remaining contents were the files we moved out.
    fn remove_empty_dirs(dir: &std::path::Path, root: &std::path::Path) {
        if dir == root { return; }
        let rd = match std::fs::read_dir(dir) {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut empty = true;
        let mut children: Vec<std::path::PathBuf> = Vec::new();
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() { children.push(p); } else { empty = false; }
        }
        for child in children {
            remove_empty_dirs(&child, root);
        }
        // Re-check after recursion cleared subdirs.
        let still_empty = std::fs::read_dir(dir).map(|r| r.count() == 0).unwrap_or(false);
        if empty && still_empty {
            let _ = std::fs::remove_dir(dir);
        }
    }
    remove_empty_dirs(&root, &root);

    Ok(results)
}

/// Writes an Extended-M3U playlist at `{dest_dir}/Playlists/{name}/{name}.m3u8`.
/// References are sibling filenames (just `01 - Artist - Title.ext`) so the
/// playlist is self-contained — moving/copying the folder anywhere keeps it
/// working. Tracks are expected to be in playlist order (index starts at 1).
#[tauri::command]
pub(crate) fn write_playlist_m3u8(
    dest_dir: String,
    playlist_name: String,
    tracks: Vec<TrackSyncInfo>,
) -> Result<(), String> {
    let safe_name = sanitize_or(&playlist_name, "Unnamed Playlist");
    let playlist_dir = std::path::Path::new(&dest_dir).join("Playlists").join(&safe_name);
    std::fs::create_dir_all(&playlist_dir).map_err(|e| e.to_string())?;
    let file_path = playlist_dir.join(format!("{}.m3u8", safe_name));

    let mut body = String::from("#EXTM3U\n");
    for (i, track) in tracks.iter().enumerate() {
        let idx = (i as u32) + 1;
        let duration = track.duration.map(|d| d as i64).unwrap_or(-1);
        let display_artist = if track.artist.trim().is_empty() { &track.album_artist[..] } else { &track.artist[..] };
        let title = track.title.trim();
        body.push_str(&format!("#EXTINF:{},{} - {}\n", duration, display_artist.trim(), title));
        // Sibling filename — same shape as build_track_path's playlist branch.
        let artist_safe = sanitize_or(display_artist, "Unknown Artist");
        let title_safe  = sanitize_or(title,          "Unknown Title");
        body.push_str(&format!("{:02} - {} - {}.{}\n", idx, artist_safe, title_safe, track.suffix));
    }
    std::fs::write(&file_path, body).map_err(|e| e.to_string())
}

/// Checks whether `path` sits on top of an active mount point (i.e. not the root
/// filesystem). This prevents accidentally writing to `/media/usb` after the
/// USB drive has been unmounted — at that point the path would fall through to `/`
/// and fill the root partition.
pub(crate) fn is_path_on_mounted_volume(path: &std::path::Path) -> bool {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => return false, // path doesn't exist or isn't accessible
    };
    // On Windows, canonicalize() prepends "\\?\" (extended-path prefix).
    // Strip it so that "\\?\E:\Music" compares correctly against mount point "E:\".
    let canonical_raw = canonical.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    let canonical_str = canonical_raw.strip_prefix(r"\\?\").unwrap_or(&canonical_raw).to_string();
    #[cfg(not(target_os = "windows"))]
    let canonical_str = canonical_raw;
    // Find the longest mount-point prefix that matches this path.
    // Exclude the root "/" (or "C:\" on Windows) so we never "match" a fallback.
    let mut best_len: usize = 0;
    for disk in disks.list() {
        let mp = disk.mount_point().to_string_lossy().to_string();
        // Skip root mount points (Linux "/" and non-removable Windows drive roots like "C:\").
        // Do NOT skip removable Windows drives (e.g. "E:\") — those are valid sync targets.
        let is_windows_root = mp.len() == 3 && mp.ends_with(":\\") && !disk.is_removable();
        if mp == "/" || is_windows_root {
            continue;
        }
        if canonical_str.starts_with(&mp) && mp.len() > best_len {
            best_len = mp.len();
        }
    }
    best_len > 0
}

#[derive(serde::Deserialize, Clone)]
pub(crate) struct TrackSyncInfo {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) suffix: String,
    /// Track artist — used in Extended M3U (#EXTINF) entries so playlists display
    /// the actual performer rather than the album artist.
    pub(crate) artist: String,
    /// Album artist — used for the top-level folder so compilation albums stay together.
    /// Falls back to `artist` in the frontend when the server has no albumArtist tag.
    #[serde(rename = "albumArtist")]
    pub(crate) album_artist: String,
    pub(crate) album: String,
    pub(crate) title: String,
    #[serde(rename = "trackNumber")]
    pub(crate) track_number: Option<u32>,
    /// Duration in seconds — needed for Extended M3U (#EXTINF) playlist entries.
    #[serde(default)]
    pub(crate) duration: Option<u32>,
    /// When set, the track belongs to a playlist source and is placed under
    /// `Playlists/{name}/` with `playlist_index` as its filename prefix.
    /// Same track synced from both an album and a playlist source ends up twice
    /// on the device — once in the album tree, once in the playlist folder.
    #[serde(default, rename = "playlistName")]
    pub(crate) playlist_name: Option<String>,
    #[serde(default, rename = "playlistIndex")]
    pub(crate) playlist_index: Option<u32>,
}

/// Summary returned by `sync_batch_to_device` after all tracks are processed.
#[derive(Clone, serde::Serialize)]
pub(crate) struct SyncBatchResult {
    pub(crate) done: u32,
    pub(crate) skipped: u32,
    pub(crate) failed: u32,
}

#[derive(serde::Serialize)]
pub(crate) struct SyncTrackResult {
    pub(crate) path: String,
    pub(crate) skipped: bool,
}

/// Replaces characters that are invalid in file/directory names on Windows and
/// most Unix filesystems with an underscore, and trims leading/trailing dots and
/// spaces which cause issues on Windows. Underscore (not deletion) so that "AC/DC"
/// and "ACDC" don't collapse into the same folder.
pub(crate) fn sanitize_path_component(s: &str) -> String {
    const INVALID: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let sanitized: String = s
        .chars()
        .map(|c| if INVALID.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    sanitized.trim_matches(|c| c == '.' || c == ' ').to_string()
}

/// Sanitize and replace empty results with a placeholder — prevents paths like
/// `//01 - .flac` when metadata is missing.
pub(crate) fn sanitize_or(s: &str, fallback: &str) -> String {
    let cleaned = sanitize_path_component(s);
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
}

/// Builds the fixed device path for a track. When the track carries a playlist
/// context it goes into the playlist folder, otherwise into the album tree.
///
/// Album-tree:  `{AlbumArtist}/{Album}/{TrackNum:02d} - {Title}.{ext}`
/// Playlist:    `Playlists/{PlaylistName}/{PlaylistIndex:02d} - {Artist} - {Title}.{ext}`
pub(crate) fn build_track_path(track: &TrackSyncInfo) -> String {
    let relative = match (&track.playlist_name, track.playlist_index) {
        (Some(name), Some(idx)) => {
            let playlist = sanitize_or(name, "Unnamed Playlist");
            let artist   = sanitize_or(&track.artist, "Unknown Artist");
            let title    = sanitize_or(&track.title,  "Unknown Title");
            format!("Playlists/{}/{:02} - {} - {}", playlist, idx, artist, title)
        }
        _ => {
            let album_artist = sanitize_or(&track.album_artist, "Unknown Artist");
            let album        = sanitize_or(&track.album,        "Unknown Album");
            let title        = sanitize_or(&track.title,        "Unknown Title");
            let track_num    = track.track_number.map(|n| format!("{:02}", n)).unwrap_or_else(|| "00".to_string());
            format!("{}/{}/{} - {}", album_artist, album, track_num, title)
        }
    };
    #[cfg(target_os = "windows")]
    let relative = relative.replace('/', "\\");
    relative
}

/// Downloads a single track to a USB/SD device using the configured filename template.
/// Emits `device:sync:progress` events with `{ jobId, trackId, status, path? }`.
#[tauri::command]
pub(crate) async fn sync_track_to_device(
    track: TrackSyncInfo,
    dest_dir: String,
    job_id: String,
    app: tauri::AppHandle,
) -> Result<SyncTrackResult, String> {
    let relative = build_track_path(&track);
    let file_name = format!("{}.{}", relative, track.suffix);
    let dest_path = std::path::Path::new(&dest_dir).join(&file_name);
    let path_str = dest_path.to_string_lossy().to_string();

    if dest_path.exists() {
        let _ = app.emit("device:sync:progress", serde_json::json!({
            "jobId": job_id, "trackId": track.id, "status": "skipped", "path": path_str,
        }));
        return Ok(SyncTrackResult { path: path_str, skipped: true });
    }

    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&track.url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        let msg = format!("HTTP {}", response.status().as_u16());
        let _ = app.emit("device:sync:progress", serde_json::json!({
            "jobId": job_id, "trackId": track.id, "status": "error", "error": msg,
        }));
        return Err(msg);
    }

    let part_path = dest_path.with_extension(format!("{}.part", track.suffix));
    if let Err(e) = stream_to_file(response, &part_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = app.emit("device:sync:progress", serde_json::json!({
            "jobId": job_id, "trackId": track.id, "status": "error", "error": e,
        }));
        return Err(e);
    }
    tokio::fs::rename(&part_path, &dest_path)
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit("device:sync:progress", serde_json::json!({
        "jobId": job_id, "trackId": track.id, "status": "done", "path": path_str,
    }));
    Ok(SyncTrackResult { path: path_str, skipped: false })
}

/// Computes the expected file paths for a batch of tracks under the fixed schema.
/// Used by the cleanup flow to find orphans.
#[tauri::command]
pub(crate) fn compute_sync_paths(tracks: Vec<TrackSyncInfo>, dest_dir: String) -> Vec<String> {
    tracks.iter().map(|track| {
        let relative = build_track_path(track);
        let file_name = format!("{}.{}", relative, track.suffix);
        std::path::Path::new(&dest_dir)
            .join(&file_name)
            .to_string_lossy()
            .to_string()
    }).collect()
}

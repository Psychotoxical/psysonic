use tauri::{Emitter, Manager};

use crate::file_transfer::{
    apply_server_http_get, finalize_streamed_download, subsonic_http_client,
};

mod rename;

use rename::rename_pairs_within_root;
pub use rename::RenameResult;

// ─── Device Sync ─────────────────────────────────────────────────────────────

/// Information about a single mounted removable drive.
#[derive(Clone, serde::Serialize, specta::Type)]
pub struct RemovableDrive {
    pub name: String,
    pub mount_point: String,
    pub available_space: u64,
    pub total_space: u64,
    pub file_system: String,
    pub is_removable: bool,
}

/// Returns all currently mounted removable drives.
/// On Linux these are typically USB sticks / SD cards under /media or /run/media.
/// On macOS they appear under /Volumes. On Windows they are separate drive letters.
#[tauri::command]
#[specta::specta]
pub fn get_removable_drives() -> Vec<RemovableDrive> {
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
pub fn write_device_manifest(
    dest_dir: String,
    owner_server_index_key: String,
    sources: serde_json::Value,
) -> Result<(), String> {
    if owner_server_index_key.trim().is_empty() {
        return Err("DEVICE_SYNC_SERVER_OWNER_MISSING".to_string());
    }
    let source_list = sources
        .as_array()
        .ok_or_else(|| "DEVICE_SYNC_SOURCES_INVALID".to_string())?;
    if source_list.iter().any(|source| {
        source
            .get("serverIndexKey")
            .and_then(|value| value.as_str())
            != Some(owner_server_index_key.as_str())
    }) {
        return Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string());
    }
    let path = std::path::Path::new(&dest_dir).join("psysonic-sync.json");
    // Manifest v3 pins raw Subsonic IDs to one durable URL-derived server owner.
    let payload = serde_json::json!({
        "version": 3,
        "schema": "fixed-v1",
        "ownerServerIndexKey": owner_server_index_key,
        "sources": sources
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Reads `psysonic-sync.json` from the target directory.
/// Returns the parsed JSON value, or null if the file doesn't exist.
#[tauri::command]
pub fn read_device_manifest(dest_dir: String) -> Option<serde_json::Value> {
    let path = std::path::Path::new(&dest_dir).join("psysonic-sync.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
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
#[specta::specta]
pub fn rename_device_files(
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
    Ok(rename_pairs_within_root(&root, pairs))
}

/// Writes an Extended-M3U playlist at `{dest_dir}/Playlists/{name}/{name}.m3u8`.
/// References are sibling filenames (just `01 - Artist - Title.ext`) so the
/// playlist is self-contained — moving/copying the folder anywhere keeps it
/// working. Tracks are expected to be in playlist order (index starts at 1).
#[tauri::command]
#[specta::specta]
pub fn write_playlist_m3u8(
    dest_dir: String,
    playlist_name: String,
    tracks: Vec<TrackSyncInfo>,
) -> Result<(), String> {
    let safe_name = sanitize_or(&playlist_name, "Unnamed Playlist");
    let playlist_dir = std::path::Path::new(&dest_dir)
        .join("Playlists")
        .join(&safe_name);
    std::fs::create_dir_all(&playlist_dir).map_err(|e| e.to_string())?;
    let file_path = playlist_dir.join(format!("{}.m3u8", safe_name));

    let mut body = String::from("#EXTM3U\n");
    for (i, track) in tracks.iter().enumerate() {
        let idx = (i as u32) + 1;
        let duration = track.duration.map(|d| d as i64).unwrap_or(-1);
        let display_artist = if track.artist.trim().is_empty() {
            &track.album_artist[..]
        } else {
            &track.artist[..]
        };
        let title = track.title.trim();
        body.push_str(&format!(
            "#EXTINF:{},{} - {}\n",
            duration,
            display_artist.trim(),
            title
        ));
        // Sibling filename — same shape as build_track_path's playlist branch.
        let artist_safe = sanitize_or(display_artist, "Unknown Artist");
        let title_safe = sanitize_or(title, "Unknown Title");
        body.push_str(&format!(
            "{:02} - {} - {}.{}\n",
            idx, artist_safe, title_safe, track.suffix
        ));
    }
    std::fs::write(&file_path, body).map_err(|e| e.to_string())
}

/// Checks whether `path` sits on top of an active mount point (i.e. not the root
/// filesystem). This prevents accidentally writing to `/media/usb` after the
/// USB drive has been unmounted — at that point the path would fall through to `/`
/// and fill the root partition.
pub fn is_path_on_mounted_volume(path: &std::path::Path) -> bool {
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
    let canonical_str = canonical_raw
        .strip_prefix(r"\\?\")
        .unwrap_or(&canonical_raw)
        .to_string();
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

#[derive(serde::Deserialize, Clone, specta::Type)]
pub struct TrackSyncInfo {
    pub id: String,
    pub url: String,
    pub suffix: String,
    /// Track artist — used in Extended M3U (#EXTINF) entries so playlists display
    /// the actual performer rather than the album artist.
    pub artist: String,
    /// Album artist — used for the top-level folder so compilation albums stay together.
    /// Falls back to `artist` in the frontend when the server has no albumArtist tag.
    #[serde(rename = "albumArtist")]
    pub album_artist: String,
    pub album: String,
    pub title: String,
    #[serde(rename = "trackNumber")]
    pub track_number: Option<u32>,
    /// Duration in seconds — needed for Extended M3U (#EXTINF) playlist entries.
    #[serde(default)]
    pub duration: Option<u32>,
    /// When set, the track belongs to a playlist source and is placed under
    /// `Playlists/{name}/` with `playlist_index` as its filename prefix.
    /// Same track synced from both an album and a playlist source ends up twice
    /// on the device — once in the album tree, once in the playlist folder.
    #[serde(default, rename = "playlistName")]
    pub playlist_name: Option<String>,
    #[serde(default, rename = "playlistIndex")]
    pub playlist_index: Option<u32>,
}

/// Summary returned by `sync_batch_to_device` after all tracks are processed.
#[derive(Clone, serde::Serialize, specta::Type)]
pub struct SyncBatchResult {
    pub done: u32,
    pub skipped: u32,
    pub failed: u32,
}

#[derive(serde::Serialize, specta::Type)]
pub struct SyncTrackResult {
    pub path: String,
    pub skipped: bool,
}

/// Replaces characters that are invalid in file/directory names on Windows and
/// most Unix filesystems with an underscore, and trims leading/trailing dots and
/// spaces which cause issues on Windows. Underscore (not deletion) so that "AC/DC"
/// and "ACDC" don't collapse into the same folder.
pub fn sanitize_path_component(s: &str) -> String {
    const INVALID: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let sanitized: String = s
        .chars()
        .map(|c| {
            if INVALID.contains(&c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    sanitized.trim_matches(|c| c == '.' || c == ' ').to_string()
}

/// Sanitize and replace empty results with a placeholder — prevents paths like
/// `//01 - .flac` when metadata is missing.
pub fn sanitize_or(s: &str, fallback: &str) -> String {
    let cleaned = sanitize_path_component(s);
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Builds the fixed device path for a track. When the track carries a playlist
/// context it goes into the playlist folder, otherwise into the album tree.
///
/// Album-tree:  `{AlbumArtist}/{Album}/{TrackNum:02d} - {Title}.{ext}`
/// Playlist:    `Playlists/{PlaylistName}/{PlaylistIndex:02d} - {Artist} - {Title}.{ext}`
pub fn build_track_path(track: &TrackSyncInfo) -> String {
    let relative = match (&track.playlist_name, track.playlist_index) {
        (Some(name), Some(idx)) => {
            let playlist = sanitize_or(name, "Unnamed Playlist");
            let artist = sanitize_or(&track.artist, "Unknown Artist");
            let title = sanitize_or(&track.title, "Unknown Title");
            format!("Playlists/{}/{:02} - {} - {}", playlist, idx, artist, title)
        }
        _ => {
            let album_artist = sanitize_or(&track.album_artist, "Unknown Artist");
            let album = sanitize_or(&track.album, "Unknown Album");
            let title = sanitize_or(&track.title, "Unknown Title");
            let track_num = track
                .track_number
                .map(|n| format!("{:02}", n))
                .unwrap_or_else(|| "00".to_string());
            format!("{}/{}/{} - {}", album_artist, album, track_num, title)
        }
    };
    #[cfg(target_os = "windows")]
    let relative = relative.replace('/', "\\");
    relative
}

/// AppHandle-free download primitive used by [`sync_track_to_device`]. Streams
/// the response body to `dest_path` (via a `.part` file) when the file isn't
/// already there.
///
/// Returns:
/// - `Ok(false)` — pre-existing file, skipped.
/// - `Ok(true)` — fresh download landed at `dest_path`.
/// - `Err(_)` — HTTP non-success or stream/rename failure.
pub(crate) async fn sync_download_one_track(
    dest_path: &std::path::Path,
    suffix: &str,
    url: &str,
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
) -> Result<bool, String> {
    if dest_path.exists() {
        return Ok(false);
    }
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let response = apply_server_http_get(client, registry, server_ref, url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let part_path = dest_path.with_extension(format!("{}.part", suffix));
    finalize_streamed_download(response, dest_path, &part_path, None).await?;
    Ok(true)
}

/// Downloads a single track to a USB/SD device using the configured filename template.
/// Emits `device:sync:progress` events with `{ jobId, trackId, status, path? }`.
#[tauri::command]
#[specta::specta]
pub async fn sync_track_to_device(
    track: TrackSyncInfo,
    dest_dir: String,
    job_id: String,
    app: tauri::AppHandle,
) -> Result<SyncTrackResult, String> {
    let relative = build_track_path(&track);
    let file_name = format!("{}.{}", relative, track.suffix);
    let dest_path = std::path::Path::new(&dest_dir).join(&file_name);
    let path_str = dest_path.to_string_lossy().to_string();

    let client = subsonic_http_client(std::time::Duration::from_secs(300))?;
    let http_registry = app
        .try_state::<std::sync::Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| std::sync::Arc::clone(&*s));
    match sync_download_one_track(
        &dest_path,
        &track.suffix,
        &track.url,
        &client,
        http_registry.as_deref(),
        None,
    )
    .await
    {
        Ok(false) => {
            let _ = app.emit(
                "device:sync:progress",
                serde_json::json!({
                    "jobId": job_id, "trackId": track.id, "status": "skipped", "path": path_str,
                }),
            );
            Ok(SyncTrackResult {
                path: path_str,
                skipped: true,
            })
        }
        Ok(true) => {
            let _ = app.emit(
                "device:sync:progress",
                serde_json::json!({
                    "jobId": job_id, "trackId": track.id, "status": "done", "path": path_str,
                }),
            );
            Ok(SyncTrackResult {
                path: path_str,
                skipped: false,
            })
        }
        Err(e) => {
            let _ = app.emit(
                "device:sync:progress",
                serde_json::json!({
                    "jobId": job_id, "trackId": track.id, "status": "error", "error": e,
                }),
            );
            Err(e)
        }
    }
}

/// Computes the expected file paths for a batch of tracks under the fixed schema.
/// Used by the cleanup flow to find orphans.
#[tauri::command]
#[specta::specta]
pub fn compute_sync_paths(tracks: Vec<TrackSyncInfo>, dest_dir: String) -> Vec<String> {
    tracks
        .iter()
        .map(|track| {
            let relative = build_track_path(track);
            let file_name = format!("{}.{}", relative, track.suffix);
            std::path::Path::new(&dest_dir)
                .join(&file_name)
                .to_string_lossy()
                .to_string()
        })
        .collect()
}

#[cfg(test)]
mod tests;

use std::sync::OnceLock;

pub mod download;
mod finalize;
mod identity;
mod manifest;
mod rename;

#[cfg(test)]
pub(crate) use download::sync_download_one_track;

pub(crate) async fn device_sync_operation_guard() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

pub(crate) fn path_contains_symlink(
    root: &std::path::Path,
    path: &std::path::Path,
) -> Result<bool, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string())?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Ok(true),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(false)
}

pub use finalize::{
    DeviceSyncFinalizePayload, DeviceSyncFinalizePlaylist, DeviceSyncFinalizeResult,
    DeviceSyncFinalizeSource,
};
pub(crate) use identity::{ensure_device_identity, validate_device_identity};
pub use manifest::write_device_manifest_for_migration;
#[cfg(test)]
use manifest::write_device_manifest_payload;
use manifest::DeviceManifestWrite;
pub(crate) use manifest::{replace_device_text_file, sync_device_directory};
use rename::rename_pairs_within_root;
pub use rename::RenameResult;
pub(crate) use rename::{planned_path_stays_within, resolve_within_root};

// ─── Device Sync ─────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn finalize_device_sync(
    dest_dir: String,
    payload: DeviceSyncFinalizePayload,
) -> Result<DeviceSyncFinalizeResult, String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    finalize::finalize_device_sync_impl(std::path::Path::new(&dest_dir), payload)
}

#[tauri::command]
#[specta::specta]
pub async fn has_pending_device_sync_plan(dest_dir: String) -> Result<bool, String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let root = std::path::Path::new(&dest_dir);
    ensure_mounted_target(root)?;
    crate::sync::batch::plan::has_active_device_sync_plan(root)
}

#[tauri::command]
#[specta::specta]
pub async fn pending_device_sync_plan_device_id(
    dest_dir: String,
) -> Result<Option<String>, String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let root = std::path::Path::new(&dest_dir);
    ensure_mounted_target(root)?;
    crate::sync::batch::plan::active_device_sync_plan_device_id(root)
}

#[tauri::command]
#[specta::specta]
pub async fn device_sync_device_id(dest_dir: String) -> Result<String, String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    ensure_device_identity(std::path::Path::new(&dest_dir))
}

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
#[allow(clippy::too_many_arguments)] // Tauri IPC fields map directly to the frontend payload.
pub async fn write_device_manifest(
    dest_dir: String,
    owner_server_index_key: String,
    sources: serde_json::Value,
    canonical_id_version: Option<u8>,
    layout_mode: Option<String>,
    playlist_path_mode: Option<String>,
    files: Option<serde_json::Value>,
    playlists: Option<serde_json::Value>,
) -> Result<(), String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    ensure_mounted_target(std::path::Path::new(&dest_dir))?;
    manifest::write_device_manifest_payload(DeviceManifestWrite {
        dest_dir,
        owner_server_index_key,
        sources,
        canonical_id_version,
        layout_mode,
        playlist_path_mode,
        files,
        playlists,
    })
}

/// Reads `psysonic-sync.json` from the target directory.
/// Returns the parsed JSON value, or null if the file doesn't exist.
#[tauri::command]
pub fn read_device_manifest(dest_dir: String) -> Option<serde_json::Value> {
    manifest::read_device_manifest(dest_dir)
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
pub async fn rename_device_files(
    target_dir: String,
    pairs: Vec<(String, String)>,
) -> Result<Vec<RenameResult>, String> {
    let _device_sync_guard = device_sync_operation_guard().await;
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
/// Explicit references allow shared album-tree files; omitted references keep
/// the legacy self-contained sibling-filename behavior.
#[tauri::command]
#[specta::specta]
pub async fn write_playlist_m3u8(
    dest_dir: String,
    playlist_name: String,
    playlist_id: Option<String>,
    tracks: Vec<TrackSyncInfo>,
    references: Option<Vec<String>>,
) -> Result<(), String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard_now()?;
    let root = std::path::Path::new(&dest_dir);
    ensure_mounted_target(root)?;
    write_playlist_m3u8_within_root(
        root,
        &playlist_name,
        playlist_id.as_deref(),
        &tracks,
        references.as_deref(),
    )
}

pub(super) fn write_playlist_m3u8_within_root(
    root: &std::path::Path,
    playlist_name: &str,
    playlist_id: Option<&str>,
    tracks: &[TrackSyncInfo],
    references: Option<&[String]>,
) -> Result<(), String> {
    if references.is_some_and(|values| values.len() != tracks.len()) {
        return Err("DEVICE_SYNC_PLAYLIST_REFERENCES_INVALID".to_string());
    }
    let directory_name = playlist_directory_name(playlist_name, playlist_id);
    let playlist_dir = root.join("Playlists").join(&directory_name);
    let file_path = playlist_dir.join(format!("{}.m3u8", directory_name));
    if path_contains_symlink(root, &file_path)? {
        return Err("DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string());
    }

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
        let reference = references
            .and_then(|values| values.get(i))
            .cloned()
            .unwrap_or_else(|| {
                let artist_safe = sanitize_or(display_artist, "Unknown Artist");
                let title_safe = sanitize_or(title, "Unknown Title");
                format!(
                    "{:02} - {} - {}.{}",
                    idx, artist_safe, title_safe, track.suffix
                )
            });
        if reference.contains(['\r', '\n']) {
            return Err("DEVICE_SYNC_PLAYLIST_REFERENCE_INVALID".to_string());
        }
        body.push_str(&reference);
        body.push('\n');
    }
    replace_device_text_file(root, &file_path, body.as_bytes())
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
    // Find the longest mount-point prefix that matches this path.
    // Exclude the root "/" (or "C:\" on Windows) so we never "match" a fallback.
    let mut best_len: usize = 0;
    for disk in disks.list() {
        let mount_point = disk.mount_point();
        let mp = mount_point.to_string_lossy().to_string();
        // Skip root mount points (Linux "/" and non-removable Windows drive roots like "C:\").
        // Do NOT skip removable Windows drives (e.g. "E:\") — those are valid sync targets.
        let is_windows_root = mp.len() == 3 && mp.ends_with(":\\") && !disk.is_removable();
        if mp == "/" || is_windows_root {
            continue;
        }
        let canonical_mount = match mount_point.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        if path_is_within_mount(&canonical, &canonical_mount) && mp.len() > best_len {
            best_len = mp.len();
        }
    }
    best_len > 0
}

pub(super) fn ensure_mounted_target(path: &std::path::Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    if !is_path_on_mounted_volume(path) {
        return Err("NOT_MOUNTED_VOLUME".to_string());
    }
    Ok(())
}

fn path_is_within_mount(path: &std::path::Path, mount_point: &std::path::Path) -> bool {
    path.starts_with(mount_point)
}

#[derive(serde::Deserialize, serde::Serialize, Clone, specta::Type)]
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
    /// When set, the self-contained layout places this track under
    /// `Playlists/{name}/` with `playlist_index` as its filename prefix.
    #[serde(default, rename = "playlistName")]
    pub playlist_name: Option<String>,
    /// Stable source identity used to disambiguate playlists with the same display name.
    #[serde(default, rename = "playlistId")]
    pub playlist_id: Option<String>,
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

pub(crate) fn playlist_directory_name(name: &str, playlist_id: Option<&str>) -> String {
    let safe_name = sanitize_or(name, "Unnamed Playlist");
    match playlist_id.filter(|id| !id.trim().is_empty()) {
        Some(id) => {
            let digest = format!("{:x}", md5::compute(id.as_bytes()));
            format!("{safe_name} [{digest}]")
        }
        None => safe_name,
    }
}

pub(crate) fn playlist_collision_key(name: &str) -> String {
    sanitize_or(name, "Unnamed Playlist").to_lowercase()
}

/// Builds the fixed device path for a track. When the track carries a playlist
/// context it goes into the playlist folder, otherwise into the album tree.
///
/// Album-tree:  `{AlbumArtist}/{Album}/{TrackNum:02d} - {Title}.{ext}`
/// Playlist:    `Playlists/{PlaylistName}/{PlaylistIndex:02d} - {Artist} - {Title}.{ext}`
pub fn build_track_path(track: &TrackSyncInfo) -> String {
    let relative = match (&track.playlist_name, track.playlist_index) {
        (Some(name), Some(idx)) => {
            let playlist = playlist_directory_name(name, track.playlist_id.as_deref());
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

use tauri::Emitter;

use crate::file_transfer::{finalize_streamed_download, subsonic_http_client};

// ─── Device Sync ─────────────────────────────────────────────────────────────

/// Information about a single mounted removable drive.
#[derive(Clone, serde::Serialize)]
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
pub fn write_device_manifest(dest_dir: String, sources: serde_json::Value) -> Result<(), String> {
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
pub fn read_device_manifest(dest_dir: String) -> Option<serde_json::Value> {
    let path = std::path::Path::new(&dest_dir).join("psysonic-sync.json");
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Per-entry result for `rename_device_files`.
#[derive(serde::Serialize)]
pub struct RenameResult {
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
pub fn write_playlist_m3u8(
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
#[derive(Clone, serde::Serialize)]
pub struct SyncBatchResult {
    pub done: u32,
    pub skipped: u32,
    pub failed: u32,
}

#[derive(serde::Serialize)]
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
        .map(|c| if INVALID.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    sanitized.trim_matches(|c| c == '.' || c == ' ').to_string()
}

/// Sanitize and replace empty results with a placeholder — prevents paths like
/// `//01 - .flac` when metadata is missing.
pub fn sanitize_or(s: &str, fallback: &str) -> String {
    let cleaned = sanitize_path_component(s);
    if cleaned.is_empty() { fallback.to_string() } else { cleaned }
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
) -> Result<bool, String> {
    if dest_path.exists() {
        return Ok(false);
    }
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
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
    match sync_download_one_track(&dest_path, &track.suffix, &track.url, &client).await {
        Ok(false) => {
            let _ = app.emit("device:sync:progress", serde_json::json!({
                "jobId": job_id, "trackId": track.id, "status": "skipped", "path": path_str,
            }));
            Ok(SyncTrackResult { path: path_str, skipped: true })
        }
        Ok(true) => {
            let _ = app.emit("device:sync:progress", serde_json::json!({
                "jobId": job_id, "trackId": track.id, "status": "done", "path": path_str,
            }));
            Ok(SyncTrackResult { path: path_str, skipped: false })
        }
        Err(e) => {
            let _ = app.emit("device:sync:progress", serde_json::json!({
                "jobId": job_id, "trackId": track.id, "status": "error", "error": e,
            }));
            Err(e)
        }
    }
}

/// Computes the expected file paths for a batch of tracks under the fixed schema.
/// Used by the cleanup flow to find orphans.
#[tauri::command]
pub fn compute_sync_paths(tracks: Vec<TrackSyncInfo>, dest_dir: String) -> Vec<String> {
    tracks.iter().map(|track| {
        let relative = build_track_path(track);
        let file_name = format!("{}.{}", relative, track.suffix);
        std::path::Path::new(&dest_dir)
            .join(&file_name)
            .to_string_lossy()
            .to_string()
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(builder: impl FnOnce(&mut TrackSyncInfo)) -> TrackSyncInfo {
        let mut t = TrackSyncInfo {
            id: "t1".into(),
            url: "http://example/stream".into(),
            suffix: "flac".into(),
            artist: "Artist".into(),
            album_artist: "AlbumArtist".into(),
            album: "Album".into(),
            title: "Title".into(),
            track_number: Some(1),
            duration: Some(180),
            playlist_name: None,
            playlist_index: None,
        };
        builder(&mut t);
        t
    }

    /// Normalize Windows backslashes so assertions can be written with `/`.
    /// `build_track_path` only emits `\` as the OS path separator on Windows;
    /// any `\` that appears inside a name component is already replaced with
    /// `_` by `sanitize_path_component`.
    fn norm(p: String) -> String {
        p.replace('\\', "/")
    }

    // ── sanitize_path_component ──────────────────────────────────────────────

    #[test]
    fn sanitize_replaces_each_invalid_char_with_underscore() {
        assert_eq!(sanitize_path_component("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
    }

    #[test]
    fn sanitize_collapses_does_not_merge_acdc_with_ac_slash_dc() {
        // Important: AC/DC must NOT collapse to ACDC (which equals plain "ACDC").
        // It becomes AC_DC so the two artists stay distinguishable on disk.
        assert_eq!(sanitize_path_component("AC/DC"), "AC_DC");
        assert_ne!(sanitize_path_component("AC/DC"), sanitize_path_component("ACDC"));
    }

    #[test]
    fn sanitize_replaces_control_characters() {
        assert_eq!(sanitize_path_component("a\nb\tc\0d"), "a_b_c_d");
    }

    #[test]
    fn sanitize_trims_leading_and_trailing_dots_and_spaces() {
        assert_eq!(sanitize_path_component("  ..hello..  "), "hello");
        assert_eq!(sanitize_path_component(".."), "");
        assert_eq!(sanitize_path_component("   "), "");
    }

    #[test]
    fn sanitize_keeps_inner_dots_and_spaces() {
        assert_eq!(sanitize_path_component("Pink Floyd - The Wall"), "Pink Floyd - The Wall");
        assert_eq!(sanitize_path_component("01.intro"), "01.intro");
    }

    #[test]
    fn sanitize_preserves_unicode() {
        assert_eq!(sanitize_path_component("Sigur Rós — Ágætis byrjun"), "Sigur Rós — Ágætis byrjun");
        assert_eq!(sanitize_path_component("坂本龍一"), "坂本龍一");
    }

    // ── sanitize_or ──────────────────────────────────────────────────────────

    #[test]
    fn sanitize_or_uses_fallback_for_empty_input() {
        assert_eq!(sanitize_or("", "Unknown Artist"), "Unknown Artist");
    }

    #[test]
    fn sanitize_or_uses_fallback_when_sanitize_collapses_to_empty() {
        assert_eq!(sanitize_or("...", "Unknown Album"), "Unknown Album");
        assert_eq!(sanitize_or("   ", "Unknown Album"), "Unknown Album");
    }

    #[test]
    fn sanitize_or_returns_sanitized_when_non_empty() {
        assert_eq!(sanitize_or("Pink Floyd", "fallback"), "Pink Floyd");
        assert_eq!(sanitize_or("AC/DC", "fallback"), "AC_DC");
    }

    // ── build_track_path: album tree ─────────────────────────────────────────

    #[test]
    fn album_path_uses_album_artist_album_tracknum_title() {
        let t = track(|t| {
            t.album_artist = "Pink Floyd".into();
            t.album = "The Wall".into();
            t.title = "Comfortably Numb".into();
            t.track_number = Some(7);
        });
        assert_eq!(norm(build_track_path(&t)), "Pink Floyd/The Wall/07 - Comfortably Numb");
    }

    #[test]
    fn album_path_pads_track_number_to_two_digits() {
        let t = track(|t| {
            t.track_number = Some(3);
        });
        assert!(norm(build_track_path(&t)).contains("/03 - "));
    }

    #[test]
    fn album_path_uses_zero_zero_when_track_number_missing() {
        let t = track(|t| {
            t.track_number = None;
        });
        assert!(norm(build_track_path(&t)).contains("/00 - "));
    }

    #[test]
    fn album_path_falls_back_when_album_artist_missing() {
        let t = track(|t| {
            t.album_artist = "".into();
        });
        assert!(norm(build_track_path(&t)).starts_with("Unknown Artist/"));
    }

    #[test]
    fn album_path_falls_back_when_album_missing() {
        let t = track(|t| {
            t.album = "".into();
        });
        assert!(norm(build_track_path(&t)).contains("/Unknown Album/"));
    }

    #[test]
    fn album_path_falls_back_when_title_missing() {
        let t = track(|t| {
            t.title = "".into();
        });
        assert!(norm(build_track_path(&t)).ends_with(" - Unknown Title"));
    }

    #[test]
    fn album_path_sanitizes_each_component_independently() {
        let t = track(|t| {
            t.album_artist = "AC/DC".into();
            t.album = "Back: in/Black".into();
            t.title = "T.N.T.*".into();
            t.track_number = Some(2);
        });
        assert_eq!(norm(build_track_path(&t)), "AC_DC/Back_ in_Black/02 - T.N.T._");
    }

    // ── build_track_path: playlist tree ──────────────────────────────────────

    #[test]
    fn playlist_path_uses_track_artist_not_album_artist() {
        // Track-Artist in the playlist filename — useful label on a mixed playlist folder.
        let t = track(|t| {
            t.artist = "Roger Waters".into();
            t.album_artist = "Pink Floyd".into();
            t.title = "The Tide Is Turning".into();
            t.playlist_name = Some("Mix".into());
            t.playlist_index = Some(5);
        });
        assert_eq!(norm(build_track_path(&t)), "Playlists/Mix/05 - Roger Waters - The Tide Is Turning");
    }

    #[test]
    fn playlist_path_pads_index_to_two_digits() {
        let t = track(|t| {
            t.playlist_name = Some("P".into());
            t.playlist_index = Some(7);
        });
        assert!(norm(build_track_path(&t)).contains("/07 - "));
    }

    #[test]
    fn playlist_path_falls_back_when_playlist_name_missing_string() {
        let t = track(|t| {
            t.playlist_name = Some("".into());
            t.playlist_index = Some(1);
        });
        assert!(norm(build_track_path(&t)).starts_with("Playlists/Unnamed Playlist/"));
    }

    #[test]
    fn playlist_path_falls_back_when_track_artist_missing() {
        let t = track(|t| {
            t.artist = "".into();
            t.playlist_name = Some("Mix".into());
            t.playlist_index = Some(1);
        });
        assert!(norm(build_track_path(&t)).contains(" - Unknown Artist - "));
    }

    #[test]
    fn playlist_path_requires_both_name_and_index() {
        // playlist_name without playlist_index → falls through to album-tree.
        let t = track(|t| {
            t.playlist_name = Some("Mix".into());
            t.playlist_index = None;
        });
        let p = norm(build_track_path(&t));
        assert!(!p.starts_with("Playlists/"), "got {p}");

        // playlist_index without playlist_name → also album-tree.
        let t2 = track(|t| {
            t.playlist_name = None;
            t.playlist_index = Some(1);
        });
        let p2 = norm(build_track_path(&t2));
        assert!(!p2.starts_with("Playlists/"), "got {p2}");
    }

    // ── cross-OS separator ───────────────────────────────────────────────────

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_path_uses_backslash_separator() {
        let t = track(|_| {});
        // No forward slashes anywhere on Windows — the OS separator is `\`.
        assert!(!build_track_path(&t).contains('/'));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn unix_path_uses_forward_slash_separator() {
        let t = track(|_| {});
        // No backslashes anywhere on non-Windows — `\` would only appear if
        // sanitize_path_component had failed to replace it.
        assert!(!build_track_path(&t).contains('\\'));
        assert!(build_track_path(&t).contains('/'));
    }

    // ── sync_download_one_track ──────────────────────────────────────────────

    use crate::file_transfer::subsonic_http_client;
    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn sync_download_writes_track_file_for_200_response() {
        let server = MockServer::start().await;
        let body = b"flac body".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("Album").join("01 - track.flac");
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/track", server.uri());
        let downloaded = sync_download_one_track(&dest, "flac", &url, &client)
            .await
            .unwrap();
        assert!(downloaded, "fresh download must report Ok(true)");
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sync_download_returns_false_when_file_already_exists() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("track.mp3");
        std::fs::write(&dest, b"already there").unwrap();

        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/should-not-be-hit", server.uri());
        let downloaded = sync_download_one_track(&dest, "mp3", &url, &client)
            .await
            .unwrap();
        assert!(!downloaded, "pre-existing file must be reported as skipped");
        assert_eq!(std::fs::read(&dest).unwrap(), b"already there");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sync_download_returns_err_for_non_success_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/missing"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("track.opus");
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/missing", server.uri());
        let err = sync_download_one_track(&dest, "opus", &url, &client)
            .await
            .unwrap_err();
        assert!(err.contains("HTTP 403"));
        assert!(!dest.exists(), "no track file must be created on error");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn sync_download_creates_missing_parent_directories() {
        let server = MockServer::start().await;
        let body = b"x".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/t"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("a").join("b").join("c").join("track.mp3");
        assert!(!dest.parent().unwrap().exists());
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/t", server.uri());
        sync_download_one_track(&dest, "mp3", &url, &client)
            .await
            .unwrap();
        assert!(dest.exists());
    }
}

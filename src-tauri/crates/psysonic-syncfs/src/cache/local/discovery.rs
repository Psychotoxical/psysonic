use std::collections::HashSet;
use std::path::PathBuf;

use psysonic_core::cover_cache_layout::sanitize_path_segment;
use psysonic_core::media_layout::{layout_fingerprint, LocalTier};
use psysonic_library::repos::TrackRepository;
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, State};

use super::paths::{
    normalize_path_key, resolve_library_track_path, resolve_media_dir, track_row_to_path_input,
};
use super::{LibraryTierDiskHit, LibraryTrackProbeResult};

pub(super) async fn discover_library_tier_on_disk(
    server_index_key: String,
    library_server_id: String,
    candidate_track_ids: Vec<String>,
    media_dir: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<Vec<LibraryTierDiskHit>, String> {
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let segment = sanitize_path_segment(&server_index_key);
    let tier_root = media_root.join(LocalTier::Library.subdir()).join(&segment);
    let disk_files: HashSet<String> = if tier_root.is_dir() {
        super::super::fs_utils::collect_regular_files_under(&tier_root)
            .into_iter()
            .map(|p| normalize_path_key(&p))
            .collect()
    } else {
        HashSet::new()
    };
    if disk_files.is_empty() {
        return Ok(Vec::new());
    }

    let repo = TrackRepository::new(&runtime.store);
    let mut hits: Vec<LibraryTierDiskHit> = Vec::new();
    let mut seen_tracks: HashSet<String> = HashSet::new();

    let offline_rows = repo.list_offline_local_paths(&library_server_id)?;

    for (track_id, local_path, suffix_opt) in offline_rows {
        if seen_tracks.contains(&track_id) {
            continue;
        }
        let path = PathBuf::from(&local_path);
        let key = normalize_path_key(&path);
        if !disk_files.contains(&key) && !path.is_file() {
            continue;
        }
        let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
            continue;
        };
        let suffix = suffix_opt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                row.suffix
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or("mp3");
        let path_input = track_row_to_path_input(&row);
        let fingerprint = layout_fingerprint(&path_input);
        let size = tokio::fs::metadata(&path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        seen_tracks.insert(track_id.clone());
        hits.push(LibraryTierDiskHit {
            track_id,
            path: local_path,
            size,
            layout_fingerprint: fingerprint,
            suffix: suffix.to_string(),
        });
    }

    for track_id in candidate_track_ids {
        if seen_tracks.contains(&track_id) {
            continue;
        }
        let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
            continue;
        };
        let suffix = row
            .suffix
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("mp3");
        let resolved = resolve_library_track_path(
            &track_id,
            &server_index_key,
            &library_server_id,
            suffix,
            media_dir.as_deref(),
            &app,
            &runtime,
        )?;
        let canonical_key = normalize_path_key(&resolved.file_path);
        if !disk_files.contains(&canonical_key) && !resolved.file_path.is_file() {
            continue;
        }
        let size = tokio::fs::metadata(&resolved.file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        seen_tracks.insert(track_id.clone());
        hits.push(LibraryTierDiskHit {
            track_id,
            path: resolved.path_str,
            size,
            layout_fingerprint: resolved.layout_fingerprint,
            suffix: suffix.to_string(),
        });
    }

    Ok(hits)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn probe_library_track_local(
    track_id: String,
    server_index_key: String,
    library_server_id: String,
    suffix: String,
    media_dir: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<LibraryTrackProbeResult, String> {
    let resolved = resolve_library_track_path(
        &track_id,
        &server_index_key,
        &library_server_id,
        &suffix,
        media_dir.as_deref(),
        &app,
        &runtime,
    )?;
    let exists = resolved.file_path.is_file();
    let size = if exists {
        tokio::fs::metadata(&resolved.file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    Ok(LibraryTrackProbeResult {
        path: resolved.path_str,
        size,
        layout_fingerprint: resolved.layout_fingerprint,
        exists,
    })
}

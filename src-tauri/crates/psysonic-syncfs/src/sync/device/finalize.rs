use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::manifest::{
    replace_device_text_file, sync_device_directory, write_device_manifest_payload,
    DeviceManifestWrite,
};
use super::{
    path_contains_symlink, planned_path_stays_within, playlist_directory_name, resolve_within_root,
    validate_device_identity, write_playlist_m3u8_within_root, TrackSyncInfo,
};
use crate::sync::batch::{
    activate_device_sync_plan, clear_device_sync_plan, normalized_manifest_files,
    normalized_manifest_playlists, normalized_strings, portable_path_identity,
    relative_delete_paths, DeviceSyncLayoutMode, DeviceSyncManifestFile,
    DeviceSyncManifestPlaylist, DeviceSyncPlanPlaylist, DeviceSyncPlaylistPathMode,
};

#[derive(serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncFinalizeSource {
    #[serde(rename = "type")]
    source_type: String,
    id: String,
    name: String,
    path_id: Option<String>,
    server_index_key: String,
    artist: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncFinalizePlaylist {
    name: String,
    path_id: Option<String>,
    tracks: Vec<TrackSyncInfo>,
    references: Vec<String>,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncFinalizePayload {
    plan_id: String,
    expected_device_id: String,
    owner_server_index_key: String,
    sources: Vec<DeviceSyncFinalizeSource>,
    canonical_id_version: Option<u8>,
    layout_mode: String,
    playlist_path_mode: String,
    files: Vec<DeviceSyncManifestFile>,
    manifest_playlists: Vec<DeviceSyncManifestPlaylist>,
    playlists: Vec<DeviceSyncFinalizePlaylist>,
    deferred_delete_paths: Vec<String>,
}

#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncFinalizeResult {
    deleted: u32,
    cleanup_failed: bool,
}

fn playlist_path(root: &Path, playlist: &DeviceSyncFinalizePlaylist) -> PathBuf {
    let directory = playlist_directory_name(&playlist.name, playlist.path_id.as_deref());
    root.join("Playlists")
        .join(&directory)
        .join(format!("{directory}.m3u8"))
}

fn restore_playlist(root: &Path, path: &Path, previous: Option<&[u8]>) -> Result<(), String> {
    match previous {
        Some(contents) => replace_device_text_file(root, path, contents),
        None => match std::fs::remove_file(path) {
            Ok(()) => sync_device_directory(path.parent()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        },
    }
}

fn rollback_playlists(
    root: &Path,
    written_playlists: &[(PathBuf, Option<Vec<u8>>)],
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (path, previous) in written_playlists.iter().rev() {
        if let Err(error) = restore_playlist(root, path, previous.as_deref()) {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn checked_existing_path(root: &Path, raw: &str) -> Result<Option<PathBuf>, String> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() || !path.exists() {
        return Ok(None);
    }
    if path_contains_symlink(root, &path)? {
        return Err("DEVICE_SYNC_DELETE_PATH_INVALID".to_string());
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("DEVICE_SYNC_DELETE_PATH_INVALID".to_string());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_path.starts_with(&canonical_root) || canonical_path == canonical_root {
        return Err("DEVICE_SYNC_DELETE_OUTSIDE_ROOT".to_string());
    }
    Ok(Some(path))
}

fn prune_empty_parents(root: &Path, path: &Path, levels: usize) -> Result<(), String> {
    let mut current = path.parent();
    for _ in 0..levels {
        let Some(directory) = current else {
            break;
        };
        if directory == root {
            break;
        }
        let parent = directory.parent();
        match std::fs::remove_dir(directory) {
            Ok(()) => {
                sync_device_directory(parent)?;
                current = parent;
            }
            Err(_) => break,
        }
    }
    Ok(())
}

fn parse_layout_mode(value: &str) -> Result<DeviceSyncLayoutMode, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|_| "DEVICE_SYNC_LAYOUT_MODE_INVALID".to_string())
}

fn parse_playlist_path_mode(value: &str) -> Result<DeviceSyncPlaylistPathMode, String> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|_| "DEVICE_SYNC_PLAYLIST_PATH_MODE_INVALID".to_string())
}

fn source_keys(sources: &[DeviceSyncFinalizeSource]) -> Vec<String> {
    normalized_strings(sources.iter().filter_map(|source| {
        serde_json::to_string(&(&source.server_index_key, &source.source_type, &source.id)).ok()
    }))
}

fn planned_playlists(
    root: &Path,
    playlists: &[DeviceSyncFinalizePlaylist],
) -> Result<Vec<DeviceSyncPlanPlaylist>, String> {
    let mut planned = Vec::with_capacity(playlists.len());
    for playlist in playlists {
        let path = playlist_path(root, playlist);
        let relative_path = path
            .strip_prefix(root)
            .map_err(|_| "DEVICE_SYNC_PLAYLIST_PATH_INVALID".to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        planned.push(DeviceSyncPlanPlaylist {
            relative_path,
            track_ids: playlist
                .tracks
                .iter()
                .map(|track| track.id.clone())
                .collect(),
            references: playlist.references.clone(),
        });
    }
    planned.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(planned)
}

fn verify_plan(
    root: &Path,
    payload: &DeviceSyncFinalizePayload,
    plan: &crate::sync::batch::DeviceSyncPlanRecord,
) -> Result<(), String> {
    let layout_mode = parse_layout_mode(&payload.layout_mode)?;
    let playlist_path_mode = parse_playlist_path_mode(&payload.playlist_path_mode)?;
    if plan.owner_server_index_key != payload.owner_server_index_key
        || plan.source_keys != source_keys(&payload.sources)
        || plan.layout_mode != layout_mode
        || plan.playlist_path_mode != playlist_path_mode
        || plan.manifest_files != normalized_manifest_files(&payload.files)
        || plan.manifest_playlists != normalized_manifest_playlists(&payload.manifest_playlists)
        || plan.playlists != planned_playlists(root, &payload.playlists)?
        || plan.delete_paths
            != relative_delete_paths(root, payload.deferred_delete_paths.iter().cloned())?
    {
        return Err("DEVICE_SYNC_PENDING_PLAN_MISMATCH".to_string());
    }
    Ok(())
}

fn preflight_files_and_references(
    root: &Path,
    payload: &DeviceSyncFinalizePayload,
) -> Result<HashSet<PathBuf>, String> {
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let mut files = HashMap::new();
    for file in &payload.files {
        let path = resolve_within_root(root, &file.relative_path)
            .ok_or_else(|| "DEVICE_SYNC_PLANNED_PATH_INVALID".to_string())?;
        if !planned_path_stays_within(root, &path).map_err(|error| error.to_string())?
            || path_contains_symlink(root, &path)?
        {
            return Err("DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT".to_string());
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|_| format!("DEVICE_SYNC_REPLACEMENT_MISSING:{}", file.relative_path))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "DEVICE_SYNC_REPLACEMENT_INVALID:{}",
                file.relative_path
            ));
        }
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT".to_string());
        }
        files.insert(portable_path_identity(&file.relative_path), canonical);
    }

    for playlist in &payload.playlists {
        let playlist_file = playlist_path(root, playlist);
        if path_contains_symlink(root, &playlist_file)? {
            return Err("DEVICE_SYNC_PLAYLIST_PATH_INVALID".to_string());
        }
        let parent = playlist_file
            .parent()
            .ok_or_else(|| "DEVICE_SYNC_PLAYLIST_PATH_INVALID".to_string())?;
        for reference in &playlist.references {
            let candidate = if let Some(rooted) = reference.strip_prefix('/') {
                root.join(rooted)
            } else {
                parent.join(reference)
            };
            let canonical = candidate
                .canonicalize()
                .map_err(|_| "DEVICE_SYNC_PLAYLIST_REFERENCE_MISSING".to_string())?;
            if !canonical.starts_with(&canonical_root)
                || !files.values().any(|file| file == &canonical)
            {
                return Err("DEVICE_SYNC_PLAYLIST_REFERENCE_INVALID".to_string());
            }
        }
    }
    Ok(files.into_values().collect())
}

pub(super) fn finalize_device_sync_impl(
    root: &Path,
    payload: DeviceSyncFinalizePayload,
) -> Result<DeviceSyncFinalizeResult, String> {
    finalize_device_sync_with_validator(root, payload, validate_device_identity)
}

fn finalize_device_sync_with_validator(
    root: &Path,
    payload: DeviceSyncFinalizePayload,
    validate: impl Fn(&Path, &str) -> Result<(), String>,
) -> Result<DeviceSyncFinalizeResult, String> {
    let expected_device_id = payload.expected_device_id.clone();
    validate(root, &expected_device_id)?;
    let plan = activate_device_sync_plan(root, &payload.plan_id, &expected_device_id)?;
    verify_plan(root, &payload, &plan)?;
    let desired_files = preflight_files_and_references(root, &payload)?;

    let mut written_playlists = Vec::new();
    let operation = (|| -> Result<(), String> {
        for playlist in &payload.playlists {
            validate(root, &expected_device_id)?;
            let path = playlist_path(root, playlist);
            let previous = match std::fs::read(&path) {
                Ok(contents) => Some(contents),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.to_string()),
            };
            write_playlist_m3u8_within_root(
                root,
                &playlist.name,
                playlist.path_id.as_deref(),
                &playlist.tracks,
                Some(&playlist.references),
            )?;
            written_playlists.push((path, previous));
        }

        validate(root, &expected_device_id)?;
        write_device_manifest_payload(DeviceManifestWrite {
            dest_dir: root.to_string_lossy().to_string(),
            owner_server_index_key: payload.owner_server_index_key.clone(),
            sources: serde_json::to_value(&payload.sources).map_err(|error| error.to_string())?,
            canonical_id_version: payload.canonical_id_version,
            layout_mode: Some(payload.layout_mode.clone()),
            playlist_path_mode: Some(payload.playlist_path_mode.clone()),
            files: Some(serde_json::to_value(&payload.files).map_err(|error| error.to_string())?),
            playlists: Some(
                serde_json::to_value(&payload.manifest_playlists)
                    .map_err(|error| error.to_string())?,
            ),
        })
    })();

    if let Err(error) = operation {
        if validate(root, &expected_device_id).is_err() {
            return Err(format!("{error}; DEVICE_SYNC_DEVICE_CHANGED"));
        }
        return match rollback_playlists(root, &written_playlists) {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(format!("{error}; rollback failed: {rollback_error}")),
        };
    }

    let mut deleted = 0_u32;
    let mut cleanup_failed = false;
    for relative_path in &plan.delete_paths {
        if validate(root, &expected_device_id).is_err() {
            cleanup_failed = true;
            break;
        }
        let path = resolve_within_root(root, relative_path)
            .ok_or_else(|| "DEVICE_SYNC_DELETE_PATH_INVALID".to_string())?;
        let Some(path) = checked_existing_path(root, &path.to_string_lossy())? else {
            continue;
        };
        let canonical = path.canonicalize().map_err(|error| error.to_string())?;
        if desired_files.contains(&canonical) {
            return Err("DEVICE_SYNC_DELETE_PATH_STILL_DESIRED".to_string());
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                deleted = deleted.saturating_add(1);
                if sync_device_directory(path.parent()).is_err()
                    || prune_empty_parents(root, &path, 2).is_err()
                {
                    cleanup_failed = true;
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => cleanup_failed = true,
        }
    }
    if !cleanup_failed {
        clear_device_sync_plan(root, &payload.plan_id)?;
    }
    Ok(DeviceSyncFinalizeResult {
        deleted,
        cleanup_failed,
    })
}

#[cfg(test)]
mod tests;

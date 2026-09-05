use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use super::payload::{device_sync_source_key, playlist_collision_source_keys};
use super::{
    estimate_track_size_bytes, inject_playlist_context, track_sync_info_from_subsonic_json,
    DeviceSyncLayoutMode, DeviceSyncManifestFile, DeviceSyncManifestPlaylist,
    DeviceSyncPlannedPlaylist, DeviceSyncPlaylistPathMode, DeviceSyncSourcePayload,
    SyncDeltaResult,
};
use crate::sync::device::{
    build_track_path, planned_path_stays_within, playlist_directory_name, read_device_manifest,
    resolve_within_root,
};

mod manifest;
mod retained;

pub(crate) use manifest::portable_path_identity;
use manifest::{
    manifest_layout_mode, manifest_source_keys, old_manifest_files, old_manifest_playlists,
};
use retained::{retained_manifest_files, retained_manifest_playlists};

#[derive(Clone)]
pub(super) struct FetchedDeviceSyncSource {
    pub source: DeviceSyncSourcePayload,
    pub tracks: Vec<serde_json::Value>,
}

#[derive(Clone)]
struct DesiredFile {
    track_id: String,
    relative_path: String,
    source_keys: BTreeSet<String>,
    size_bytes: u64,
    track: serde_json::Value,
    playlist_name: Option<String>,
    playlist_id: Option<String>,
    playlist_index: Option<u32>,
}

struct DesiredState {
    files: BTreeMap<String, DesiredFile>,
    playlists: Vec<DeviceSyncPlannedPlaylist>,
    manifest_playlists: Vec<DeviceSyncManifestPlaylist>,
}

struct DesiredFileInput<'a> {
    key: String,
    source_key: &'a str,
    track_id: &'a str,
    track: &'a serde_json::Value,
    playlist_name: Option<&'a str>,
    playlist_id: Option<&'a str>,
    playlist_index: Option<u32>,
}

fn portable_track_path(track: &crate::sync::device::TrackSyncInfo) -> String {
    format!("{}.{}", build_track_path(track), track.suffix).replace('\\', "/")
}

fn playlist_manifest_path(name: &str, path_id: Option<&str>) -> String {
    let directory = playlist_directory_name(name, path_id);
    format!("Playlists/{directory}/{directory}.m3u8")
}

fn playlist_reference(relative_path: &str, mode: DeviceSyncPlaylistPathMode) -> String {
    match mode {
        DeviceSyncPlaylistPathMode::PlaylistRelative => format!("../../{relative_path}"),
        DeviceSyncPlaylistPathMode::DeviceRooted => format!("/{relative_path}"),
    }
}

fn physical_key(
    source: &DeviceSyncSourcePayload,
    source_key: &str,
    track_id: &str,
    playlist_index: u32,
    layout_mode: DeviceSyncLayoutMode,
) -> String {
    if source.source_type == "playlist" && layout_mode == DeviceSyncLayoutMode::SelfContained {
        format!("playlist:{source_key}:{playlist_index}:{track_id}")
    } else {
        format!("track:{track_id}")
    }
}

fn add_file(
    files: &mut BTreeMap<String, DesiredFile>,
    paths: &mut HashMap<String, String>,
    input: DesiredFileInput<'_>,
) -> Result<String, String> {
    if let Some(existing) = files.get_mut(&input.key) {
        existing.source_keys.insert(input.source_key.to_string());
        return Ok(existing.relative_path.clone());
    }

    let sync_info = track_sync_info_from_subsonic_json(
        input.track,
        input.track_id,
        input.playlist_name,
        input.playlist_id,
        input.playlist_index,
    );
    let relative_path = portable_track_path(&sync_info);
    let path_identity = portable_path_identity(&relative_path);
    if let Some(existing_key) = paths.get(&path_identity) {
        if existing_key != &input.key {
            return Err(format!("DEVICE_SYNC_PATH_COLLISION:{relative_path}"));
        }
    }
    paths.insert(path_identity, input.key.clone());

    let mut source_keys = BTreeSet::new();
    source_keys.insert(input.source_key.to_string());
    files.insert(
        input.key,
        DesiredFile {
            track_id: input.track_id.to_string(),
            relative_path: relative_path.clone(),
            source_keys,
            size_bytes: estimate_track_size_bytes(input.track),
            track: input.track.clone(),
            playlist_name: input.playlist_name.map(str::to_string),
            playlist_id: input.playlist_id.map(str::to_string),
            playlist_index: input.playlist_index,
        },
    );
    Ok(relative_path)
}

fn build_desired_state(
    fetched: &[FetchedDeviceSyncSource],
    included_source_keys: &HashSet<String>,
    layout_mode: DeviceSyncLayoutMode,
    playlist_path_mode: DeviceSyncPlaylistPathMode,
) -> Result<DesiredState, String> {
    let included_sources = fetched
        .iter()
        .filter(|entry| included_source_keys.contains(&device_sync_source_key(&entry.source)))
        .map(|entry| entry.source.clone())
        .collect::<Vec<_>>();
    let collision_sources = playlist_collision_source_keys(&included_sources);
    let mut files = BTreeMap::new();
    let mut paths = HashMap::new();

    // Album/artist metadata wins when a shared track is also present in a playlist.
    for entry in fetched.iter().filter(|entry| {
        entry.source.source_type != "playlist"
            && included_source_keys.contains(&device_sync_source_key(&entry.source))
    }) {
        let source_key = device_sync_source_key(&entry.source);
        for track in &entry.tracks {
            let Some(track_id) = track.get("id").and_then(|value| value.as_str()) else {
                continue;
            };
            let key = physical_key(&entry.source, &source_key, track_id, 0, layout_mode);
            add_file(
                &mut files,
                &mut paths,
                DesiredFileInput {
                    key,
                    source_key: &source_key,
                    track_id,
                    track,
                    playlist_name: None,
                    playlist_id: None,
                    playlist_index: None,
                },
            )?;
        }
    }

    let mut playlists = Vec::new();
    let mut manifest_playlists = Vec::new();
    for entry in fetched.iter().filter(|entry| {
        entry.source.source_type == "playlist"
            && included_source_keys.contains(&device_sync_source_key(&entry.source))
    }) {
        let source_key = device_sync_source_key(&entry.source);
        let playlist_name = entry.source.name.as_deref().unwrap_or("");
        let playlist_id = entry.source.path_id.as_deref().or_else(|| {
            collision_sources
                .contains(&source_key)
                .then_some(entry.source.id.as_str())
        });
        let relative_playlist_path = playlist_manifest_path(playlist_name, playlist_id);
        let mut playlist_tracks = Vec::with_capacity(entry.tracks.len());
        let mut references = Vec::with_capacity(entry.tracks.len());

        for (index, track) in entry.tracks.iter().enumerate() {
            let Some(track_id) = track.get("id").and_then(|value| value.as_str()) else {
                continue;
            };
            let playlist_index = (index as u32) + 1;
            let key = physical_key(
                &entry.source,
                &source_key,
                track_id,
                playlist_index,
                layout_mode,
            );
            let (path_name, path_id, path_index) =
                if layout_mode == DeviceSyncLayoutMode::SelfContained {
                    (Some(playlist_name), playlist_id, Some(playlist_index))
                } else {
                    (None, None, None)
                };
            let relative_track_path = add_file(
                &mut files,
                &mut paths,
                DesiredFileInput {
                    key,
                    source_key: &source_key,
                    track_id,
                    track,
                    playlist_name: path_name,
                    playlist_id: path_id,
                    playlist_index: path_index,
                },
            )?;
            let reference = if layout_mode == DeviceSyncLayoutMode::SelfContained {
                relative_track_path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&relative_track_path)
                    .to_string()
            } else {
                playlist_reference(&relative_track_path, playlist_path_mode)
            };
            playlist_tracks.push(track.clone());
            references.push(reference);
        }

        playlists.push(DeviceSyncPlannedPlaylist {
            source_key: source_key.clone(),
            name: playlist_name.to_string(),
            path_id: playlist_id.map(str::to_string),
            relative_path: relative_playlist_path.clone(),
            tracks: playlist_tracks,
            references,
        });
        manifest_playlists.push(DeviceSyncManifestPlaylist {
            source_key,
            relative_path: relative_playlist_path,
        });
    }

    Ok(DesiredState {
        files,
        playlists,
        manifest_playlists,
    })
}

fn manifest_files(state: &DesiredState) -> Vec<DeviceSyncManifestFile> {
    state
        .files
        .values()
        .map(|file| DeviceSyncManifestFile {
            track_id: file.track_id.clone(),
            relative_path: file.relative_path.clone(),
            source_keys: file.source_keys.iter().cloned().collect(),
            size_bytes: file.size_bytes,
        })
        .collect()
}

#[cfg(test)]
pub(super) fn build_sync_plan(
    fetched: &[FetchedDeviceSyncSource],
    deletion_ids: &[String],
    target_dir: &str,
    layout_mode: DeviceSyncLayoutMode,
    playlist_path_mode: DeviceSyncPlaylistPathMode,
) -> Result<SyncDeltaResult, String> {
    build_sync_plan_with_resume(
        fetched,
        deletion_ids,
        target_dir,
        layout_mode,
        playlist_path_mode,
        None,
    )
}

pub(super) fn build_sync_plan_with_resume(
    fetched: &[FetchedDeviceSyncSource],
    deletion_ids: &[String],
    target_dir: &str,
    layout_mode: DeviceSyncLayoutMode,
    playlist_path_mode: DeviceSyncPlaylistPathMode,
    resume_files: Option<&[DeviceSyncManifestFile]>,
) -> Result<SyncDeltaResult, String> {
    let root = Path::new(target_dir);
    let deletion_keys = deletion_ids.iter().cloned().collect::<HashSet<_>>();
    let all_source_keys = fetched
        .iter()
        .map(|entry| device_sync_source_key(&entry.source))
        .collect::<HashSet<_>>();
    let desired_source_keys = all_source_keys
        .difference(&deletion_keys)
        .cloned()
        .collect::<HashSet<_>>();
    let desired = build_desired_state(
        fetched,
        &desired_source_keys,
        layout_mode,
        playlist_path_mode,
    )?;

    let previous_manifest = read_device_manifest(target_dir.to_string());
    if let (Some(manifest), Some(owner)) = (
        previous_manifest.as_ref(),
        fetched
            .first()
            .map(|entry| entry.source.server_index_key.as_str()),
    ) {
        if manifest
            .get("ownerServerIndexKey")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|previous_owner| previous_owner != owner)
        {
            return Err("DEVICE_SYNC_SERVER_OWNER_MISMATCH".to_string());
        }
    }
    let previous_source_keys = previous_manifest
        .as_ref()
        .map(manifest_source_keys)
        .filter(|keys| !keys.is_empty())
        .unwrap_or_else(|| all_source_keys.clone());
    let derived_old = build_desired_state(
        fetched,
        &previous_source_keys,
        manifest_layout_mode(previous_manifest.as_ref()),
        DeviceSyncPlaylistPathMode::PlaylistRelative,
    )?;
    let has_materialized_plan = previous_manifest.as_ref().is_some_and(|manifest| {
        manifest.get("files").is_some() && manifest.get("playlists").is_some()
    });
    let derived_old_files = manifest_files(&derived_old);
    let expected_old_files = derived_old_files
        .iter()
        .map(|file| (portable_path_identity(&file.relative_path), file))
        .collect::<HashMap<_, _>>();
    let materialized_old_files = previous_manifest.as_ref().and_then(old_manifest_files);
    let old_files = materialized_old_files
        .clone()
        .map(|files| {
            files
                .into_iter()
                .filter(|file| {
                    let Some(expected) =
                        expected_old_files.get(&portable_path_identity(&file.relative_path))
                    else {
                        return false;
                    };
                    file.track_id == expected.track_id
                        && !file.source_keys.is_empty()
                        && file
                            .source_keys
                            .iter()
                            .all(|key| previous_source_keys.contains(key))
                })
                .collect()
        })
        .unwrap_or(derived_old_files);
    let expected_old_playlists = derived_old
        .manifest_playlists
        .iter()
        .map(|playlist| (portable_path_identity(&playlist.relative_path), playlist))
        .collect::<HashMap<_, _>>();
    let materialized_old_playlists = previous_manifest.as_ref().and_then(old_manifest_playlists);
    let old_playlists = materialized_old_playlists
        .clone()
        .map(|playlists| {
            playlists
                .into_iter()
                .filter(|playlist| {
                    expected_old_playlists
                        .get(&portable_path_identity(&playlist.relative_path))
                        .is_some_and(|expected| playlist.source_key == expected.source_key)
                })
                .collect()
        })
        .unwrap_or(derived_old.manifest_playlists);

    let desired_paths = desired
        .files
        .values()
        .map(|file| portable_path_identity(&file.relative_path))
        .collect::<HashSet<_>>();
    let desired_tracks_by_path = desired
        .files
        .values()
        .map(|file| {
            (
                portable_path_identity(&file.relative_path),
                file.track_id.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut desired_paths_by_track: HashMap<&str, Vec<&str>> = HashMap::new();
    for file in desired.files.values() {
        desired_paths_by_track
            .entry(&file.track_id)
            .or_default()
            .push(&file.relative_path);
    }
    let mut old_files_by_path = HashMap::new();
    for file in &old_files {
        let path_identity = portable_path_identity(&file.relative_path);
        if old_files_by_path
            .insert(path_identity, file.track_id.as_str())
            .is_some_and(|track_id| track_id != file.track_id)
        {
            return Err("DEVICE_SYNC_MANIFEST_PLAN_INVALID".to_string());
        }
    }
    let resume_files_by_path = resume_files
        .unwrap_or_default()
        .iter()
        .map(|file| {
            (
                portable_path_identity(&file.relative_path),
                file.track_id.as_str(),
            )
        })
        .collect::<HashMap<_, _>>();

    let mut delete_paths = Vec::new();
    let mut deferred_delete_paths = Vec::new();
    let mut del_bytes = 0_u64;
    let mut reclaimable_bytes = 0_u64;
    for old in &old_files {
        let path_identity = portable_path_identity(&old.relative_path);
        if desired_paths.contains(&path_identity) {
            let desired_track_id = desired_tracks_by_path.get(&path_identity).copied();
            if desired_track_id != Some(old.track_id.as_str()) {
                return Err(format!(
                    "DEVICE_SYNC_PATH_IDENTITY_COLLISION:{}",
                    old.relative_path
                ));
            }
            continue;
        }
        let Some(absolute) = resolve_within_root(root, &old.relative_path) else {
            return Err("DEVICE_SYNC_MANIFEST_PATH_INVALID".to_string());
        };
        if !absolute.exists() {
            continue;
        }
        if !planned_path_stays_within(root, &absolute).map_err(|error| error.to_string())? {
            return Err("DEVICE_SYNC_MANIFEST_PATH_ESCAPES_ROOT".to_string());
        }
        del_bytes = del_bytes.saturating_add(old.size_bytes);
        let waits_for_replacement = desired_paths_by_track
            .get(old.track_id.as_str())
            .is_some_and(|paths| {
                paths
                    .iter()
                    .any(|path| resolve_within_root(root, path).is_some_and(|next| !next.exists()))
            });
        if waits_for_replacement {
            deferred_delete_paths.push(absolute.to_string_lossy().to_string());
        } else {
            reclaimable_bytes = reclaimable_bytes.saturating_add(old.size_bytes);
            delete_paths.push(absolute.to_string_lossy().to_string());
        }
    }

    let desired_playlist_paths = desired
        .manifest_playlists
        .iter()
        .map(|playlist| portable_path_identity(&playlist.relative_path))
        .collect::<HashSet<_>>();
    for old in &old_playlists {
        if desired_playlist_paths.contains(&portable_path_identity(&old.relative_path)) {
            continue;
        }
        let Some(absolute) = resolve_within_root(root, &old.relative_path) else {
            return Err("DEVICE_SYNC_MANIFEST_PATH_INVALID".to_string());
        };
        if absolute.exists() {
            if !planned_path_stays_within(root, &absolute).map_err(|error| error.to_string())? {
                return Err("DEVICE_SYNC_MANIFEST_PATH_ESCAPES_ROOT".to_string());
            }
            delete_paths.push(absolute.to_string_lossy().to_string());
        }
    }

    let mut tracks = Vec::new();
    let mut add_bytes = 0_u64;
    for file in desired.files.values() {
        let Some(absolute) = resolve_within_root(root, &file.relative_path) else {
            return Err("DEVICE_SYNC_PLANNED_PATH_INVALID".to_string());
        };
        if !planned_path_stays_within(root, &absolute).map_err(|error| error.to_string())? {
            return Err("DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT".to_string());
        }
        if absolute.exists() {
            if has_materialized_plan
                && old_files_by_path
                    .get(&portable_path_identity(&file.relative_path))
                    .copied()
                    != Some(file.track_id.as_str())
                && resume_files_by_path
                    .get(&portable_path_identity(&file.relative_path))
                    .copied()
                    != Some(file.track_id.as_str())
            {
                return Err(format!(
                    "DEVICE_SYNC_PATH_IDENTITY_COLLISION:{}",
                    file.relative_path
                ));
            }
            continue;
        }
        let mut track = file.track.clone();
        inject_playlist_context(
            &mut track,
            file.playlist_name.as_deref(),
            file.playlist_id.as_deref(),
            file.playlist_index,
        );
        add_bytes = add_bytes.saturating_add(file.size_bytes);
        tracks.push(track);
    }

    let authenticated_file_paths = old_files
        .iter()
        .map(|file| portable_path_identity(&file.relative_path))
        .collect::<HashSet<_>>();
    let mut desired_manifest_files = manifest_files(&desired);
    desired_manifest_files.extend(retained_manifest_files(
        root,
        materialized_old_files.unwrap_or_default(),
        &authenticated_file_paths,
        &desired_paths,
    ));
    desired_manifest_files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let authenticated_playlist_paths = old_playlists
        .iter()
        .map(|playlist| portable_path_identity(&playlist.relative_path))
        .collect::<HashSet<_>>();
    let mut desired_manifest_playlists = desired.manifest_playlists;
    desired_manifest_playlists.extend(retained_manifest_playlists(
        root,
        materialized_old_playlists.unwrap_or_default(),
        &authenticated_playlist_paths,
        &desired_playlist_paths,
    ));
    desired_manifest_playlists.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(SyncDeltaResult {
        plan_id: String::new(),
        device_id: String::new(),
        add_bytes,
        add_count: tracks.len() as u32,
        del_bytes,
        del_count: (delete_paths.len() + deferred_delete_paths.len()) as u32,
        reclaimable_bytes,
        available_bytes: 0,
        tracks,
        delete_paths,
        deferred_delete_paths,
        playlists: desired.playlists,
        manifest_files: desired_manifest_files,
        manifest_playlists: desired_manifest_playlists,
    })
}

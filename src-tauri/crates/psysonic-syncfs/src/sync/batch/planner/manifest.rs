use std::collections::HashSet;

use super::{DeviceSyncLayoutMode, DeviceSyncManifestFile, DeviceSyncManifestPlaylist};

pub(super) fn portable_path_identity(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

fn source_type_from_key(source_key: &str) -> Option<String> {
    serde_json::from_str::<(String, String, String)>(source_key)
        .ok()
        .map(|(_, source_type, _)| source_type)
}

fn manifest_path_components(path: &str) -> Option<Vec<&str>> {
    if path.is_empty() || path.contains('\\') {
        return None;
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| component.is_empty() || *component == "." || *component == "..")
    {
        return None;
    }
    Some(components)
}

pub(super) fn manifest_file_is_owned(
    file: &DeviceSyncManifestFile,
    source_keys: &HashSet<String>,
    layout_mode: DeviceSyncLayoutMode,
) -> bool {
    if file.source_keys.is_empty()
        || file
            .source_keys
            .iter()
            .any(|key| !source_keys.contains(key))
    {
        return false;
    }
    let Some(components) = manifest_path_components(&file.relative_path) else {
        return false;
    };
    if components.len() != 3 {
        return false;
    }
    let has_playlist_owner = file
        .source_keys
        .iter()
        .any(|key| source_type_from_key(key).as_deref() == Some("playlist"));
    match layout_mode {
        DeviceSyncLayoutMode::SharedAlbumTree => components[0] != "Playlists",
        DeviceSyncLayoutMode::SelfContained if has_playlist_owner => components[0] == "Playlists",
        DeviceSyncLayoutMode::SelfContained => components[0] != "Playlists",
    }
}

pub(super) fn manifest_playlist_is_owned(
    playlist: &DeviceSyncManifestPlaylist,
    source_keys: &HashSet<String>,
) -> bool {
    if !source_keys.contains(&playlist.source_key)
        || source_type_from_key(&playlist.source_key).as_deref() != Some("playlist")
    {
        return false;
    }
    let Some(components) = manifest_path_components(&playlist.relative_path) else {
        return false;
    };
    components.len() == 3
        && components[0] == "Playlists"
        && components[2] == format!("{}.m3u8", components[1])
}

pub(super) fn manifest_source_keys(manifest: &serde_json::Value) -> HashSet<String> {
    manifest
        .get("sources")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|source| {
            let server = source.get("serverIndexKey")?.as_str()?;
            let source_type = source.get("type")?.as_str()?;
            let id = source.get("id")?.as_str()?;
            serde_json::to_string(&(server, source_type, id)).ok()
        })
        .collect()
}

pub(super) fn manifest_layout_mode(manifest: Option<&serde_json::Value>) -> DeviceSyncLayoutMode {
    manifest
        .and_then(|value| value.get("layoutMode"))
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

pub(super) fn old_manifest_files(
    manifest: &serde_json::Value,
) -> Option<Vec<DeviceSyncManifestFile>> {
    manifest
        .get("files")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

pub(super) fn old_manifest_playlists(
    manifest: &serde_json::Value,
) -> Option<Vec<DeviceSyncManifestPlaylist>> {
    manifest
        .get("playlists")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

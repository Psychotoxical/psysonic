use std::collections::HashSet;

use super::{DeviceSyncLayoutMode, DeviceSyncManifestFile, DeviceSyncManifestPlaylist};

pub(crate) fn portable_path_identity(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
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

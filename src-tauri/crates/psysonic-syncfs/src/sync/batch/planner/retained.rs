use std::collections::HashSet;
use std::path::Path;

use crate::sync::batch::{DeviceSyncManifestFile, DeviceSyncManifestPlaylist};
use crate::sync::device::{path_contains_symlink, resolve_within_root};

use super::portable_path_identity;

fn exists_as_regular_file(root: &Path, relative_path: &str) -> bool {
    resolve_within_root(root, relative_path)
        .and_then(|absolute| {
            std::fs::symlink_metadata(&absolute)
                .ok()
                .map(|metadata| (absolute, metadata))
        })
        .is_some_and(|(absolute, metadata)| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && path_contains_symlink(root, &absolute).ok() == Some(false)
        })
}

pub(super) fn retained_manifest_files(
    root: &Path,
    files: Vec<DeviceSyncManifestFile>,
    authenticated_paths: &HashSet<String>,
    desired_paths: &HashSet<String>,
) -> Vec<DeviceSyncManifestFile> {
    files
        .into_iter()
        .filter(|file| {
            let path = portable_path_identity(&file.relative_path);
            !authenticated_paths.contains(&path)
                && !desired_paths.contains(&path)
                && exists_as_regular_file(root, &file.relative_path)
        })
        .collect()
}

pub(super) fn retained_manifest_playlists(
    root: &Path,
    playlists: Vec<DeviceSyncManifestPlaylist>,
    authenticated_paths: &HashSet<String>,
    desired_paths: &HashSet<String>,
) -> Vec<DeviceSyncManifestPlaylist> {
    playlists
        .into_iter()
        .filter(|playlist| {
            let path = portable_path_identity(&playlist.relative_path);
            !authenticated_paths.contains(&path)
                && !desired_paths.contains(&path)
                && exists_as_regular_file(root, &playlist.relative_path)
        })
        .collect()
}

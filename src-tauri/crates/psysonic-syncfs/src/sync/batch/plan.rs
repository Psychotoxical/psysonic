use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    DeviceSyncLayoutMode, DeviceSyncManifestFile, DeviceSyncManifestPlaylist,
    DeviceSyncPlannedPlaylist, DeviceSyncPlaylistPathMode, SyncDeltaResult,
};
use crate::sync::device::replace_device_text_file;

const PLAN_FILE: &str = ".psysonic-sync-plan.json";

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceSyncPlanPlaylist {
    pub(crate) relative_path: String,
    pub(crate) track_ids: Vec<String>,
    pub(crate) references: Vec<String>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceSyncPlanRecord {
    version: u8,
    pub(crate) plan_id: String,
    pub(crate) active: bool,
    pub(crate) expected_device_id: String,
    pub(crate) owner_server_index_key: String,
    pub(crate) source_keys: Vec<String>,
    pub(crate) layout_mode: DeviceSyncLayoutMode,
    pub(crate) playlist_path_mode: DeviceSyncPlaylistPathMode,
    pub(crate) delete_paths: Vec<String>,
    pub(crate) manifest_files: Vec<DeviceSyncManifestFile>,
    pub(crate) manifest_playlists: Vec<DeviceSyncManifestPlaylist>,
    pub(crate) playlists: Vec<DeviceSyncPlanPlaylist>,
}

pub(crate) fn normalized_manifest_files(
    files: &[DeviceSyncManifestFile],
) -> Vec<DeviceSyncManifestFile> {
    let mut files = files.to_vec();
    for file in &mut files {
        file.source_keys.sort();
        file.source_keys.dedup();
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    files
}

pub(crate) fn normalized_manifest_playlists(
    playlists: &[DeviceSyncManifestPlaylist],
) -> Vec<DeviceSyncManifestPlaylist> {
    let mut playlists = playlists.to_vec();
    playlists.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    playlists
}

fn planned_playlists(playlists: &[DeviceSyncPlannedPlaylist]) -> Vec<DeviceSyncPlanPlaylist> {
    let mut playlists = playlists
        .iter()
        .map(|playlist| DeviceSyncPlanPlaylist {
            relative_path: playlist.relative_path.clone(),
            track_ids: playlist
                .tracks
                .iter()
                .filter_map(|track| track.get("id").and_then(serde_json::Value::as_str))
                .map(str::to_string)
                .collect(),
            references: playlist.references.clone(),
        })
        .collect::<Vec<_>>();
    playlists.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    playlists
}

pub(crate) fn normalized_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn plan_path(root: &Path) -> std::path::PathBuf {
    root.join(PLAN_FILE)
}

pub(crate) fn relative_delete_paths(
    root: &Path,
    values: impl IntoIterator<Item = String>,
) -> Result<Vec<String>, String> {
    let mut relative = Vec::new();
    for value in values {
        let path = std::path::PathBuf::from(value);
        let path = path
            .strip_prefix(root)
            .map_err(|_| "DEVICE_SYNC_DELETE_OUTSIDE_ROOT".to_string())?;
        relative.push(path.to_string_lossy().replace('\\', "/"));
    }
    Ok(normalized_strings(relative))
}

fn write_plan(root: &Path, plan: &DeviceSyncPlanRecord) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(plan).map_err(|error| error.to_string())?;
    replace_device_text_file(root, &plan_path(root), &json)
}

pub(crate) fn read_device_sync_plan(root: &Path) -> Result<Option<DeviceSyncPlanRecord>, String> {
    let path = plan_path(root);
    let contents = match std::fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let plan = serde_json::from_slice::<DeviceSyncPlanRecord>(&contents)
        .map_err(|_| "DEVICE_SYNC_PENDING_PLAN_INVALID".to_string())?;
    if plan.version != 1 {
        return Err("DEVICE_SYNC_PENDING_PLAN_INVALID".to_string());
    }
    Ok(Some(plan))
}

impl DeviceSyncPlanRecord {
    pub(crate) fn matches_device_owner(
        &self,
        expected_device_id: &str,
        owner_server_index_key: &str,
    ) -> bool {
        self.expected_device_id == expected_device_id
            && self.owner_server_index_key == owner_server_index_key
    }

    pub(crate) fn matches_request(
        &self,
        expected_device_id: &str,
        owner_server_index_key: &str,
        source_keys: &[String],
        layout_mode: DeviceSyncLayoutMode,
        playlist_path_mode: DeviceSyncPlaylistPathMode,
    ) -> bool {
        self.expected_device_id == expected_device_id
            && self.owner_server_index_key == owner_server_index_key
            && self.source_keys == normalized_strings(source_keys.iter().cloned())
            && self.layout_mode == layout_mode
            && self.playlist_path_mode == playlist_path_mode
    }

    pub(crate) fn matches_desired(&self, result: &SyncDeltaResult) -> bool {
        self.manifest_files == normalized_manifest_files(&result.manifest_files)
            && self.manifest_playlists == normalized_manifest_playlists(&result.manifest_playlists)
            && self.playlists == planned_playlists(&result.playlists)
    }
}

#[allow(clippy::too_many_arguments)] // Keeps the persisted plan inputs explicit at the single write site.
pub(crate) fn prepare_device_sync_plan(
    root: &Path,
    expected_device_id: &str,
    owner_server_index_key: &str,
    source_keys: Vec<String>,
    layout_mode: DeviceSyncLayoutMode,
    playlist_path_mode: DeviceSyncPlaylistPathMode,
    result: &mut SyncDeltaResult,
    existing_active: Option<DeviceSyncPlanRecord>,
) -> Result<(), String> {
    let supersedes_active = existing_active.is_some();
    if let Some(plan) = existing_active {
        if plan.matches_request(
            expected_device_id,
            owner_server_index_key,
            &source_keys,
            layout_mode,
            playlist_path_mode,
        ) && plan.matches_desired(result)
        {
            result.plan_id = plan.plan_id;
            result.delete_paths = plan
                .delete_paths
                .iter()
                .map(|path| root.join(path).to_string_lossy().to_string())
                .collect();
            result.deferred_delete_paths.clear();
            return Ok(());
        }
    }

    static PLAN_COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = PLAN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!(
        "{}:{}:{}:{sequence}",
        expected_device_id,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    let plan_id = format!("{:x}", md5::compute(seed));
    let delete_paths = relative_delete_paths(
        root,
        result
            .delete_paths
            .iter()
            .chain(&result.deferred_delete_paths)
            .cloned(),
    )?;
    let plan = DeviceSyncPlanRecord {
        version: 1,
        plan_id: plan_id.clone(),
        active: supersedes_active,
        expected_device_id: expected_device_id.to_string(),
        owner_server_index_key: owner_server_index_key.to_string(),
        source_keys: normalized_strings(source_keys),
        layout_mode,
        playlist_path_mode,
        delete_paths,
        manifest_files: normalized_manifest_files(&result.manifest_files),
        manifest_playlists: normalized_manifest_playlists(&result.manifest_playlists),
        playlists: planned_playlists(&result.playlists),
    };
    write_plan(root, &plan)?;
    result.plan_id = plan_id;
    Ok(())
}

pub(crate) fn carry_active_plan_cleanup(
    root: &Path,
    plan: &DeviceSyncPlanRecord,
    result: &mut SyncDeltaResult,
) {
    let desired_paths = result
        .manifest_files
        .iter()
        .map(|file| file.relative_path.replace('\\', "/").to_lowercase())
        .chain(
            result
                .manifest_playlists
                .iter()
                .map(|playlist| playlist.relative_path.replace('\\', "/").to_lowercase()),
        )
        .collect::<std::collections::HashSet<_>>();
    let mut cleanup = plan
        .delete_paths
        .iter()
        .filter(|path| !desired_paths.contains(&path.to_lowercase()))
        .map(|path| root.join(path).to_string_lossy().to_string())
        .collect::<Vec<_>>();
    cleanup.extend(
        plan.manifest_files
            .iter()
            .filter(|file| {
                !desired_paths.contains(&file.relative_path.replace('\\', "/").to_lowercase())
            })
            .map(|file| root.join(&file.relative_path).to_string_lossy().to_string()),
    );
    cleanup.extend(
        plan.manifest_playlists
            .iter()
            .filter(|playlist| {
                !desired_paths.contains(&playlist.relative_path.replace('\\', "/").to_lowercase())
            })
            .map(|playlist| {
                root.join(&playlist.relative_path)
                    .to_string_lossy()
                    .to_string()
            }),
    );
    result.delete_paths.extend(cleanup);
    result.delete_paths = normalized_strings(std::mem::take(&mut result.delete_paths));
    result.del_count = result.delete_paths.len() as u32;
}

fn canonicalize_source_key(
    value: &str,
    previous_owner_server_index_key: Option<&str>,
    owner_server_index_key: &str,
) -> String {
    let Ok((server, source_type, id)) = serde_json::from_str::<(String, String, String)>(value)
    else {
        return value.to_string();
    };
    if server != owner_server_index_key && previous_owner_server_index_key != Some(server.as_str())
    {
        return value.to_string();
    }
    serde_json::to_string(&(
        owner_server_index_key,
        source_type,
        psysonic_core::navidrome_id_codec::canonical_id(&id),
    ))
    .unwrap_or_else(|_| value.to_string())
}

pub(crate) fn canonicalize_device_sync_plan(
    root: &Path,
    previous_owner_server_index_key: Option<&str>,
    owner_server_index_key: &str,
) -> Result<(), String> {
    let Some(mut plan) = read_device_sync_plan(root)? else {
        return Ok(());
    };
    if plan.owner_server_index_key != owner_server_index_key
        && previous_owner_server_index_key != Some(plan.owner_server_index_key.as_str())
    {
        return Ok(());
    }
    plan.owner_server_index_key = owner_server_index_key.to_string();
    plan.source_keys = normalized_strings(plan.source_keys.into_iter().map(|key| {
        canonicalize_source_key(
            &key,
            previous_owner_server_index_key,
            owner_server_index_key,
        )
    }));
    for file in &mut plan.manifest_files {
        file.track_id = psysonic_core::navidrome_id_codec::canonical_id(&file.track_id);
        file.source_keys = normalized_strings(file.source_keys.drain(..).map(|key| {
            canonicalize_source_key(
                &key,
                previous_owner_server_index_key,
                owner_server_index_key,
            )
        }));
    }
    for playlist in &mut plan.manifest_playlists {
        playlist.source_key = canonicalize_source_key(
            &playlist.source_key,
            previous_owner_server_index_key,
            owner_server_index_key,
        );
    }
    for playlist in &mut plan.playlists {
        for track_id in &mut playlist.track_ids {
            *track_id = psysonic_core::navidrome_id_codec::canonical_id(track_id);
        }
    }
    write_plan(root, &plan)
}

pub(crate) fn activate_device_sync_plan(
    root: &Path,
    plan_id: &str,
    expected_device_id: &str,
) -> Result<DeviceSyncPlanRecord, String> {
    let mut plan = read_device_sync_plan(root)?
        .ok_or_else(|| "DEVICE_SYNC_PENDING_PLAN_MISSING".to_string())?;
    if plan.plan_id != plan_id || plan.expected_device_id != expected_device_id {
        return Err("DEVICE_SYNC_PENDING_PLAN_MISMATCH".to_string());
    }
    if !plan.active {
        plan.active = true;
        write_plan(root, &plan)?;
    }
    Ok(plan)
}

pub(crate) fn clear_device_sync_plan(root: &Path, plan_id: &str) -> Result<(), String> {
    let Some(plan) = read_device_sync_plan(root)? else {
        return Ok(());
    };
    if plan.plan_id != plan_id {
        return Err("DEVICE_SYNC_PENDING_PLAN_MISMATCH".to_string());
    }
    match std::fs::remove_file(plan_path(root)) {
        Ok(()) => crate::sync::device::sync_device_directory(Some(root)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn has_active_device_sync_plan(root: &Path) -> Result<bool, String> {
    Ok(read_device_sync_plan(root)?.is_some_and(|plan| plan.active))
}

pub(crate) fn active_device_sync_plan_device_id(root: &Path) -> Result<Option<String>, String> {
    Ok(read_device_sync_plan(root)?
        .filter(|plan| plan.active)
        .map(|plan| plan.expected_device_id))
}

pub(crate) fn validate_active_device_sync_plan_binding(
    root: &Path,
    current_device_id: &str,
    expected_device_id: Option<&str>,
) -> Result<(), String> {
    if expected_device_id != Some(current_device_id) {
        return Err("DEVICE_SYNC_PENDING_PLAN_DEVICE_MISMATCH".to_string());
    }
    let Some(plan) = read_device_sync_plan(root)?.filter(|plan| plan.active) else {
        return Ok(());
    };
    if plan.expected_device_id != current_device_id {
        return Err("DEVICE_SYNC_PENDING_PLAN_DEVICE_MISMATCH".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_plan_survives_reload_until_explicitly_cleared() {
        let root = tempfile::tempdir().unwrap();
        let mut result = SyncDeltaResult {
            plan_id: String::new(),
            device_id: "device-1".to_string(),
            add_bytes: 0,
            add_count: 0,
            del_bytes: 0,
            del_count: 0,
            reclaimable_bytes: 0,
            available_bytes: 0,
            tracks: Vec::new(),
            delete_paths: Vec::new(),
            deferred_delete_paths: Vec::new(),
            playlists: Vec::new(),
            manifest_files: Vec::new(),
            manifest_playlists: Vec::new(),
        };
        prepare_device_sync_plan(
            root.path(),
            "device-1",
            "owner.test",
            Vec::new(),
            DeviceSyncLayoutMode::SharedAlbumTree,
            DeviceSyncPlaylistPathMode::DeviceRooted,
            &mut result,
            None,
        )
        .unwrap();

        let active = activate_device_sync_plan(root.path(), &result.plan_id, "device-1").unwrap();
        assert!(active.active);
        assert!(read_device_sync_plan(root.path()).unwrap().unwrap().active);
        assert!(validate_active_device_sync_plan_binding(
            root.path(),
            "device-1",
            Some("device-1")
        )
        .is_ok());
        assert_eq!(
            validate_active_device_sync_plan_binding(root.path(), "device-1", Some("device-2")),
            Err("DEVICE_SYNC_PENDING_PLAN_DEVICE_MISMATCH".to_string())
        );
        assert_eq!(
            validate_active_device_sync_plan_binding(root.path(), "device-1", None),
            Err("DEVICE_SYNC_PENDING_PLAN_DEVICE_MISMATCH".to_string())
        );

        clear_device_sync_plan(root.path(), &result.plan_id).unwrap();
        assert!(read_device_sync_plan(root.path()).unwrap().is_none());
        assert_eq!(
            validate_active_device_sync_plan_binding(root.path(), "device-2", Some("device-1")),
            Err("DEVICE_SYNC_PENDING_PLAN_DEVICE_MISMATCH".to_string())
        );
        assert!(validate_active_device_sync_plan_binding(
            root.path(),
            "device-2",
            Some("device-2")
        )
        .is_ok());
    }
}

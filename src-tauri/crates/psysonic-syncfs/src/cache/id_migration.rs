use std::io::Read;
use std::path::{Path, PathBuf};

use psysonic_core::navidrome_id_codec::canonical_id;
use psysonic_library::runtime::MigrationPhase;
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NavidromeFilesystemMigrationDto {
    pub offline_files_scanned: u64,
    pub offline_files_moved: u64,
    pub offline_files_merged: u64,
    pub hot_cache_files_scanned: u64,
    pub hot_cache_files_moved: u64,
    pub hot_cache_files_merged: u64,
    pub offline_paths_retargeted: u64,
}

#[derive(Debug, Default)]
struct FlatCacheMigration {
    scanned: u64,
    moved: u64,
    merged: u64,
    path_changes: Vec<(PathBuf, PathBuf)>,
}

#[derive(Clone, Copy)]
enum CollisionPolicy {
    RequireIdentical,
    PreferDestination,
}

#[tauri::command]
#[specta::specta]
pub async fn migrate_navidrome_filesystem_ids(
    generation: u64,
    library_server_id: String,
    server_index_key: String,
    custom_offline_dir: Option<String>,
    custom_hot_cache_dir: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<NavidromeFilesystemMigrationDto, String> {
    let library_server_id = library_server_id.trim().to_string();
    let server_index_key = server_index_key.trim().to_string();
    if server_index_key.is_empty() {
        return Err("filesystem migration server index key must not be empty".to_string());
    }
    runtime.ensure_migration_phase(generation, &library_server_id, MigrationPhase::Native)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let offline_root = custom_offline_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data.join("psysonic-offline"));
    let hot_root = super::downloads::resolve_hot_cache_root(custom_hot_cache_dir, &app)?;
    let offline_dir = offline_root.join(super::offline::legacy_safe_segment(&server_index_key));
    let hot_dir = hot_root.join(&server_index_key);
    let store = runtime.store.clone();

    tauri::async_runtime::spawn_blocking(move || {
        psysonic_core::migration_write_barrier::MigrationWriteBarrier::scope_sync(generation, || {
            let offline = migrate_flat_cache_dir(&offline_dir, CollisionPolicy::RequireIdentical)?;
            let hot = migrate_flat_cache_dir(&hot_dir, CollisionPolicy::PreferDestination)?;
            let path_changes = offline
                .path_changes
                .iter()
                .map(|(old_path, new_path)| {
                    (
                        old_path.to_string_lossy().to_string(),
                        new_path.to_string_lossy().to_string(),
                    )
                })
                .collect::<Vec<_>>();
            let offline_paths_retargeted =
                psysonic_library::navidrome_native_migration::retarget_offline_paths(
                    &store,
                    &library_server_id,
                    &path_changes,
                )?;
            Ok(NavidromeFilesystemMigrationDto {
                offline_files_scanned: offline.scanned,
                offline_files_moved: offline.moved,
                offline_files_merged: offline.merged,
                hot_cache_files_scanned: hot.scanned,
                hot_cache_files_moved: hot.moved,
                hot_cache_files_merged: hot.merged,
                offline_paths_retargeted,
            })
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn verify_navidrome_filesystem_ids(
    app: &AppHandle,
    server_index_key: &str,
    custom_offline_dir: Option<String>,
    custom_hot_cache_dir: Option<String>,
) -> Result<(), String> {
    let server_index_key = server_index_key.trim();
    if server_index_key.is_empty() {
        return Err("filesystem verification server index key must not be empty".to_string());
    }
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let offline_root = custom_offline_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| app_data.join("psysonic-offline"));
    let hot_root = super::downloads::resolve_hot_cache_root(custom_hot_cache_dir, app)?;
    let offline_dir =
        offline_root.join(super::offline::legacy_safe_segment(server_index_key));
    let hot_dir = hot_root.join(server_index_key);

    tauri::async_runtime::spawn_blocking(move || {
        verify_flat_cache_dir(&offline_dir)?;
        verify_flat_cache_dir(&hot_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn migrate_flat_cache_dir(
    dir: &Path,
    collision_policy: CollisionPolicy,
) -> Result<FlatCacheMigration, String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(FlatCacheMigration::default());
    };
    let entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut result = FlatCacheMigration::default();
    for entry in entries {
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "cache migration found a non-UTF-8 filename".to_string())?;
        if name.ends_with(".part") {
            continue;
        }
        let Some((old_id, suffix)) = name.split_once('.') else {
            continue;
        };
        result.scanned = result.scanned.saturating_add(1);
        let new_id = canonical_id(old_id);
        if new_id == old_id {
            continue;
        }
        let destination = dir.join(format!("{new_id}.{suffix}"));
        if destination.exists() {
            if matches!(collision_policy, CollisionPolicy::RequireIdentical)
                && !files_are_identical(&source, &destination)?
            {
                return Err(format!(
                    "conflicting Navidrome filesystem collision `{}` -> `{}`",
                    source.display(),
                    destination.display()
                ));
            }
            std::fs::remove_file(&source).map_err(|error| error.to_string())?;
            result.merged = result.merged.saturating_add(1);
        } else {
            std::fs::rename(&source, &destination).map_err(|error| error.to_string())?;
            result.moved = result.moved.saturating_add(1);
        }
        result.path_changes.push((source, destination));
    }
    verify_flat_cache_dir(dir)?;
    Ok(result)
}

fn files_are_identical(left: &Path, right: &Path) -> Result<bool, String> {
    if std::fs::metadata(left).map_err(|error| error.to_string())?.len()
        != std::fs::metadata(right).map_err(|error| error.to_string())?.len()
    {
        return Ok(false);
    }
    let mut left = std::io::BufReader::new(
        std::fs::File::open(left).map_err(|error| error.to_string())?,
    );
    let mut right = std::io::BufReader::new(
        std::fs::File::open(right).map_err(|error| error.to_string())?,
    );
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left
            .read(&mut left_buffer)
            .map_err(|error| error.to_string())?;
        let right_read = right
            .read(&mut right_buffer)
            .map_err(|error| error.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn verify_flat_cache_dir(dir: &Path) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.path().is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| "cache verification found a non-UTF-8 filename".to_string())?;
        if name.ends_with(".part") {
            continue;
        }
        let Some((id, _)) = name.split_once('.') else {
            continue;
        };
        if canonical_id(id) != id {
            return Err(format!(
                "Navidrome filesystem migration residue in `{}`",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: &str = "e3b7fc2ae9447bbec37a13bf916e3cf6";
    const CANONICAL: &str = "6VHl3uR4kss6sUPKA8Cwnk";

    fn fresh_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "psysonic-id-fs-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn moves_legacy_filename_and_preserves_suffix() {
        let dir = fresh_dir("move");
        std::fs::write(dir.join(format!("{LEGACY}.flac")), b"audio").unwrap();
        let result =
            migrate_flat_cache_dir(&dir, CollisionPolicy::RequireIdentical).unwrap();
        assert_eq!(result.moved, 1);
        assert_eq!(
            std::fs::read(dir.join(format!("{CANONICAL}.flac"))).unwrap(),
            b"audio"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn identical_canonical_destination_merges_the_legacy_file() {
        let dir = fresh_dir("merge");
        std::fs::write(dir.join(format!("{LEGACY}.flac")), b"same audio").unwrap();
        std::fs::write(dir.join(format!("{CANONICAL}.flac")), b"same audio").unwrap();
        let result =
            migrate_flat_cache_dir(&dir, CollisionPolicy::RequireIdentical).unwrap();
        assert_eq!(result.merged, 1);
        assert_eq!(
            std::fs::read(dir.join(format!("{CANONICAL}.flac"))).unwrap(),
            b"same audio"
        );
        assert!(!dir.join(format!("{LEGACY}.flac")).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn different_canonical_destination_blocks_without_deleting_either_file() {
        let dir = fresh_dir("conflict");
        let legacy_path = dir.join(format!("{LEGACY}.flac"));
        let canonical_path = dir.join(format!("{CANONICAL}.flac"));
        std::fs::write(&legacy_path, b"legacy audio").unwrap();
        std::fs::write(&canonical_path, b"different audio").unwrap();
        assert!(migrate_flat_cache_dir(&dir, CollisionPolicy::RequireIdentical)
            .unwrap_err()
            .contains("conflicting Navidrome filesystem collision"));
        assert_eq!(std::fs::read(legacy_path).unwrap(), b"legacy audio");
        assert_eq!(std::fs::read(canonical_path).unwrap(), b"different audio");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ephemeral_collision_prefers_the_canonical_destination() {
        let dir = fresh_dir("ephemeral-conflict");
        let legacy_path = dir.join(format!("{LEGACY}.mp3"));
        let canonical_path = dir.join(format!("{CANONICAL}.mp3"));
        std::fs::write(&legacy_path, b"obsolete hot bytes").unwrap();
        std::fs::write(&canonical_path, b"current hot bytes").unwrap();
        let result =
            migrate_flat_cache_dir(&dir, CollisionPolicy::PreferDestination).unwrap();
        assert_eq!(result.merged, 1);
        assert!(!legacy_path.exists());
        assert_eq!(std::fs::read(canonical_path).unwrap(), b"current hot bytes");
        let _ = std::fs::remove_dir_all(dir);
    }
}

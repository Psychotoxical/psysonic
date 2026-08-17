use std::path::{Path, PathBuf};

use psysonic_core::cover_cache_layout::sanitize_path_segment;
use psysonic_core::media_layout::{absolute_track_path, layout_fingerprint, LocalTier};
use psysonic_library::repos::{TrackRepository, TrackRow};
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, Manager, State};

use super::paths::{resolve_media_dir, track_row_to_path_input};
use super::{LegacyOfflineDiskEntry, LegacyOfflineMigrationResult};

fn default_legacy_offline_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("psysonic-offline"))
}

fn scan_flat_offline_root(root: &Path) -> Vec<LegacyOfflineDiskEntry> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    let Ok(server_dirs) = std::fs::read_dir(root) else {
        return out;
    };
    for server_entry in server_dirs.flatten() {
        let server_path = server_entry.path();
        if !server_path.is_dir() {
            continue;
        }
        let server_segment = server_entry.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(&server_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let path = file_entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some((track_id, suffix)) = name.rsplit_once('.') else {
                continue;
            };
            if track_id.is_empty() || suffix.is_empty() {
                continue;
            }
            let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(LegacyOfflineDiskEntry {
                server_segment: server_segment.clone(),
                track_id: track_id.to_string(),
                path: path.to_string_lossy().to_string(),
                suffix: suffix.to_string(),
                size_bytes,
            });
        }
    }
    out
}

fn legacy_offline_roots(app: &AppHandle, custom_offline_dir: Option<&str>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = default_legacy_offline_root(app) {
        roots.push(root);
    }
    if let Some(cd) = custom_offline_dir.filter(|s| !s.is_empty()) {
        let custom = PathBuf::from(cd);
        if roots.iter().all(|r| r != &custom) {
            roots.push(custom);
        }
    }
    roots
}

fn server_index_key_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed)
        .to_string()
}

fn base_url_for_server(runtime: &LibraryRuntime, server_id: &str) -> Option<String> {
    runtime
        .sync_sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(server_id).map(|s| s.base_url.clone()))
}

fn server_index_key_for_disk(
    runtime: &LibraryRuntime,
    server_id: &str,
    disk_segment: &str,
) -> String {
    if let Some(url) = base_url_for_server(runtime, server_id) {
        let key = server_index_key_from_url(&url);
        if !key.is_empty() {
            return key;
        }
    }
    disk_segment.to_string()
}

fn disk_segment_matches(disk_segment: &str, server_id: &str, index_key: &str) -> bool {
    if disk_segment == server_id || disk_segment == index_key {
        return true;
    }
    sanitize_path_segment(disk_segment) == sanitize_path_segment(index_key)
        || sanitize_path_segment(disk_segment) == sanitize_path_segment(server_id)
}

fn resolve_track_for_disk_file(
    repo: &TrackRepository,
    runtime: &LibraryRuntime,
    disk_segment: &str,
    track_id: &str,
) -> Result<Option<(TrackRow, String)>, String> {
    if let Some(row) = repo.find_one(disk_segment, track_id)? {
        let key = server_index_key_for_disk(runtime, &row.server_id, disk_segment);
        return Ok(Some((row, key)));
    }
    let candidates = repo.find_live_by_id(track_id)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    for row in &candidates {
        let key = server_index_key_for_disk(runtime, &row.server_id, disk_segment);
        if disk_segment_matches(disk_segment, &row.server_id, &key) {
            return Ok(Some((row.clone(), key)));
        }
    }
    if candidates.len() == 1 {
        let row = candidates[0].clone();
        let key = server_index_key_for_disk(runtime, &row.server_id, disk_segment);
        return Ok(Some((row, key)));
    }
    Ok(None)
}

fn passes_server_filter(filter: Option<&str>, disk_segment: &str, server_index_key: &str) -> bool {
    let Some(filter) = filter.filter(|s| !s.is_empty()) else {
        return true;
    };
    disk_segment == filter
        || server_index_key == filter
        || sanitize_path_segment(disk_segment) == sanitize_path_segment(filter)
}

async fn relocate_file_to_target(old_path: &Path, target_path: &Path) -> Result<bool, String> {
    if old_path == target_path {
        return Ok(false);
    }
    if target_path.is_file() {
        if old_path.is_file() && old_path != target_path {
            let _ = tokio::fs::remove_file(old_path).await;
        }
        return Ok(old_path != target_path);
    }
    if !old_path.is_file() {
        return Err("SOURCE_MISSING".to_string());
    }
    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    match tokio::fs::rename(old_path, target_path).await {
        Ok(()) => Ok(true),
        Err(e) if e.raw_os_error() == Some(18) => {
            tokio::fs::copy(old_path, target_path)
                .await
                .map_err(|e| e.to_string())?;
            tokio::fs::remove_file(old_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(true)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn prune_legacy_offline_parents(old_path: &Path, app: &AppHandle) {
    let Some(legacy_root) = default_legacy_offline_root(app) else {
        return;
    };
    let Some(parent) = old_path.parent() else {
        return;
    };
    if parent.starts_with(&legacy_root) {
        super::super::fs_utils::prune_empty_dirs_up_to(parent, &legacy_root);
    }
}

struct RelocateLegacyTrackFile<'a> {
    track_id: &'a str,
    server_index_key: &'a str,
    old_path: &'a Path,
    suffix: &'a str,
    row: &'a TrackRow,
    media_root: &'a Path,
    library_boundary: &'a Path,
    app: &'a AppHandle,
}

async fn relocate_legacy_track_file(
    args: RelocateLegacyTrackFile<'_>,
) -> LegacyOfflineMigrationResult {
    let path_input = track_row_to_path_input(args.row);
    let fingerprint = layout_fingerprint(&path_input);
    let target_path = absolute_track_path(
        args.media_root,
        LocalTier::Library,
        args.server_index_key,
        &path_input,
        args.suffix,
    );
    let target_str = target_path.to_string_lossy().to_string();
    let old_path_str = args.old_path.to_string_lossy().to_string();

    if args.old_path.is_file() && args.old_path == target_path {
        let size = tokio::fs::metadata(&target_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        return LegacyOfflineMigrationResult {
            track_id: args.track_id.to_string(),
            server_index_key: args.server_index_key.to_string(),
            path: target_str,
            size,
            layout_fingerprint: fingerprint,
            relocated: false,
            skipped_reason: None,
        };
    }

    if target_path.is_file() {
        if args.old_path.is_file() && args.old_path != target_path {
            let _ = tokio::fs::remove_file(args.old_path).await;
            prune_legacy_offline_parents(args.old_path, args.app);
        }
        let size = tokio::fs::metadata(&target_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        return LegacyOfflineMigrationResult {
            track_id: args.track_id.to_string(),
            server_index_key: args.server_index_key.to_string(),
            path: target_str,
            size,
            layout_fingerprint: fingerprint,
            relocated: args.old_path.is_file(),
            skipped_reason: None,
        };
    }

    match relocate_file_to_target(args.old_path, &target_path).await {
        Ok(relocated) => {
            if relocated {
                prune_legacy_offline_parents(args.old_path, args.app);
                if let Some(parent) = target_path.parent() {
                    super::super::fs_utils::prune_empty_dirs_up_to(parent, args.library_boundary);
                }
            }
            let size = if target_path.is_file() {
                tokio::fs::metadata(&target_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0)
            } else {
                0
            };
            LegacyOfflineMigrationResult {
                track_id: args.track_id.to_string(),
                server_index_key: args.server_index_key.to_string(),
                path: target_str,
                size,
                layout_fingerprint: fingerprint,
                relocated,
                skipped_reason: if target_path.is_file() {
                    None
                } else {
                    Some("source_missing".to_string())
                },
            }
        }
        Err(reason) => LegacyOfflineMigrationResult {
            track_id: args.track_id.to_string(),
            server_index_key: args.server_index_key.to_string(),
            path: old_path_str,
            size: 0,
            layout_fingerprint: fingerprint,
            relocated: false,
            skipped_reason: Some(reason),
        },
    }
}

pub(super) async fn migrate_legacy_offline_disk(
    media_dir: Option<String>,
    custom_offline_dir: Option<String>,
    server_index_key_filter: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<Vec<LegacyOfflineMigrationResult>, String> {
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let library_boundary = media_root.join(LocalTier::Library.subdir());
    let repo = TrackRepository::new(&runtime.store);
    let filter = server_index_key_filter.as_deref();

    let mut disk_files = Vec::new();
    for root in legacy_offline_roots(&app, custom_offline_dir.as_deref()) {
        disk_files.extend(scan_flat_offline_root(&root));
    }

    let mut out = Vec::with_capacity(disk_files.len());
    for file in disk_files {
        let suffix = file.suffix.trim().trim_start_matches('.');
        let suffix = if suffix.is_empty() { "mp3" } else { suffix };
        let old_path = PathBuf::from(&file.path);

        let Some((row, server_index_key)) =
            resolve_track_for_disk_file(&repo, &runtime, &file.server_segment, &file.track_id)?
        else {
            out.push(LegacyOfflineMigrationResult {
                track_id: file.track_id,
                server_index_key: file.server_segment.clone(),
                path: file.path,
                size: file.size_bytes,
                layout_fingerprint: String::new(),
                relocated: false,
                skipped_reason: Some("library_track_not_found".to_string()),
            });
            continue;
        };

        if !passes_server_filter(filter, &file.server_segment, &server_index_key) {
            continue;
        }

        out.push(
            relocate_legacy_track_file(RelocateLegacyTrackFile {
                track_id: &file.track_id,
                server_index_key: &server_index_key,
                old_path: &old_path,
                suffix,
                row: &row,
                media_root: &media_root,
                library_boundary: &library_boundary,
                app: &app,
            })
            .await,
        );
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_flat_offline_root_lists_track_files() {
        let base = std::env::temp_dir().join(format!("psysonic-scan-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let track = base.join("my.server").join("abc123.flac");
        std::fs::create_dir_all(track.parent().unwrap()).unwrap();
        std::fs::write(&track, b"x").unwrap();
        let found = scan_flat_offline_root(&base);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].track_id, "abc123");
        assert_eq!(found[0].suffix, "flac");
        assert_eq!(found[0].server_segment, "my.server");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn relocate_moves_file_to_nested_target() {
        let base =
            std::env::temp_dir().join(format!("psysonic-migrate-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("psysonic-offline").join("srv").join("t1.mp3");
        let target = base
            .join("media")
            .join("library")
            .join("Artist")
            .join("Album")
            .join("01 - Song.mp3");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"abc").unwrap();
        let relocated = relocate_file_to_target(&old, &target).await.unwrap();
        assert!(relocated);
        assert!(target.is_file());
        assert!(!old.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use psysonic_core::cover_cache_layout::sanitize_path_segment;
use psysonic_core::media_layout::LocalTier;
use tauri::AppHandle;

use super::paths::{normalize_path_key, resolve_media_dir, resolve_media_tier_root};

pub(super) async fn prune_orphan_files_under_root(
    root: &Path,
    keep_paths: &[String],
) -> Vec<String> {
    if !root.is_dir() {
        return Vec::new();
    }
    let keep: HashSet<String> = keep_paths
        .iter()
        .map(|p| normalize_path_key(Path::new(p)))
        .collect();
    let mut removed = Vec::new();
    for file in super::super::fs_utils::collect_regular_files_under(root) {
        if keep.contains(&normalize_path_key(&file)) {
            continue;
        }
        if tokio::fs::remove_file(&file).await.is_err() {
            continue;
        }
        removed.push(file.to_string_lossy().to_string());
        if let Some(parent) = file.parent() {
            super::super::fs_utils::prune_empty_dirs_up_to(parent, root);
        }
    }
    super::super::fs_utils::prune_empty_subdirs_under(root);
    removed
}

struct OrphanCacheFile {
    path: PathBuf,
    size: u64,
    modified: std::time::SystemTime,
}

pub(super) async fn evict_orphan_files_under_root_to_fit(
    root: &Path,
    keep_paths: &[String],
    max_bytes: u64,
) -> Vec<String> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut total = super::super::fs_utils::dir_size_recursive(root);
    if total <= max_bytes {
        return Vec::new();
    }

    let keep: HashSet<String> = keep_paths
        .iter()
        .map(|p| normalize_path_key(Path::new(p)))
        .collect();

    let mut orphans: Vec<OrphanCacheFile> = Vec::new();
    for file in super::super::fs_utils::collect_regular_files_under(root) {
        if keep.contains(&normalize_path_key(&file)) {
            continue;
        }
        let meta = match std::fs::metadata(&file) {
            Ok(m) => m,
            Err(_) => continue,
        };
        orphans.push(OrphanCacheFile {
            path: file,
            size: meta.len(),
            modified: meta.modified().unwrap_or(std::time::UNIX_EPOCH),
        });
    }
    orphans.sort_by_key(|f| f.modified);

    let mut removed = Vec::new();
    for orphan in orphans {
        if total <= max_bytes {
            break;
        }
        if tokio::fs::remove_file(&orphan.path).await.is_err() {
            continue;
        }
        total = total.saturating_sub(orphan.size);
        removed.push(orphan.path.to_string_lossy().to_string());
        if let Some(parent) = orphan.path.parent() {
            super::super::fs_utils::prune_empty_dirs_up_to(parent, root);
        }
    }
    super::super::fs_utils::prune_empty_subdirs_under(root);
    removed
}

pub(super) async fn prune_orphan_library_tier_files(
    server_index_key: String,
    keep_paths: Vec<String>,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let segment = sanitize_path_segment(&server_index_key);
    let root = media_root.join(LocalTier::Library.subdir()).join(segment);
    Ok(prune_orphan_files_under_root(&root, &keep_paths).await)
}

pub(super) async fn evict_ephemeral_cache_orphans_to_fit(
    keep_paths: Vec<String>,
    max_bytes: u64,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let root = media_root.join(LocalTier::Ephemeral.subdir());
    Ok(evict_orphan_files_under_root_to_fit(&root, &keep_paths, max_bytes).await)
}

pub(super) async fn prune_orphan_ephemeral_cache_files(
    keep_paths: Vec<String>,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let root = media_root.join(LocalTier::Ephemeral.subdir());
    Ok(prune_orphan_files_under_root(&root, &keep_paths).await)
}

pub(super) fn probe_media_files(local_paths: Vec<String>) -> Vec<bool> {
    local_paths.iter().map(|p| Path::new(p).is_file()).collect()
}

pub(super) async fn get_media_tier_size(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> u64 {
    let local_tier = match LocalTier::parse(&tier) {
        Some(t) => t,
        None => return 0,
    };
    resolve_media_tier_root(local_tier, media_dir.as_deref(), &app)
        .map(|root| super::super::fs_utils::dir_size_recursive(&root))
        .unwrap_or(0)
}

pub(super) async fn purge_media_tier(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let local_tier =
        LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;
    let root = resolve_media_tier_root(local_tier, media_dir.as_deref(), &app)?;
    if root.exists() {
        tokio::fs::remove_dir_all(&root)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn prune_parents_after_media_file_delete(
    file_path: &Path,
    media_dir: Option<&str>,
    app: &AppHandle,
) {
    let Some(parent) = file_path.parent() else {
        return;
    };
    if let Some(boundary) = super::super::fs_utils::local_tier_boundary_from_path(file_path) {
        super::super::fs_utils::prune_empty_dirs_up_to(parent, &boundary);
        return;
    }
    if let Ok(media_root) = resolve_media_dir(media_dir, app) {
        for tier in [
            LocalTier::Ephemeral,
            LocalTier::Library,
            LocalTier::Favorites,
        ] {
            let boundary = media_root.join(tier.subdir());
            super::super::fs_utils::prune_empty_dirs_up_to(parent, &boundary);
        }
    }
}

pub(super) async fn delete_media_file(
    local_path: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let file_path = PathBuf::from(&local_path);
    if file_path.is_file() {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }
    prune_parents_after_media_file_delete(&file_path, media_dir.as_deref(), &app);
    Ok(())
}

pub(super) async fn prune_empty_media_tier_dirs(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let local_tier =
        LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;
    let root = resolve_media_tier_root(local_tier, media_dir.as_deref(), &app)?;
    super::super::fs_utils::prune_empty_subdirs_under(&root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn evict_ephemeral_cache_orphans_to_fit_removes_oldest_first_when_over_budget() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-ephemeral-evict-age-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let keep = cache.join("srv").join("keep.flac");
        let old_orphan = cache.join("srv").join("old.flac");
        let new_orphan = cache.join("srv").join("new.flac");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&old_orphan, b"oldorphan!").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&new_orphan, b"new!!").unwrap();

        let removed =
            evict_orphan_files_under_root_to_fit(&cache, &[keep.to_string_lossy().to_string()], 10)
                .await;

        assert_eq!(removed.len(), 1);
        assert!(removed[0].contains("old.flac"));
        assert!(keep.is_file());
        assert!(!old_orphan.exists());
        assert!(new_orphan.is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn evict_ephemeral_cache_orphans_to_fit_noop_when_under_budget() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-ephemeral-evict-noop-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let keep = cache.join("srv").join("keep.flac");
        let orphan = cache.join("srv").join("extra.flac");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep").unwrap();
        std::fs::write(&orphan, b"x").unwrap();

        let removed = evict_orphan_files_under_root_to_fit(
            &cache,
            &[keep.to_string_lossy().to_string()],
            100,
        )
        .await;

        assert!(removed.is_empty());
        assert!(orphan.is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn prune_orphan_ephemeral_cache_removes_untracked_files_and_empty_dirs() {
        let base =
            std::env::temp_dir().join(format!("psysonic-ephemeral-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let keep = base
            .join("cache")
            .join("srv")
            .join("Artist")
            .join("Album")
            .join("01 - Keep.flac");
        let orphan = base
            .join("cache")
            .join("srv")
            .join("Artist")
            .join("Album")
            .join("02 - Drop.flac");
        let orphan_part = base
            .join("cache")
            .join("srv")
            .join("Other")
            .join("stale.flac.part");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::create_dir_all(orphan_part.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep").unwrap();
        std::fs::write(&orphan, b"drop").unwrap();
        std::fs::write(&orphan_part, b"part").unwrap();

        let removed = prune_orphan_files_under_root(
            &base.join("cache"),
            &[keep.to_string_lossy().to_string()],
        )
        .await;

        assert_eq!(removed.len(), 2);
        assert!(keep.is_file());
        assert!(!orphan.exists());
        assert!(!orphan_part.exists());
        assert!(!base.join("cache/srv/Other").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}

pub(super) async fn list_device_dir_files_impl(dir: String) -> Result<Vec<String>, String> {
    let root = std::path::PathBuf::from(&dir);
    if !root.exists() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    let mut files = Vec::new();
    let mut stack = vec![root];
    while let Some(current) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&current).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            // Skip hidden dirs (e.g. .Trash-1000, .Ventoy, .fseventsd)
            let is_hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false);
            if is_hidden {
                continue;
            }
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(files)
}

use crate::sync::device::planned_path_stays_within;

fn validate_device_root(root: &std::path::Path) -> Result<(), String> {
    if !root.is_dir() {
        return Err("VOLUME_NOT_FOUND".to_string());
    }
    Ok(())
}

fn validate_device_file_path(root: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    match planned_path_stays_within(root, path) {
        Ok(true) => Ok(()),
        Ok(false) => Err("DEVICE_SYNC_PATH_ESCAPES_ROOT".to_string()),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) async fn delete_device_file_impl(dest_dir: String, path: String) -> Result<(), String> {
    let root = std::path::PathBuf::from(dest_dir);
    validate_device_root(&root)?;
    let path = std::path::PathBuf::from(&path);
    validate_device_file_path(&root, &path)?;
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| e.to_string())?;
        prune_empty_parents_with_boundary(&path, 2, &root).await;
    }
    Ok(())
}

/// Prune empty parent directories up to `levels` levels above `file_path`.
pub async fn prune_empty_parents(file_path: &std::path::Path, levels: usize) {
    prune_empty_parents_with_boundary(file_path, levels, std::path::Path::new("")).await;
}

async fn prune_empty_parents_with_boundary(
    file_path: &std::path::Path,
    levels: usize,
    boundary: &std::path::Path,
) {
    let mut current = file_path.parent().map(|dir| dir.to_path_buf());
    for _ in 0..levels {
        let Some(dir) = current else { break };
        if !boundary.as_os_str().is_empty() && dir == boundary {
            break;
        }
        let is_empty = std::fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if is_empty {
            let _ = tokio::fs::remove_dir(&dir).await;
            current = dir.parent().map(|parent| parent.to_path_buf());
        } else {
            break;
        }
    }
}

pub(super) async fn delete_device_files_impl(
    dest_dir: String,
    paths: Vec<String>,
) -> Result<u32, String> {
    let root = std::path::PathBuf::from(dest_dir);
    validate_device_root(&root)?;
    let mut deleted: u32 = 0;
    for path in &paths {
        let path = std::path::PathBuf::from(path);
        validate_device_file_path(&root, &path)?;
        if !path.exists() {
            continue;
        }
        tokio::fs::remove_file(&path)
            .await
            .map_err(|error| format!("{}: {error}", path.to_string_lossy()))?;
        deleted += 1;
        prune_empty_parents_with_boundary(&path, 2, &root).await;
    }
    Ok(deleted)
}

pub(super) async fn rollback_device_files(
    root: &std::path::Path,
    paths: Vec<std::path::PathBuf>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for path in paths {
        if let Err(error) = validate_device_file_path(root, &path) {
            errors.push(format!("{}: {error}", path.to_string_lossy()));
            continue;
        }
        if !path.exists() {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => prune_empty_parents_with_boundary(&path, 2, root).await,
            Err(error) => errors.push(format!("{}: {error}", path.to_string_lossy())),
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(())
}

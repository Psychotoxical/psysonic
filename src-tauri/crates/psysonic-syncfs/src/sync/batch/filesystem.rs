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
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(files)
}

pub(super) async fn delete_device_file_impl(path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&path);
    if path.exists() {
        tokio::fs::remove_file(&path)
            .await
            .map_err(|e| e.to_string())?;
        prune_empty_parents(&path, 2).await;
    }
    Ok(())
}

/// Prune empty parent directories up to `levels` levels above `file_path`.
pub async fn prune_empty_parents(file_path: &std::path::Path, levels: usize) {
    let mut current = file_path.parent().map(|dir| dir.to_path_buf());
    for _ in 0..levels {
        let Some(dir) = current else { break };
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

pub(super) async fn delete_device_files_impl(paths: Vec<String>) -> Result<u32, String> {
    let mut deleted: u32 = 0;
    for path in &paths {
        let path = std::path::PathBuf::from(path);
        if path.exists() && tokio::fs::remove_file(&path).await.is_ok() {
            deleted += 1;
            prune_empty_parents(&path, 2).await;
        }
    }
    Ok(deleted)
}

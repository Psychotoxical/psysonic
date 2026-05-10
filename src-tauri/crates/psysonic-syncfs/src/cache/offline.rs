use tauri::Manager;

use psysonic_analysis::analysis_cache;
use psysonic_analysis::analysis_runtime::enqueue_analysis_seed;
use crate::DownloadSemaphore;

use crate::file_transfer::{finalize_streamed_download, subsonic_http_client};

// ─── Offline Track Cache ──────────────────────────────────────────────────────

pub async fn enqueue_analysis_seed_from_file(
    app: &tauri::AppHandle,
    track_id: &str,
    file_path: &std::path::Path,
) {
    if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
        if cache.cpu_seed_redundant_for_track(track_id).unwrap_or(false) {
            return;
        }
    }
    let bytes = match tokio::fs::read(file_path).await {
        Ok(v) => v,
        Err(_) => return,
    };
    if bytes.is_empty() {
        return;
    }
    let _ = enqueue_analysis_seed(app, track_id, &bytes).await;
}

/// Downloads a single track to the app's offline cache directory.
/// Returns the absolute file path so TypeScript can store it and later
/// construct a `psysonic-local://<path>` URL for the audio engine.
#[tauri::command]
pub async fn download_track_offline(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    dl_sem: tauri::State<'_, DownloadSemaphore>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Determine base cache directory.
    let cache_dir = if let Some(ref cd) = custom_dir {
        let base = std::path::PathBuf::from(cd);
        // Check that the volume/directory is still accessible.
        if !base.exists() {
            return Err("VOLUME_NOT_FOUND".to_string());
        }
        base.join(&server_id)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-offline")
            .join(&server_id)
    };

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    // Already cached — skip re-download (no semaphore needed).
    if file_path.exists() {
        return Ok(path_str);
    }

    // Acquire a download slot. The permit is held for the duration of the HTTP transfer
    // and released automatically when this function returns (success or error).
    let _permit = dl_sem.acquire().await.map_err(|e| e.to_string())?;

    let client = subsonic_http_client(std::time::Duration::from_secs(120))?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let part_path = file_path.with_extension(format!("{suffix}.part"));
    finalize_streamed_download(response, &file_path, &part_path).await?;

    enqueue_analysis_seed_from_file(&app, &track_id, &file_path).await;

    Ok(path_str)
}

/// Returns the total size in bytes of all files in the offline cache directory (and optional custom dir).
#[tauri::command]
pub async fn get_offline_cache_size(custom_dir: Option<String>, app: tauri::AppHandle) -> u64 {
    let default_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("psysonic-offline"),
        Err(_) => return 0,
    };
    let mut total = super::fs_utils::dir_size_recursive(&default_dir);

    if let Some(cd) = custom_dir {
        let custom = std::path::PathBuf::from(cd);
        if custom != std::path::Path::new("") {
            total += super::fs_utils::dir_size_recursive(&custom);
        }
    }
    total
}

/// Removes a cached track from the offline cache. Accepts the full local path
/// (stored in OfflineTrackMeta) so it works regardless of which directory was used.
/// After deleting the file, empty parent directories up to (but not including)
/// `base_dir` are pruned using `remove_dir` (never `remove_dir_all`).
#[tauri::command]
pub async fn delete_offline_track(
    local_path: String,
    base_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&local_path);
    if file_path.exists() {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Determine the safe boundary — never delete at or above this directory.
    let boundary = if let Some(bd) = base_dir.filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(bd)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-offline")
    };

    if let Some(parent) = file_path.parent() {
        super::fs_utils::prune_empty_dirs_up_to(parent, &boundary);
    }

    Ok(())
}


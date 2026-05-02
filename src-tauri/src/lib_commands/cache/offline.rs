use super::*;

use super::*;

// ─── Offline Track Cache ──────────────────────────────────────────────────────

/// Streams an HTTP response body directly to `dest_path` in small chunks.
/// Never buffers the full file in memory — keeps RAM flat regardless of file size.
pub(crate) async fn stream_to_file(response: reqwest::Response, dest_path: &std::path::Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) async fn enqueue_analysis_seed(app: &tauri::AppHandle, track_id: &str, bytes: &[u8]) -> Result<bool, String> {
    let high = analysis_backfill_is_current_track(app, track_id);
    let outcome = submit_analysis_cpu_seed(
        app.clone(),
        track_id.to_string(),
        bytes.to_vec(),
        high,
    )
    .await
    .map_err(|e| {
        crate::app_eprintln!("[analysis] failed to seed {}: {}", track_id, e);
        e
    })?;
    let has_loudness = app
        .try_state::<analysis_cache::AnalysisCache>()
        .and_then(|cache| cache.get_latest_loudness_for_track(track_id).ok().flatten())
        .is_some();
    crate::app_deprintln!(
        "[analysis] seed result track_id={} bytes={} has_loudness={} outcome={outcome:?}",
        track_id,
        bytes.len(),
        has_loudness
    );
    Ok(has_loudness)
}

pub(crate) async fn enqueue_analysis_seed_from_file(
    app: &tauri::AppHandle,
    track_id: &str,
    file_path: &std::path::Path,
) {
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
pub(crate) async fn download_track_offline(
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

    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    // Stream directly to a .part file; rename on success to avoid partial files.
    let part_path = file_path.with_extension(format!("{suffix}.part"));
    if let Err(e) = stream_to_file(response, &part_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(e);
    }
    tokio::fs::rename(&part_path, &file_path)
        .await
        .map_err(|e| e.to_string())?;

    enqueue_analysis_seed_from_file(&app, &track_id, &file_path).await;

    Ok(path_str)
}

/// Returns the total size in bytes of all files in the offline cache directory (and optional custom dir).
#[tauri::command]
pub(crate) async fn get_offline_cache_size(custom_dir: Option<String>, app: tauri::AppHandle) -> u64 {
    fn dir_size(root: std::path::PathBuf) -> u64 {
        if !root.exists() { return 0; }
        let mut total: u64 = 0;
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(meta) = std::fs::metadata(&path) {
                    total += meta.len();
                }
            }
        }
        total
    }

    let default_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("psysonic-offline"),
        Err(_) => return 0,
    };
    let mut total = dir_size(default_dir);

    if let Some(cd) = custom_dir {
        let custom = std::path::PathBuf::from(cd);
        if custom != std::path::PathBuf::from("") {
            total += dir_size(custom);
        }
    }
    total
}

/// Removes a cached track from the offline cache. Accepts the full local path
/// (stored in OfflineTrackMeta) so it works regardless of which directory was used.
/// After deleting the file, empty parent directories up to (but not including)
/// `base_dir` are pruned using `remove_dir` (never `remove_dir_all`).
#[tauri::command]
pub(crate) async fn delete_offline_track(
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

    // Walk upward, pruning directories that have become empty.
    // Stops as soon as a non-empty directory or the boundary is reached.
    let mut current = file_path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == boundary || !dir.starts_with(&boundary) {
            break;
        }
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break; // Directory still has contents — stop pruning.
                }
                if std::fs::remove_dir(&dir).is_err() {
                    break; // Could not remove (e.g. permissions) — stop.
                }
                current = dir.parent().map(|p| p.to_path_buf());
            }
            Err(_) => break,
        }
    }

    Ok(())
}


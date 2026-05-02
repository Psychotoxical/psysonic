use super::*;

#[tauri::command]
pub(crate) async fn download_track_hot_cache(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<HotCacheDownloadResult, String> {
    let root = resolve_hot_cache_root(custom_dir, &app)?;
    let cache_dir = root.join(&server_id);

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    if file_path.exists() {
        let size = tokio::fs::metadata(&file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        crate::app_deprintln!(
            "[hot-cache] download disk_hit track_id={} server_id={} bytes={}",
            track_id,
            server_id,
            size
        );
        // Disk hit: still seed analysis, but do not block the command (full-file read); the
        // prefetch worker runs invokes sequentially.
        let app_seed = app.clone();
        let tid = track_id.clone();
        let fp = file_path.clone();
        tokio::spawn(async move {
            enqueue_analysis_seed_from_file(&app_seed, &tid, &fp).await;
        });
        return Ok(HotCacheDownloadResult {
            path: path_str,
            size,
        });
    }

    crate::app_deprintln!(
        "[hot-cache] download http_start track_id={} server_id={}",
        track_id,
        server_id
    );

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

    let app_seed = app.clone();
    let tid = track_id.clone();
    let fp = file_path.clone();
    tokio::spawn(async move {
        enqueue_analysis_seed_from_file(&app_seed, &tid, &fp).await;
    });

    let size = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    crate::app_deprintln!(
        "[hot-cache] download http_done track_id={} server_id={} bytes={}",
        track_id,
        server_id,
        size
    );
    Ok(HotCacheDownloadResult {
        path: path_str,
        size,
    })
}

/// Promotes bytes captured by the manual streaming path into hot cache on disk.
/// Returns `Ok(None)` when no completed stream cache is available for this URL.
#[tauri::command]
pub(crate) async fn promote_stream_cache_to_hot_cache(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, audio::AudioEngine>,
) -> Result<Option<HotCacheDownloadResult>, String> {
    let root = resolve_hot_cache_root(custom_dir, &app)?;
    let cache_dir = root.join(&server_id);
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    if file_path.exists() {
        let size = tokio::fs::metadata(&file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        crate::app_deprintln!(
            "[hot-cache] promote disk_hit track_id={} server_id={} bytes={}",
            track_id,
            server_id,
            size
        );
        let app_seed = app.clone();
        let tid = track_id.clone();
        let fp = file_path.clone();
        tokio::spawn(async move {
            enqueue_analysis_seed_from_file(&app_seed, &tid, &fp).await;
        });
        return Ok(Some(HotCacheDownloadResult { path: path_str, size }));
    }

    let bytes = match audio::take_stream_completed_for_url(&state, &url) {
        Some(b) => b,
        None => {
            crate::app_deprintln!(
                "[hot-cache] promote skip track_id={} reason=no_completed_stream_for_url",
                track_id
            );
            return Ok(None);
        }
    };

    let part_path = file_path.with_extension(format!("{suffix}.part"));
    if let Err(e) = tokio::fs::write(&part_path, &bytes).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(e.to_string());
    }
    tokio::fs::rename(&part_path, &file_path)
        .await
        .map_err(|e| e.to_string())?;

    let _ = enqueue_analysis_seed(&app, &track_id, &bytes).await;

    let size = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    crate::app_deprintln!(
        "[hot-cache] promote from_stream track_id={} server_id={} bytes={}",
        track_id,
        server_id,
        size
    );
    Ok(Some(HotCacheDownloadResult { path: path_str, size }))
}

#[tauri::command]
pub(crate) async fn get_hot_cache_size(custom_dir: Option<String>, app: tauri::AppHandle) -> u64 {
    fn dir_size(root: std::path::PathBuf) -> u64 {
        if !root.exists() {
            return 0;
        }
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

    resolve_hot_cache_root(custom_dir, &app)
        .map(|root| dir_size(root))
        .unwrap_or(0)
}

#[tauri::command]
pub(crate) async fn delete_hot_cache_track(
    local_path: String,
    custom_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&local_path);
    let existed = file_path.exists();
    if existed {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }
    crate::app_deprintln!(
        "[hot-cache] delete file existed={} path_suffix={}",
        existed,
        file_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("?")
    );

    let boundary = resolve_hot_cache_root(custom_dir, &app)?;

    let mut current = file_path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == boundary || !dir.starts_with(&boundary) {
            break;
        }
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break;
                }
                if std::fs::remove_dir(&dir).is_err() {
                    break;
                }
                current = dir.parent().map(|p| p.to_path_buf());
            }
            Err(_) => break,
        }
    }

    Ok(())
}

/// Removes the entire hot cache root (`psysonic-hot-cache` for the active location).
#[tauri::command]
pub(crate) async fn purge_hot_cache(custom_dir: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    let root = resolve_hot_cache_root(custom_dir, &app)?;
    if !root.exists() {
        return Ok(());
    }
    tokio::fs::remove_dir_all(&root)
        .await
        .map_err(|e| e.to_string())?;
    crate::app_deprintln!(
        "[hot-cache] purge root={} status=ok",
        root.to_string_lossy()
    );
    Ok(())
}

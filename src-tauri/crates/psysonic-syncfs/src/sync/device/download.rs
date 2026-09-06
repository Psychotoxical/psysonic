use tauri::{Emitter, Manager};

use super::{
    build_track_path, device_sync_operation_guard, path_contains_symlink, SyncTrackResult,
    TrackSyncInfo,
};
use crate::file_transfer::{
    apply_server_http_get, finalize_streamed_download, subsonic_http_client,
};

/// AppHandle-free download primitive used by [`sync_track_to_device`].
pub(crate) async fn sync_download_one_track(
    dest_path: &std::path::Path,
    suffix: &str,
    url: &str,
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
) -> Result<bool, String> {
    if dest_path.exists() {
        return Ok(false);
    }
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let response = apply_server_http_get(client, registry, server_ref, url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let part_path = dest_path.with_extension(format!("{suffix}.part"));
    finalize_streamed_download(response, dest_path, &part_path, None).await?;
    Ok(true)
}

/// Downloads one track through the legacy single-track command.
#[tauri::command]
#[specta::specta]
pub async fn sync_track_to_device(
    track: TrackSyncInfo,
    dest_dir: String,
    job_id: String,
    app: tauri::AppHandle,
) -> Result<SyncTrackResult, String> {
    let _device_sync_guard = device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    let root = std::path::Path::new(&dest_dir);
    let relative = build_track_path(&track);
    let file_name = format!("{}.{}", relative, track.suffix);
    let dest_path = root.join(&file_name);
    if path_contains_symlink(root, &dest_path)? {
        return Err("DEVICE_SYNC_PLANNED_PATH_ESCAPES_ROOT".to_string());
    }
    let path_str = dest_path.to_string_lossy().to_string();

    let client = subsonic_http_client(std::time::Duration::from_secs(300))?;
    let http_registry = app
        .try_state::<std::sync::Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|state| std::sync::Arc::clone(&*state));
    match sync_download_one_track(
        &dest_path,
        &track.suffix,
        &track.url,
        &client,
        http_registry.as_deref(),
        None,
    )
    .await
    {
        Ok(downloaded) => {
            let status = if downloaded { "done" } else { "skipped" };
            let _ = app.emit(
                "device:sync:progress",
                serde_json::json!({
                    "jobId": job_id, "trackId": track.id, "status": status, "path": path_str,
                }),
            );
            Ok(SyncTrackResult {
                path: path_str,
                skipped: !downloaded,
            })
        }
        Err(error) => {
            let _ = app.emit(
                "device:sync:progress",
                serde_json::json!({
                    "jobId": job_id, "trackId": track.id, "status": "error", "error": error,
                }),
            );
            Err(error)
        }
    }
}

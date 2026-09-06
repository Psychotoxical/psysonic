use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::sync_cancel_flags;

use super::device::{
    build_track_path, ensure_mounted_target, get_removable_drives, path_contains_symlink,
    planned_path_stays_within, validate_device_identity, SyncBatchResult, TrackSyncInfo,
};
use crate::file_transfer::{
    apply_server_http_get, finalize_streamed_download, subsonic_http_client,
};

mod filesystem;
mod model;
mod payload;
pub(crate) mod plan;
mod planner;

pub(crate) use model::{
    estimate_track_size_bytes, fetch_subsonic_songs, inject_playlist_context,
    subsonic_response_root, track_sync_info_from_subsonic_json,
};
pub use model::{
    parse_subsonic_songs, DeviceSyncLayoutMode, DeviceSyncManifestFile, DeviceSyncManifestPlaylist,
    DeviceSyncPlannedPlaylist, DeviceSyncPlaylistPathMode, DeviceSyncSourcePayload,
    SubsonicAuthPayload, SyncDeltaResult,
};
pub(crate) use plan::{
    activate_device_sync_plan, clear_device_sync_plan, normalized_manifest_files,
    normalized_manifest_playlists, normalized_strings, relative_delete_paths,
    validate_active_device_sync_plan_binding, DeviceSyncPlanPlaylist, DeviceSyncPlanRecord,
};
pub(crate) use planner::portable_path_identity;

pub use filesystem::prune_empty_parents;
use filesystem::{
    delete_device_file_impl, delete_device_files_impl, list_device_dir_files_impl,
    rollback_device_files,
};
use payload::calculate_sync_payload_impl;
#[cfg(test)]
use payload::{
    device_sync_source_key, playlist_collision_source_keys, validate_device_sync_source_owners,
};

#[tauri::command]
#[specta::specta]
pub async fn list_device_dir_files(dir: String) -> Result<Vec<String>, String> {
    list_device_dir_files_impl(dir).await
}

/// Deletes a file from the device and prunes empty parent directories
/// (up to 2 levels: album folder, then artist folder).
#[tauri::command]
#[specta::specta]
pub async fn delete_device_file(dest_dir: String, path: String) -> Result<(), String> {
    let _device_sync_guard = super::device::device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    ensure_mounted_target(std::path::Path::new(&dest_dir))?;
    delete_device_file_impl(dest_dir, path).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri IPC fields map directly to the frontend request.
pub async fn calculate_sync_payload(
    sources: Vec<DeviceSyncSourcePayload>,
    deletion_ids: Vec<String>,
    auth: SubsonicAuthPayload,
    target_dir: String,
    layout_mode: DeviceSyncLayoutMode,
    playlist_path_mode: DeviceSyncPlaylistPathMode,
    expected_device_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<SyncDeltaResult, String> {
    let _device_sync_guard = super::device::device_sync_operation_guard().await;
    let device_id = {
        let _filesystem_write_guard = crate::filesystem_write_guard().await?;
        let root = std::path::Path::new(&target_dir);
        let device_id = super::device::ensure_device_identity(root)?;
        validate_active_device_sync_plan_binding(root, &device_id, expected_device_id.as_deref())?;
        device_id
    };
    calculate_sync_payload_impl(
        sources,
        deletion_ids,
        auth,
        target_dir,
        layout_mode,
        playlist_path_mode,
        device_id,
        expected_device_id,
        app,
    )
    .await
}

/// Signals a running `sync_batch_to_device` job to stop after its current tracks finish.
#[tauri::command]
#[specta::specta]
pub fn cancel_device_sync(job_id: String, app: tauri::AppHandle) {
    if let Ok(flags) = sync_cancel_flags().lock() {
        if let Some(flag) = flags.get(&job_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    let _ = app.emit(
        "device:sync:cancelled",
        serde_json::json!({ "jobId": job_id }),
    );
}

/// Downloads a batch of tracks to a USB/SD device with controlled concurrency.
/// At most 2 parallel writes run simultaneously to prevent I/O choking on USB.
/// Emits throttled `device:sync:progress` events (max once per 500ms) and a
/// final `device:sync:complete` event with the summary.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // Tauri IPC fields map directly to the generated frontend binding.
pub async fn sync_batch_to_device(
    tracks: Vec<TrackSyncInfo>,
    dest_dir: String,
    job_id: String,
    expected_bytes: u64,
    expected_device_id: String,
    plan_id: String,
    server_id: Option<String>,
    app: tauri::AppHandle,
) -> Result<SyncBatchResult, String> {
    let _device_sync_guard = super::device::device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};
    use tokio::sync::Mutex;

    let dest_root = std::path::PathBuf::from(&dest_dir);
    validate_device_identity(&dest_root, &expected_device_id)?;

    // Safety: Ensure target logic hasn't exceeded physical volume capacities securely stopping dead bytes natively.
    let drives = get_removable_drives();
    let dest_canon = dest_root
        .canonicalize()
        .unwrap_or_else(|_| dest_root.clone());
    let dest_str = dest_canon.to_string_lossy();

    for drive in drives {
        if dest_str.starts_with(&drive.mount_point) {
            // Buffer of ~10 MB padding boundary natively mapped
            if expected_bytes > drive.available_space.saturating_sub(10_000_000) {
                return Err("NOT_ENOUGH_SPACE".to_string());
            }
            break;
        }
    }

    // Register a cancellation flag for this job.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Ok(mut flags) = sync_cancel_flags().lock() {
        flags.insert(job_id.clone(), cancel_flag.clone());
    }

    // Shared reqwest client — reused across all downloads.
    let client = subsonic_http_client(Duration::from_secs(300))?;
    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let active_plan = activate_device_sync_plan(&dest_root, &plan_id, &expected_device_id)?;
    let planned_tracks = active_plan
        .manifest_files
        .iter()
        .map(|file| {
            (
                portable_path_identity(&file.relative_path),
                file.track_id.as_str(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    for track in &tracks {
        let relative = format!("{}.{}", build_track_path(track), track.suffix);
        if planned_tracks
            .get(&portable_path_identity(&relative))
            .copied()
            != Some(track.id.as_str())
        {
            return Err("DEVICE_SYNC_PENDING_PLAN_MISMATCH".to_string());
        }
    }

    // Concurrency limiter: max 2 parallel USB writes.
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(2));

    // Counters.
    let done = std::sync::Arc::new(AtomicU32::new(0));
    let skipped = std::sync::Arc::new(AtomicU32::new(0));
    let failed = std::sync::Arc::new(AtomicU32::new(0));
    let fresh_paths = std::sync::Arc::new(Mutex::new(Vec::new()));

    // Throttled event emission (max once per 500ms).
    let last_emit = std::sync::Arc::new(Mutex::new(Instant::now()));
    let total = tracks.len() as u32;

    let mut handles = Vec::with_capacity(tracks.len());

    for track in tracks {
        let sem = semaphore.clone();
        let cli = client.clone();
        let reg_for_task = http_registry.clone();
        let app2 = app.clone();
        let job = job_id.clone();
        let dest = dest_dir.clone();
        let d = done.clone();
        let s = skipped.clone();
        let f = failed.clone();
        let le = last_emit.clone();
        let fresh = fresh_paths.clone();
        let cancel = cancel_flag.clone();
        let request_server_id = server_id.clone();
        let expected_device = expected_device_id.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.expect("semaphore closed");
            let registry = reg_for_task.as_deref();

            // Bail out if cancelled while waiting in the semaphore queue.
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            if validate_device_identity(std::path::Path::new(&dest), &expected_device).is_err() {
                f.fetch_add(1, Ordering::Relaxed);
                return;
            }

            let relative = build_track_path(&track);
            let file_name = format!("{}.{}", relative, track.suffix);
            let dest_path = std::path::Path::new(&dest).join(&file_name);
            let path_str = dest_path.to_string_lossy().to_string();

            match planned_path_stays_within(std::path::Path::new(&dest), &dest_path) {
                Ok(true) => {}
                Ok(false) => {
                    f.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Err(_) => {
                    f.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }
            if path_contains_symlink(std::path::Path::new(&dest), &dest_path).unwrap_or(true) {
                f.fetch_add(1, Ordering::Relaxed);
                return;
            }

            let status = if dest_path.exists() {
                s.fetch_add(1, Ordering::Relaxed);
                "skipped"
            } else {
                // Ensure parent directories exist.
                if let Some(parent) = dest_path.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit(
                            "device:sync:progress",
                            serde_json::json!({
                                "jobId": job, "trackId": track.id, "status": "error",
                                "error": e.to_string(),
                            }),
                        );
                        return;
                    }
                }
                if !planned_path_stays_within(std::path::Path::new(&dest), &dest_path)
                    .unwrap_or(false)
                    || path_contains_symlink(std::path::Path::new(&dest), &dest_path)
                        .unwrap_or(true)
                {
                    f.fetch_add(1, Ordering::Relaxed);
                    return;
                }

                let response = match apply_server_http_get(
                    &cli,
                    registry,
                    request_server_id.as_deref(),
                    &track.url,
                )
                .send()
                .await
                {
                    Ok(r) if r.status().is_success() => r,
                    Ok(r) => {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit(
                            "device:sync:progress",
                            serde_json::json!({
                                "jobId": job, "trackId": track.id, "status": "error",
                                "error": format!("HTTP {}", r.status().as_u16()),
                            }),
                        );
                        return;
                    }
                    Err(e) => {
                        f.fetch_add(1, Ordering::Relaxed);
                        let _ = app2.emit(
                            "device:sync:progress",
                            serde_json::json!({
                                "jobId": job, "trackId": track.id, "status": "error",
                                "error": e.to_string(),
                            }),
                        );
                        return;
                    }
                };

                let part_path = dest_path.with_extension(format!("{}.part", track.suffix));
                if validate_device_identity(std::path::Path::new(&dest), &expected_device).is_err()
                {
                    f.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                if let Err(e) =
                    finalize_streamed_download(response, &dest_path, &part_path, None).await
                {
                    f.fetch_add(1, Ordering::Relaxed);
                    let _ = app2.emit(
                        "device:sync:progress",
                        serde_json::json!({
                            "jobId": job, "trackId": track.id, "status": "error",
                            "error": e,
                        }),
                    );
                    return;
                }

                d.fetch_add(1, Ordering::Relaxed);
                fresh.lock().await.push(dest_path.clone());
                "done"
            };

            // Throttled progress event — max once per 500ms.
            let should_emit = {
                let mut guard = le.lock().await;
                if guard.elapsed() >= Duration::from_millis(500) {
                    *guard = Instant::now();
                    true
                } else {
                    false
                }
            };
            if should_emit {
                let _ = app2.emit(
                    "device:sync:progress",
                    serde_json::json!({
                        "jobId": job, "trackId": track.id, "status": status, "path": path_str,
                        "done": d.load(Ordering::Relaxed),
                        "skipped": s.load(Ordering::Relaxed),
                        "failed": f.load(Ordering::Relaxed),
                        "total": total,
                    }),
                );
            }
        }));
    }

    // Wait for all tasks to complete.
    for handle in handles {
        let _ = handle.await;
    }

    // Clean up the cancellation flag.
    let was_cancelled = cancel_flag.load(Ordering::Relaxed);
    if let Ok(mut flags) = sync_cancel_flags().lock() {
        flags.remove(&job_id);
    }

    let should_rollback = was_cancelled || failed.load(Ordering::Relaxed) > 0;
    if should_rollback {
        let paths = std::mem::take(&mut *fresh_paths.lock().await);
        let rollback_ok = validate_device_identity(&dest_root, &expected_device_id).is_ok()
            && rollback_device_files(&dest_root, paths).await.is_ok();
        if !rollback_ok {
            failed.fetch_add(1, Ordering::Relaxed);
        }
        done.store(0, Ordering::Relaxed);
    }

    let result = SyncBatchResult {
        done: done.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        failed: failed.load(Ordering::Relaxed),
    };

    // Final event so the frontend always sees 100%.
    let _ = app.emit(
        "device:sync:complete",
        serde_json::json!({
            "jobId": job_id,
            "done": result.done,
            "skipped": result.skipped,
            "failed": result.failed,
            "total": total,
            "cancelled": was_cancelled,
        }),
    );

    Ok(result)
}

/// Deletes multiple files from the device in one call and prunes empty parent
/// directories. Returns the number of files successfully deleted.
#[tauri::command]
#[specta::specta]
pub async fn delete_device_files(dest_dir: String, paths: Vec<String>) -> Result<u32, String> {
    let _device_sync_guard = super::device::device_sync_operation_guard().await;
    let _filesystem_write_guard = crate::filesystem_write_guard().await?;
    ensure_mounted_target(std::path::Path::new(&dest_dir))?;
    delete_device_files_impl(dest_dir, paths).await
}

#[cfg(test)]
mod tests;

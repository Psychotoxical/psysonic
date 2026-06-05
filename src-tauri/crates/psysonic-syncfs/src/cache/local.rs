//! Unified local playback download primitive (LP-1).
//!
//! Builds hierarchical paths from the library index row and downloads bytes
//! under `{media}/{cache|library}/…`. Legacy `download_track_hot_cache` /
//! `download_track_offline` remain until LP-2/3 switch call sites.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use psysonic_analysis::analysis_runtime::{enqueue_track_analysis, AnalysisBackfillPriority};
use psysonic_audio as audio;
use psysonic_core::media_layout::{
    absolute_track_path, layout_fingerprint, LocalTier, TrackPathInput,
};
use psysonic_library::{repos::TrackRepository, LibraryRuntime};
use tauri::{AppHandle, Manager, State};

use crate::file_transfer::{finalize_streamed_download, subsonic_http_client};
use crate::{offline_cancel_flags, DownloadSemaphore};

use super::offline::enqueue_analysis_seed_from_file;

/// Resolved media root `M` — user `mediaDir` or `{app_data}/media/`.
pub fn resolve_media_dir(custom_media_dir: Option<&str>, app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if let Some(cd) = custom_media_dir.filter(|s| !s.is_empty()) {
        let base = std::path::PathBuf::from(cd);
        if !base.exists() {
            return Err("VOLUME_NOT_FOUND".to_string());
        }
        Ok(base)
    } else {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("media"))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrackDownloadResult {
    pub path: String,
    pub size: u64,
    pub layout_fingerprint: String,
}

fn track_row_to_path_input(row: &psysonic_library::repos::TrackRow) -> TrackPathInput {
    TrackPathInput {
        artist: row.artist.clone(),
        album_artist: row.album_artist.clone(),
        album: row.album.clone(),
        title: row.title.clone(),
        track_number: row.track_number,
        disc_number: row.disc_number,
        suffix: row.suffix.clone(),
        raw_json: Some(row.raw_json.clone()),
    }
}

/// Downloads a track into the unified media layout. Requires a library index row
/// (cold miss → `LIBRARY_TRACK_NOT_FOUND`). Disk scope uses `server_index_key`;
/// SQL lookup uses `library_server_id`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_track_local(
    tier: String,
    track_id: String,
    server_index_key: String,
    library_server_id: String,
    url: String,
    suffix: String,
    media_dir: Option<String>,
    download_id: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    dl_sem: State<'_, DownloadSemaphore>,
    app: AppHandle,
) -> Result<LocalTrackDownloadResult, String> {
    let local_tier = LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;

    let repo = TrackRepository::new(&runtime.store);
    let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
        return Err("LIBRARY_TRACK_NOT_FOUND".to_string());
    };

    let path_input = track_row_to_path_input(&row);
    let fingerprint = layout_fingerprint(&path_input);
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let file_path = absolute_track_path(
        &media_root,
        local_tier,
        &server_index_key,
        &path_input,
        &suffix,
    );
    let path_str = file_path.to_string_lossy().to_string();

    if file_path.is_file() {
        let size = tokio::fs::metadata(&file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let app_seed = app.clone();
        let tid = track_id.clone();
        let sid = library_server_id.clone();
        let fp = file_path.clone();
        tokio::spawn(async move {
            enqueue_analysis_seed_from_file(&app_seed, &sid, &tid, &fp, None).await;
        });
        return Ok(LocalTrackDownloadResult {
            path: path_str,
            size,
            layout_fingerprint: fingerprint,
        });
    }

    let cancel_flag: Option<Arc<AtomicBool>> = download_id.as_deref().and_then(|id| {
        offline_cancel_flags().lock().ok().map(|mut flags| {
            flags
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(AtomicBool::new(false)))
                .clone()
        })
    });

    let _permit = dl_sem.acquire().await.map_err(|e| e.to_string())?;

    if cancel_flag.as_ref().is_some_and(|f| f.load(Ordering::Relaxed)) {
        return Err("CANCELLED".to_string());
    }

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let client = subsonic_http_client(std::time::Duration::from_secs(120))?;
    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let part_path = file_path.with_extension(format!("{suffix}.part"));
    finalize_streamed_download(
        response,
        &file_path,
        &part_path,
        cancel_flag.as_deref(),
    )
    .await?;

    enqueue_analysis_seed_from_file(
        &app,
        &library_server_id,
        &track_id,
        &file_path,
        None,
    )
    .await;

    let size = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(LocalTrackDownloadResult {
        path: path_str,
        size,
        layout_fingerprint: fingerprint,
    })
}

fn resolve_media_tier_root(
    tier: LocalTier,
    media_dir: Option<&str>,
    app: &AppHandle,
) -> Result<std::path::PathBuf, String> {
    Ok(resolve_media_dir(media_dir, app)?.join(tier.subdir()))
}

/// Recursive byte size under `{media}/{cache|library}/`.
#[tauri::command]
pub async fn get_media_tier_size(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> u64 {
    let local_tier = match LocalTier::parse(&tier) {
        Some(t) => t,
        None => return 0,
    };
    resolve_media_tier_root(local_tier, media_dir.as_deref(), &app)
        .map(|root| super::fs_utils::dir_size_recursive(&root))
        .unwrap_or(0)
}

/// Deletes the entire `{cache|library}/` subtree under the media root.
#[tauri::command]
pub async fn purge_media_tier(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let local_tier = LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;
    let root = resolve_media_tier_root(local_tier, media_dir.as_deref(), &app)?;
    if root.exists() {
        tokio::fs::remove_dir_all(&root)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Deletes one media file and prunes empty parents up to the tier root.
#[tauri::command]
pub async fn delete_media_file(
    local_path: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&local_path);
    if file_path.is_file() {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    if let Some(parent) = file_path.parent() {
        for tier in [LocalTier::Ephemeral, LocalTier::Library] {
            let boundary = media_root.join(tier.subdir());
            super::fs_utils::prune_empty_dirs_up_to(parent, &boundary);
        }
    }
    Ok(())
}

/// Promotes stream-cache bytes into `{media}/cache/…` using library-index paths.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn promote_stream_cache_to_local(
    track_id: String,
    server_index_key: String,
    library_server_id: String,
    url: String,
    suffix: String,
    media_dir: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
    state: State<'_, audio::AudioEngine>,
) -> Result<Option<LocalTrackDownloadResult>, String> {
    let repo = TrackRepository::new(&runtime.store);
    let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
        return Ok(None);
    };
    let path_input = track_row_to_path_input(&row);
    let fingerprint = layout_fingerprint(&path_input);
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let file_path = absolute_track_path(
        &media_root,
        LocalTier::Ephemeral,
        &server_index_key,
        &path_input,
        &suffix,
    );
    let path_str = file_path.to_string_lossy().to_string();

    if file_path.is_file() {
        let size = tokio::fs::metadata(&file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        return Ok(Some(LocalTrackDownloadResult {
            path: path_str,
            size,
            layout_fingerprint: fingerprint,
        }));
    }

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let part_path = file_path.with_extension(format!("{suffix}.part"));

    if let Some(bytes) = audio::take_stream_completed_for_url(&state, &url) {
        if let Err(e) = tokio::fs::write(&part_path, &bytes).await {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e.to_string());
        }
        tokio::fs::rename(&part_path, &file_path)
            .await
            .map_err(|e| e.to_string())?;
        let priority = psysonic_analysis::analysis_runtime::analysis_backfill_resolve_priority(
            &app,
            &library_server_id,
            &track_id,
            None,
        );
        let format_hint = Some(suffix.to_ascii_lowercase());
        let _ = enqueue_track_analysis(
            &app,
            &library_server_id,
            &track_id,
            &bytes,
            format_hint.as_deref(),
            priority,
        )
        .await;
    } else if let Some(spill_path) = audio::take_stream_completed_spill_for_url(&state, &url) {
        if let Err(e) = tokio::fs::rename(&spill_path, &file_path).await {
            if let Err(copy_err) = tokio::fs::copy(&spill_path, &file_path).await {
                let _ = tokio::fs::remove_file(&spill_path).await;
                return Err(format!("promote spill rename: {e}; copy: {copy_err}"));
            }
            let _ = tokio::fs::remove_file(&spill_path).await;
        }
        enqueue_analysis_seed_from_file(
            &app,
            &library_server_id,
            &track_id,
            &file_path,
            Some(AnalysisBackfillPriority::Middle),
        )
        .await;
    } else {
        return Ok(None);
    }

    let size = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(Some(LocalTrackDownloadResult {
        path: path_str,
        size,
        layout_fingerprint: fingerprint,
    }))
}


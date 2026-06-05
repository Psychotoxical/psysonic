//! Unified local playback download primitive (LP-1).
//!
//! Builds hierarchical paths from the library index row and downloads bytes
//! under `{media}/{cache|library}/…`. Legacy `download_track_hot_cache` /
//! `download_track_offline` remain until LP-2/3 switch call sites.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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


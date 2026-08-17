//! Unified local playback download primitive (LP-1).
//!
//! Builds hierarchical paths from the library index row and downloads bytes
//! under `{media}/{cache|library}/…`. Legacy `download_track_hot_cache` /
//! `download_track_offline` remain until LP-2/3 switch call sites.

mod discovery;
mod download;
mod eviction;
mod legacy;
mod paths;
mod promotion;

use psysonic_audio as audio;
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, State};

use crate::DownloadSemaphore;

/// Resolved media root `M` — user `mediaDir` or `{app_data}/media/`.
pub fn resolve_media_dir(
    custom_media_dir: Option<&str>,
    app: &AppHandle,
) -> Result<std::path::PathBuf, String> {
    paths::resolve_media_dir(custom_media_dir, app)
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrackDownloadResult {
    pub path: String,
    pub size: u64,
    pub layout_fingerprint: String,
    pub original_bytes_verified: bool,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrackProbeResult {
    pub path: String,
    pub size: u64,
    pub layout_fingerprint: String,
    pub exists: bool,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTierDiskHit {
    pub track_id: String,
    pub path: String,
    pub size: u64,
    pub layout_fingerprint: String,
    pub suffix: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LegacyOfflineMigrationResult {
    pub track_id: String,
    pub server_index_key: String,
    pub path: String,
    pub size: u64,
    pub layout_fingerprint: String,
    pub relocated: bool,
    pub skipped_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyOfflineDiskEntry {
    pub server_segment: String,
    pub track_id: String,
    pub path: String,
    pub suffix: String,
    pub size_bytes: u64,
}

/// Downloads a track into the unified media layout. Library/Favorites tiers require
/// a library index row (cold miss → `LIBRARY_TRACK_NOT_FOUND`); Ephemeral returns
/// `TRACK_NOT_INDEXED` when the row is missing. Disk scope uses `server_index_key`;
/// SQL lookup uses `library_server_id`.
#[tauri::command]
#[specta::specta]
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
    download::download_track_local(
        tier,
        track_id,
        server_index_key,
        library_server_id,
        url,
        suffix,
        media_dir,
        download_id,
        runtime,
        dl_sem,
        app,
    )
    .await
}

/// Scan library-tier bytes on disk and match them to known candidates only
/// (`track_offline.local_path` + canonical paths for `candidate_track_ids`).
#[tauri::command]
#[specta::specta]
pub async fn discover_library_tier_on_disk(
    server_index_key: String,
    library_server_id: String,
    candidate_track_ids: Vec<String>,
    media_dir: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<Vec<LibraryTierDiskHit>, String> {
    discovery::discover_library_tier_on_disk(
        server_index_key,
        library_server_id,
        candidate_track_ids,
        media_dir,
        runtime,
        app,
    )
    .await
}

/// Resolve the canonical `library/` path for a track and report on-disk presence only
/// (no download, no analysis seed).
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn probe_library_track_local(
    track_id: String,
    server_index_key: String,
    library_server_id: String,
    suffix: String,
    media_dir: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<LibraryTrackProbeResult, String> {
    discovery::probe_library_track_local(
        track_id,
        server_index_key,
        library_server_id,
        suffix,
        media_dir,
        runtime,
        app,
    )
    .await
}

/// Remove library-tier files under `{server_index_key}` that are not listed in `keep_paths`.
#[tauri::command]
#[specta::specta]
pub async fn prune_orphan_library_tier_files(
    server_index_key: String,
    keep_paths: Vec<String>,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    eviction::prune_orphan_library_tier_files(server_index_key, keep_paths, media_dir, app).await
}

/// Evict unindexed ephemeral cache files (oldest first) until tier size ≤ `max_bytes`.
#[tauri::command]
#[specta::specta]
pub async fn evict_ephemeral_cache_orphans_to_fit(
    keep_paths: Vec<String>,
    max_bytes: u64,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    eviction::evict_ephemeral_cache_orphans_to_fit(keep_paths, max_bytes, media_dir, app).await
}

/// Remove ephemeral-tier files under `{media}/cache/` not listed in `keep_paths`.
#[tauri::command]
#[specta::specta]
pub async fn prune_orphan_ephemeral_cache_files(
    keep_paths: Vec<String>,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    eviction::prune_orphan_ephemeral_cache_files(keep_paths, media_dir, app).await
}

/// Batch existence probe for reconcile (index rows without on-disk bytes).
#[tauri::command]
#[specta::specta]
pub fn probe_media_files(local_paths: Vec<String>) -> Vec<bool> {
    eviction::probe_media_files(local_paths)
}

/// Recursive byte size under `{media}/{cache|library}/`.
#[tauri::command]
#[specta::specta]
pub async fn get_media_tier_size(tier: String, media_dir: Option<String>, app: AppHandle) -> u64 {
    eviction::get_media_tier_size(tier, media_dir, app).await
}

/// Deletes the entire `{cache|library}/` subtree under the media root.
#[tauri::command]
#[specta::specta]
pub async fn purge_media_tier(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    eviction::purge_media_tier(tier, media_dir, app).await
}

/// Deletes one media file and prunes empty parents up to the tier root.
#[tauri::command]
#[specta::specta]
pub async fn delete_media_file(
    local_path: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    eviction::delete_media_file(local_path, media_dir, app).await
}

/// Removes empty directories under `{media}/{cache|library}/` (post-eviction sweep).
#[tauri::command]
#[specta::specta]
pub async fn prune_empty_media_tier_dirs(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    eviction::prune_empty_media_tier_dirs(tier, media_dir, app).await
}

/// Promotes stream-cache bytes into `{media}/cache/…` using library-index paths.
#[tauri::command]
#[specta::specta]
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
    promotion::promote_stream_cache_to_local(
        track_id,
        server_index_key,
        library_server_id,
        url,
        suffix,
        media_dir,
        runtime,
        app,
        state,
    )
    .await
}

/// Scan `psysonic-offline/{segment}/{trackId}.ext`, verify each id in the library
/// index, and relocate live tracks into `{media}/library/…`.
#[tauri::command]
#[specta::specta]
pub async fn migrate_legacy_offline_disk(
    media_dir: Option<String>,
    custom_offline_dir: Option<String>,
    server_index_key_filter: Option<String>,
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
) -> Result<Vec<LegacyOfflineMigrationResult>, String> {
    legacy::migrate_legacy_offline_disk(
        media_dir,
        custom_offline_dir,
        server_index_key_filter,
        runtime,
        app,
    )
    .await
}

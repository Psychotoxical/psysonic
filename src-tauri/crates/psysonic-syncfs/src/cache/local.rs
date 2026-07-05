//! Unified local playback download primitive (LP-1).
//!
//! Builds hierarchical paths from the library index row and downloads bytes
//! under `{media}/{cache|library}/…`. Legacy `download_track_hot_cache` /
//! `download_track_offline` remain until LP-2/3 switch call sites.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use psysonic_analysis::analysis_runtime::{
    enqueue_offline_library_analysis_from_file, enqueue_track_analysis, AnalysisBackfillPriority,
};
use psysonic_audio as audio;
use psysonic_core::cover_cache_layout::sanitize_path_segment;
use psysonic_core::media_layout::{
    absolute_track_path, ensure_track_path_within_tier, layout_fingerprint, LocalTier,
    TrackPathInput,
};
use psysonic_library::repos::TrackRow;
use psysonic_library::{repos::TrackRepository, LibraryRuntime};
use tauri::{AppHandle, Manager, State};

use crate::file_transfer::{apply_server_http_get, finalize_streamed_download, subsonic_http_client};
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

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrackDownloadResult {
    pub path: String,
    pub size: u64,
    pub layout_fingerprint: String,
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

struct ResolvedLibraryTrackPath {
    file_path: PathBuf,
    path_str: String,
    layout_fingerprint: String,
}

fn resolve_library_track_path(
    track_id: &str,
    server_index_key: &str,
    library_server_id: &str,
    suffix: &str,
    media_dir: Option<&str>,
    app: &AppHandle,
    runtime: &LibraryRuntime,
) -> Result<ResolvedLibraryTrackPath, String> {
    resolve_track_path_for_tier(ResolveTrackPathForTier {
        tier: LocalTier::Library,
        track_id,
        server_index_key,
        library_server_id,
        suffix,
        media_dir,
        app,
        runtime,
    })
}

struct ResolveTrackPathForTier<'a> {
    tier: LocalTier,
    track_id: &'a str,
    server_index_key: &'a str,
    library_server_id: &'a str,
    suffix: &'a str,
    media_dir: Option<&'a str>,
    app: &'a AppHandle,
    runtime: &'a LibraryRuntime,
}

fn resolve_track_path_for_tier(
    args: ResolveTrackPathForTier<'_>,
) -> Result<ResolvedLibraryTrackPath, String> {
    let repo = TrackRepository::new(&args.runtime.store);
    let Some(row) = repo.find_one(args.library_server_id, args.track_id)? else {
        return Err("LIBRARY_TRACK_NOT_FOUND".to_string());
    };
    let path_input = track_row_to_path_input(&row);
    let fingerprint = layout_fingerprint(&path_input);
    let media_root = resolve_media_dir(args.media_dir, args.app)?;
    let file_path = absolute_track_path(
        &media_root,
        args.tier,
        args.server_index_key,
        &path_input,
        args.suffix,
    );
    Ok(ResolvedLibraryTrackPath {
        path_str: file_path.to_string_lossy().to_string(),
        file_path,
        layout_fingerprint: fingerprint,
    })
}

fn normalize_path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// Per-track download mutex — serializes concurrent `download_track_local` /
/// `promote_stream_cache_to_local` for the same `(tier, server, track)` so two
/// callers do not stream into the same `.part` file (M5).
fn track_download_locks(
) -> &'static tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

async fn acquire_per_track_download_lock(key: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock_arc = {
        let mut map = track_download_locks().lock().await;
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    lock_arc.lock_owned().await
}

fn per_track_download_lock_key(tier: LocalTier, server_index_key: &str, track_id: &str) -> String {
    format!("{}:{}:{}", tier.subdir(), server_index_key, track_id)
}

/// Part file beside the final track; keyed by sanitized `track_id` instead of
/// replacing the media extension so concurrent different-suffix attempts do not
/// share one `{suffix}.part` on the same stem.
fn unique_part_path(file_path: &Path, suffix: &str, track_id: &str) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let safe_id = sanitize_path_segment(track_id);
    parent.join(format!("{safe_id}.{suffix}.part"))
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

async fn local_track_hit_if_exists(
    file_path: &Path,
    path_str: &str,
    fingerprint: &str,
    app: &AppHandle,
    server_index_key: &str,
    library_server_id: &str,
    track_id: &str,
) -> Result<Option<LocalTrackDownloadResult>, String> {
    if !file_path.is_file() {
        return Ok(None);
    }
    let size = tokio::fs::metadata(file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let app_seed = app.clone();
    let tid = track_id.to_string();
    let index_key = server_index_key.to_string();
    let library_id = library_server_id.to_string();
    let fp = file_path.to_path_buf();
    tokio::spawn(async move {
        let _ = enqueue_offline_library_analysis_from_file(
            &app_seed,
            &index_key,
            &library_id,
            &tid,
            &fp,
            None,
        )
        .await;
    });
    Ok(Some(LocalTrackDownloadResult {
        path: path_str.to_string(),
        size,
        layout_fingerprint: fingerprint.to_string(),
    }))
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
    let local_tier = LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;

    let resolved = if local_tier == LocalTier::Library || local_tier == LocalTier::Favorites {
        resolve_track_path_for_tier(ResolveTrackPathForTier {
            tier: local_tier,
            track_id: &track_id,
            server_index_key: &server_index_key,
            library_server_id: &library_server_id,
            suffix: &suffix,
            media_dir: media_dir.as_deref(),
            app: &app,
            runtime: &runtime,
        })?
    } else {
        let repo = TrackRepository::new(&runtime.store);
        let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
            return Err("TRACK_NOT_INDEXED".to_string());
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
        ResolvedLibraryTrackPath {
            path_str: file_path.to_string_lossy().to_string(),
            file_path,
            layout_fingerprint: fingerprint,
        }
    };
    let ResolvedLibraryTrackPath {
        file_path,
        path_str,
        layout_fingerprint: fingerprint,
    } = resolved;

    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    ensure_track_path_within_tier(&media_root, local_tier, &file_path)
        .map_err(|e| e.to_string())?;

    if let Some(hit) = local_track_hit_if_exists(
        &file_path,
        &path_str,
        &fingerprint,
        &app,
        &server_index_key,
        &library_server_id,
        &track_id,
    )
    .await?
    {
        return Ok(hit);
    }

    let _track_guard = acquire_per_track_download_lock(&per_track_download_lock_key(
        local_tier,
        &server_index_key,
        &track_id,
    ))
    .await;

    if let Some(hit) = local_track_hit_if_exists(
        &file_path,
        &path_str,
        &fingerprint,
        &app,
        &server_index_key,
        &library_server_id,
        &track_id,
    )
    .await?
    {
        return Ok(hit);
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

    if let Some(hit) = local_track_hit_if_exists(
        &file_path,
        &path_str,
        &fingerprint,
        &app,
        &server_index_key,
        &library_server_id,
        &track_id,
    )
    .await?
    {
        return Ok(hit);
    }

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let client = subsonic_http_client(std::time::Duration::from_secs(120))?;
    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let response = apply_server_http_get(
        &client,
        http_registry.as_deref(),
        Some(&server_index_key),
        &url,
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let part_path = unique_part_path(&file_path, &suffix, &track_id);
    finalize_streamed_download(
        response,
        &file_path,
        &part_path,
        cancel_flag.as_deref(),
    )
    .await?;

    enqueue_offline_library_analysis_from_file(
        &app,
        &server_index_key,
        &library_server_id,
        &track_id,
        &file_path,
        None,
    )
    .await?;

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
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let segment = sanitize_path_segment(&server_index_key);
    let tier_root = media_root
        .join(LocalTier::Library.subdir())
        .join(&segment);
    let disk_files: HashSet<String> = if tier_root.is_dir() {
        super::fs_utils::collect_regular_files_under(&tier_root)
            .into_iter()
            .map(|p| normalize_path_key(&p))
            .collect()
    } else {
        HashSet::new()
    };
    if disk_files.is_empty() {
        return Ok(Vec::new());
    }

    let repo = TrackRepository::new(&runtime.store);
    let mut hits: Vec<LibraryTierDiskHit> = Vec::new();
    let mut seen_tracks: HashSet<String> = HashSet::new();

    let offline_rows = repo.list_offline_local_paths(&library_server_id)?;

    for (track_id, local_path, suffix_opt) in offline_rows {
        if seen_tracks.contains(&track_id) {
            continue;
        }
        let path = PathBuf::from(&local_path);
        let key = normalize_path_key(&path);
        if !disk_files.contains(&key) && !path.is_file() {
            continue;
        }
        let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
            continue;
        };
        let suffix = suffix_opt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| row.suffix.as_deref().map(str::trim).filter(|s| !s.is_empty()))
            .unwrap_or("mp3");
        let path_input = track_row_to_path_input(&row);
        let fingerprint = layout_fingerprint(&path_input);
        let size = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        seen_tracks.insert(track_id.clone());
        hits.push(LibraryTierDiskHit {
            track_id,
            path: local_path,
            size,
            layout_fingerprint: fingerprint,
            suffix: suffix.to_string(),
        });
    }

    for track_id in candidate_track_ids {
        if seen_tracks.contains(&track_id) {
            continue;
        }
        let Some(row) = repo.find_one(&library_server_id, &track_id)? else {
            continue;
        };
        let suffix = row
            .suffix
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("mp3");
        let resolved = resolve_library_track_path(
            &track_id,
            &server_index_key,
            &library_server_id,
            suffix,
            media_dir.as_deref(),
            &app,
            &runtime,
        )?;
        let canonical_key = normalize_path_key(&resolved.file_path);
        if !disk_files.contains(&canonical_key) && !resolved.file_path.is_file() {
            continue;
        }
        let size = tokio::fs::metadata(&resolved.file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        seen_tracks.insert(track_id.clone());
        hits.push(LibraryTierDiskHit {
            track_id,
            path: resolved.path_str,
            size,
            layout_fingerprint: resolved.layout_fingerprint,
            suffix: suffix.to_string(),
        });
    }

    Ok(hits)
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
    let resolved = resolve_library_track_path(
        &track_id,
        &server_index_key,
        &library_server_id,
        &suffix,
        media_dir.as_deref(),
        &app,
        &runtime,
    )?;
    let exists = resolved.file_path.is_file();
    let size = if exists {
        tokio::fs::metadata(&resolved.file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };
    Ok(LibraryTrackProbeResult {
        path: resolved.path_str,
        size,
        layout_fingerprint: resolved.layout_fingerprint,
        exists,
    })
}

async fn prune_orphan_files_under_root(root: &Path, keep_paths: &[String]) -> Vec<String> {
    if !root.is_dir() {
        return Vec::new();
    }
    let keep: HashSet<String> = keep_paths
        .iter()
        .map(|p| normalize_path_key(Path::new(p)))
        .collect();
    let mut removed = Vec::new();
    for file in super::fs_utils::collect_regular_files_under(root) {
        if keep.contains(&normalize_path_key(&file)) {
            continue;
        }
        if tokio::fs::remove_file(&file).await.is_err() {
            continue;
        }
        removed.push(file.to_string_lossy().to_string());
        if let Some(parent) = file.parent() {
            super::fs_utils::prune_empty_dirs_up_to(parent, root);
        }
    }
    super::fs_utils::prune_empty_subdirs_under(root);
    removed
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
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let segment = sanitize_path_segment(&server_index_key);
    let root = media_root.join(LocalTier::Library.subdir()).join(segment);
    Ok(prune_orphan_files_under_root(&root, &keep_paths).await)
}

struct OrphanCacheFile {
    path: PathBuf,
    size: u64,
    modified: std::time::SystemTime,
}

/// Delete cache files not in `keep_paths`, oldest mtime first, until total size ≤ `max_bytes`.
async fn evict_orphan_files_under_root_to_fit(
    root: &Path,
    keep_paths: &[String],
    max_bytes: u64,
) -> Vec<String> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut total = super::fs_utils::dir_size_recursive(root);
    if total <= max_bytes {
        return Vec::new();
    }

    let keep: HashSet<String> = keep_paths
        .iter()
        .map(|p| normalize_path_key(Path::new(p)))
        .collect();

    let mut orphans: Vec<OrphanCacheFile> = Vec::new();
    for file in super::fs_utils::collect_regular_files_under(root) {
        if keep.contains(&normalize_path_key(&file)) {
            continue;
        }
        let meta = match std::fs::metadata(&file) {
            Ok(m) => m,
            Err(_) => continue,
        };
        orphans.push(OrphanCacheFile {
            path: file,
            size: meta.len(),
            modified: meta.modified().unwrap_or(std::time::UNIX_EPOCH),
        });
    }
    orphans.sort_by_key(|f| f.modified);

    let mut removed = Vec::new();
    for orphan in orphans {
        if total <= max_bytes {
            break;
        }
        if tokio::fs::remove_file(&orphan.path).await.is_err() {
            continue;
        }
        total = total.saturating_sub(orphan.size);
        removed.push(orphan.path.to_string_lossy().to_string());
        if let Some(parent) = orphan.path.parent() {
            super::fs_utils::prune_empty_dirs_up_to(parent, root);
        }
    }
    super::fs_utils::prune_empty_subdirs_under(root);
    removed
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
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let root = media_root.join(LocalTier::Ephemeral.subdir());
    Ok(evict_orphan_files_under_root_to_fit(&root, &keep_paths, max_bytes).await)
}

/// Remove ephemeral-tier files under `{media}/cache/` not listed in `keep_paths`.
#[tauri::command]
#[specta::specta]
pub async fn prune_orphan_ephemeral_cache_files(
    keep_paths: Vec<String>,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let root = media_root.join(LocalTier::Ephemeral.subdir());
    Ok(prune_orphan_files_under_root(&root, &keep_paths).await)
}

/// Batch existence probe for reconcile (index rows without on-disk bytes).
#[tauri::command]
#[specta::specta]
pub fn probe_media_files(local_paths: Vec<String>) -> Vec<bool> {
    local_paths
        .iter()
        .map(|p| std::path::Path::new(p).is_file())
        .collect()
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
#[specta::specta]
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
#[specta::specta]
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

fn prune_parents_after_media_file_delete(
    file_path: &Path,
    media_dir: Option<&str>,
    app: &AppHandle,
) {
    let Some(parent) = file_path.parent() else {
        return;
    };
    if let Some(boundary) = super::fs_utils::local_tier_boundary_from_path(file_path) {
        super::fs_utils::prune_empty_dirs_up_to(parent, &boundary);
        return;
    }
    if let Ok(media_root) = resolve_media_dir(media_dir, app) {
        for tier in [LocalTier::Ephemeral, LocalTier::Library, LocalTier::Favorites] {
            let boundary = media_root.join(tier.subdir());
            super::fs_utils::prune_empty_dirs_up_to(parent, &boundary);
        }
    }
}

/// Deletes one media file and prunes empty parents up to the tier root.
#[tauri::command]
#[specta::specta]
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
    prune_parents_after_media_file_delete(&file_path, media_dir.as_deref(), &app);
    Ok(())
}

/// Removes empty directories under `{media}/{cache|library}/` (post-eviction sweep).
#[tauri::command]
#[specta::specta]
pub async fn prune_empty_media_tier_dirs(
    tier: String,
    media_dir: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let local_tier =
        LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;
    let root = resolve_media_tier_root(local_tier, media_dir.as_deref(), &app)?;
    super::fs_utils::prune_empty_subdirs_under(&root);
    Ok(())
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

    ensure_track_path_within_tier(&media_root, LocalTier::Ephemeral, &file_path)
        .map_err(|e| e.to_string())?;

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

    let _track_guard = acquire_per_track_download_lock(&per_track_download_lock_key(
        LocalTier::Ephemeral,
        &server_index_key,
        &track_id,
    ))
    .await;

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

    let part_path = unique_part_path(&file_path, &suffix, &track_id);

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

fn default_legacy_offline_root(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("psysonic-offline"))
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

fn scan_flat_offline_root(root: &std::path::Path) -> Vec<LegacyOfflineDiskEntry> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    let Ok(server_dirs) = std::fs::read_dir(root) else {
        return out;
    };
    for server_entry in server_dirs.flatten() {
        let server_path = server_entry.path();
        if !server_path.is_dir() {
            continue;
        }
        let server_segment = server_entry.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(&server_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let path = file_entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some((track_id, suffix)) = name.rsplit_once('.') else {
                continue;
            };
            if track_id.is_empty() || suffix.is_empty() {
                continue;
            }
            let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            out.push(LegacyOfflineDiskEntry {
                server_segment: server_segment.clone(),
                track_id: track_id.to_string(),
                path: path.to_string_lossy().to_string(),
                suffix: suffix.to_string(),
                size_bytes,
            });
        }
    }
    out
}

fn legacy_offline_roots(
    app: &AppHandle,
    custom_offline_dir: Option<&str>,
) -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = default_legacy_offline_root(app) {
        roots.push(root);
    }
    if let Some(cd) = custom_offline_dir.filter(|s| !s.is_empty()) {
        let custom = std::path::PathBuf::from(cd);
        if roots.iter().all(|r| r != &custom) {
            roots.push(custom);
        }
    }
    roots
}

fn server_index_key_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed)
        .to_string()
}

fn base_url_for_server(runtime: &LibraryRuntime, server_id: &str) -> Option<String> {
    runtime
        .sync_sessions
        .lock()
        .ok()
        .and_then(|sessions| sessions.get(server_id).map(|s| s.base_url.clone()))
}

fn server_index_key_for_disk(
    runtime: &LibraryRuntime,
    server_id: &str,
    disk_segment: &str,
) -> String {
    if let Some(url) = base_url_for_server(runtime, server_id) {
        let key = server_index_key_from_url(&url);
        if !key.is_empty() {
            return key;
        }
    }
    disk_segment.to_string()
}

fn disk_segment_matches(disk_segment: &str, server_id: &str, index_key: &str) -> bool {
    if disk_segment == server_id || disk_segment == index_key {
        return true;
    }
    sanitize_path_segment(disk_segment) == sanitize_path_segment(index_key)
        || sanitize_path_segment(disk_segment) == sanitize_path_segment(server_id)
}

fn resolve_track_for_disk_file(
    repo: &TrackRepository,
    runtime: &LibraryRuntime,
    disk_segment: &str,
    track_id: &str,
) -> Result<Option<(TrackRow, String)>, String> {
    if let Some(row) = repo.find_one(disk_segment, track_id)? {
        let key = server_index_key_for_disk(runtime, &row.server_id, disk_segment);
        return Ok(Some((row, key)));
    }
    let candidates = repo.find_live_by_id(track_id)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    for row in &candidates {
        let key = server_index_key_for_disk(runtime, &row.server_id, disk_segment);
        if disk_segment_matches(disk_segment, &row.server_id, &key) {
            return Ok(Some((row.clone(), key)));
        }
    }
    if candidates.len() == 1 {
        let row = candidates[0].clone();
        let key = server_index_key_for_disk(runtime, &row.server_id, disk_segment);
        return Ok(Some((row, key)));
    }
    Ok(None)
}

fn passes_server_filter(
    filter: Option<&str>,
    disk_segment: &str,
    server_index_key: &str,
) -> bool {
    let Some(filter) = filter.filter(|s| !s.is_empty()) else {
        return true;
    };
    disk_segment == filter
        || server_index_key == filter
        || sanitize_path_segment(disk_segment) == sanitize_path_segment(filter)
}

/// Move `old_path` → `target_path` when needed (rename, or copy+delete on EXDEV).
async fn relocate_file_to_target(
    old_path: &std::path::Path,
    target_path: &std::path::Path,
) -> Result<bool, String> {
    if old_path == target_path {
        return Ok(false);
    }
    if target_path.is_file() {
        if old_path.is_file() && old_path != target_path {
            let _ = tokio::fs::remove_file(old_path).await;
        }
        return Ok(old_path != target_path);
    }
    if !old_path.is_file() {
        return Err("SOURCE_MISSING".to_string());
    }
    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    match tokio::fs::rename(old_path, target_path).await {
        Ok(()) => Ok(true),
        Err(e) if e.raw_os_error() == Some(18) => {
            tokio::fs::copy(old_path, target_path)
                .await
                .map_err(|e| e.to_string())?;
            tokio::fs::remove_file(old_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(true)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn prune_legacy_offline_parents(old_path: &std::path::Path, app: &AppHandle) {
    let Some(legacy_root) = default_legacy_offline_root(app) else {
        return;
    };
    let Some(parent) = old_path.parent() else {
        return;
    };
    if parent.starts_with(&legacy_root) {
        super::fs_utils::prune_empty_dirs_up_to(parent, &legacy_root);
    }
}

struct RelocateLegacyTrackFile<'a> {
    track_id: &'a str,
    server_index_key: &'a str,
    old_path: &'a Path,
    suffix: &'a str,
    row: &'a TrackRow,
    media_root: &'a Path,
    library_boundary: &'a Path,
    app: &'a AppHandle,
}

async fn relocate_legacy_track_file(
    args: RelocateLegacyTrackFile<'_>,
) -> LegacyOfflineMigrationResult {
    let path_input = track_row_to_path_input(args.row);
    let fingerprint = layout_fingerprint(&path_input);
    let target_path = absolute_track_path(
        args.media_root,
        LocalTier::Library,
        args.server_index_key,
        &path_input,
        args.suffix,
    );
    let target_str = target_path.to_string_lossy().to_string();
    let old_path_str = args.old_path.to_string_lossy().to_string();

    if args.old_path.is_file() && args.old_path == target_path {
        let size = tokio::fs::metadata(&target_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        return LegacyOfflineMigrationResult {
            track_id: args.track_id.to_string(),
            server_index_key: args.server_index_key.to_string(),
            path: target_str,
            size,
            layout_fingerprint: fingerprint,
            relocated: false,
            skipped_reason: None,
        };
    }

    if target_path.is_file() {
        if args.old_path.is_file() && args.old_path != target_path {
            let _ = tokio::fs::remove_file(args.old_path).await;
            prune_legacy_offline_parents(args.old_path, args.app);
        }
        let size = tokio::fs::metadata(&target_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        return LegacyOfflineMigrationResult {
            track_id: args.track_id.to_string(),
            server_index_key: args.server_index_key.to_string(),
            path: target_str,
            size,
            layout_fingerprint: fingerprint,
            relocated: args.old_path.is_file(),
            skipped_reason: None,
        };
    }

    match relocate_file_to_target(args.old_path, &target_path).await {
        Ok(relocated) => {
            if relocated {
                prune_legacy_offline_parents(args.old_path, args.app);
                if let Some(parent) = target_path.parent() {
                    super::fs_utils::prune_empty_dirs_up_to(parent, args.library_boundary);
                }
            }
            let size = if target_path.is_file() {
                tokio::fs::metadata(&target_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0)
            } else {
                0
            };
            LegacyOfflineMigrationResult {
                track_id: args.track_id.to_string(),
                server_index_key: args.server_index_key.to_string(),
                path: target_str,
                size,
                layout_fingerprint: fingerprint,
                relocated,
                skipped_reason: if target_path.is_file() {
                    None
                } else {
                    Some("source_missing".to_string())
                },
            }
        }
        Err(reason) => LegacyOfflineMigrationResult {
            track_id: args.track_id.to_string(),
            server_index_key: args.server_index_key.to_string(),
            path: old_path_str,
            size: 0,
            layout_fingerprint: fingerprint,
            relocated: false,
            skipped_reason: Some(reason),
        },
    }
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
    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    let library_boundary = media_root.join(LocalTier::Library.subdir());
    let repo = TrackRepository::new(&runtime.store);
    let filter = server_index_key_filter.as_deref();

    let mut disk_files = Vec::new();
    for root in legacy_offline_roots(&app, custom_offline_dir.as_deref()) {
        disk_files.extend(scan_flat_offline_root(&root));
    }

    let mut out = Vec::with_capacity(disk_files.len());
    for file in disk_files {
        let suffix = file.suffix.trim().trim_start_matches('.');
        let suffix = if suffix.is_empty() { "mp3" } else { suffix };
        let old_path = std::path::PathBuf::from(&file.path);

        let Some((row, server_index_key)) =
            resolve_track_for_disk_file(&repo, &runtime, &file.server_segment, &file.track_id)?
        else {
            out.push(LegacyOfflineMigrationResult {
                track_id: file.track_id,
                server_index_key: file.server_segment.clone(),
                path: file.path,
                size: file.size_bytes,
                layout_fingerprint: String::new(),
                relocated: false,
                skipped_reason: Some("library_track_not_found".to_string()),
            });
            continue;
        };

        if !passes_server_filter(filter, &file.server_segment, &server_index_key) {
            continue;
        }

        out.push(
            relocate_legacy_track_file(RelocateLegacyTrackFile {
                track_id: &file.track_id,
                server_index_key: &server_index_key,
                old_path: &old_path,
                suffix,
                row: &row,
                media_root: &media_root,
                library_boundary: &library_boundary,
                app: &app,
            })
            .await,
        );
    }

    Ok(out)
}

#[cfg(test)]
mod migrate_tests {
    use super::*;

    #[test]
    fn scan_flat_offline_root_lists_track_files() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-scan-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let track = base.join("my.server").join("abc123.flac");
        std::fs::create_dir_all(track.parent().unwrap()).unwrap();
        std::fs::write(&track, b"x").unwrap();
        let found = scan_flat_offline_root(&base);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].track_id, "abc123");
        assert_eq!(found[0].suffix, "flac");
        assert_eq!(found[0].server_segment, "my.server");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn evict_ephemeral_cache_orphans_to_fit_removes_oldest_first_when_over_budget() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-ephemeral-evict-age-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let keep = cache.join("srv").join("keep.flac");
        let old_orphan = cache.join("srv").join("old.flac");
        let new_orphan = cache.join("srv").join("new.flac");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&old_orphan, b"oldorphan!").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&new_orphan, b"new!!").unwrap();

        let removed =
            evict_orphan_files_under_root_to_fit(&cache, &[keep.to_string_lossy().to_string()], 10)
                .await;

        assert_eq!(removed.len(), 1);
        assert!(removed[0].contains("old.flac"));
        assert!(keep.is_file());
        assert!(!old_orphan.exists());
        assert!(new_orphan.is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn evict_ephemeral_cache_orphans_to_fit_noop_when_under_budget() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-ephemeral-evict-noop-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let cache = base.join("cache");
        let keep = cache.join("srv").join("keep.flac");
        let orphan = cache.join("srv").join("extra.flac");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep").unwrap();
        std::fs::write(&orphan, b"x").unwrap();

        let removed =
            evict_orphan_files_under_root_to_fit(&cache, &[keep.to_string_lossy().to_string()], 100)
                .await;

        assert!(removed.is_empty());
        assert!(orphan.is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn prune_orphan_ephemeral_cache_removes_untracked_files_and_empty_dirs() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-ephemeral-prune-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let keep = base
            .join("cache")
            .join("srv")
            .join("Artist")
            .join("Album")
            .join("01 - Keep.flac");
        let orphan = base
            .join("cache")
            .join("srv")
            .join("Artist")
            .join("Album")
            .join("02 - Drop.flac");
        let orphan_part = base
            .join("cache")
            .join("srv")
            .join("Other")
            .join("stale.flac.part");
        std::fs::create_dir_all(keep.parent().unwrap()).unwrap();
        std::fs::create_dir_all(orphan_part.parent().unwrap()).unwrap();
        std::fs::write(&keep, b"keep").unwrap();
        std::fs::write(&orphan, b"drop").unwrap();
        std::fs::write(&orphan_part, b"part").unwrap();

        let removed = prune_orphan_files_under_root(
            &base.join("cache"),
            &[keep.to_string_lossy().to_string()],
        )
        .await;

        assert_eq!(removed.len(), 2);
        assert!(keep.is_file());
        assert!(!orphan.exists());
        assert!(!orphan_part.exists());
        assert!(!base.join("cache/srv/Other").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn relocate_moves_file_to_nested_target() {
        let base = std::env::temp_dir().join(format!(
            "psysonic-migrate-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let old = base.join("psysonic-offline").join("srv").join("t1.mp3");
        let target = base
            .join("media")
            .join("library")
            .join("Artist")
            .join("Album")
            .join("01 - Song.mp3");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, b"abc").unwrap();
        let relocated = relocate_file_to_target(&old, &target).await.unwrap();
        assert!(relocated);
        assert!(target.is_file());
        assert!(!old.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}


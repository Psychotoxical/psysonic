use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use psysonic_core::cover_cache_layout::sanitize_path_segment;
use psysonic_core::media_layout::{
    absolute_track_path, layout_fingerprint, LocalTier, TrackPathInput,
};
use psysonic_library::repos::{TrackRepository, TrackRow};
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, Manager};

pub(super) fn resolve_media_dir(
    custom_media_dir: Option<&str>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    if let Some(cd) = custom_media_dir.filter(|s| !s.is_empty()) {
        let base = PathBuf::from(cd);
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

pub(super) struct ResolvedLibraryTrackPath {
    pub(super) file_path: PathBuf,
    pub(super) path_str: String,
    pub(super) layout_fingerprint: String,
}

pub(super) fn resolve_library_track_path(
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

pub(super) struct ResolveTrackPathForTier<'a> {
    pub(super) tier: LocalTier,
    pub(super) track_id: &'a str,
    pub(super) server_index_key: &'a str,
    pub(super) library_server_id: &'a str,
    pub(super) suffix: &'a str,
    pub(super) media_dir: Option<&'a str>,
    pub(super) app: &'a AppHandle,
    pub(super) runtime: &'a LibraryRuntime,
}

pub(super) fn resolve_track_path_for_tier(
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

pub(super) fn normalize_path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

/// Per-track download mutex for the same `(tier, server, track)`.
fn track_download_locks(
) -> &'static tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

pub(super) async fn acquire_per_track_download_lock(key: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let lock_arc = {
        let mut map = track_download_locks().lock().await;
        map.entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    lock_arc.lock_owned().await
}

pub(super) fn per_track_download_lock_key(
    tier: LocalTier,
    server_index_key: &str,
    track_id: &str,
) -> String {
    format!("{}:{}:{}", tier.subdir(), server_index_key, track_id)
}

/// Part file beside the final track, keyed by sanitized `track_id`.
pub(super) fn unique_part_path(file_path: &Path, suffix: &str, track_id: &str) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let safe_id = sanitize_path_segment(track_id);
    parent.join(format!("{safe_id}.{suffix}.part"))
}

pub(super) fn track_row_to_path_input(row: &TrackRow) -> TrackPathInput {
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

pub(super) fn resolve_media_tier_root(
    tier: LocalTier,
    media_dir: Option<&str>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    Ok(resolve_media_dir(media_dir, app)?.join(tier.subdir()))
}

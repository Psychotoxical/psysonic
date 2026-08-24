use std::path::{Path, PathBuf};

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
    pub(super) expected_size_bytes: Option<u64>,
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
        expected_size_bytes: row.size_bytes.and_then(|size| u64::try_from(size).ok()),
    })
}

pub(super) fn normalize_path_key(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

pub(super) fn unique_part_path(file_path: &Path, track_id: &str) -> PathBuf {
    crate::file_transfer::sibling_part_path(file_path, track_id)
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

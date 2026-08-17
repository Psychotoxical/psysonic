use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use psysonic_analysis::analysis_runtime::enqueue_offline_library_analysis_from_file;
use psysonic_core::media_layout::{
    absolute_track_path, ensure_track_path_within_tier, layout_fingerprint, LocalTier,
};
use psysonic_library::repos::TrackRepository;
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncReadExt;

use crate::file_transfer::{
    apply_server_http_get, finalize_streamed_download, subsonic_http_client,
};
use crate::{offline_cancel_flags, DownloadSemaphore};

use super::paths::{
    acquire_per_track_download_lock, per_track_download_lock_key, resolve_media_dir,
    resolve_track_path_for_tier, track_row_to_path_input, unique_part_path,
    ResolveTrackPathForTier, ResolvedLibraryTrackPath,
};
use super::LocalTrackDownloadResult;

struct LocalTrackHitArgs<'a> {
    file_path: &'a Path,
    path_str: &'a str,
    fingerprint: &'a str,
    app: &'a AppHandle,
    server_index_key: &'a str,
    library_server_id: &'a str,
    track_id: &'a str,
    url: &'a str,
    client: &'a reqwest::Client,
    registry: Option<&'a psysonic_core::server_http::ServerHttpRegistry>,
}

async fn local_track_hit_if_exists(
    args: &LocalTrackHitArgs<'_>,
    verified_raw_request: bool,
) -> Result<Option<LocalTrackDownloadResult>, String> {
    if !args.file_path.is_file() {
        return Ok(None);
    }
    if verified_raw_request {
        let trusted = psysonic_analysis::raw_probe::fetch_trusted_original_md5(
            args.client,
            args.registry,
            Some(args.server_index_key),
            args.url,
        )
        .await
        .ok_or_else(|| "raw original identity unavailable for existing local file".to_string())?;
        let prefix = read_raw_probe_prefix(args.file_path)
            .await
            .map_err(|e| e.to_string())?;
        if !psysonic_analysis::raw_probe::bytes_match_trusted(&prefix, &trusted) {
            tokio::fs::remove_file(args.file_path)
                .await
                .map_err(|e| format!("remove stale unverified local file: {e}"))?;
            return Ok(None);
        }
    }
    let size = tokio::fs::metadata(args.file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let app_seed = args.app.clone();
    let tid = args.track_id.to_string();
    let index_key = args.server_index_key.to_string();
    let library_id = args.library_server_id.to_string();
    let fp = args.file_path.to_path_buf();
    tokio::spawn(async move {
        let _ = enqueue_offline_library_analysis_from_file(
            &app_seed,
            &index_key,
            &library_id,
            &tid,
            &fp,
            None,
            verified_raw_request,
        )
        .await;
    });
    Ok(Some(LocalTrackDownloadResult {
        path: args.path_str.to_string(),
        size,
        layout_fingerprint: args.fingerprint.to_string(),
        original_bytes_verified: verified_raw_request,
    }))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn download_track_local(
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
    let local_tier =
        LocalTier::parse(&tier).ok_or_else(|| format!("unknown local tier: `{tier}`"))?;

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

    let client = subsonic_http_client(std::time::Duration::from_secs(120))?;
    let http_registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let verified_raw_request = psysonic_analysis::raw_probe::is_verified_raw_stream_request(
        http_registry.as_deref(),
        Some(&server_index_key),
        &url,
    );
    let local_track_hit_args = LocalTrackHitArgs {
        file_path: &file_path,
        path_str: &path_str,
        fingerprint: &fingerprint,
        app: &app,
        server_index_key: &server_index_key,
        library_server_id: &library_server_id,
        track_id: &track_id,
        url: &url,
        client: &client,
        registry: http_registry.as_deref(),
    };

    if !verified_raw_request {
        if let Some(hit) = local_track_hit_if_exists(&local_track_hit_args, false).await? {
            return Ok(hit);
        }
    }

    let _track_guard = acquire_per_track_download_lock(&per_track_download_lock_key(
        local_tier,
        &server_index_key,
        &track_id,
    ))
    .await;

    if let Some(hit) =
        local_track_hit_if_exists(&local_track_hit_args, verified_raw_request).await?
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

    if cancel_flag
        .as_ref()
        .is_some_and(|f| f.load(Ordering::Relaxed))
    {
        return Err("CANCELLED".to_string());
    }

    if !verified_raw_request {
        if let Some(hit) = local_track_hit_if_exists(&local_track_hit_args, false).await? {
            return Ok(hit);
        }
    }

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let trusted_raw_hash = if verified_raw_request {
        Some(
            psysonic_analysis::raw_probe::fetch_trusted_original_md5(
                &client,
                http_registry.as_deref(),
                Some(&server_index_key),
                &url,
            )
            .await
            .ok_or_else(|| "raw original identity unavailable for local download".to_string())?,
        )
    } else {
        None
    };

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
    if verified_raw_request && response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "raw original download returned HTTP {}",
            response.status().as_u16()
        ));
    }

    let part_path = unique_part_path(&file_path, &suffix, &track_id);
    finalize_streamed_download(response, &file_path, &part_path, cancel_flag.as_deref()).await?;

    if let Some(trusted) = trusted_raw_hash.as_deref() {
        let prefix = read_raw_probe_prefix(&file_path)
            .await
            .map_err(|e| e.to_string())?;
        if !psysonic_analysis::raw_probe::bytes_match_trusted(&prefix, trusted) {
            let _ = tokio::fs::remove_file(&file_path).await;
            return Err("raw original changed or did not match the downloaded bytes".to_string());
        }
    }

    enqueue_offline_library_analysis_from_file(
        &app,
        &server_index_key,
        &library_server_id,
        &track_id,
        &file_path,
        None,
        verified_raw_request,
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
        original_bytes_verified: verified_raw_request,
    })
}

pub(super) async fn read_raw_probe_prefix(path: &Path) -> std::io::Result<Vec<u8>> {
    let limit = psysonic_analysis::raw_probe::RAW_PROBE_RANGE_END + 1;
    let file = tokio::fs::File::open(path).await?;
    let mut prefix = Vec::with_capacity(limit as usize);
    file.take(limit).read_to_end(&mut prefix).await?;
    Ok(prefix)
}

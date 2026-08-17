use std::path::Path;
use std::sync::Arc;

use psysonic_analysis::analysis_runtime::enqueue_offline_library_analysis_from_file;
use psysonic_audio as audio;
use psysonic_core::media_layout::{
    absolute_track_path, ensure_track_path_within_tier, layout_fingerprint, LocalTier,
};
use psysonic_library::repos::TrackRepository;
use psysonic_library::LibraryRuntime;
use tauri::{AppHandle, Manager, State};

use super::download::read_raw_probe_prefix;
use super::paths::{
    acquire_per_track_download_lock, per_track_download_lock_key, resolve_media_dir,
    track_row_to_path_input, unique_part_path,
};
use super::LocalTrackDownloadResult;

async fn retain_consumed_spill_if_trusted(
    spill_path: &Path,
    prefix_result: std::io::Result<Vec<u8>>,
    trusted: &str,
) -> Result<bool, String> {
    if prefix_result
        .as_ref()
        .is_ok_and(|prefix| psysonic_analysis::raw_probe::bytes_match_trusted(prefix, trusted))
    {
        return Ok(true);
    }

    match tokio::fs::remove_file(spill_path).await {
        Ok(()) => Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!(
            "remove rejected stream spill {}: {e}",
            spill_path.display()
        )),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn promote_stream_cache_to_local(
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
            original_bytes_verified: false,
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
            original_bytes_verified: false,
        }));
    }

    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }

    let part_path = unique_part_path(&file_path, &suffix, &track_id);

    // Provenance gate: only promote bytes that match the verified original.
    let registry = app
        .try_state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
        .map(|s| Arc::clone(&*s));
    let trusted = match psysonic_analysis::raw_probe::resolve_trusted_identity(
        &reqwest::Client::new(),
        registry.as_deref(),
        Some(library_server_id.as_str()),
        &url,
    )
    .await
    {
        psysonic_analysis::raw_probe::TrustedProbeVerdict::Trusted(h) => h,
        psysonic_analysis::raw_probe::TrustedProbeVerdict::SkipCanonicalWrites => {
            return Ok(None);
        }
    };

    if let Some(bytes) = audio::take_stream_completed_for_url(&state, &url) {
        if !psysonic_analysis::raw_probe::bytes_match_trusted(&bytes, &trusted) {
            return Ok(None);
        }
        if let Err(e) = tokio::fs::write(&part_path, &bytes).await {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e.to_string());
        }
        tokio::fs::rename(&part_path, &file_path)
            .await
            .map_err(|e| e.to_string())?;
    } else if let Some(spill_path) = audio::take_stream_completed_spill_for_url(&state, &url) {
        let prefix = read_raw_probe_prefix(&spill_path).await;
        if !retain_consumed_spill_if_trusted(&spill_path, prefix, &trusted).await? {
            return Ok(None);
        }
        if let Err(e) = tokio::fs::rename(&spill_path, &file_path).await {
            if let Err(copy_err) = tokio::fs::copy(&spill_path, &file_path).await {
                let _ = tokio::fs::remove_file(&spill_path).await;
                return Err(format!("promote spill rename: {e}; copy: {copy_err}"));
            }
            let _ = tokio::fs::remove_file(&spill_path).await;
        }
    } else {
        return Ok(None);
    }

    let priority = psysonic_analysis::analysis_runtime::analysis_backfill_resolve_priority(
        &app,
        &server_index_key,
        &track_id,
        None,
    );
    let _ = enqueue_offline_library_analysis_from_file(
        &app,
        &server_index_key,
        &library_server_id,
        &track_id,
        &file_path,
        Some(priority),
        true,
    )
    .await;

    let size = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(Some(LocalTrackDownloadResult {
        path: path_str,
        size,
        layout_fingerprint: fingerprint,
        original_bytes_verified: true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stream_spill_probe_read_is_bounded_to_raw_window() {
        let dir = tempfile::tempdir().unwrap();
        let spill = dir.path().join("large.complete");
        let limit = (psysonic_analysis::raw_probe::RAW_PROBE_RANGE_END + 1) as usize;
        let mut bytes = vec![0x11; limit];
        bytes.extend(std::iter::repeat_n(0x22, 4096));
        tokio::fs::write(&spill, bytes).await.unwrap();

        let prefix = read_raw_probe_prefix(&spill).await.unwrap();

        assert_eq!(prefix.len(), limit);
        assert!(prefix.iter().all(|byte| *byte == 0x11));
    }

    #[tokio::test]
    async fn stream_spill_fingerprint_mismatch_removes_consumed_file() {
        let dir = tempfile::tempdir().unwrap();
        let spill = dir.path().join("mismatch.complete");
        tokio::fs::write(&spill, vec![0x33; 1024]).await.unwrap();
        let prefix = read_raw_probe_prefix(&spill).await;
        let trusted = psysonic_analysis::analysis_cache::md5_first_16kb(&vec![0x44; 1024]);

        let retained = retain_consumed_spill_if_trusted(&spill, prefix, &trusted)
            .await
            .unwrap();

        assert!(!retained);
        assert!(!spill.exists());
    }

    #[tokio::test]
    async fn stream_spill_read_error_removes_consumed_file() {
        let dir = tempfile::tempdir().unwrap();
        let spill = dir.path().join("read-error.complete");
        tokio::fs::write(&spill, vec![0x55; 1024]).await.unwrap();
        let read_error = std::io::Result::<Vec<u8>>::Err(std::io::Error::other("read failed"));

        let retained = retain_consumed_spill_if_trusted(&spill, read_error, "unused")
            .await
            .unwrap();

        assert!(!retained);
        assert!(!spill.exists());
    }

    #[tokio::test]
    async fn trusted_stream_spill_is_retained_for_atomic_promotion() {
        let dir = tempfile::tempdir().unwrap();
        let spill = dir.path().join("trusted.complete");
        let bytes = vec![0x66; 1024];
        tokio::fs::write(&spill, &bytes).await.unwrap();
        let prefix = read_raw_probe_prefix(&spill).await;
        let trusted = psysonic_analysis::analysis_cache::md5_first_16kb(&bytes);

        let retained = retain_consumed_spill_if_trusted(&spill, prefix, &trusted)
            .await
            .unwrap();

        assert!(retained);
        assert!(spill.is_file());
    }
}

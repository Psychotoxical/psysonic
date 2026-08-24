use std::path::Path;
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
    acquire_download_destination_lock, acquire_download_permit,
    finalize_resumable_download_cancellable, max_download_bytes,
    prepare_resumable_download_cancellable, promote_completed_partial,
    subsonic_download_http_client, subsonic_http_client,
};
use crate::{offline_download_cancellation, DownloadSemaphore};

use super::paths::{
    resolve_media_dir, resolve_track_path_for_tier, track_row_to_path_input, unique_part_path,
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
    mut cancellation: Option<&mut crate::file_transfer::DownloadCancellation>,
) -> Result<Option<LocalTrackDownloadResult>, String> {
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        return Err("CANCELLED".to_string());
    }
    if !args.file_path.is_file() {
        return Ok(None);
    }
    if verified_raw_request
        && !existing_raw_file_matches_trusted(
            args.file_path,
            args.client,
            args.registry,
            args.server_index_key,
            args.url,
            cancellation.as_deref_mut(),
        )
        .await?
    {
        tokio::fs::remove_file(args.file_path)
            .await
            .map_err(|e| format!("remove stale unverified local file: {e}"))?;
        return Ok(None);
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
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        return Err("CANCELLED".to_string());
    }
    Ok(Some(LocalTrackDownloadResult {
        path: args.path_str.to_string(),
        size,
        layout_fingerprint: args.fingerprint.to_string(),
        original_bytes_verified: verified_raw_request,
    }))
}

async fn existing_raw_file_matches_trusted(
    file_path: &Path,
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_index_key: &str,
    url: &str,
    mut cancellation: Option<&mut crate::file_transfer::DownloadCancellation>,
) -> Result<bool, String> {
    let trusted = fetch_trusted_original_md5_cancellable(
        client,
        registry,
        server_index_key,
        url,
        cancellation.as_deref_mut(),
    )
    .await?
    .ok_or_else(|| "raw original identity unavailable for existing local file".to_string())?;

    let read = read_raw_probe_prefix(file_path);
    tokio::pin!(read);
    let prefix = if let Some(cancel) = cancellation.as_deref_mut() {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            prefix = &mut read => prefix,
        }
    } else {
        read.await
    };
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        return Err("CANCELLED".to_string());
    }
    let prefix = prefix.map_err(|error| error.to_string())?;
    Ok(psysonic_analysis::raw_probe::bytes_match_trusted(
        &prefix, &trusted,
    ))
}

async fn fetch_trusted_original_md5_cancellable(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_index_key: &str,
    url: &str,
    mut cancellation: Option<&mut crate::file_transfer::DownloadCancellation>,
) -> Result<Option<String>, String> {
    let fetch = psysonic_analysis::raw_probe::fetch_trusted_original_md5(
        client,
        registry,
        Some(server_index_key),
        url,
    );
    tokio::pin!(fetch);
    let trusted = if let Some(cancel) = cancellation.as_deref_mut() {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            trusted = &mut fetch => trusted,
        }
    } else {
        fetch.await
    };
    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        return Err("CANCELLED".to_string());
    }
    Ok(trusted)
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
            expected_size_bytes: row.size_bytes.and_then(|size| u64::try_from(size).ok()),
        }
    };
    let ResolvedLibraryTrackPath {
        file_path,
        path_str,
        layout_fingerprint: fingerprint,
        expected_size_bytes,
    } = resolved;

    let media_root = resolve_media_dir(media_dir.as_deref(), &app)?;
    ensure_track_path_within_tier(&media_root, local_tier, &file_path)
        .map_err(|e| e.to_string())?;
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }

    let client = if local_tier == LocalTier::Ephemeral {
        subsonic_http_client(std::time::Duration::from_secs(120))?
    } else {
        subsonic_download_http_client()?
    };
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

    let mut cancellation = download_id.as_deref().map(offline_download_cancellation);
    let _destination_guard =
        acquire_download_destination_lock(&file_path, cancellation.as_mut()).await?;

    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        return Err("CANCELLED".to_string());
    }

    if let Some(hit) = local_track_hit_if_exists(
        &local_track_hit_args,
        verified_raw_request,
        cancellation.as_mut(),
    )
    .await?
    {
        return Ok(hit);
    }

    let _permit = acquire_download_permit(&dl_sem, cancellation.as_mut()).await?;

    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        return Err("CANCELLED".to_string());
    }

    if !verified_raw_request {
        if let Some(hit) =
            local_track_hit_if_exists(&local_track_hit_args, false, cancellation.as_mut()).await?
        {
            return Ok(hit);
        }
    }

    let trusted_raw_hash = if verified_raw_request {
        let trusted = fetch_trusted_original_md5_cancellable(
            &client,
            http_registry.as_deref(),
            &server_index_key,
            &url,
            cancellation.as_mut(),
        )
        .await?;
        Some(trusted.ok_or_else(|| {
            crate::app_eprintln!(
                "[offline] raw probe failed server={} track={}",
                server_index_key,
                track_id,
            );
            "raw original identity unavailable for local download".to_string()
        })?)
    } else {
        None
    };

    let part_path = unique_part_path(&file_path, &track_id);
    let max_bytes = max_download_bytes(expected_size_bytes);
    if !promote_completed_partial(&part_path, &file_path, &url, max_bytes).await? {
        let prepared = prepare_resumable_download_cancellable(
            &client,
            http_registry.as_deref(),
            Some(&server_index_key),
            &url,
            &part_path,
            max_bytes,
            cancellation.as_mut(),
        )
        .await
        .map_err(|error| {
            crate::app_eprintln!(
                "[offline] request failed server={} track={}: {}",
                server_index_key,
                track_id,
                error,
            );
            error
        })?;
        if let Err(error) = prepared.validate_status() {
            crate::app_eprintln!(
                "[offline] HTTP failure server={} track={} status={}",
                server_index_key,
                track_id,
                prepared.response.status().as_u16(),
            );
            return Err(error);
        }
        if let Err(error) = finalize_resumable_download_cancellable(
            prepared,
            &file_path,
            &part_path,
            max_bytes,
            cancellation.as_mut(),
        )
        .await
        {
            if error != "CANCELLED" {
                crate::app_eprintln!(
                    "[offline] transfer failed server={} track={}: {}",
                    server_index_key,
                    track_id,
                    error,
                );
            }
            return Err(error);
        }
    }

    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        let _ = tokio::fs::remove_file(&file_path).await;
        return Err("CANCELLED".to_string());
    }

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
    .await
    .map_err(|error| {
        crate::app_eprintln!(
            "[offline] post-download analysis enqueue failed server={} track={}: {}",
            server_index_key,
            track_id,
            error,
        );
        error
    })?;

    if cancellation
        .as_ref()
        .is_some_and(|cancel| cancel.is_cancelled())
    {
        let _ = tokio::fs::remove_file(&file_path).await;
        return Err("CANCELLED".to_string());
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use psysonic_core::server_http::{
        EndpointKind, ServerHttpContextSyncWire, ServerHttpEndpointWire, ServerHttpRegistry,
    };
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_interrupts_existing_file_identity_probe() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_started, mut request_started_rx) = tokio::sync::oneshot::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let _ = request_started.send(());
            thread::sleep(Duration::from_secs(2));
        });
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("track.flac");
        tokio::fs::write(&file, b"existing bytes").await.unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut cancellation = crate::file_transfer::DownloadCancellation::new(
            Arc::clone(&flag),
            receiver,
        );
        let client = reqwest::Client::new();
        let url = format!("http://{address}/rest/stream.view?id=track");
        let registry = ServerHttpRegistry::new();
        registry.sync(ServerHttpContextSyncWire {
            server_id: "server.test".to_string(),
            app_server_id: "server.test".to_string(),
            endpoints: vec![ServerHttpEndpointWire {
                url: format!("http://{address}"),
                kind: EndpointKind::Local,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream: true,
        });
        let probe = existing_raw_file_matches_trusted(
            &file,
            &client,
            Some(&registry),
            "server.test",
            &url,
            Some(&mut cancellation),
        );
        tokio::pin!(probe);

        tokio::select! {
            _ = &mut probe => panic!("probe completed before issuing its HTTP request"),
            started = &mut request_started_rx => started.unwrap(),
        }
        flag.store(true, Ordering::Relaxed);
        sender.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(1), probe)
            .await
            .unwrap();

        assert!(matches!(result, Err(ref error) if error == "CANCELLED"));
        drop(server);
    }
}

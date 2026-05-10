use tauri::Manager;

use psysonic_analysis::analysis_cache;
use psysonic_analysis::analysis_runtime::enqueue_analysis_seed;
use crate::DownloadSemaphore;

use crate::file_transfer::{finalize_streamed_download, subsonic_http_client};

// ─── Offline Track Cache ──────────────────────────────────────────────────────

pub async fn enqueue_analysis_seed_from_file(
    app: &tauri::AppHandle,
    track_id: &str,
    file_path: &std::path::Path,
) {
    if let Some(cache) = app.try_state::<analysis_cache::AnalysisCache>() {
        if cache.cpu_seed_redundant_for_track(track_id).unwrap_or(false) {
            return;
        }
    }
    let bytes = match tokio::fs::read(file_path).await {
        Ok(v) => v,
        Err(_) => return,
    };
    if bytes.is_empty() {
        return;
    }
    let _ = enqueue_analysis_seed(app, track_id, &bytes).await;
}

/// AppHandle-free download primitive: ensures `cache_dir` exists, returns
/// the cached path on hit, otherwise issues a GET via `client`, streams to
/// `<cache_dir>/<track_id>.<suffix>` via a `.part` file, and returns the
/// final path. Caller is responsible for the semaphore + analysis seeding.
pub(crate) async fn download_track_to_cache_dir(
    cache_dir: &std::path::Path,
    track_id: &str,
    suffix: &str,
    url: &str,
    client: &reqwest::Client,
) -> Result<std::path::PathBuf, String> {
    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = cache_dir.join(format!("{track_id}.{suffix}"));
    if file_path.exists() {
        return Ok(file_path);
    }

    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let part_path = file_path.with_extension(format!("{suffix}.part"));
    finalize_streamed_download(response, &file_path, &part_path).await?;
    Ok(file_path)
}

/// Downloads a single track to the app's offline cache directory.
/// Returns the absolute file path so TypeScript can store it and later
/// construct a `psysonic-local://<path>` URL for the audio engine.
#[tauri::command]
pub async fn download_track_offline(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    dl_sem: tauri::State<'_, DownloadSemaphore>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Determine base cache directory.
    let cache_dir = if let Some(ref cd) = custom_dir {
        let base = std::path::PathBuf::from(cd);
        // Check that the volume/directory is still accessible.
        if !base.exists() {
            return Err("VOLUME_NOT_FOUND".to_string());
        }
        base.join(&server_id)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-offline")
            .join(&server_id)
    };

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    // Already cached — skip re-download (no semaphore needed).
    if file_path.exists() {
        return Ok(path_str);
    }

    // Acquire a download slot. The permit is held for the duration of the HTTP transfer
    // and released automatically when this function returns (success or error).
    let _permit = dl_sem.acquire().await.map_err(|e| e.to_string())?;

    let client = subsonic_http_client(std::time::Duration::from_secs(120))?;
    let final_path =
        download_track_to_cache_dir(&cache_dir, &track_id, &suffix, &url, &client).await?;

    enqueue_analysis_seed_from_file(&app, &track_id, &final_path).await;

    Ok(path_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn download_to_cache_dir_writes_track_for_200_response() {
        let server = MockServer::start().await;
        let body = b"flac body bytes".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/stream/track-1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().join("psysonic-offline").join("server-A");
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/stream/track-1", server.uri());

        let path = download_track_to_cache_dir(&cache_dir, "track-1", "flac", &url, &client)
            .await
            .unwrap();
        assert!(path.exists());
        assert_eq!(path.file_name().unwrap(), "track-1.flac");
        assert_eq!(std::fs::read(&path).unwrap(), body);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn download_to_cache_dir_returns_existing_path_without_hitting_network() {
        // No mock — if the function tries to hit the network the test fails on its own.
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_path_buf();
        let pre_existing = cache_dir.join("track-1.flac");
        std::fs::write(&pre_existing, b"already here").unwrap();

        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/should-not-be-hit", server.uri());

        let path = download_track_to_cache_dir(&cache_dir, "track-1", "flac", &url, &client)
            .await
            .unwrap();
        assert_eq!(path, pre_existing);
        assert_eq!(std::fs::read(&path).unwrap(), b"already here");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn download_to_cache_dir_returns_err_for_non_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/stream/missing"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().to_path_buf();
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/stream/missing", server.uri());

        let err = download_track_to_cache_dir(&cache_dir, "missing", "flac", &url, &client)
            .await
            .unwrap_err();
        assert!(err.contains("HTTP 404"), "got {err}");
        assert!(!cache_dir.join("missing.flac").exists(), "no track file created on error");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn download_to_cache_dir_creates_missing_intermediate_directories() {
        let server = MockServer::start().await;
        let body = b"x".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        // Three levels of nesting that don't exist yet.
        let cache_dir = dir.path().join("a").join("b").join("c");
        assert!(!cache_dir.exists());
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/track", server.uri());

        download_track_to_cache_dir(&cache_dir, "t", "mp3", &url, &client)
            .await
            .unwrap();
        assert!(cache_dir.join("t.mp3").exists());
    }

    // ── delete_offline_track_with_boundary (AppHandle-free) ─────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_with_boundary_removes_file_and_prunes_to_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let server_dir = dir.path().join("server-A");
        let nested = server_dir.join("AlbumArtist").join("Album");
        std::fs::create_dir_all(&nested).unwrap();
        let track = nested.join("01 - Track.flac");
        std::fs::write(&track, b"x").unwrap();

        delete_offline_track_with_boundary(&track.to_string_lossy(), &server_dir)
            .await
            .unwrap();

        assert!(!track.exists(), "file removed");
        assert!(!nested.exists(), "empty Album dir pruned");
        assert!(
            !server_dir.join("AlbumArtist").exists(),
            "empty AlbumArtist dir pruned"
        );
        assert!(server_dir.exists(), "boundary preserved");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_with_boundary_is_noop_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let boundary = dir.path().to_path_buf();
        let phantom = boundary.join("never-existed.flac");
        let result = delete_offline_track_with_boundary(&phantom.to_string_lossy(), &boundary)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_with_boundary_does_not_remove_boundary_itself() {
        let dir = tempfile::tempdir().unwrap();
        let track = dir.path().join("only-track.mp3");
        std::fs::write(&track, b"x").unwrap();
        delete_offline_track_with_boundary(&track.to_string_lossy(), dir.path())
            .await
            .unwrap();
        assert!(!track.exists());
        assert!(dir.path().exists(), "boundary itself must remain");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn delete_with_boundary_stops_pruning_at_non_empty_parent() {
        let dir = tempfile::tempdir().unwrap();
        let server_dir = dir.path().join("server");
        let album = server_dir.join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let track = album.join("track.mp3");
        let sibling = server_dir.join("notes.txt");
        std::fs::write(&track, b"x").unwrap();
        std::fs::write(&sibling, b"y").unwrap();

        delete_offline_track_with_boundary(&track.to_string_lossy(), dir.path())
            .await
            .unwrap();
        assert!(!album.exists(), "empty leaf pruned");
        assert!(server_dir.exists(), "non-empty parent preserved");
        assert!(sibling.exists());
    }
}

/// Returns the total size in bytes of all files in the offline cache directory (and optional custom dir).
#[tauri::command]
pub async fn get_offline_cache_size(custom_dir: Option<String>, app: tauri::AppHandle) -> u64 {
    let default_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("psysonic-offline"),
        Err(_) => return 0,
    };
    let mut total = super::fs_utils::dir_size_recursive(&default_dir);

    if let Some(cd) = custom_dir {
        let custom = std::path::PathBuf::from(cd);
        if custom != std::path::Path::new("") {
            total += super::fs_utils::dir_size_recursive(&custom);
        }
    }
    total
}

/// AppHandle-free deletion primitive: removes the file at `local_path` (no-op
/// if missing), then prunes empty parents upward, never crossing `boundary`.
pub(crate) async fn delete_offline_track_with_boundary(
    local_path: &str,
    boundary: &std::path::Path,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(local_path);
    if file_path.exists() {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(parent) = file_path.parent() {
        super::fs_utils::prune_empty_dirs_up_to(parent, boundary);
    }
    Ok(())
}

/// Removes a cached track from the offline cache. Accepts the full local path
/// (stored in OfflineTrackMeta) so it works regardless of which directory was used.
/// After deleting the file, empty parent directories up to (but not including)
/// `base_dir` are pruned using `remove_dir` (never `remove_dir_all`).
#[tauri::command]
pub async fn delete_offline_track(
    local_path: String,
    base_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Determine the safe boundary — never delete at or above this directory.
    let boundary = if let Some(bd) = base_dir.filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(bd)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-offline")
    };
    delete_offline_track_with_boundary(&local_path, &boundary).await
}


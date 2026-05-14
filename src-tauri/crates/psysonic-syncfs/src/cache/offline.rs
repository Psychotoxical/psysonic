use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::Manager;

use psysonic_analysis::analysis_cache;
use psysonic_analysis::analysis_runtime::enqueue_analysis_seed;
use crate::{offline_cancel_flags, DownloadSemaphore};

use crate::file_transfer::{finalize_streamed_download, subsonic_http_client};

// ─── Offline Track Cache ──────────────────────────────────────────────────────

pub async fn enqueue_analysis_seed_from_file(
    app: &tauri::AppHandle,
    track_id: &str,
    file_path: &std::path::Path,
) {
    let cache = app.try_state::<analysis_cache::AnalysisCache>();
    let cache_ref: Option<&analysis_cache::AnalysisCache> = cache.as_ref().map(|s| s.inner());
    let Some(bytes) = read_seed_bytes_if_needed(cache_ref, track_id, file_path).await else {
        return;
    };
    let _ = enqueue_analysis_seed(app, track_id, &bytes).await;
}

/// AppHandle-free decision: returns the file bytes when seeding is required
/// (cache miss or no cache attached), or `None` when the cache says seeding is
/// redundant, the file can't be read, or the file is empty.
///
/// Pulled out of [`enqueue_analysis_seed_from_file`] so tests can drive every
/// branch with `AnalysisCache::open_in_memory()` plus a `tempfile::TempDir`.
pub(crate) async fn read_seed_bytes_if_needed(
    cache: Option<&analysis_cache::AnalysisCache>,
    track_id: &str,
    file_path: &std::path::Path,
) -> Option<Vec<u8>> {
    if let Some(cache) = cache {
        if cache.cpu_seed_redundant_for_track(track_id).unwrap_or(false) {
            return None;
        }
    }
    let bytes = tokio::fs::read(file_path).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(bytes)
}

/// AppHandle-free download primitive: ensures `cache_dir` exists, returns
/// the cached path on hit, otherwise issues a GET via `client`, streams to
/// `<cache_dir>/<track_id>.<suffix>` via a `.part` file, and returns the
/// final path. Caller is responsible for the semaphore + analysis seeding.
///
/// `cancel`, when supplied, aborts the in-flight stream with `Err("CANCELLED")`
/// (the `.part` file is cleaned up); `None` means the download is not cancellable.
pub(crate) async fn download_track_to_cache_dir(
    cache_dir: &std::path::Path,
    track_id: &str,
    suffix: &str,
    url: &str,
    client: &reqwest::Client,
    cancel: Option<&AtomicBool>,
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
    finalize_streamed_download(response, &file_path, &part_path, cancel).await?;
    Ok(file_path)
}

/// AppHandle-free resolver for the offline-cache directory: checks the
/// optional user-supplied volume root for accessibility, otherwise falls
/// back to the app-data root supplied by the caller. Returns the
/// per-server subdirectory path, but does NOT create it.
pub(crate) fn resolve_offline_cache_dir(
    custom_dir: Option<&str>,
    server_id: &str,
    default_root: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    if let Some(cd) = custom_dir.filter(|s| !s.is_empty()) {
        let base = std::path::PathBuf::from(cd);
        if !base.exists() {
            return Err("VOLUME_NOT_FOUND".to_string());
        }
        Ok(base.join(server_id))
    } else {
        Ok(default_root.join(server_id))
    }
}

/// Downloads a single track to the app's offline cache directory.
/// Returns the absolute file path so TypeScript can store it and later
/// construct a `psysonic-local://<path>` URL for the audio engine.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command surface — args map 1:1 to the JS call.
pub async fn download_track_offline(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    download_id: Option<String>,
    dl_sem: tauri::State<'_, DownloadSemaphore>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let default_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("psysonic-offline");
    let cache_dir = resolve_offline_cache_dir(custom_dir.as_deref(), &server_id, &default_root)?;

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    // Already cached — skip re-download (no semaphore needed).
    if file_path.exists() {
        return Ok(path_str);
    }

    // Resolve this download's cancellation flag. A missing `download_id` (e.g.
    // an older caller) simply means the download cannot be cancelled.
    let cancel_flag: Option<Arc<AtomicBool>> = download_id.as_deref().and_then(|id| {
        offline_cancel_flags().lock().ok().map(|mut flags| {
            flags
                .entry(id.to_string())
                .or_insert_with(|| Arc::new(AtomicBool::new(false)))
                .clone()
        })
    });

    // Acquire a download slot. The permit is held for the duration of the HTTP transfer
    // and released automatically when this function returns (success or error).
    let _permit = dl_sem.acquire().await.map_err(|e| e.to_string())?;

    // Cancelled while parked on the semaphore — bail before opening a connection.
    if cancel_flag.as_ref().is_some_and(|f| f.load(Ordering::Relaxed)) {
        return Err("CANCELLED".to_string());
    }

    let client = subsonic_http_client(std::time::Duration::from_secs(120))?;
    let final_path = download_track_to_cache_dir(
        &cache_dir,
        &track_id,
        &suffix,
        &url,
        &client,
        cancel_flag.as_deref(),
    )
    .await?;

    enqueue_analysis_seed_from_file(&app, &track_id, &final_path).await;

    Ok(path_str)
}

/// Marks the given offline-download ids as cancelled. In-flight
/// `download_track_offline` calls abort their HTTP stream at the next chunk
/// boundary; ones still parked on the download semaphore bail as soon as they
/// acquire a slot. Mirrors `cancel_device_sync` for the device-sync side.
#[tauri::command]
pub fn cancel_offline_downloads(download_ids: Vec<String>) {
    if let Ok(mut flags) = offline_cancel_flags().lock() {
        for id in download_ids {
            flags
                .entry(id)
                .or_insert_with(|| Arc::new(AtomicBool::new(false)))
                .store(true, Ordering::Relaxed);
        }
    }
}

/// Drops a finished download's cancellation flag so the registry does not grow
/// across a long session. The frontend calls this once an album/playlist
/// download settles (completed or cancelled).
#[tauri::command]
pub fn clear_offline_cancel(download_id: String) {
    if let Ok(mut flags) = offline_cancel_flags().lock() {
        flags.remove(&download_id);
    }
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

        let path = download_track_to_cache_dir(&cache_dir, "track-1", "flac", &url, &client, None)
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

        let path = download_track_to_cache_dir(&cache_dir, "track-1", "flac", &url, &client, None)
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

        let err = download_track_to_cache_dir(&cache_dir, "missing", "flac", &url, &client, None)
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

        download_track_to_cache_dir(&cache_dir, "t", "mp3", &url, &client, None)
            .await
            .unwrap();
        assert!(cache_dir.join("t.mp3").exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn download_to_cache_dir_aborts_and_cleans_up_when_cancelled() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/stream/track-1"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"flac body bytes".to_vec()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().join("psysonic-offline").join("server-A");
        let client = subsonic_http_client(std::time::Duration::from_secs(5)).unwrap();
        let url = format!("{}/stream/track-1", server.uri());

        let cancel = AtomicBool::new(true);
        let err =
            download_track_to_cache_dir(&cache_dir, "track-1", "flac", &url, &client, Some(&cancel))
                .await
                .unwrap_err();
        assert_eq!(err, "CANCELLED");
        assert!(!cache_dir.join("track-1.flac").exists(), "no final file on cancel");
        assert!(!cache_dir.join("track-1.flac.part").exists(), "no .part orphan on cancel");
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

    // ── read_seed_bytes_if_needed (AppHandle-free) ──────────────────────────

    use psysonic_analysis::analysis_cache::{
        AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry,
    };

    fn populate_redundant_seed_rows(cache: &AnalysisCache, track_id: &str) {
        // cpu_seed_redundant_for_track returns true when both waveform AND
        // loudness rows exist for the current algo version.
        let key = TrackKey {
            track_id: track_id.to_string(),
            md5_16kb: "deadbeef".to_string(),
        };
        cache.touch_track_status(&key, "ready").unwrap();
        cache
            .upsert_waveform(
                &key,
                &WaveformEntry {
                    bins: vec![0u8; 1000], // 2 * 500
                    bin_count: 500,
                    is_partial: false,
                    known_until_sec: 0.0,
                    duration_sec: 0.0,
                    updated_at: 1_700_000_000,
                },
            )
            .unwrap();
        cache
            .upsert_loudness(
                &key,
                &LoudnessEntry {
                    integrated_lufs: -14.0,
                    true_peak: 1.0,
                    recommended_gain_db: 0.0,
                    target_lufs: -14.0,
                    updated_at: 1_700_000_000,
                },
            )
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_seed_bytes_returns_bytes_when_no_cache_attached() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("track.mp3");
        std::fs::write(&file, b"audio data").unwrap();
        let bytes = read_seed_bytes_if_needed(None, "anything", &file).await;
        assert_eq!(bytes.as_deref(), Some(b"audio data".as_slice()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_seed_bytes_returns_bytes_when_cache_has_no_rows_for_track() {
        let cache = AnalysisCache::open_in_memory();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("track.flac");
        std::fs::write(&file, b"some bytes").unwrap();
        let bytes = read_seed_bytes_if_needed(Some(&cache), "fresh-track", &file).await;
        assert_eq!(bytes.as_deref(), Some(b"some bytes".as_slice()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_seed_bytes_returns_none_when_cache_says_redundant() {
        let cache = AnalysisCache::open_in_memory();
        populate_redundant_seed_rows(&cache, "redundant-track");

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("track.mp3");
        std::fs::write(&file, b"would-be-decoded bytes").unwrap();

        let bytes = read_seed_bytes_if_needed(Some(&cache), "redundant-track", &file).await;
        assert!(
            bytes.is_none(),
            "redundant-cache short-circuit must skip the file read entirely"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_seed_bytes_returns_none_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let phantom = dir.path().join("never-written.mp3");
        let bytes = read_seed_bytes_if_needed(None, "any", &phantom).await;
        assert!(bytes.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_seed_bytes_returns_none_for_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("empty.flac");
        std::fs::write(&file, b"").unwrap();
        let bytes = read_seed_bytes_if_needed(None, "any", &file).await;
        assert!(bytes.is_none(), "empty file must not trigger seeding");
    }

    // ── resolve_offline_cache_dir ────────────────────────────────────────────

    #[test]
    fn resolve_cache_dir_uses_default_root_when_no_custom_dir() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve_offline_cache_dir(None, "server-A", dir.path()).unwrap();
        assert_eq!(resolved, dir.path().join("server-A"));
    }

    #[test]
    fn resolve_cache_dir_uses_default_root_when_custom_dir_is_empty_string() {
        let dir = tempfile::tempdir().unwrap();
        // Empty custom_dir is treated as None — Frank's frontend may pass "".
        let resolved = resolve_offline_cache_dir(Some(""), "server-A", dir.path()).unwrap();
        assert_eq!(resolved, dir.path().join("server-A"));
    }

    #[test]
    fn resolve_cache_dir_joins_server_id_under_existing_custom_volume() {
        let dir = tempfile::tempdir().unwrap();
        let resolved = resolve_offline_cache_dir(
            Some(&dir.path().to_string_lossy()),
            "server-B",
            std::path::Path::new("/should/not/be/used"),
        )
        .unwrap();
        assert_eq!(resolved, dir.path().join("server-B"));
    }

    #[test]
    fn resolve_cache_dir_returns_volume_not_found_for_missing_custom_dir() {
        let dir = tempfile::tempdir().unwrap();
        let phantom = dir.path().join("never-existed");
        let err = resolve_offline_cache_dir(
            Some(&phantom.to_string_lossy()),
            "server-A",
            std::path::Path::new("/unused"),
        )
        .unwrap_err();
        assert_eq!(err, "VOLUME_NOT_FOUND");
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


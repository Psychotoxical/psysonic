use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::locking::{destination_from_part_path, destination_is_locked, is_destination_lock_file};
use super::{
    apply_server_http_get, reborrow_cancellation, reqwest_error_without_url, DownloadCancellation,
    ABSOLUTE_MAX_DOWNLOAD_BYTES,
};

mod finalize;

pub use finalize::{finalize_resumable_download, finalize_resumable_download_cancellable};

#[derive(Debug)]
pub struct ResumableDownloadResponse {
    pub response: reqwest::Response,
    pub append: bool,
    pub resumed_from: u64,
    expected_total: Option<u64>,
    resume_supported: bool,
    completed_partial: bool,
}

impl ResumableDownloadResponse {
    pub fn validate_status(&self) -> Result<(), String> {
        let accepted = self.completed_partial
            || (!self.append && self.response.status() == reqwest::StatusCode::OK)
            || (self.append && self.response.status() == reqwest::StatusCode::PARTIAL_CONTENT);
        accepted
            .then_some(())
            .ok_or_else(|| format!("HTTP {}", self.response.status().as_u16()))
    }
}

struct ContentRange {
    start: u64,
    end: u64,
    total: u64,
}

struct ResumeMetadata {
    etag: String,
    total: u64,
    resource: String,
}

const RESUMABLE_ARTIFACT_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn resume_metadata_path(part_path: &Path) -> PathBuf {
    let mut path = part_path.as_os_str().to_os_string();
    path.push(".meta");
    PathBuf::from(path)
}

fn part_path_from_metadata_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy();
    let part_name = name.strip_suffix(".meta")?;
    Some(path.with_file_name(part_name))
}

fn download_resource_fingerprint(url: &str) -> String {
    let Ok(mut parsed) = reqwest::Url::parse(url) else {
        return format!("{:x}", md5::compute(url.as_bytes()));
    };
    let mut query: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| {
            !matches!(
                key.to_ascii_lowercase().as_str(),
                "p" | "t" | "s" | "password" | "token" | "apikey" | "api_key"
            )
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    query.sort_unstable();
    parsed.set_query(None);
    parsed.set_fragment(None);
    let _ = parsed.set_password(None);
    let mut canonical = parsed.to_string();
    for (key, value) in query {
        canonical.push('\n');
        canonical.push_str(&key);
        canonical.push('=');
        canonical.push_str(&value);
    }
    format!("{:x}", md5::compute(canonical.as_bytes()))
}

fn content_range(response: &reqwest::Response) -> Option<ContentRange> {
    let value = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let parsed = ContentRange {
        start: start.parse().ok()?,
        end: end.parse().ok()?,
        total: total.parse().ok()?,
    };
    (parsed.start <= parsed.end && parsed.end < parsed.total).then_some(parsed)
}

fn unsatisfied_content_range_total(response: &reqwest::Response) -> Option<u64> {
    let value = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    value.strip_prefix("bytes */")?.parse().ok()
}

fn strong_etag(response: &reqwest::Response) -> Option<String> {
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)?
        .to_str()
        .ok()?;
    (!etag.starts_with("W/")).then(|| etag.to_string())
}

async fn read_resume_metadata(part_path: &Path) -> Option<ResumeMetadata> {
    let content = tokio::fs::read_to_string(resume_metadata_path(part_path))
        .await
        .ok()?;
    let mut lines = content.lines();
    let total = lines.next()?;
    let etag = lines.next()?;
    let resource = lines.next()?;
    let total = total.parse().ok()?;
    (total > 0
        && total <= ABSOLUTE_MAX_DOWNLOAD_BYTES
        && !etag.is_empty()
        && !etag.starts_with("W/")
        && resource.len() == 32
        && resource.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| ResumeMetadata {
        etag: etag.to_string(),
        total,
        resource: resource.to_string(),
    })
}

async fn write_resume_metadata(part_path: &Path, metadata: &ResumeMetadata) -> bool {
    tokio::fs::write(
        resume_metadata_path(part_path),
        format!(
            "{}\n{}\n{}",
            metadata.total, metadata.etag, metadata.resource
        ),
    )
    .await
    .is_ok()
}

async fn remove_partial_download(part_path: &Path) {
    let _ = tokio::fs::remove_file(part_path).await;
    let _ = tokio::fs::remove_file(resume_metadata_path(part_path)).await;
}

async fn send_download_get(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
    url: &str,
    resume: Option<(u64, &str)>,
    cancellation: Option<&mut DownloadCancellation>,
) -> Result<reqwest::Response, String> {
    let mut request = apply_server_http_get(client, registry, server_ref, url);
    if let Some((start, etag)) = resume {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={start}-"))
            .header(reqwest::header::IF_RANGE, etag);
    }
    let send = request.send();
    tokio::pin!(send);
    if let Some(cancel) = cancellation {
        tokio::select! {
            response = &mut send => response.map_err(reqwest_error_without_url),
            _ = cancel.cancelled() => Err("CANCELLED".to_string()),
        }
    } else {
        send.await.map_err(reqwest_error_without_url)
    }
}

pub async fn promote_completed_partial(
    part_path: &Path,
    destination: &Path,
    url: &str,
    max_bytes: u64,
) -> Result<bool, String> {
    let Some(metadata) = read_resume_metadata(part_path).await else {
        return Ok(false);
    };
    let existing = tokio::fs::metadata(part_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if existing == 0
        || existing != metadata.total
        || existing > max_bytes
        || metadata.resource != download_resource_fingerprint(url)
    {
        return Ok(false);
    }
    tokio::fs::rename(part_path, destination)
        .await
        .map_err(|error| error.to_string())?;
    let _ = tokio::fs::remove_file(resume_metadata_path(part_path)).await;
    Ok(true)
}

pub async fn is_protected_download_artifact(path: &Path) -> bool {
    is_protected_download_artifact_with_max_age(path, RESUMABLE_ARTIFACT_MAX_AGE).await
}

async fn is_protected_download_artifact_with_max_age(path: &Path, max_age: Duration) -> bool {
    if is_destination_lock_file(path) {
        return true;
    }
    let part_path = if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".part.meta"))
    {
        let Some(part_path) = part_path_from_metadata_path(path) else {
            return false;
        };
        part_path
    } else if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".part"))
    {
        path.to_path_buf()
    } else {
        return destination_is_locked(path).await;
    };

    if let Some(destination) = destination_from_part_path(&part_path) {
        if destination_is_locked(&destination).await {
            return true;
        }
    }
    let Some(metadata) = read_resume_metadata(&part_path).await else {
        return false;
    };
    let metadata_path = resume_metadata_path(&part_path);
    let Ok(part_metadata) = tokio::fs::metadata(&part_path).await else {
        return false;
    };
    let Ok(sidecar_metadata) = tokio::fs::metadata(metadata_path).await else {
        return false;
    };
    let existing = part_metadata.len();
    if existing == 0 || existing > metadata.total || existing > ABSOLUTE_MAX_DOWNLOAD_BYTES {
        return false;
    }
    let latest_modified = [
        part_metadata.modified().ok(),
        sidecar_metadata.modified().ok(),
    ]
    .into_iter()
    .flatten()
    .max();
    let Some(latest_modified) = latest_modified else {
        return false;
    };
    if SystemTime::now()
        .duration_since(latest_modified)
        .is_ok_and(|age| age > max_age)
    {
        return false;
    }
    if part_path.is_file() {
        return true;
    }
    false
}

pub async fn prepare_resumable_download(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
    url: &str,
    part_path: &Path,
    max_bytes: u64,
) -> Result<ResumableDownloadResponse, String> {
    prepare_resumable_download_cancellable(
        client, registry, server_ref, url, part_path, max_bytes, None,
    )
    .await
}

pub async fn prepare_resumable_download_cancellable(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
    url: &str,
    part_path: &Path,
    max_bytes: u64,
    mut cancellation: Option<&mut DownloadCancellation>,
) -> Result<ResumableDownloadResponse, String> {
    let mut existing = tokio::fs::metadata(part_path)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut metadata = read_resume_metadata(part_path).await;
    let resource = download_resource_fingerprint(url);
    if existing > max_bytes
        || metadata.as_ref().is_none_or(|saved| {
            existing == 0
                || existing > saved.total
                || saved.total > max_bytes
                || saved.resource != resource
        })
    {
        remove_partial_download(part_path).await;
        existing = 0;
        metadata = None;
    }

    let mut response = send_download_get(
        client,
        registry,
        server_ref,
        url,
        metadata
            .as_ref()
            .map(|saved| (existing, saved.etag.as_str())),
        reborrow_cancellation(&mut cancellation),
    )
    .await?;

    if existing > 0 && response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
        remove_partial_download(part_path).await;
        existing = 0;
        metadata = None;
        response = send_download_get(
            client,
            registry,
            server_ref,
            url,
            None,
            reborrow_cancellation(&mut cancellation),
        )
        .await?;
    }

    if existing > 0 && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        let saved = metadata
            .as_ref()
            .expect("existing partial requires metadata");
        let server_total = unsatisfied_content_range_total(&response);
        let validator_matches = strong_etag(&response)
            .as_deref()
            .is_none_or(|etag| etag == saved.etag);
        if server_total == Some(existing) && existing == saved.total && validator_matches {
            return Ok(ResumableDownloadResponse {
                response,
                append: false,
                resumed_from: existing,
                expected_total: Some(saved.total),
                resume_supported: true,
                completed_partial: true,
            });
        }
        remove_partial_download(part_path).await;
        existing = 0;
        metadata = None;
        response = send_download_get(
            client,
            registry,
            server_ref,
            url,
            None,
            reborrow_cancellation(&mut cancellation),
        )
        .await?;
    }

    if existing > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let saved = metadata
            .as_ref()
            .expect("existing partial requires metadata");
        let parsed = content_range(&response);
        let valid = parsed.as_ref().is_some_and(|range| {
            let expected_body = range.end - range.start + 1;
            range.start == existing
                && range.end + 1 == range.total
                && range.total == saved.total
                && response.content_length() == Some(expected_body)
                && strong_etag(&response).as_deref() == Some(saved.etag.as_str())
        });
        if valid {
            return Ok(ResumableDownloadResponse {
                response,
                append: true,
                resumed_from: existing,
                expected_total: Some(saved.total),
                resume_supported: true,
                completed_partial: false,
            });
        }
        remove_partial_download(part_path).await;
        existing = 0;
        metadata = None;
        response = send_download_get(
            client,
            registry,
            server_ref,
            url,
            None,
            reborrow_cancellation(&mut cancellation),
        )
        .await?;
    }

    if existing == 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        return Err("download server returned partial content without a Range request".to_string());
    }

    if existing > 0 && response.status() == reqwest::StatusCode::OK {
        remove_partial_download(part_path).await;
        existing = 0;
        metadata = None;
    }

    if existing > 0 {
        let saved = metadata.expect("existing partial requires metadata");
        return Ok(ResumableDownloadResponse {
            response,
            append: false,
            resumed_from: existing,
            expected_total: Some(saved.total),
            resume_supported: true,
            completed_partial: false,
        });
    }

    let expected_total = response.content_length();
    let resume_supported = if response.status() == reqwest::StatusCode::OK {
        match (strong_etag(&response), expected_total) {
            (Some(etag), Some(total)) if total > 0 && total <= max_bytes => {
                write_resume_metadata(
                    part_path,
                    &ResumeMetadata {
                        etag,
                        total,
                        resource,
                    },
                )
                .await
            }
            _ => false,
        }
    } else {
        false
    };
    if !resume_supported {
        let _ = tokio::fs::remove_file(resume_metadata_path(part_path)).await;
    }

    Ok(ResumableDownloadResponse {
        response,
        append: false,
        resumed_from: 0,
        expected_total,
        resume_supported,
        completed_partial: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;
    use wiremock::matchers::{header, method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn seed_partial(part: &Path, url: &str, bytes: &[u8], total: u64) {
        tokio::fs::write(part, bytes).await.unwrap();
        assert!(
            write_resume_metadata(
                part,
                &ResumeMetadata {
                    etag: "\"track-v1\"".to_string(),
                    total,
                    resource: download_resource_fingerprint(url),
                },
            )
            .await
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn matching_range_response_resumes_existing_partial() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/track.flac"))
            .and(header("range", "bytes=3-"))
            .and(header("if-range", "\"track-v1\""))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("Content-Range", "bytes 3-5/6")
                    .insert_header("ETag", "\"track-v1\"")
                    .set_body_bytes(b"def".to_vec()),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let url = format!("{}/track.flac", server.uri());
        seed_partial(&part, &url, b"abc", 6).await;

        let prepared =
            prepare_resumable_download(&reqwest::Client::new(), None, None, &url, &part, 1024)
                .await
                .unwrap();
        assert!(prepared.append);
        assert_eq!(prepared.resumed_from, 3);
        finalize_resumable_download(prepared, &destination, &part, 1024, None)
            .await
            .unwrap();

        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"abcdef");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn precondition_failure_restarts_without_range() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut ranged, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let size = ranged.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..size])
                .to_ascii_lowercase()
                .contains("range: bytes=3-"));
            ranged
                .write_all(
                    b"HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();

            let (mut full, _) = listener.accept().unwrap();
            let size = full.read(&mut request).unwrap();
            assert!(!String::from_utf8_lossy(&request[..size])
                .to_ascii_lowercase()
                .contains("range:"));
            full.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
            )
            .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let url = format!("http://{address}/track.flac");
        seed_partial(&part, &url, b"abc", 6).await;

        let prepared =
            prepare_resumable_download(&reqwest::Client::new(), None, None, &url, &part, 1024)
                .await
                .unwrap();
        assert!(!prepared.append);
        finalize_resumable_download(prepared, &destination, &part, 1024, None)
            .await
            .unwrap();

        server.join().unwrap();
        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"abcdef");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn range_not_satisfiable_promotes_complete_partial() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/track.flac"))
            .and(header("range", "bytes=6-"))
            .and(header("if-range", "\"track-v1\""))
            .respond_with(
                ResponseTemplate::new(416)
                    .insert_header("Content-Range", "bytes */6")
                    .insert_header("ETag", "\"track-v1\""),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let url = format!("{}/track.flac", server.uri());
        seed_partial(&part, &url, b"abcdef", 6).await;

        let prepared =
            prepare_resumable_download(&reqwest::Client::new(), None, None, &url, &part, 1024)
                .await
                .unwrap();
        prepared.validate_status().unwrap();
        finalize_resumable_download(prepared, &destination, &part, 1024, None)
            .await
            .unwrap();

        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"abcdef");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn range_not_satisfiable_with_mismatched_total_restarts_without_range() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut ranged, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let size = ranged.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..size])
                .to_ascii_lowercase()
                .contains("range: bytes=3-"));
            ranged
                .write_all(
                    b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();

            let (mut full, _) = listener.accept().unwrap();
            let size = full.read(&mut request).unwrap();
            assert!(!String::from_utf8_lossy(&request[..size])
                .to_ascii_lowercase()
                .contains("range:"));
            full.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
            )
            .unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let url = format!("http://{address}/track.flac");
        seed_partial(&part, &url, b"abc", 6).await;

        let prepared =
            prepare_resumable_download(&reqwest::Client::new(), None, None, &url, &part, 1024)
                .await
                .unwrap();
        prepared.validate_status().unwrap();
        finalize_resumable_download(prepared, &destination, &part, 1024, None)
            .await
            .unwrap();

        server.join().unwrap();
        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"abcdef");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn completed_partial_is_promoted_without_network() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = super::super::sibling_part_path(&destination, "track-1");
        let url = "https://music.test/rest/stream?id=track-1";
        seed_partial(&part, url, b"abcdef", 6).await;

        assert!(promote_completed_partial(&part, &destination, url, 1024)
            .await
            .unwrap());
        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"abcdef");
        assert!(!part.exists());
        assert!(!resume_metadata_path(&part).exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn auth_rate_limit_and_transient_statuses_preserve_partial() {
        for status in [401, 403, 429, 503] {
            let server = MockServer::start().await;
            Mock::given(method("GET"))
                .and(wm_path("/track.flac"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            let dir = tempfile::tempdir().unwrap();
            let part = dir.path().join("track.flac.part");
            let url = format!("{}/track.flac", server.uri());
            seed_partial(&part, &url, b"abc", 6).await;

            let prepared =
                prepare_resumable_download(&reqwest::Client::new(), None, None, &url, &part, 1024)
                    .await
                    .unwrap();

            assert_eq!(prepared.response.status().as_u16(), status);
            assert_eq!(tokio::fs::read(&part).await.unwrap(), b"abc");
            assert!(resume_metadata_path(&part).exists());
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rename_failure_preserves_complete_part_and_metadata() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/track.flac"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("ETag", "\"track-v1\"")
                    .set_body_bytes(b"abcdef".to_vec()),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("track.flac.part");
        let destination = dir.path().join("missing").join("track.flac");
        let prepared = prepare_resumable_download(
            &reqwest::Client::new(),
            None,
            None,
            &format!("{}/track.flac", server.uri()),
            &part,
            1024,
        )
        .await
        .unwrap();

        assert!(
            finalize_resumable_download(prepared, &destination, &part, 1024, None)
                .await
                .is_err()
        );
        assert_eq!(tokio::fs::read(&part).await.unwrap(), b"abcdef");
        assert!(resume_metadata_path(&part).exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn valid_resume_pair_is_protected_from_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("track.flac.part");
        seed_partial(&part, "https://music.test/track", b"abc", 6).await;

        assert!(is_protected_download_artifact(&part).await);
        assert!(is_protected_download_artifact(&resume_metadata_path(&part)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn corrupt_resume_pair_is_not_protected_from_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("track.flac.part");
        seed_partial(&part, "https://music.test/track", b"abcdefg", 6).await;

        assert!(!is_protected_download_artifact(&part).await);
        assert!(!is_protected_download_artifact(&resume_metadata_path(&part)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn expired_resume_pair_is_not_protected_from_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("track.flac.part");
        seed_partial(&part, "https://music.test/track", b"abc", 6).await;
        let old = SystemTime::now() - RESUMABLE_ARTIFACT_MAX_AGE - Duration::from_secs(1);
        for path in [&part, &resume_metadata_path(&part)] {
            let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
            file.set_times(std::fs::FileTimes::new().set_modified(old))
                .unwrap();
        }

        assert!(!is_protected_download_artifact(&part).await);
        assert!(!is_protected_download_artifact(&resume_metadata_path(&part)).await);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn finalizer_rejects_unaccepted_http_status() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/missing"))
            .respond_with(ResponseTemplate::new(404).set_body_bytes(b"not audio".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let prepared = prepare_resumable_download(
            &reqwest::Client::new(),
            None,
            None,
            &format!("{}/missing", server.uri()),
            &part,
            1024,
        )
        .await
        .unwrap();

        let error = finalize_resumable_download(prepared, &destination, &part, 1024, None)
            .await
            .unwrap_err();

        assert_eq!(error, "HTTP 404");
        assert!(!destination.exists());
        assert!(!part.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_interrupts_waiting_for_response_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            thread::sleep(Duration::from_secs(2));
        });
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("track.flac.part");
        let flag = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut cancellation = DownloadCancellation::new(Arc::clone(&flag), receiver);
        let client = reqwest::Client::new();
        let url = format!("http://{address}/track");
        let request = prepare_resumable_download_cancellable(
            &client,
            None,
            None,
            &url,
            &part,
            1024,
            Some(&mut cancellation),
        );
        tokio::pin!(request);

        tokio::time::sleep(Duration::from_millis(50)).await;
        flag.store(true, Ordering::Relaxed);
        sender.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(1), request)
            .await
            .unwrap();

        assert!(matches!(result, Err(ref error) if error == "CANCELLED"));
        drop(server);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_interrupts_stalled_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nETag: \"v1\"\r\n\r\n")
                .unwrap();
            stream.flush().unwrap();
            thread::sleep(Duration::from_secs(2));
        });
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let flag = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut cancellation = DownloadCancellation::new(Arc::clone(&flag), receiver);
        let prepared = prepare_resumable_download_cancellable(
            &reqwest::Client::new(),
            None,
            None,
            &format!("http://{address}/track"),
            &part,
            1024,
            Some(&mut cancellation),
        )
        .await
        .unwrap();
        let transfer = finalize_resumable_download_cancellable(
            prepared,
            &destination,
            &part,
            1024,
            Some(&mut cancellation),
        );
        tokio::pin!(transfer);

        tokio::time::sleep(Duration::from_millis(50)).await;
        flag.store(true, Ordering::Relaxed);
        sender.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(1), transfer)
            .await
            .unwrap();

        assert!(matches!(result, Err(ref error) if error == "CANCELLED"));
        assert!(!part.exists());
        assert!(!resume_metadata_path(&part).exists());
        server.join().unwrap();
    }
}

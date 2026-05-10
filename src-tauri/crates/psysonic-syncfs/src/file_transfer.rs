use std::path::Path;
use std::time::Duration;

/// Build a reqwest client with the standard Subsonic UA and a single overall timeout.
/// For flows that need separate connect + read timeouts (long-running update/zip
/// downloads with progress events), build the client inline.
pub fn subsonic_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

/// Streams an HTTP response body to `dest_path` in chunks. Never buffers the full
/// file in memory — keeps RAM flat regardless of file size.
pub async fn stream_to_file(
    response: reqwest::Response,
    dest_path: &Path,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Streams `response` to `part_path`, then renames `part_path` → `dest_path`.
/// On any failure the partial `.part` file is best-effort removed so it does
/// not linger on disk. Caller must ensure `dest_path.parent()` exists.
///
/// Note vs. previous inline implementations: the offline/device single-track
/// flows used to leave a `.part` orphan if the final rename failed. This helper
/// always cleans up, matching the batch-sync flow that already did.
pub async fn finalize_streamed_download(
    response: reqwest::Response,
    dest_path: &Path,
    part_path: &Path,
) -> Result<(), String> {
    if let Err(e) = stream_to_file(response, part_path).await {
        let _ = tokio::fs::remove_file(part_path).await;
        return Err(e);
    }
    if let Err(e) = tokio::fs::rename(part_path, dest_path).await {
        let _ = tokio::fs::remove_file(part_path).await;
        return Err(e.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn subsonic_http_client_builds_with_short_timeout() {
        assert!(subsonic_http_client(Duration::from_secs(1)).is_ok());
    }

    #[test]
    fn subsonic_http_client_builds_with_long_timeout() {
        // The 5-minute timeout used by sync_track_to_device must construct successfully.
        assert!(subsonic_http_client(Duration::from_secs(300)).is_ok());
    }

    #[test]
    fn subsonic_http_client_builds_with_zero_timeout() {
        // zero is a valid Duration — reqwest treats it as "no timeout effectively".
        // The constructor must not reject it.
        assert!(subsonic_http_client(Duration::from_secs(0)).is_ok());
    }

    // ── stream_to_file ────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn stream_to_file_writes_full_response_body() {
        let server = MockServer::start().await;
        let body = b"hello psysonic test bytes".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/track.flac"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("track.flac");
        let response = reqwest::get(format!("{}/track.flac", server.uri()))
            .await
            .unwrap();
        stream_to_file(response, &dest).await.unwrap();

        let written = std::fs::read(&dest).unwrap();
        assert_eq!(written, body);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stream_to_file_creates_empty_file_for_empty_body() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/empty"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(Vec::<u8>::new()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("empty.bin");
        let response = reqwest::get(format!("{}/empty", server.uri()))
            .await
            .unwrap();
        stream_to_file(response, &dest).await.unwrap();
        assert!(dest.exists());
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stream_to_file_returns_err_when_dest_directory_missing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/x"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"x".to_vec()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("missing-subdir").join("x.bin");
        let response = reqwest::get(format!("{}/x", server.uri()))
            .await
            .unwrap();
        let result = stream_to_file(response, &dest).await;
        assert!(result.is_err(), "create on missing parent dir must err");
    }

    // ── finalize_streamed_download ────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn finalize_renames_part_to_dest_on_success() {
        let server = MockServer::start().await;
        let body = b"final body content".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("track.flac");
        let part = dest.with_extension("flac.part");
        let response = reqwest::get(format!("{}/track", server.uri()))
            .await
            .unwrap();

        finalize_streamed_download(response, &dest, &part).await.unwrap();
        assert!(dest.exists(), "dest file must exist after success");
        assert!(!part.exists(), "part file must not linger");
        assert_eq!(std::fs::read(&dest).unwrap(), body);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn finalize_cleans_up_part_when_rename_fails() {
        // Pre-create the dest as a directory — rename(file -> existing-dir)
        // fails on every supported OS (renaming a file over a directory is
        // not allowed, even when the dir is empty).
        let server = MockServer::start().await;
        let body = b"some content".to_vec();
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("blocker");
        std::fs::create_dir(&dest).unwrap(); // dest is a dir → rename should fail
        let part = dir.path().join("blocker.part");
        let response = reqwest::get(format!("{}/track", server.uri()))
            .await
            .unwrap();

        let result = finalize_streamed_download(response, &dest, &part).await;
        assert!(result.is_err(), "rename onto existing directory must fail");
        assert!(!part.exists(), "part file must be cleaned up after rename failure");
        assert!(dest.is_dir(), "the blocker directory itself stays untouched");
    }
}

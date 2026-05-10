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
}

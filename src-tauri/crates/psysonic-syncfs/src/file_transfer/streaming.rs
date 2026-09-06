use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use super::{reqwest_error_without_url, wait_for_atomic_cancellation};

/// Streams an HTTP response body to `dest_path` without buffering the full file.
pub async fn stream_to_file(
    response: reqwest::Response,
    dest_path: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|error| error.to_string())?;
    stream_response_to_file(response, &mut file, cancel).await
}

async fn stream_response_to_file(
    response: reqwest::Response,
    file: &mut tokio::fs::File,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    loop {
        let next = if let Some(flag) = cancel {
            tokio::select! {
                chunk = stream.next() => chunk,
                _ = wait_for_atomic_cancellation(flag) => return Err("CANCELLED".to_string()),
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(reqwest_error_without_url)?;
        file.write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
    }
    file.flush().await.map_err(|error| error.to_string())?;
    file.sync_all().await.map_err(|error| error.to_string())?;
    Ok(())
}

async fn stream_to_fresh_file(
    response: reqwest::Response,
    path: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_dir() => {
            return Err("download part path is a directory".to_string())
        }
        Ok(_) => tokio::fs::remove_file(path)
            .await
            .map_err(|error| error.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|error| error.to_string())?;
    stream_response_to_file(response, &mut file, cancel).await
}

/// Streams `response` to `part_path`, then renames `part_path` to `dest_path`.
pub async fn finalize_streamed_download(
    response: reqwest::Response,
    dest_path: &Path,
    part_path: &Path,
    cancel: Option<&AtomicBool>,
) -> Result<(), String> {
    if let Err(error) = stream_to_fresh_file(response, part_path, cancel).await {
        let _ = tokio::fs::remove_file(part_path).await;
        return Err(error);
    }
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        let _ = tokio::fs::remove_file(part_path).await;
        return Err("CANCELLED".to_string());
    }
    if let Err(error) = tokio::fs::rename(part_path, dest_path).await {
        let _ = tokio::fs::remove_file(part_path).await;
        return Err(error.to_string());
    }
    #[cfg(unix)]
    if let Some(parent) = dest_path.parent() {
        if let Err(error) = std::fs::File::open(parent).and_then(|directory| directory.sync_all()) {
            let _ = tokio::fs::remove_file(dest_path).await;
            return Err(error.to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn streamed_download_writes_and_renames_complete_body() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"complete".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let response = reqwest::get(format!("{}/track", server.uri()))
            .await
            .unwrap();

        finalize_streamed_download(response, &destination, &part, None)
            .await
            .unwrap();

        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"complete");
        assert!(!part.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn already_cancelled_stream_does_not_write_final_file() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"complete".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        let response = reqwest::get(format!("{}/track", server.uri()))
            .await
            .unwrap();
        let cancel = AtomicBool::new(true);

        assert_eq!(
            finalize_streamed_download(response, &destination, &part, Some(&cancel))
                .await
                .unwrap_err(),
            "CANCELLED"
        );
        assert!(!destination.exists());
        assert!(!part.exists());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn preexisting_part_symlink_is_unlinked_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/track"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"complete".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), b"outside").unwrap();
        let destination = dir.path().join("track.flac");
        let part = dir.path().join("track.flac.part");
        symlink(outside.path(), &part).unwrap();
        let response = reqwest::get(format!("{}/track", server.uri()))
            .await
            .unwrap();

        finalize_streamed_download(response, &destination, &part, None)
            .await
            .unwrap();

        assert_eq!(std::fs::read(outside.path()).unwrap(), b"outside");
        assert_eq!(tokio::fs::read(destination).await.unwrap(), b"complete");
    }
}

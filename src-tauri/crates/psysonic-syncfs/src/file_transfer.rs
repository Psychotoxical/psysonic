use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

mod locking;
mod resumable;
mod space;
mod streaming;

pub use locking::{acquire_download_destination_lock, sibling_part_path, DownloadDestinationGuard};
pub use resumable::{
    finalize_resumable_download, finalize_resumable_download_cancellable,
    is_protected_download_artifact, prepare_resumable_download,
    prepare_resumable_download_cancellable, promote_completed_partial, ResumableDownloadResponse,
};
pub use streaming::{finalize_streamed_download, stream_to_file};

const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(120);
const DOWNLOAD_SIZE_HEADROOM_BYTES: u64 = 64 * 1024 * 1024;
const FALLBACK_MAX_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const ABSOLUTE_MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone)]
pub struct DownloadCancellation {
    flag: Arc<AtomicBool>,
    receiver: tokio::sync::watch::Receiver<bool>,
}

impl DownloadCancellation {
    pub(crate) fn new(flag: Arc<AtomicBool>, receiver: tokio::sync::watch::Receiver<bool>) -> Self {
        Self { flag, receiver }
    }

    pub fn flag(&self) -> &AtomicBool {
        &self.flag
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed) || *self.receiver.borrow()
    }

    pub async fn cancelled(&mut self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            if self.receiver.changed().await.is_err() {
                wait_for_atomic_cancellation(&self.flag).await;
                return;
            }
        }
    }
}

pub(super) async fn wait_for_atomic_cancellation(flag: &AtomicBool) {
    while !flag.load(Ordering::Relaxed) {
        tokio::time::sleep(CANCELLATION_POLL_INTERVAL).await;
    }
}

pub(super) fn reborrow_cancellation<'a>(
    cancellation: &'a mut Option<&mut DownloadCancellation>,
) -> Option<&'a mut DownloadCancellation> {
    cancellation.as_mut().map(|cancel| &mut **cancel)
}

pub(crate) async fn acquire_download_permit<'a>(
    semaphore: &'a tokio::sync::Semaphore,
    cancellation: Option<&mut DownloadCancellation>,
) -> Result<tokio::sync::SemaphorePermit<'a>, String> {
    if let Some(cancel) = cancellation {
        tokio::select! {
            permit = semaphore.acquire() => permit.map_err(|error| error.to_string()),
            _ = cancel.cancelled() => Err("CANCELLED".to_string()),
        }
    } else {
        semaphore.acquire().await.map_err(|error| error.to_string())
    }
}

/// Build a reqwest client with the standard Subsonic user agent and one timeout.
pub fn subsonic_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
        .timeout(timeout)
        .build()
        .map_err(|error| error.to_string())
}

fn build_subsonic_download_http_client(
    connect_timeout: Duration,
    read_timeout: Duration,
) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .build()
        .map_err(|error| error.to_string())
}

/// File downloads may run for hours. Bound connection and stalled-read time only.
pub fn subsonic_download_http_client() -> Result<reqwest::Client, String> {
    build_subsonic_download_http_client(DOWNLOAD_CONNECT_TIMEOUT, DOWNLOAD_READ_TIMEOUT)
}

pub fn reqwest_error_without_url(error: reqwest::Error) -> String {
    let timed_out = error.is_timeout();
    let message = error.without_url().to_string();
    if timed_out && !message.to_ascii_lowercase().contains("timed out") {
        format!("{message}: timed out")
    } else {
        message
    }
}

pub fn max_download_bytes(expected_size_bytes: Option<u64>) -> u64 {
    expected_size_bytes
        .filter(|size| *size > 0)
        .map(|size| {
            size.saturating_mul(2)
                .saturating_add(DOWNLOAD_SIZE_HEADROOM_BYTES)
        })
        .unwrap_or(FALLBACK_MAX_DOWNLOAD_BYTES)
        .min(ABSOLUTE_MAX_DOWNLOAD_BYTES)
}

pub fn apply_server_http_get(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
    url: &str,
) -> reqwest::RequestBuilder {
    psysonic_core::server_http::apply_optional_registry_headers(
        registry,
        server_ref,
        url,
        client.get(url),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn download_clients_accept_short_long_and_zero_timeouts() {
        assert!(subsonic_http_client(Duration::from_secs(1)).is_ok());
        assert!(subsonic_http_client(Duration::from_secs(300)).is_ok());
        assert!(subsonic_http_client(Duration::ZERO).is_ok());
    }

    #[test]
    fn expected_size_limit_has_headroom_and_absolute_cap() {
        assert_eq!(
            max_download_bytes(Some(10)),
            DOWNLOAD_SIZE_HEADROOM_BYTES + 20
        );
        assert_eq!(max_download_bytes(None), FALLBACK_MAX_DOWNLOAD_BYTES);
        assert_eq!(
            max_download_bytes(Some(u64::MAX)),
            ABSOLUTE_MAX_DOWNLOAD_BYTES
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_wakes_semaphore_waiter() {
        let semaphore = tokio::sync::Semaphore::new(0);
        let flag = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut cancellation = DownloadCancellation::new(Arc::clone(&flag), receiver);
        let wait = acquire_download_permit(&semaphore, Some(&mut cancellation));
        tokio::pin!(wait);

        tokio::time::sleep(Duration::from_millis(25)).await;
        flag.store(true, Ordering::Relaxed);
        sender.send_replace(true);

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), wait)
                .await
                .unwrap()
                .unwrap_err(),
            "CANCELLED"
        );
    }
}

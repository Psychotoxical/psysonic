use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;

use crate::engine::PlaybackHttpHeaders;
use crate::stream::TRACK_STREAM_MAX_RECONNECTS;

/// Outcome of [`ranged_http_download_loop`] — total bytes written to the buffer
/// plus the reason the loop stopped. The wrapper task uses this to decide
/// whether to promote the buffer to the stream-complete cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RangedHttpLoopOutcome {
    /// Stream ended with `downloaded == total_size`.
    Completed,
    /// `gen_arc` no longer matches `gen` — playback skipped to another track.
    Superseded,
    /// Stream stopped early without finishing — server cut, reconnect budget
    /// exhausted, or non-success status on the (re)connect response.
    Aborted,
}

/// Returns `(downloaded_bytes, outcome)`. The caller is responsible for setting
/// any `done` flag, promoting the buffer to a cache, or kicking off analysis
/// seeding once the loop returns.
#[allow(clippy::too_many_arguments)]
pub(super) async fn ranged_http_download_loop<F>(
    http_client: reqwest::Client,
    url: &str,
    initial_response: reqwest::Response,
    buf: &Arc<Mutex<Vec<u8>>>,
    downloaded_to: &Arc<AtomicUsize>,
    gen: u64,
    gen_arc: &Arc<AtomicU64>,
    http_headers: &PlaybackHttpHeaders,
    mut on_partial: F,
    playback_armed: Option<&AtomicBool>,
) -> (usize, RangedHttpLoopOutcome)
where
    F: FnMut(usize, usize),
{
    let total_size = buf.lock().unwrap().len();
    let mut downloaded: usize = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let mut next_progress_mb: usize = 0;

    'outer: loop {
        let response = if let Some(r) = next_response.take() {
            r
        } else {
            let mut req = http_client.get(url);
            if downloaded > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            }
            req = http_headers.apply(url, req);
            match req.send().await {
                Ok(r) => r,
                Err(err) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] ranged reconnect failed after {} attempts: {}",
                            reconnects,
                            err
                        );
                        return (downloaded, RangedHttpLoopOutcome::Aborted);
                    }
                    reconnects += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue 'outer;
                }
            }
        };
        if downloaded > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            crate::app_eprintln!(
                "[audio] ranged reconnect returned {}, expected 206",
                response.status()
            );
            return (downloaded, RangedHttpLoopOutcome::Aborted);
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] ranged HTTP {}", response.status());
            return (downloaded, RangedHttpLoopOutcome::Aborted);
        }

        let mut byte_stream = response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            if gen_arc.load(Ordering::SeqCst) != gen {
                crate::app_deprintln!(
                    "[stream] ranged dl superseded by skip: gen={}→{} downloaded={}/{} bytes",
                    gen,
                    gen_arc.load(Ordering::SeqCst),
                    downloaded,
                    total_size
                );
                return (downloaded, RangedHttpLoopOutcome::Superseded);
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] ranged dl error after {} reconnects: {}",
                            reconnects,
                            e
                        );
                        return (downloaded, RangedHttpLoopOutcome::Aborted);
                    }
                    reconnects += 1;
                    crate::app_eprintln!(
                        "[audio] ranged dl error (attempt {}/{}): {} — reconnecting",
                        reconnects,
                        TRACK_STREAM_MAX_RECONNECTS,
                        e
                    );
                    next_response = None;
                    continue 'outer;
                }
            };
            reconnects = 0;
            let writable = total_size.saturating_sub(downloaded);
            if writable == 0 {
                break;
            }
            let n = chunk.len().min(writable);
            {
                let mut b = buf.lock().unwrap();
                b[downloaded..downloaded + n].copy_from_slice(&chunk[..n]);
            }
            downloaded += n;
            downloaded_to.store(downloaded, Ordering::SeqCst);
            if let Some(armed) = playback_armed {
                crate::stream::maybe_arm_stream_playback(downloaded as u64, armed);
            }
            on_partial(downloaded, total_size);
            let mb = downloaded / (1024 * 1024);
            while mb >= next_progress_mb {
                let pct = if total_size > 0 {
                    (downloaded as f64 / total_size as f64 * 100.0) as u32
                } else {
                    0u32
                };
                crate::app_deprintln!(
                    "[stream] dl progress: {} MB / {} MB ({}%)",
                    mb,
                    total_size / (1024 * 1024),
                    pct
                );
                next_progress_mb = mb + 1;
            }
            if downloaded >= total_size {
                break;
            }
        }
        // Stream ended cleanly (or we wrote total_size).
        if downloaded >= total_size {
            return (downloaded, RangedHttpLoopOutcome::Completed);
        }
        return (downloaded, RangedHttpLoopOutcome::Aborted);
    }
}

/// Fetch `bytes=start-end` into `buf[start..=end]` (inclusive HTTP Range).
#[allow(clippy::too_many_arguments)]
pub(super) async fn ranged_write_http_range(
    http_client: &reqwest::Client,
    url: &str,
    buf: &Arc<Mutex<Vec<u8>>>,
    start: u64,
    end_inclusive: u64,
    gen: u64,
    gen_arc: &Arc<AtomicU64>,
    http_headers: &PlaybackHttpHeaders,
) -> Result<usize, ()> {
    if gen_arc.load(Ordering::SeqCst) != gen {
        return Err(());
    }
    let response = http_headers
        .apply(
            url,
            http_client.get(url).header(
                reqwest::header::RANGE,
                format!("bytes={start}-{end_inclusive}"),
            ),
        )
        .send()
        .await
        .map_err(|_| ())?;
    if gen_arc.load(Ordering::SeqCst) != gen {
        return Err(());
    }
    // Require 206 for any non-zero offset. A server that ignored the `Range`
    // header and replied 200 returns the *whole* body from byte 0; writing that
    // at `start` would corrupt the buffer. A 200 is only safe when we asked from
    // offset 0 (the body genuinely starts there).
    let status = response.status();
    let ok = status == reqwest::StatusCode::PARTIAL_CONTENT
        || (status == reqwest::StatusCode::OK && start == 0);
    if !ok {
        return Err(());
    }
    let mut written = 0usize;
    let start_usize = start as usize;
    let mut byte_stream = response.bytes_stream();
    while let Some(chunk) = byte_stream.next().await {
        if gen_arc.load(Ordering::SeqCst) != gen {
            return Err(());
        }
        let chunk = chunk.map_err(|_| ())?;
        if chunk.is_empty() {
            continue;
        }
        let mut b = buf.lock().unwrap();
        let end = (start_usize + written + chunk.len()).min(b.len());
        let n = end.saturating_sub(start_usize + written);
        b[start_usize + written..start_usize + written + n].copy_from_slice(&chunk[..n]);
        written += n;
        if start_usize + written > end_inclusive as usize {
            break;
        }
    }
    Ok(written)
}

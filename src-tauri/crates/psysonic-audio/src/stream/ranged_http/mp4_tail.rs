use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::range_task::ranged_write_http_range;
use crate::engine::PlaybackHttpHeaders;

/// Prefetch the tail of a moov-at-end MP4 so Symphonia can parse metadata while
/// the linear download still fills `mdat` from offset 0.
#[allow(clippy::too_many_arguments)]
pub(super) async fn ranged_prefetch_mp4_tail(
    http_client: reqwest::Client,
    url: String,
    buf: Arc<Mutex<Vec<u8>>>,
    total_size: usize,
    tail_ready: Arc<AtomicBool>,
    tail_filled_from: Arc<AtomicU64>,
    playback_armed: Arc<AtomicBool>,
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_headers: PlaybackHttpHeaders,
) {
    const MIN_TAIL: u64 = 256 * 1024;
    const MAX_TAIL: u64 = 8 * 1024 * 1024;
    let total = total_size as u64;
    if total < MIN_TAIL + 64 * 1024 {
        return;
    }
    let tail_len = MAX_TAIL.min(total / 2).max(MIN_TAIL);
    let tail_from = total.saturating_sub(tail_len);
    let end_inclusive = total.saturating_sub(1);
    match ranged_write_http_range(
        &http_client,
        &url,
        &buf,
        tail_from,
        end_inclusive,
        gen,
        &gen_arc,
        &http_headers,
    )
    .await
    {
        Ok(written) if written > 0 => {
            tail_filled_from.store(tail_from, Ordering::Relaxed);
            tail_ready.store(true, Ordering::SeqCst);
            if !playback_armed.load(Ordering::Relaxed) {
                playback_armed.store(true, Ordering::SeqCst);
                crate::app_deprintln!(
                    "[stream] playback armed after moov tail prefetch ({} KiB)",
                    written / 1024
                );
            }
            crate::app_deprintln!(
                "[stream] ranged: moov-at-end tail prefetch {} KiB (from byte {})",
                written / 1024,
                tail_from / 1024
            );
        }
        _ => {
            crate::app_deprintln!("[stream] ranged: moov-at-end tail prefetch failed");
        }
    }
}

//! Live internet-radio session state and the async HTTP download task.
//!
//! Lifecycle:
//!   'outer loop — reconnect on TCP drop (up to MAX_CONSECUTIVE_FAILURES)
//!   'inner loop — read HTTP chunks → ICY interceptor → push audio to ring buffer
//!
//! Hard-pause detection: if push_slice() returns 0 (buffer full) AND sink is
//! paused AND that condition persists for `RADIO_HARD_PAUSE_SECS` → disconnect.
//! Sets `is_hard_paused = true` so audio_resume knows it must reconnect.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use ringbuf::HeapCons;
use ringbuf::HeapProd;
use ringbuf::traits::{Observer, Producer};
use tauri::{AppHandle, Emitter};

use super::icy::IcyInterceptor;
use super::{RADIO_BUF_CAPACITY, RADIO_HARD_PAUSE_SECS};

pub(crate) struct RadioSharedFlags {
    /// Set by audio_pause; cleared by audio_resume.
    pub(crate) is_paused: AtomicBool,
    /// Set by download task on hard disconnect; cleared on resume-reconnect.
    pub(crate) is_hard_paused: AtomicBool,
    /// Delivers a fresh HeapCons<u8> to AudioStreamReader on reconnect.
    pub(crate) new_cons_tx: Mutex<std::sync::mpsc::Sender<HeapCons<u8>>>,
}

/// Live state for the current radio session, stored in AudioEngine.
/// Dropping this struct aborts the HTTP download task immediately.
pub(crate) struct RadioLiveState {
    pub url: String,
    pub gen: u64,
    pub task: tokio::task::JoinHandle<()>,
    pub flags: Arc<RadioSharedFlags>,
}

impl Drop for RadioLiveState {
    fn drop(&mut self) { self.task.abort(); }
}

/// Pure: extract the `icy-metaint` header value from a HeaderMap. Returns
/// `None` when the header is absent, non-ASCII, or doesn't parse as `usize`.
pub(crate) fn parse_icy_metaint_from_headers(
    headers: &reqwest::header::HeaderMap,
) -> Option<usize> {
    headers
        .get("icy-metaint")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
}

/// Pure: should the radio download task disconnect because the consumer has
/// been stuck on a full ring buffer for too long while paused?
pub(crate) fn should_hard_pause(
    is_paused: bool,
    stall_since: Option<std::time::Instant>,
    now: std::time::Instant,
    threshold: Duration,
) -> bool {
    is_paused
        && stall_since.is_some_and(|since| now.duration_since(since) >= threshold)
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn radio_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    mut initial_response: Option<reqwest::Response>,
    http_client: reqwest::Client,
    url: String,
    mut prod: HeapProd<u8>,
    flags: Arc<RadioSharedFlags>,
    app: AppHandle,
) {
    let mut bytes_total: u64 = 0;
    // Counts consecutive failures (reset on each successful chunk).
    // laut.fm and similar CDNs force-reconnect every ~700 KB; this is normal.
    let mut reconnect_count: u32 = 0;
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    let mut audio_scratch: Vec<u8> = Vec::with_capacity(65_536);

    'outer: loop {
        if gen_arc.load(Ordering::SeqCst) != gen { return; }

        // ── Obtain response (initial or reconnect) ────────────────────────────
        let response = match initial_response.take() {
            Some(r) => r,
            None => {
                if reconnect_count >= MAX_CONSECUTIVE_FAILURES {
                    crate::app_eprintln!("[radio] {MAX_CONSECUTIVE_FAILURES} consecutive failures — giving up");
                    break 'outer;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                if gen_arc.load(Ordering::SeqCst) != gen { return; }
                match http_client
                    .get(&url)
                    .header("Icy-MetaData", "1")
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => {
                        crate::app_eprintln!("[radio] reconnected ({bytes_total} B so far)");
                        r
                    }
                    Ok(r) => {
                        crate::app_eprintln!("[radio] reconnect: HTTP {} — giving up", r.status());
                        break 'outer;
                    }
                    Err(e) => {
                        crate::app_eprintln!("[radio] reconnect error: {e} — giving up");
                        break 'outer;
                    }
                }
            }
        };

        // Parse ICY metaint from each response (consistent across reconnects).
        let metaint = parse_icy_metaint_from_headers(response.headers());
        let mut icy = metaint.map(IcyInterceptor::new);

        let mut byte_stream = response.bytes_stream();
        // Stall timer: tracks how long push_slice() returns 0 while paused.
        let mut stall_since: Option<std::time::Instant> = None;

        'inner: loop {
            if gen_arc.load(Ordering::SeqCst) != gen { return; }

            // ── Back-pressure + hard-pause detection ──────────────────────────
            if prod.is_full() {
                let now = std::time::Instant::now();
                let is_paused = flags.is_paused.load(Ordering::Relaxed);
                if is_paused {
                    stall_since.get_or_insert(now);
                } else {
                    stall_since = None;
                }
                if should_hard_pause(
                    is_paused,
                    stall_since,
                    now,
                    Duration::from_secs(RADIO_HARD_PAUSE_SECS),
                ) {
                    let fill_pct = ((1.0
                        - prod.vacant_len() as f32 / RADIO_BUF_CAPACITY as f32)
                        * 100.0) as u32;
                    crate::app_eprintln!(
                        "[radio] hard pause: {fill_pct}% full, \
                         paused >{RADIO_HARD_PAUSE_SECS}s → disconnecting"
                    );
                    flags.is_hard_paused.store(true, Ordering::Release);
                    return; // Drop HeapProd → TCP connection released.
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue 'inner;
            }
            stall_since = None;

            // ── Read HTTP chunk ───────────────────────────────────────────────
            match byte_stream.next().await {
                Some(Ok(chunk)) => {
                    bytes_total += chunk.len() as u64;
                    // Successful data → reset consecutive-failure counter.
                    reconnect_count = 0;
                    audio_scratch.clear();

                    if let Some(ref mut interceptor) = icy {
                        if let Some(meta) = interceptor.process(&chunk, &mut audio_scratch) {
                            let label = if meta.is_ad { "[Ad]" } else { "" };
                            crate::app_eprintln!("[radio] ICY StreamTitle: {}{}", label, meta.title);
                            let _ = app.emit("radio:metadata", &meta);
                        }
                    } else {
                        audio_scratch.extend_from_slice(&chunk);
                    }

                    // Push with per-chunk back-pressure: yield 5 ms if full mid-chunk.
                    let mut offset = 0;
                    while offset < audio_scratch.len() {
                        if gen_arc.load(Ordering::SeqCst) != gen { return; }
                        let pushed = prod.push_slice(&audio_scratch[offset..]);
                        if pushed == 0 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        } else {
                            offset += pushed;
                        }
                    }
                }
                Some(Err(e)) => {
                    reconnect_count += 1;
                    crate::app_eprintln!("[radio] stream error: {e} → reconnecting (consecutive #{reconnect_count})");
                    break 'inner;
                }
                None => {
                    reconnect_count += 1;
                    crate::app_eprintln!("[radio] stream ended cleanly → reconnecting (consecutive #{reconnect_count})");
                    break 'inner;
                }
            }
        } // 'inner

        // Do NOT swap the ring buffer here.  The remaining bytes in the buffer
        // are still valid audio and will drain naturally during reconnect.
        // Clearing it would cause an immediate underrun/glitch.
        // The buffer is kept small (RADIO_BUF_CAPACITY) so stale audio drains
        // within a few seconds rather than minutes.
    } // 'outer

    crate::app_eprintln!("[radio] download task done ({bytes_total} B total)");
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_icy_metaint_from_headers ────────────────────────────────────────

    fn make_headers(pairs: &[(&str, &str)]) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                reqwest::header::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn icy_metaint_parses_valid_integer() {
        let h = make_headers(&[("icy-metaint", "16384")]);
        assert_eq!(parse_icy_metaint_from_headers(&h), Some(16384));
    }

    #[test]
    fn icy_metaint_returns_none_when_header_absent() {
        let h = make_headers(&[]);
        assert!(parse_icy_metaint_from_headers(&h).is_none());
    }

    #[test]
    fn icy_metaint_returns_none_for_non_numeric_value() {
        let h = make_headers(&[("icy-metaint", "not-a-number")]);
        assert!(parse_icy_metaint_from_headers(&h).is_none());
    }

    #[test]
    fn icy_metaint_returns_none_for_empty_string() {
        let h = make_headers(&[("icy-metaint", "")]);
        assert!(parse_icy_metaint_from_headers(&h).is_none());
    }

    // ── should_hard_pause ─────────────────────────────────────────────────────

    #[test]
    fn hard_pause_false_when_not_paused() {
        let now = std::time::Instant::now();
        let stalled = now - Duration::from_secs(60);
        // Not paused → never disconnect even after long stalls.
        assert!(!should_hard_pause(false, Some(stalled), now, Duration::from_secs(5)));
    }

    #[test]
    fn hard_pause_false_when_no_stall_recorded() {
        let now = std::time::Instant::now();
        // No stall recorded → no disconnect even when paused.
        assert!(!should_hard_pause(true, None, now, Duration::from_secs(5)));
    }

    #[test]
    fn hard_pause_false_when_stall_below_threshold() {
        let now = std::time::Instant::now();
        let stalled_recent = now - Duration::from_secs(2);
        assert!(!should_hard_pause(
            true,
            Some(stalled_recent),
            now,
            Duration::from_secs(5)
        ));
    }

    #[test]
    fn hard_pause_true_when_paused_and_stall_at_or_past_threshold() {
        let now = std::time::Instant::now();
        let stalled_long = now - Duration::from_secs(10);
        assert!(should_hard_pause(
            true,
            Some(stalled_long),
            now,
            Duration::from_secs(5)
        ));
    }

    #[test]
    fn hard_pause_inclusive_at_exact_threshold() {
        let now = std::time::Instant::now();
        let stalled_exact = now - Duration::from_secs(5);
        // `>= threshold` — exactly at threshold counts.
        assert!(should_hard_pause(
            true,
            Some(stalled_exact),
            now,
            Duration::from_secs(5)
        ));
    }
}

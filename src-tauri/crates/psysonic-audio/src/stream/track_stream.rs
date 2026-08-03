//! One-shot HTTP downloader for non-ranged track streaming.
//!
//! Pushes response chunks into an SPSC ring buffer consumed by `AudioStreamReader`.
//! Terminates when:
//! - generation changes (track superseded),
//! - response stream ends, or
//! - response emits an error.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use ringbuf::HeapProd;
use ringbuf::traits::Producer;
use tauri::AppHandle;

use super::super::engine::PlaybackHttpHeaders;
use super::super::state::PreloadedTrack;
use super::{
    AnalysisSeedHoldGuard, TRACK_STREAM_MAX_RECONNECTS, TRACK_STREAM_PROMOTE_MAX_BYTES,
    maybe_arm_stream_playback,
};

fn finish_legacy_stream_download(
    completed: Option<PreloadedTrack>,
    promote_cache_slot: &Mutex<Option<PreloadedTrack>>,
    playback_armed: &AtomicBool,
    done: &AtomicBool,
    after_publish: impl FnOnce(),
) {
    if let Some(completed) = completed {
        *promote_cache_slot.lock().unwrap() = Some(completed);
    }
    playback_armed.store(true, Ordering::SeqCst);
    done.store(true, Ordering::SeqCst);
    after_publish();
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn track_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_client: reqwest::Client,
    app: AppHandle,
    url: String,
    initial_response: reqwest::Response,
    mut prod: HeapProd<u8>,
    done: Arc<AtomicBool>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
    cache_track_id: Option<String>,
    // Playback server scope for the analysis-cache write key (empty/`None` → legacy '').
    server_id: Option<String>,
    _analysis_seed_hold: Option<AnalysisSeedHoldGuard>,
    http_headers: PlaybackHttpHeaders,
    playback_armed: Arc<AtomicBool>,
) {
    let mut downloaded: u64 = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let mut capture: Vec<u8> = Vec::new();
    let mut capture_over_limit = false;
    'outer: loop {
        let response = if let Some(r) = next_response.take() {
            r
        } else {
            let mut req = http_client.get(&url);
            if downloaded > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            }
            req = http_headers.apply(&url, req);
            match req.send().await {
                Ok(r) => r,
                Err(err) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] streaming reconnect failed after {} attempts: {}",
                            reconnects, err
                        );
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    reconnects += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue 'outer;
                }
            }
        };
        if downloaded > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            crate::app_eprintln!(
                "[audio] streaming reconnect returned {}, expected 206 for range resume",
                response.status()
            );
            done.store(true, Ordering::SeqCst);
            return;
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] streaming HTTP {}", response.status());
            done.store(true, Ordering::SeqCst);
            return;
        }

        let mut byte_stream = response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            if gen_arc.load(Ordering::SeqCst) != gen {
                crate::app_deprintln!(
                    "[stream] track-stream dl superseded by skip: track_id={:?} gen={}→{}",
                    cache_track_id, gen, gen_arc.load(Ordering::SeqCst)
                );
                done.store(true, Ordering::SeqCst);
                return;
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] streaming download error after {} reconnects: {}",
                            reconnects, e
                        );
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    reconnects += 1;
                    crate::app_eprintln!(
                        "[audio] streaming download error (attempt {}/{}): {} — reconnecting",
                        reconnects,
                        TRACK_STREAM_MAX_RECONNECTS,
                        e
                    );
                    next_response = None;
                    continue 'outer;
                }
            };
            reconnects = 0;
            let mut offset = 0;
            while offset < chunk.len() {
                if gen_arc.load(Ordering::SeqCst) != gen {
                    done.store(true, Ordering::SeqCst);
                    return;
                }
                let pushed = prod.push_slice(&chunk[offset..]);
                if pushed == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                } else {
                    if !capture_over_limit {
                        if capture.len().saturating_add(pushed) <= TRACK_STREAM_PROMOTE_MAX_BYTES {
                            let from = offset;
                            let to = offset + pushed;
                            capture.extend_from_slice(&chunk[from..to]);
                        } else {
                            capture.clear();
                            capture_over_limit = true;
                        }
                    }
                    offset += pushed;
                    downloaded += pushed as u64;
                    maybe_arm_stream_playback(downloaded, &playback_armed);
                }
            }
        }
        let (completed, analysis_capture) = if !capture_over_limit && !capture.is_empty() {
            if gen_arc.load(Ordering::SeqCst) != gen {
                done.store(true, Ordering::SeqCst);
                return;
            }
            let analysis_capture = cache_track_id.as_ref().map(|_| capture.clone());
            (
                Some(PreloadedTrack {
                    url: url.clone(),
                    data: capture,
                }),
                analysis_capture,
            )
        } else {
            (None, None)
        };
        finish_legacy_stream_download(
            completed,
            &promote_cache_slot,
            &playback_armed,
            &done,
            || {
                if let (Some(track_id), Some(capture)) = (cache_track_id, analysis_capture) {
                    crate::app_deprintln!(
                        "[stream] legacy stream: capture complete track_id={} capture_mib={:.2} — full-track analysis (cpu-seed queue)",
                        track_id,
                        capture.len() as f64 / (1024.0 * 1024.0)
                    );
                    let sid = crate::analysis_dispatch::resolve_server_id_for_app(
                        &app,
                        server_id.as_deref(),
                    );
                    let priority = crate::analysis_dispatch::analysis_priority_for_app(
                        &app, &sid, &track_id, None,
                    );
                    crate::analysis_dispatch::spawn_track_analysis_bytes(
                        app,
                        crate::analysis_dispatch::TrackAnalysisOrigin::StreamDownloadComplete,
                        sid,
                        track_id,
                        capture,
                        Some(url),
                        priority,
                        Some((gen, gen_arc)),
                    );
                }
            },
        );
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_publishes_before_analysis_callback() {
        let body = vec![0xAB; 2048];
        let done = Arc::new(AtomicBool::new(false));
        let completed = Arc::new(Mutex::new(None));
        let playback_armed = Arc::new(AtomicBool::new(false));
        let analysis_started = AtomicBool::new(false);

        finish_legacy_stream_download(
            Some(PreloadedTrack {
                url: "https://example.test/stream".to_string(),
                data: body.clone(),
            }),
            &completed,
            &playback_armed,
            &done,
            || {
                let completed = completed.lock().unwrap();
                assert_eq!(completed.as_ref().unwrap().data, body);
                assert!(playback_armed.load(Ordering::SeqCst));
                assert!(done.load(Ordering::SeqCst));
                analysis_started.store(true, Ordering::SeqCst);
            },
        );

        assert!(analysis_started.load(Ordering::SeqCst));
        assert!(done.load(Ordering::SeqCst));
        assert!(playback_armed.load(Ordering::SeqCst));
    }
}

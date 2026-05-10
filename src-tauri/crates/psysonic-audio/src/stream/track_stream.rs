//! One-shot HTTP downloader for non-ranged track streaming.
//!
//! Pushes response chunks into an SPSC ring buffer consumed by `AudioStreamReader`.
//! Terminates when:
//! - generation changes (track superseded),
//! - response stream ends, or
//! - response emits an error.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use ringbuf::HeapProd;
use ringbuf::traits::Producer;
use tauri::AppHandle;

use super::super::state::PreloadedTrack;
use super::{TRACK_STREAM_MAX_RECONNECTS, TRACK_STREAM_PROMOTE_MAX_BYTES};

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
    normalization_engine: Arc<AtomicU32>,
    normalization_target_lufs: Arc<AtomicU32>,
    loudness_pre_analysis_attenuation_db: Arc<AtomicU32>,
    cache_track_id: Option<String>,
) {
    let mut downloaded: u64 = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let mut capture: Vec<u8> = Vec::new();
    let mut capture_over_limit = false;
    let mut last_partial_loudness_emit = Instant::now() - Duration::from_secs(5);
    'outer: loop {
        let response = if let Some(r) = next_response.take() {
            r
        } else {
            let mut req = http_client.get(&url);
            if downloaded > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            }
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
                    if !capture_over_limit
                        && last_partial_loudness_emit.elapsed() >= Duration::from_millis(crate::helpers::PARTIAL_LOUDNESS_EMIT_INTERVAL_MS)
                    {
                        last_partial_loudness_emit = Instant::now();
                        if normalization_engine.load(Ordering::Relaxed) == 2 {
                            let target_lufs = f32::from_bits(normalization_target_lufs.load(Ordering::Relaxed));
                            let pre_db = f32::from_bits(
                                loudness_pre_analysis_attenuation_db.load(Ordering::Relaxed),
                            )
                            .clamp(-24.0, 0.0);
                            crate::helpers::emit_partial_loudness_from_bytes(&app, &url, &capture, target_lufs, pre_db);
                        }
                    }
                    offset += pushed;
                    downloaded += pushed as u64;
                }
            }
        }
        if !capture_over_limit && !capture.is_empty() {
            if gen_arc.load(Ordering::SeqCst) != gen {
                done.store(true, Ordering::SeqCst);
                return;
            }
            if let Some(track_id) = cache_track_id {
                crate::app_deprintln!(
                    "[stream] legacy stream: capture complete track_id={} capture_mib={:.2} — full-track analysis (cpu-seed queue)",
                    track_id,
                    capture.len() as f64 / (1024.0 * 1024.0)
                );
                let high = crate::engine::analysis_seed_high_priority_for_track(&app, &track_id);
                if let Err(e) =
                    psysonic_analysis::analysis_runtime::submit_analysis_cpu_seed(app.clone(), track_id.clone(), capture.clone(), high).await
                {
                    crate::app_eprintln!("[analysis] track seed failed for {}: {}", track_id, e);
                }
            }
            if gen_arc.load(Ordering::SeqCst) != gen {
                done.store(true, Ordering::SeqCst);
                return;
            }
            *promote_cache_slot.lock().unwrap() = Some(PreloadedTrack {
                url: url.clone(),
                data: capture,
            });
        }
        done.store(true, Ordering::SeqCst);
        return;
    }
}

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
use ringbuf::traits::{Observer, Producer};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

use super::super::engine::PlaybackHttpHeaders;
use super::super::helpers::{install_stream_completed_spill_if, stream_spill_file_paths};
use super::super::state::{PreloadedTrack, StreamCompletedSpill};
use super::{
    AnalysisSeedHoldGuard, TRACK_STREAM_MAX_RECONNECTS, TRACK_STREAM_PROMOTE_MAX_BYTES,
    StreamDownloadControl, maybe_arm_stream_playback,
};

struct LegacySpillCapture {
    file: Option<tokio::fs::File>,
    part_path: std::path::PathBuf,
    final_path: std::path::PathBuf,
    track_id: String,
}

impl LegacySpillCapture {
    async fn start(
        app: &AppHandle,
        track_id: &str,
        spill_key: &str,
        buffered: &[u8],
        next: &[u8],
    ) -> Result<Self, String> {
        let (final_path, part_path) = stream_spill_file_paths(app, spill_key)?;
        let mut file = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| e.to_string())?;
        if let Err(e) = file.write_all(buffered).await {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e.to_string());
        }
        if let Err(e) = file.write_all(next).await {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e.to_string());
        }
        Ok(Self {
            file: Some(file),
            part_path,
            final_path,
            track_id: track_id.to_string(),
        })
    }

    async fn finish(mut self) -> Result<(String, std::path::PathBuf), String> {
        if let Some(mut file) = self.file.take() {
            file.flush().await.map_err(|e| e.to_string())?;
        }
        if self.final_path.exists() {
            let _ = tokio::fs::remove_file(&self.final_path).await;
        }
        tokio::fs::rename(&self.part_path, &self.final_path)
            .await
            .map_err(|e| e.to_string())?;
        Ok((self.track_id.clone(), self.final_path.clone()))
    }
}

impl Drop for LegacySpillCapture {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.part_path);
    }
}

fn finish_legacy_stream_download(
    completed: Option<PreloadedTrack>,
    promote_cache_slot: &Mutex<Option<PreloadedTrack>>,
    download_control: &StreamDownloadControl,
    gen: u64,
    gen_arc: &AtomicU64,
    playback_armed: &AtomicBool,
) -> bool {
    let run_after_publish = if let Some(completed) = completed {
        let mut slot = promote_cache_slot.lock().unwrap();
        if gen_arc.load(Ordering::SeqCst) == gen && !download_control.fallback_succeeded() {
            *slot = Some(completed);
            true
        } else {
            false
        }
    } else {
        true
    };
    playback_armed.store(true, Ordering::SeqCst);
    download_control.done.store(true, Ordering::SeqCst);
    run_after_publish
}

fn push_slice_or_skip_closed_consumer(prod: &mut HeapProd<u8>, bytes: &[u8]) -> (usize, bool) {
    if prod.read_is_held() {
        (prod.push_slice(bytes), true)
    } else {
        // Decoder setup failed and dropped the consumer. Keep downloading into
        // the bounded capture so the full-buffer retry and Hot Cache can reuse it.
        (bytes.len(), false)
    }
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
    download_control: Arc<StreamDownloadControl>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
    spill_cache_slot: Arc<Mutex<Option<StreamCompletedSpill>>>,
    cache_track_id: Option<String>,
    // Playback server scope for the analysis-cache write key (empty/`None` → legacy '').
    server_id: Option<String>,
    analysis_seed_hold: Option<AnalysisSeedHoldGuard>,
    http_headers: PlaybackHttpHeaders,
    playback_armed: Arc<AtomicBool>,
) {
    let done = download_control.done.clone();
    let mut downloaded: u64 = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let mut capture: Vec<u8> = Vec::new();
    let mut capture_over_limit = false;
    let mut spill_capture: Option<LegacySpillCapture> = None;
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
                        download_control.mark_ended_without_reusable_bytes();
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
            download_control.mark_ended_without_reusable_bytes();
            return;
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] streaming HTTP {}", response.status());
            download_control.mark_ended_without_reusable_bytes();
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
                        download_control.mark_ended_without_reusable_bytes();
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
                let (pushed, consumer_active) =
                    push_slice_or_skip_closed_consumer(&mut prod, &chunk[offset..]);
                if pushed == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                } else {
                    let from = offset;
                    let to = offset + pushed;
                    let pushed_bytes = &chunk[from..to];
                    if let Some(spill) = spill_capture.as_mut() {
                        if let Some(file) = spill.file.as_mut() {
                            if let Err(e) = file.write_all(pushed_bytes).await {
                                crate::app_eprintln!(
                                    "[stream] legacy spill append failed track_id={:?}: {}",
                                    cache_track_id,
                                    e
                                );
                                spill_capture = None;
                            }
                        }
                    } else if !capture_over_limit {
                        if capture.len().saturating_add(pushed)
                            <= TRACK_STREAM_PROMOTE_MAX_BYTES
                        {
                            capture.extend_from_slice(pushed_bytes);
                        } else {
                            if let Some(track_id) = cache_track_id.as_deref() {
                                match LegacySpillCapture::start(
                                    &app,
                                    track_id,
                                    &format!("{track_id}-legacy-{gen}"),
                                    &capture,
                                    pushed_bytes,
                                )
                                .await
                                {
                                    Ok(spill) => {
                                        crate::app_deprintln!(
                                            "[stream] legacy stream exceeded RAM capture cap — spilling track_id={track_id}"
                                        );
                                        spill_capture = Some(spill);
                                    }
                                    Err(e) => crate::app_eprintln!(
                                        "[stream] legacy spill start failed track_id={track_id}: {e}"
                                    ),
                                }
                            }
                            capture.clear();
                            capture_over_limit = true;
                        }
                    }
                    offset += pushed;
                    downloaded += pushed as u64;
                    if consumer_active {
                        maybe_arm_stream_playback(downloaded, &playback_armed);
                    }
                }
            }
        }
        let completed_spill = match spill_capture.take() {
            Some(spill) => match spill.finish().await {
                Ok(completed) => Some(completed),
                Err(e) => {
                    crate::app_eprintln!("[stream] legacy spill finalize failed: {e}");
                    None
                }
            },
            None => None,
        };
        if let Some((track_id, path)) = completed_spill {
            if gen_arc.load(Ordering::SeqCst) != gen {
                let _ = tokio::fs::remove_file(path).await;
                done.store(true, Ordering::SeqCst);
                return;
            }
            crate::app_deprintln!(
                "[stream] legacy stream spilled to disk track_id={} size_mib={:.2} path={}",
                track_id,
                downloaded as f64 / (1024.0 * 1024.0),
                path.display()
            );
            let prepared_file = crate::analysis_dispatch::prepare_track_analysis_file(
                crate::analysis_dispatch::TrackAnalysisOrigin::StreamSpillFile,
                &track_id,
                &path,
            );
            if !install_stream_completed_spill_if(
                &spill_cache_slot,
                url.clone(),
                path.clone(),
                || {
                    gen_arc.load(Ordering::SeqCst) == gen
                        && !download_control.fallback_succeeded()
                },
            ) {
                done.store(true, Ordering::SeqCst);
                return;
            }
            let analysis_gen_arc = gen_arc.clone();
            let published = finish_legacy_stream_download(
                None,
                &promote_cache_slot,
                &download_control,
                gen,
                &gen_arc,
                &playback_armed,
            );
            if published && download_control.downloader_analysis_selected().await {
                if let Some(prepared_file) = prepared_file {
                    let sid = crate::analysis_dispatch::resolve_server_id_for_app(
                        &app,
                        server_id.as_deref(),
                    );
                    let priority = crate::analysis_dispatch::analysis_priority_for_app(
                        &app, &sid, &track_id, None,
                    );
                    crate::analysis_dispatch::spawn_track_analysis_prepared_file(
                        app,
                        crate::analysis_dispatch::TrackAnalysisOrigin::StreamSpillFile,
                        sid,
                        track_id,
                        prepared_file,
                        Some(url),
                        priority,
                        Some((gen, analysis_gen_arc)),
                        analysis_seed_hold,
                    );
                }
            }
            return;
        }
        if download_control.fallback_succeeded() {
            done.store(true, Ordering::SeqCst);
            return;
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
        if completed.is_none() {
            download_control.mark_ended_without_reusable_bytes();
        }
        let analysis_gen_arc = gen_arc.clone();
        let published = finish_legacy_stream_download(
            completed,
            &promote_cache_slot,
            &download_control,
            gen,
            &gen_arc,
            &playback_armed,
        );
        if published {
            if let (Some(track_id), Some(capture)) = (cache_track_id, analysis_capture) {
                if download_control.downloader_analysis_selected().await {
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
                        Some((gen, analysis_gen_arc)),
                        analysis_seed_hold,
                    );
                }
            }
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::HeapRb;
    use ringbuf::traits::Split;

    #[test]
    fn closed_consumer_advances_without_filling_the_ring() {
        let rb = HeapRb::<u8>::new(8);
        let (mut prod, cons) = rb.split();
        drop(cons);

        let (advanced, consumer_active) =
            push_slice_or_skip_closed_consumer(&mut prod, &[1, 2, 3, 4]);
        assert_eq!(advanced, 4);
        assert!(!consumer_active);
        assert_eq!(prod.occupied_len(), 0);
    }

    #[test]
    fn completion_publishes_before_analysis_callback() {
        let body = vec![0xAB; 2048];
        let download_control = StreamDownloadControl::new();
        let done = download_control.done.clone();
        let completed = Arc::new(Mutex::new(None));
        let playback_armed = Arc::new(AtomicBool::new(false));
        let analysis_started = AtomicBool::new(false);
        let generation = AtomicU64::new(7);

        let published = finish_legacy_stream_download(
            Some(PreloadedTrack {
                url: "https://example.test/stream".to_string(),
                data: body.clone(),
            }),
            &completed,
            &download_control,
            7,
            &generation,
            &playback_armed,
        );
        if published {
            let completed = completed.lock().unwrap();
            assert_eq!(completed.as_ref().unwrap().data, body);
            assert!(playback_armed.load(Ordering::SeqCst));
            assert!(done.load(Ordering::SeqCst));
            analysis_started.store(true, Ordering::SeqCst);
        }

        assert!(analysis_started.load(Ordering::SeqCst));
        assert!(done.load(Ordering::SeqCst));
        assert!(playback_armed.load(Ordering::SeqCst));
    }
}

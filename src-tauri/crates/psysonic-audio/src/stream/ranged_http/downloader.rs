use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::mp4_tail::ranged_prefetch_mp4_tail;
use super::range_task::{ranged_http_download_loop, RangedHttpLoopOutcome};
use crate::analysis_dispatch::{
    analysis_priority_for_app, dispatch_track_analysis_bytes, prepare_track_analysis_file,
    resolve_server_id_for_app, spawn_track_analysis_prepared_file, TrackAnalysisDispatchOptions,
    TrackAnalysisOrigin,
};
use crate::engine::PlaybackHttpHeaders;
use crate::helpers::{install_stream_completed_spill_if, write_stream_spill_file};
use crate::state::{PreloadedTrack, StreamCompletedSpill};
use crate::stream::{AnalysisSeedHoldGuard, StreamDownloadControl, TRACK_STREAM_PROMOTE_MAX_BYTES};

/// Linear downloader for `RangedHttpSource`: fills the pre-allocated buffer
/// from offset 0 to total_size. Reconnects via HTTP Range from the current
/// `downloaded` offset on transient errors. On completion (full track) the
/// data is promoted to `stream_completed_cache` (≤ 64 MiB) or spilled to disk for hot cache.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn ranged_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_client: reqwest::Client,
    app: AppHandle,
    _duration_hint: f64,
    url: String,
    initial_response: reqwest::Response,
    buf: Arc<Mutex<Vec<u8>>>,
    downloaded_to: Arc<AtomicUsize>,
    download_control: Arc<StreamDownloadControl>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
    spill_cache_slot: Arc<Mutex<Option<StreamCompletedSpill>>>,
    normalization_engine: Arc<AtomicU32>,
    normalization_target_lufs: Arc<AtomicU32>,
    loudness_pre_analysis_attenuation_db: Arc<AtomicU32>,
    cache_track_id: Option<String>,
    // Playback server scope for the analysis-cache write key (empty/`None` → legacy '').
    server_id: Option<String>,
    needs_partial_loudness: bool,
    http_headers: PlaybackHttpHeaders,
    // Armed synchronously before this task is spawned so frontend refresh cannot
    // race a duplicate HTTP backfill ahead of the downloader.
    mut analysis_seed_hold: Option<AnalysisSeedHoldGuard>,
    playback_armed: Arc<AtomicBool>,
    format_hint: Option<String>,
    tail_ready: Arc<AtomicBool>,
    tail_filled_from: Arc<AtomicU64>,
) {
    let done = download_control.done.clone();
    let total_size = buf.lock().unwrap().len();
    let dl_started = Instant::now();
    let mut last_partial_loudness_emit = Instant::now() - Duration::from_secs(5);
    let url_for_emit = url.clone();
    let app_for_emit = app.clone();
    let server_id_for_emit = resolve_server_id_for_app(&app, server_id.as_deref());

    crate::app_deprintln!(
        "[stream] ranged dl start: total={} KiB (~{:.2} MiB)",
        total_size.saturating_div(1024),
        total_size as f64 / (1024.0 * 1024.0)
    );

    let on_partial = |downloaded: usize, total: usize| {
        if !needs_partial_loudness
            || downloaded < crate::helpers::PARTIAL_LOUDNESS_MIN_BYTES
            || total == 0
            || last_partial_loudness_emit.elapsed()
                < Duration::from_millis(crate::helpers::PARTIAL_LOUDNESS_EMIT_INTERVAL_MS)
        {
            return;
        }
        last_partial_loudness_emit = Instant::now();
        if normalization_engine.load(Ordering::Relaxed) != 2 {
            return;
        }
        let target_lufs = f32::from_bits(normalization_target_lufs.load(Ordering::Relaxed));
        let start_db = f32::from_bits(loudness_pre_analysis_attenuation_db.load(Ordering::Relaxed))
            .clamp(-24.0, 0.0);
        let Some(provisional_db) = crate::helpers::provisional_loudness_gain_from_progress(
            downloaded,
            total,
            target_lufs,
            start_db,
        ) else {
            return;
        };
        let track_key = crate::helpers::playback_identity(&url_for_emit)
            .unwrap_or_else(|| url_for_emit.clone());
        if !crate::ipc::partial_loudness_should_emit(&track_key, gen, provisional_db) {
            return;
        }
        let _ = app_for_emit.emit(
            "analysis:loudness-partial",
            crate::ipc::PartialLoudnessPayload {
                track_id: crate::helpers::playback_identity(&url_for_emit),
                server_index_key: (!server_id_for_emit.is_empty())
                    .then_some(server_id_for_emit.clone()),
                gain_db: provisional_db,
                target_lufs,
                is_partial: true,
            },
        );
    };

    let tail_prefetch = crate::stream::mp4::mp4_needs_tail_prefetch(&[], format_hint.as_deref());
    let tail_handle = if tail_prefetch {
        let client = http_client.clone();
        let url_tail = url.clone();
        let buf_tail = buf.clone();
        let tail_ready_bg = tail_ready.clone();
        let tail_from_bg = tail_filled_from.clone();
        let armed_bg = playback_armed.clone();
        let gen_bg = gen_arc.clone();
        let headers_bg = http_headers.clone();
        Some(tokio::spawn(async move {
            ranged_prefetch_mp4_tail(
                client,
                url_tail,
                buf_tail,
                total_size,
                tail_ready_bg,
                tail_from_bg,
                armed_bg,
                gen,
                gen_bg,
                headers_bg,
            )
            .await;
        }))
    } else {
        None
    };

    let linear_arm = if tail_prefetch {
        None
    } else {
        Some(playback_armed.as_ref())
    };
    let (downloaded, outcome) = ranged_http_download_loop(
        http_client,
        &url,
        initial_response,
        &buf,
        &downloaded_to,
        gen,
        &gen_arc,
        &http_headers,
        on_partial,
        linear_arm,
    )
    .await;

    if let Some(handle) = tail_handle {
        let _ = handle.await;
    }

    playback_armed.store(true, Ordering::SeqCst);
    done.store(true, Ordering::SeqCst);

    if matches!(outcome, RangedHttpLoopOutcome::Superseded) {
        return;
    }
    if download_control.fallback_succeeded() {
        return;
    }

    if downloaded < total_size {
        crate::app_eprintln!(
            "[stream] ranged dl ABORTED: {} / {} bytes in {:.2}s (track_id={:?})",
            downloaded,
            total_size,
            dl_started.elapsed().as_secs_f64(),
            cache_track_id
        );
        download_control.mark_ended_without_reusable_bytes();
        return;
    } else {
        crate::app_deprintln!(
            "[stream] dl done: {} / {} bytes in {:.2}s",
            downloaded,
            total_size,
            dl_started.elapsed().as_secs_f64()
        );
    }

    if downloaded == total_size && total_size > 0 {
        if total_size <= TRACK_STREAM_PROMOTE_MAX_BYTES {
            let invalid_mp4 = if crate::stream::container_hint_is_mp4(format_hint.as_deref()) {
                let guard = buf.lock().unwrap();
                if !crate::stream::isobmff_buffer_looks_complete(&guard) {
                    crate::stream::log_isobmff_buffer_diagnostic(
                        &guard,
                        format_hint.as_deref(),
                        "ranged-dl-complete-incomplete",
                    );
                    true
                } else if crate::stream::mp4_suspect_zero_holes(&guard) {
                    crate::stream::log_isobmff_buffer_diagnostic(
                        &guard,
                        format_hint.as_deref(),
                        "ranged-dl-complete-zero-holes",
                    );
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if invalid_mp4 {
                download_control.mark_ended_without_reusable_bytes();
                return;
            }
            if let Some(ref tid) = cache_track_id {
                crate::app_deprintln!(
                    "[stream] ranged: HTTP buffer full track_id={} size_mib={:.2} — cloning {} bytes then full-track analysis (cpu-seed queue; this task awaits completion)",
                    tid,
                    total_size as f64 / (1024.0 * 1024.0),
                    total_size
                );
            }
            let t_clone = Instant::now();
            let data = buf.lock().unwrap().clone();
            if total_size > 32 * 1024 * 1024 {
                crate::app_deprintln!(
                    "[stream] ranged: buffer cloned in_ms={}",
                    t_clone.elapsed().as_millis()
                );
            }
            let analysis_input = cache_track_id
                .clone()
                .map(|track_id| (track_id, data.clone()));
            {
                let mut slot = promote_cache_slot.lock().unwrap();
                if gen_arc.load(Ordering::SeqCst) != gen || download_control.fallback_succeeded() {
                    return;
                }
                *slot = Some(PreloadedTrack {
                    url: url.clone(),
                    data,
                });
            }
            crate::app_deprintln!("[stream] promoted to stream_completed_cache for replay");
            if let Some((track_id, analysis_data)) = analysis_input {
                if !download_control.downloader_analysis_selected().await {
                    return;
                }
                let sid = resolve_server_id_for_app(&app, server_id.as_deref());
                let priority = analysis_priority_for_app(&app, &sid, &track_id, None);
                let guard = (gen, gen_arc.clone());
                match dispatch_track_analysis_bytes(
                    &app,
                    TrackAnalysisOrigin::StreamDownloadComplete,
                    &sid,
                    &track_id,
                    analysis_data,
                    Some(&url),
                    TrackAnalysisDispatchOptions {
                        priority,
                        generation_guard: Some(&guard),
                    },
                )
                .await
                {
                    Ok(_) => {}
                    Err(e) => {
                        crate::app_eprintln!("[analysis] ranged seed failed for {track_id}: {e}");
                    }
                }
            }
        } else if let Some(track_id) = cache_track_id.clone() {
            if gen_arc.load(Ordering::SeqCst) != gen {
                return;
            }
            let spill_result = {
                let spill_bytes = buf.lock().unwrap();
                if gen_arc.load(Ordering::SeqCst) != gen {
                    return;
                }
                write_stream_spill_file(&app, &format!("{track_id}-ranged-{gen}"), &spill_bytes)
            };
            match spill_result {
                Ok(path) => {
                    crate::app_deprintln!(
                        "[stream] ranged: spilled to disk track_id={} size_mib={:.2} path={}",
                        track_id,
                        total_size as f64 / (1024.0 * 1024.0),
                        path.display()
                    );
                    if gen_arc.load(Ordering::SeqCst) != gen {
                        let _ = std::fs::remove_file(&path);
                        return;
                    }
                    let prepared_file = prepare_track_analysis_file(
                        TrackAnalysisOrigin::StreamSpillFile,
                        &track_id,
                        &path,
                    );
                    let spill_stream_url = url.clone();
                    if !install_stream_completed_spill_if(
                        &spill_cache_slot,
                        url,
                        path.clone(),
                        || {
                            gen_arc.load(Ordering::SeqCst) == gen
                                && !download_control.fallback_succeeded()
                        },
                    ) {
                        return;
                    }
                    let sid = resolve_server_id_for_app(&app, server_id.as_deref());
                    let priority = analysis_priority_for_app(&app, &sid, &track_id, None);
                    if download_control.downloader_analysis_selected().await {
                        if let Some(prepared_file) = prepared_file {
                            spawn_track_analysis_prepared_file(
                                app.clone(),
                                TrackAnalysisOrigin::StreamSpillFile,
                                sid,
                                track_id,
                                prepared_file,
                                Some(spill_stream_url), // spilled HTTP bytes keep stream provenance
                                priority,
                                Some((gen, gen_arc.clone())),
                                analysis_seed_hold.take(),
                            );
                        }
                    }
                }
                Err(e) => {
                    crate::app_eprintln!(
                        "[stream] ranged: spill write failed track_id={}: {}",
                        track_id,
                        e
                    );
                    download_control.mark_ended_without_reusable_bytes();
                }
            }
        } else {
            download_control.mark_ended_without_reusable_bytes();
        }
    }
}

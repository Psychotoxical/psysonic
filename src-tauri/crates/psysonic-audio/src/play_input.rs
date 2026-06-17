//! Source-selection logic for `audio_play`: given a URL + various caches +
//! Subsonic hints, decide whether to play from in-memory bytes, a seekable
//! local file, a seekable RangedHttpSource, or a non-seekable streaming reader.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ringbuf::traits::Split;
use ringbuf::{HeapCons, HeapRb};
use symphonia::core::io::MediaSource;
use tauri::{AppHandle, Emitter, State};

use super::analysis_dispatch::{
    prepare_playback_analysis, spawn_track_analysis_bytes, spawn_track_analysis_file,
    TrackAnalysisOrigin,
};
use super::engine::{audio_http_client, AudioEngine};
use super::helpers::{
    content_type_to_hint, fetch_data, format_hint_from_content_disposition,
    normalize_stream_suffix_for_hint, sniff_stream_format_extension,
    same_playback_target,
    STREAM_FORMAT_SNIFF_PROBE_BYTES,
};
use super::stream::{
    ranged_download_task, track_download_task, AudioStreamReader,
    LocalFileSource, RangedHttpSource,
    TRACK_READ_TIMEOUT_SECS, TRACK_STREAM_MAX_BUF_CAPACITY, TRACK_STREAM_MIN_BUF_CAPACITY,
};

/// What `audio_play` will hand to `build_source` / `build_streaming_source`.
pub(crate) enum PlayInput {
    Bytes(Vec<u8>),
    /// Seekable on-demand source — `RangedHttpSource` for HTTP streams,
    /// `LocalFileSource` for `psysonic-local://` files. Goes through
    /// `build_streaming_source` (no iTunSMPB scan, since we don't have the
    /// bytes in memory; chained-track gapless trim still applies via the
    /// re-played `Bytes` path on the next start).
    SeekableMedia {
        reader: Box<dyn MediaSource>,
        format_hint: Option<String>,
        tag: &'static str,
        /// Source can cheaply seek to EOF (local file). Drives whether Ogg keeps
        /// seekability through the probe so its seek path does not panic.
        random_access: bool,
        /// When set, Symphonia probe waits for moov (tail or fast-start prefix).
        mp4_probe_gate: Option<super::stream::RangedMp4ProbeGate>,
    },
    Streaming {
        reader: AudioStreamReader,
        format_hint: Option<String>,
    },
}

/// Inputs `audio_play` has already computed before source selection.
pub(super) struct PlayInputContext<'a> {
    pub url: &'a str,
    pub gen: u64,
    pub duration_hint: f64,
    pub stream_format_suffix: Option<&'a str>,
    pub format_hint: Option<&'a str>,
    pub cache_id_for_tasks: Option<&'a str>,
    /// Playback server scope for the analysis-cache write key (empty/`None` →
    /// legacy `''`). Rides alongside `cache_id_for_tasks` into every seed path.
    pub server_id: Option<&'a str>,
    /// `Some(bytes)` when manual-skip onto a pre-chained track reuses bytes
    /// from the chained-info block.
    pub reuse_chained_bytes: Option<Vec<u8>>,
}

fn spawn_playback_analysis_bytes(
    app: &AppHandle,
    state: &State<'_, AudioEngine>,
    ctx: &PlayInputContext<'_>,
    origin: TrackAnalysisOrigin,
    bytes: Vec<u8>,
) {
    let Some(track_id) = ctx
        .cache_id_for_tasks
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let (sid, high) =
        prepare_playback_analysis(app, state, ctx.server_id, track_id, None);
    spawn_track_analysis_bytes(
        app.clone(),
        origin,
        sid,
        track_id.to_string(),
        bytes,
        high,
        Some((ctx.gen, state.generation.clone())),
    );
}

/// Resolves the play input for `audio_play` honouring (in priority order):
/// 1. Reused chained bytes — manual skip onto pre-chained track.
/// 2. `psysonic-local://` files — open as seekable LocalFileSource.
/// 3. Remote HTTP without preload/stream-cache hit — try ranged HTTP, fall
///    back to non-seekable AudioStreamReader.
/// 4. Preload/stream-cache hit — replay in-memory bytes via `fetch_data`.
///
/// Returns `Ok(None)` when the operation was superseded by a later
/// `audio_play` call (generation bump) — caller should bail out silently.
pub(super) async fn select_play_input(
    ctx: PlayInputContext<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<Option<PlayInput>, String> {
    if let Some(d) = ctx.reuse_chained_bytes {
        if let Some(track_id) = ctx
            .cache_id_for_tasks
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let (sid, high) =
                prepare_playback_analysis(app, state, ctx.server_id, track_id, None);
            spawn_track_analysis_bytes(
                app.clone(),
                TrackAnalysisOrigin::InMemoryReplay,
                sid,
                track_id.to_string(),
                d.clone(),
                high,
                Some((ctx.gen, state.generation.clone())),
            );
        }
        return Ok(Some(PlayInput::Bytes(d)));
    }

    let stream_cache_hit = {
        let streamed = state.stream_completed_cache.lock().unwrap();
        streamed
            .as_ref()
            .is_some_and(|p| same_playback_target(&p.url, ctx.url))
    };
    let preloaded_hit = {
        let preloaded = state.preloaded.lock().unwrap();
        preloaded
            .as_ref()
            .is_some_and(|p| same_playback_target(&p.url, ctx.url))
    };
    let is_local = ctx.url.starts_with("psysonic-local://");

    if is_local && !stream_cache_hit && !preloaded_hit {
        return Ok(Some(open_local_file_input(&ctx, state, app)?));
    }
    if !stream_cache_hit && !preloaded_hit && !is_local {
        return open_ranged_or_streaming_input(&ctx, state, app).await;
    }

    // Preloaded or stream-cache hit → replay in-memory bytes.
    let data = match fetch_data(ctx.url, state, ctx.gen, app).await? {
        Some(d) => d,
        None => return Ok(None), // superseded while downloading
    };
    spawn_playback_analysis_bytes(
        app,
        state,
        &ctx,
        TrackAnalysisOrigin::InMemoryReplay,
        data.clone(),
    );
    Ok(Some(PlayInput::Bytes(data)))
}

/// `psysonic-local://<path>` → seekable `LocalFileSource`. Spawns a
/// background CPU-seed for the analysis cache when the file is small
/// enough (skipped if the cache already has a row for this track).
fn open_local_file_input(
    ctx: &PlayInputContext<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<PlayInput, String> {
    let path = ctx.url.strip_prefix("psysonic-local://").unwrap();
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let local_hint = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    crate::app_deprintln!(
        "[stream] LocalFileSource selected — size={} KB, hint={:?}",
        len / 1024,
        local_hint
    );
    if let Some(seed_id) = ctx.cache_id_for_tasks {
        let (sid, high) =
            prepare_playback_analysis(app, state, ctx.server_id, seed_id, None);
        spawn_track_analysis_file(
            app.clone(),
            TrackAnalysisOrigin::LocalFilePlayback,
            sid,
            seed_id.to_string(),
            std::path::PathBuf::from(path),
            high,
            Some((ctx.gen, state.generation.clone())),
        );
    }
    let reader = LocalFileSource { file, len };
    Ok(PlayInput::SeekableMedia {
        reader: Box::new(reader),
        format_hint: local_hint,
        tag: "local-file",
        random_access: true,
        mp4_probe_gate: None,
    })
}

/// Manual or auto-advance starts that aren't already cached: try ranged HTTP
/// (seekable) first, fall back to a non-seekable `AudioStreamReader` if the
/// server doesn't advertise byte-range support or a length.
async fn open_ranged_or_streaming_input(
    ctx: &PlayInputContext<'_>,
    state: &State<'_, AudioEngine>,
    app: &AppHandle,
) -> Result<Option<PlayInput>, String> {
    let response = audio_http_client(state).get(ctx.url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        if state.generation.load(Ordering::SeqCst) != ctx.gen {
            return Ok(None); // superseded
        }
        let status = response.status().as_u16();
        let msg = format!("HTTP {status}");
        app.emit("audio:error", &msg).ok();
        return Err(msg);
    }

    let mut stream_hint = content_type_to_hint(
        response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    )
    .or_else(|| {
        response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|v| v.to_str().ok())
            .and_then(format_hint_from_content_disposition)
    })
    .or_else(|| normalize_stream_suffix_for_hint(ctx.stream_format_suffix))
    .or_else(|| ctx.format_hint.map(|s| s.to_string()));

    let supports_range = response.headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
    let total_size = response.content_length();

    if stream_hint.is_none() && supports_range {
        if let Some(total_u64) = total_size.filter(|&t| t > 0) {
            let last = total_u64
                .saturating_sub(1)
                .min((STREAM_FORMAT_SNIFF_PROBE_BYTES - 1) as u64);
            if let Ok(pr) = audio_http_client(state)
                .get(ctx.url)
                .header(reqwest::header::RANGE, format!("bytes=0-{last}"))
                .send()
                .await
            {
                let stat = pr.status();
                let ok = stat == reqwest::StatusCode::PARTIAL_CONTENT
                    || stat == reqwest::StatusCode::OK;
                if ok {
                    match pr.bytes().await {
                        Ok(bytes) if !bytes.is_empty() => {
                            stream_hint = sniff_stream_format_extension(&bytes).or(stream_hint);
                            if stream_hint.is_some() {
                                crate::app_deprintln!(
                                    "[stream] ranged: format sniff from {} B prefix → hint={:?}",
                                    bytes.len(),
                                    stream_hint
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if let (true, Some(total), true) = (supports_range, total_size, stream_hint.is_some()) {
        let total_usize = total as usize;
        crate::app_deprintln!(
            "[stream] RangedHttpSource selected — total={} KB, hint={:?}",
            total_usize / 1024,
            stream_hint
        );
        let buf = Arc::new(Mutex::new(vec![0u8; total_usize]));
        let downloaded_to = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        state.stream_playback_armed.store(false, Ordering::SeqCst);
        let playback_armed = state.stream_playback_armed.clone();
        let tail_ready = Arc::new(AtomicBool::new(false));
        let tail_filled_from = Arc::new(AtomicU64::new(0));
        let tail_prefetch =
            super::stream::mp4_needs_tail_prefetch(&[], stream_hint.as_deref());
        let mp4_probe_gate = tail_prefetch.then(|| super::stream::RangedMp4ProbeGate {
            tail_ready: tail_ready.clone(),
            buf: buf.clone(),
            downloaded_to: downloaded_to.clone(),
            gen_arc: state.generation.clone(),
            gen: ctx.gen,
            format_hint: stream_hint.clone(),
        });
        let loudness_hold_for_defer = (total_usize <= super::stream::TRACK_STREAM_PROMOTE_MAX_BYTES)
            .then_some(state.ranged_loudness_seed_hold.clone());
        tokio::spawn(ranged_download_task(
            ctx.gen,
            state.generation.clone(),
            audio_http_client(state),
            app.clone(),
            ctx.duration_hint,
            ctx.url.to_string(),
            response,
            buf.clone(),
            downloaded_to.clone(),
            done.clone(),
            state.stream_completed_cache.clone(),
            state.stream_completed_spill.clone(),
            state.normalization_engine.clone(),
            state.normalization_target_lufs.clone(),
            state.loudness_pre_analysis_attenuation_db.clone(),
            ctx.cache_id_for_tasks.map(|s| s.to_string()),
            ctx.server_id.map(|s| s.to_string()),
            loudness_hold_for_defer,
            playback_armed,
            stream_hint.clone(),
            tail_ready.clone(),
            tail_filled_from.clone(),
        ));
        // On-demand random-access fetcher: lets seeks (Ogg bisection, end-of-
        // stream probe, forward scrubs) pull arbitrary byte ranges over HTTP
        // Range instead of blocking until the linear filler reaches the target.
        // This is what makes seeking work on a still-downloading Opus/Ogg stream
        // (previously a contained no-op) without forcing a full pre-download.
        let on_demand = Some(Arc::new(super::stream::OnDemand::new(
            audio_http_client(state),
            tokio::runtime::Handle::current(),
            ctx.url.to_string(),
            buf.clone(),
            total,
            state.generation.clone(),
            ctx.gen,
        )));
        let reader = RangedHttpSource {
            buf,
            downloaded_to,
            tail_ready,
            tail_filled_from,
            total_size: total,
            pos: 0,
            done,
            gen_arc: state.generation.clone(),
            gen: ctx.gen,
            on_demand,
        };
        return Ok(Some(PlayInput::SeekableMedia {
            reader: Box::new(reader),
            format_hint: stream_hint,
            tag: "ranged-stream",
            // The on-demand fetcher makes a seek-to-EOF during the probe cheap,
            // so Ogg can stay seekable through the probe (records its byte range
            // → real seeking) without forcing a full download.
            random_access: true,
            mp4_probe_gate,
        }));
    }

    // Legacy non-seekable streaming reader fallback.
    crate::app_deprintln!(
        "[stream] legacy AudioStreamReader (non-seekable) — accept-ranges={}, content-length={:?}, hint={:?}",
        supports_range, total_size, stream_hint
    );
    let buffer_cap = total_size
        .map(|n| n as usize)
        .unwrap_or(TRACK_STREAM_MIN_BUF_CAPACITY)
        .clamp(TRACK_STREAM_MIN_BUF_CAPACITY, TRACK_STREAM_MAX_BUF_CAPACITY);
    let rb = HeapRb::<u8>::new(buffer_cap);
    let (prod, cons) = rb.split();
    let done = Arc::new(AtomicBool::new(false));
    state.stream_playback_armed.store(false, Ordering::SeqCst);
    let playback_armed = state.stream_playback_armed.clone();
    tokio::spawn(track_download_task(
        ctx.gen,
        state.generation.clone(),
        audio_http_client(state),
        app.clone(),
        ctx.url.to_string(),
        response,
        prod,
        done.clone(),
        state.stream_completed_cache.clone(),
        state.normalization_engine.clone(),
        state.normalization_target_lufs.clone(),
        state.loudness_pre_analysis_attenuation_db.clone(),
        ctx.cache_id_for_tasks.map(|s| s.to_string()),
        ctx.server_id.map(|s| s.to_string()),
        playback_armed,
    ));

    let (_new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapCons<u8>>();
    let reader = AudioStreamReader {
        read_timeout_secs: TRACK_READ_TIMEOUT_SECS,
        cons: Mutex::new(cons),
        new_cons_rx: Mutex::new(new_cons_rx),
        deadline: std::time::Instant::now()
            + Duration::from_secs(TRACK_READ_TIMEOUT_SECS),
        gen_arc: state.generation.clone(),
        gen: ctx.gen,
        source_tag: "track-stream",
        eof_when_empty: Some(done),
        pos: 0,
    };
    Ok(Some(PlayInput::Streaming {
        reader,
        format_hint: stream_hint,
    }))
}

/// Pulled out of the format_hint extraction block in `audio_play` — strip the
/// query string first so Subsonic-style URLs (`stream.view?...&v=1.16.1&...`)
/// don't latch onto random query-param substrings; only accept short
/// alphanumeric tails that look like an actual audio extension.
pub(crate) fn url_format_hint(url: &str) -> Option<String> {
    url.split('?').next()
        .and_then(|path| path.rsplit('.').next())
        .filter(|ext| {
            (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "mp3" | "flac" | "ogg" | "oga" | "opus" | "m4a" | "mp4"
                    | "aac" | "wav" | "wave" | "ape" | "wv" | "webm" | "mka"
                )
        })
        .map(|s| s.to_lowercase())
}

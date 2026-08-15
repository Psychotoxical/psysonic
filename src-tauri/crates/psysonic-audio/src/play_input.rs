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
use super::engine::{audio_http_client, AudioEngine, PlaybackHttpHeaders};
use super::helpers::{
    content_type_to_hint, fetch_data, format_hint_from_content_disposition,
    normalize_audio_extension_for_hint, normalize_stream_suffix_for_hint,
    sniff_stream_format_extension,
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
        download_control: Option<Arc<super::stream::StreamDownloadControl>>,
        /// Source can cheaply seek to EOF (local file). Drives whether Ogg keeps
        /// seekability through the probe so its seek path does not panic.
        random_access: bool,
        /// When set, Symphonia probe waits for moov (tail or fast-start prefix).
        mp4_probe_gate: Option<super::stream::RangedMp4ProbeGate>,
        /// The reader's own playback generation, where it has one. Lets the
        /// decoder tell a skipped track from a truncated stream at end of media.
        /// `None` for a plain local file: it cannot be superseded mid-read, so
        /// EOF with nothing decoded there really is a broken file.
        superseded: Option<super::stream::GenerationGuard>,
    },
    Streaming {
        reader: AudioStreamReader,
        format_hint: Option<String>,
        download_control: Arc<super::stream::StreamDownloadControl>,
        superseded: Option<super::stream::GenerationGuard>,
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
    /// Final loudness is absent for this playback identity, so stream progress
    /// may emit provisional gain hints while loudness mode is active.
    pub needs_partial_loudness: bool,
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
        Some(ctx.url.to_string()),
        high,
        Some((ctx.gen, state.generation.clone())),
        None,
    );
}

fn ranged_analysis_seed_hold_allowed(total_size: usize) -> bool {
    total_size <= super::stream::LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES
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
                Some(ctx.url.to_string()),
                high,
                Some((ctx.gen, state.generation.clone())),
                None,
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
            None, // genuine local file — original by definition
            high,
            Some((ctx.gen, state.generation.clone())),
            None,
        );
    }
    let reader = LocalFileSource { file, len };
    Ok(PlayInput::SeekableMedia {
        reader: Box::new(reader),
        format_hint: local_hint,
        tag: "local-file",
        download_control: None,
        random_access: true,
        mp4_probe_gate: None,
        superseded: None,
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
    let http_headers = PlaybackHttpHeaders::from_app(app, ctx.server_id);
    let response = http_headers
        .apply(ctx.url, audio_http_client(state).get(ctx.url))
        .send()
        .await
        .map_err(|e| e.to_string())?;
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
    let ranged_total_size = total_size.filter(|&total| total > 0);

    if stream_hint.is_none() && supports_range {
        if let Some(total_u64) = total_size.filter(|&t| t > 0) {
            let last = total_u64
                .saturating_sub(1)
                .min((STREAM_FORMAT_SNIFF_PROBE_BYTES - 1) as u64);
            if let Ok(pr) = http_headers
                .apply(ctx.url, audio_http_client(state).get(ctx.url))
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

    if let (true, Some(total), true) = (supports_range, ranged_total_size, stream_hint.is_some()) {
        let total_usize = total as usize;
        crate::app_deprintln!(
            "[stream] RangedHttpSource selected — total={} KB, hint={:?}",
            total_usize / 1024,
            stream_hint
        );
        let buf = Arc::new(Mutex::new(vec![0u8; total_usize]));
        let downloaded_to = Arc::new(AtomicUsize::new(0));
        let download_control = super::stream::StreamDownloadControl::new();
        let done = download_control.done.clone();
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
        let analysis_seed_hold = ranged_analysis_seed_hold_allowed(total_usize)
            .then(|| {
                super::stream::AnalysisSeedHoldGuard::arm(
                    Some(&state.playback_analysis_seed_hold),
                    ctx.cache_id_for_tasks,
                    ctx.gen,
                    &state.generation,
                )
            })
            .flatten();
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
            download_control.clone(),
            state.stream_completed_cache.clone(),
            state.stream_completed_spill.clone(),
            state.normalization_engine.clone(),
            state.normalization_target_lufs.clone(),
            state.loudness_pre_analysis_attenuation_db.clone(),
            ctx.cache_id_for_tasks.map(|s| s.to_string()),
            ctx.server_id.map(|s| s.to_string()),
            ctx.needs_partial_loudness,
            http_headers.clone(),
            analysis_seed_hold,
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
            http_headers.clone(),
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
            download_control: Some(download_control),
            superseded: Some(super::stream::GenerationGuard {
                gen: ctx.gen,
                gen_arc: state.generation.clone(),
            }),
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
    let download_control = super::stream::StreamDownloadControl::new();
    let done = download_control.done.clone();
    state.stream_playback_armed.store(false, Ordering::SeqCst);
    let playback_armed = state.stream_playback_armed.clone();
    let analysis_seed_hold = super::stream::AnalysisSeedHoldGuard::arm(
        Some(&state.playback_analysis_seed_hold),
        ctx.cache_id_for_tasks,
        ctx.gen,
        &state.generation,
    );
    tokio::spawn(track_download_task(
        ctx.gen,
        state.generation.clone(),
        audio_http_client(state),
        app.clone(),
        ctx.url.to_string(),
        response,
        prod,
        download_control.clone(),
        state.stream_completed_cache.clone(),
        state.stream_completed_spill.clone(),
        ctx.cache_id_for_tasks.map(|s| s.to_string()),
        ctx.server_id.map(|s| s.to_string()),
        analysis_seed_hold,
        http_headers,
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
        download_control,
        superseded: Some(super::stream::GenerationGuard {
            gen: ctx.gen,
            gen_arc: state.generation.clone(),
        }),
    }))
}

/// Pulled out of the format_hint extraction block in `audio_play` — strip the
/// query string first so Subsonic-style URLs (`stream.view?...&v=1.16.1&...`)
/// don't latch onto random query-param substrings; only accept short
/// alphanumeric tails that look like an actual audio extension.
pub(crate) fn url_format_hint(url: &str) -> Option<String> {
    url.split('?').next()
        .and_then(|path| path.rsplit('.').next())
        .and_then(normalize_audio_extension_for_hint)
}

/// The `maxBitRate` cap (kbps) a `stream.view` URL was opened with, if any.
/// This latches the requested quality to the stream itself — the setting may
/// change while the track is still playing, but the URL records what this
/// playback generation actually asked the server for.
pub(crate) fn url_stream_cap_kbps(url: &str) -> Option<u32> {
    let query = url.split_once('?')?.1;
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k != "maxBitRate" { return None; }
        v.parse::<u32>().ok().filter(|&n| n > 0)
    })
}

#[cfg(test)]
mod url_param_tests {
    use super::{ranged_analysis_seed_hold_allowed, url_format_hint, url_stream_cap_kbps};

    #[test]
    fn ranged_analysis_hold_covers_disk_spill_sizes() {
        assert!(ranged_analysis_seed_hold_allowed(
            super::super::stream::TRACK_STREAM_PROMOTE_MAX_BYTES + 1
        ));
        assert!(ranged_analysis_seed_hold_allowed(
            super::super::stream::LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES
        ));
        assert!(!ranged_analysis_seed_hold_allowed(
            super::super::stream::LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES + 1
        ));
    }

    #[test]
    fn extracts_aiff_format_hint_from_url_path() {
        assert_eq!(
            url_format_hint("https://s.example/music/track.AIFF?token=x"),
            Some("aiff".into()),
        );
    }

    #[test]
    fn parses_max_bit_rate_from_stream_url() {
        let url = "https://s.example/rest/stream.view?id=t1&u=a&maxBitRate=128&f=json";
        assert_eq!(url_stream_cap_kbps(url), Some(128));
    }

    #[test]
    fn absent_or_zero_cap_is_none() {
        assert_eq!(url_stream_cap_kbps("https://s.example/rest/stream.view?id=t1&u=a"), None);
        assert_eq!(url_stream_cap_kbps("https://s.example/rest/stream.view?id=t1&maxBitRate=0"), None);
        assert_eq!(url_stream_cap_kbps("psysonic-local:///library/t1.flac"), None);
    }
}

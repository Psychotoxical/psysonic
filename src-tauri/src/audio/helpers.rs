//! URL identity, loudness cache resolution, fetch, gain math, and stream analysis helpers.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rodio::Sink;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::engine::AudioEngine;
use crate::audio::ipc::{
    partial_loudness_should_emit, PartialLoudnessPayload, PARTIAL_LOUDNESS_DELTA_THRESHOLD_DB,
};

pub(crate) fn emit_partial_loudness_from_bytes(
    app: &AppHandle,
    url: &str,
    bytes: &[u8],
    target_lufs: f32,
    pre_analysis_attenuation_db: f32,
) {
    if bytes.len() < PARTIAL_LOUDNESS_MIN_BYTES {
        crate::app_deprintln!(
            "[normalization] partial-loudness skip reason=insufficient-bytes bytes={} min_bytes={}",
            bytes.len(),
            PARTIAL_LOUDNESS_MIN_BYTES
        );
        return;
    }
    // Lightweight fallback based on buffered bytes count to keep CPU low.
    let mb = bytes.len() as f32 / (1024.0 * 1024.0);
    let pre_floor = pre_analysis_attenuation_db.clamp(-24.0, 0.0);
    // Target-derived hint (e.g. -12 LUFS → -1 dB). Old `(hint).clamp(pre, 0)` left
    // the hint when it lay inside [pre, 0] — e.g. -1 with pre=-6, so AAC/M4A
    // streaming often sat at -1 dB until full analysis. Combine with user trim:
    // stricter (more negative) pre wins; milder pre still caps vs the hint.
    let heuristic_floor = (target_lufs + 11.0).clamp(-6.0, 0.0);
    let floor_db = if pre_floor < heuristic_floor {
        pre_floor
    } else {
        pre_floor.max(heuristic_floor)
    };
    let gain_db = (-(mb * 0.7)).max(floor_db).min(0.0);
    let track_key = playback_identity(url).unwrap_or_else(|| url.to_string());
    if !partial_loudness_should_emit(&track_key, gain_db as f32) {
        crate::app_deprintln!(
            "[normalization] partial-loudness skip reason=delta-below-threshold gain_db={:.2} threshold_db={:.2} track_id={:?}",
            gain_db,
            PARTIAL_LOUDNESS_DELTA_THRESHOLD_DB,
            playback_identity(url)
        );
        return;
    }
    crate::app_deprintln!(
        "[normalization] partial-loudness emit bytes={} gain_db={:.2} target_lufs={:.2} track_id={:?}",
        bytes.len(),
        gain_db,
        target_lufs,
        playback_identity(url)
    );
    let _ = app.emit(
        "analysis:loudness-partial",
        PartialLoudnessPayload {
            track_id: playback_identity(url),
            gain_db: gain_db as f32,
            target_lufs,
            is_partial: true,
        },
    );
}

pub(crate) fn provisional_loudness_gain_from_progress(
    downloaded: usize,
    total_size: usize,
    target_lufs: f32,
    start_db_in: f32,
) -> Option<f32> {
    if total_size == 0 || downloaded == 0 {
        return None;
    }
    let progress = (downloaded as f32 / total_size as f32).clamp(0.0, 1.0);
    // Move from startup attenuation toward a more realistic late-stream level.
    // This avoids staying near -2 dB and then jumping hard when final LUFS lands.
    let start_db = start_db_in.clamp(-24.0, 0.0).min(0.0);
    let end_db = (target_lufs + 6.0).clamp(-10.0, -3.0).min(0.0);
    let shaped = progress.powf(0.75);
    Some(start_db + (end_db - start_db) * shaped)
}

pub(crate) fn content_type_to_hint(ct: &str) -> Option<String> {
    let ct = ct.to_ascii_lowercase();
    if ct.contains("mpeg") || ct.contains("mp3") { Some("mp3".into()) }
    else if ct.contains("aac") || ct.contains("aacp") { Some("aac".into()) }
    else if ct.contains("ogg") { Some("ogg".into()) }
    else if ct.contains("flac") { Some("flac".into()) }
    else if ct.contains("wav") || ct.contains("wave") { Some("wav".into()) }
    else if ct.contains("opus") { Some("opus".into()) }
    else { None }
}
// ─── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
    pub current_time: f64,
    pub duration: f64,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Subsonic `buildStreamUrl()` uses a fresh random salt on every call, so two
/// URLs for the same track differ in `t`/`s` query params. Compare a stable key.
pub(crate) fn playback_identity(url: &str) -> Option<String> {
    if let Some(path) = url.strip_prefix("psysonic-local://") {
        return Some(format!("local:{path}"));
    }
    if !url.contains("stream.view") {
        return None;
    }
    let q = url.split('?').nth(1)?;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("id=") {
            let v = v.split('&').next().unwrap_or(v);
            return Some(format!("stream:{v}"));
        }
    }
    None
}

/// Stable id for analysis cache rows and `analysis:waveform-updated`.
/// Prefer the Subsonic track id from the frontend: `psysonic-local://` URLs
/// only map to `local:path` in `playback_identity`, which does not match
/// `analysis_get_waveform_for_track(trackId)` or the UI's `currentTrack.id`.
pub(crate) fn analysis_cache_track_id(logical_track_id: Option<&str>, url: &str) -> Option<String> {
    let logical = logical_track_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    logical.or_else(|| playback_identity(url))
}

pub(crate) fn same_playback_target(a_url: &str, b_url: &str) -> bool {
    match (playback_identity(a_url), playback_identity(b_url)) {
        (Some(a), Some(b)) => a == b,
        _ => a_url == b_url,
    }
}

#[derive(Clone, Copy)]
pub(crate) struct ResolveLoudnessCacheOpts {
    /// When false, skip `get_latest_waveform_for_track` — `audio_update_replay_gain` runs
    /// on every partial-LUFS tick; loudness gain does not depend on waveform, and the extra
    /// SQLite read was pure overhead on the IPC path.
    pub(crate) touch_waveform: bool,
    /// When false, omit `cache-miss` / `cache-invalid` debug lines (still log hits and errors).
    pub(crate) log_soft_misses: bool,
}

impl Default for ResolveLoudnessCacheOpts {
    fn default() -> Self {
        Self {
            touch_waveform: true,
            log_soft_misses: true,
        }
    }
}

pub(crate) fn resolve_loudness_gain_from_cache(
    app: &AppHandle,
    url: &str,
    target_lufs: f32,
    logical_track_id: Option<&str>,
) -> Option<f32> {
    resolve_loudness_gain_from_cache_impl(
        app,
        url,
        target_lufs,
        logical_track_id,
        ResolveLoudnessCacheOpts::default(),
    )
}

pub(crate) fn resolve_loudness_gain_from_cache_impl(
    app: &AppHandle,
    url: &str,
    target_lufs: f32,
    logical_track_id: Option<&str>,
    opts: ResolveLoudnessCacheOpts,
) -> Option<f32> {
    // Only a SQLite loudness row counts here. Ephemeral JS hints (`analysis:loudness-partial`)
    // are applied in `audio_update_replay_gain` via `loudness_gain_db_or_startup(..., true, _)`.
    let Some(track_id) = analysis_cache_track_id(logical_track_id, url) else {
        if opts.log_soft_misses {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=no-identity url_len={}",
                url.len()
            );
        }
        return None;
    };
    let Some(cache) = app.try_state::<crate::analysis_cache::AnalysisCache>() else {
        if opts.log_soft_misses {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=no-analysis-cache track_id={}",
                track_id
            );
        }
        return None;
    };
    if opts.touch_waveform {
        // Bind / preload: verify waveform context exists alongside loudness lookup.
        let _ = cache.get_latest_waveform_for_track(&track_id);
    }
    match cache.get_latest_loudness_for_track(&track_id) {
        Ok(Some(row)) if row.integrated_lufs.is_finite() => {
            let recommended = crate::analysis_cache::recommended_gain_for_target(
                row.integrated_lufs,
                row.true_peak,
                target_lufs as f64,
            ) as f32;
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=cache track_id={} gain_db={:.2} target_lufs={:.2} integrated_lufs={:.2} updated_at={}",
                track_id,
                recommended,
                target_lufs,
                row.integrated_lufs,
                row.updated_at
            );
            Some(recommended)
        }
        Ok(Some(row)) => {
            if opts.log_soft_misses {
                crate::app_deprintln!(
                    "[normalization] resolve_loudness_gain source=cache-invalid track_id={} integrated_lufs={}",
                    track_id,
                    row.integrated_lufs
                );
            }
            None
        }
        Ok(None) => {
            if opts.log_soft_misses {
                crate::app_deprintln!(
                    "[normalization] resolve_loudness_gain source=cache-miss track_id={}",
                    track_id
                );
            }
            None
        }
        Err(e) => {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=cache-error track_id={} err={}",
                track_id,
                e
            );
            None
        }
    }
}

/// Typical integrated LUFS (streaming pivot) when SQLite has no row yet — so target changes
/// still move gain before real analysis completes.
const LOUDNESS_PLACEHOLDER_INTEGRATED_LUFS: f64 = -14.0;

#[inline]
pub(crate) fn loudness_gain_placeholder_until_cache(target_lufs: f32, pre_analysis_attenuation_db: f32) -> f32 {
    let pre = pre_analysis_attenuation_db.clamp(-24.0, 0.0).min(0.0);
    // `true_peak = 0.0` skips the headroom cap until integrated measurement exists.
    let pivot = crate::analysis_cache::recommended_gain_for_target(
        LOUDNESS_PLACEHOLDER_INTEGRATED_LUFS,
        0.0,
        f64::from(target_lufs),
    ) as f32;
    (pivot + pre).clamp(-24.0, 24.0)
}

/// LUFS gain after a single `resolve_loudness_gain_from_cache` result (`None` = miss).
/// Keeps `audio_update_replay_gain` / `audio_play` from resolving twice on the same URL.
/// Until a cache row exists, follow current target (see [`loudness_gain_placeholder_until_cache`]).
pub(crate) fn loudness_gain_db_after_resolve(
    resolved_from_cache: Option<f32>,
    target_lufs: f32,
    pre_analysis_attenuation_db: f32,
    allow_js_when_uncached: bool,
    js_gain_db: Option<f32>,
) -> Option<f32> {
    let uncached = loudness_gain_placeholder_until_cache(target_lufs, pre_analysis_attenuation_db);
    match resolved_from_cache {
        Some(g) => Some(g),
        None => {
            if allow_js_when_uncached {
                match js_gain_db {
                    Some(r) if r.is_finite() => Some(r),
                    _ => Some(uncached),
                }
            } else {
                Some(uncached)
            }
        }
    }
}

/// LUFS: DB-backed integrated LUFS only at bind time (`allow_js_when_uncached = false`);
/// after `analysis:loudness-partial`, `audio_update_replay_gain` passes `true` so finite
/// JS gain applies until SQLite catches up. Must never return `None` or `compute_gain` uses unity.
pub(crate) fn loudness_gain_db_or_startup(
    app: &AppHandle,
    url: &str,
    target_lufs: f32,
    logical_track_id: Option<&str>,
    pre_analysis_attenuation_db: f32,
    allow_js_when_uncached: bool,
    js_gain_db: Option<f32>,
) -> Option<f32> {
    let resolved = resolve_loudness_gain_from_cache_impl(
        app,
        url,
        target_lufs,
        logical_track_id,
        ResolveLoudnessCacheOpts::default(),
    );
    loudness_gain_db_after_resolve(
        resolved,
        target_lufs,
        pre_analysis_attenuation_db,
        allow_js_when_uncached,
        js_gain_db,
    )
}

#[inline]
pub(crate) fn loudness_pre_analysis_db_for_engine(state: &AudioEngine) -> f32 {
    f32::from_bits(
        state
            .loudness_pre_analysis_attenuation_db
            .load(Ordering::Relaxed),
    )
    .clamp(-24.0, 0.0)
    .min(0.0)
}

/// Take (consume) completed manual-stream bytes if they correspond to `url`.
pub fn take_stream_completed_for_url(state: &AudioEngine, url: &str) -> Option<Vec<u8>> {
    let mut guard = state.stream_completed_cache.lock().unwrap();
    if guard
        .as_ref()
        .is_some_and(|p| same_playback_target(&p.url, url))
    {
        return guard.take().map(|p| p.data);
    }
    None
}

/// Fetch track bytes from the preload cache or via HTTP.
pub(crate) async fn fetch_data(
    url: &str,
    state: &AudioEngine,
    gen: u64,
    app: &AppHandle,
) -> Result<Option<Vec<u8>>, String> {
    // Check completed streamed-track cache first (manual streaming fallback cache).
    let streamed_cached = {
        let mut streamed = state.stream_completed_cache.lock().unwrap();
        if streamed.as_ref().is_some_and(|p| same_playback_target(&p.url, url)) {
            streamed.take().map(|p| p.data)
        } else {
            None
        }
    };
    if let Some(data) = streamed_cached {
        return Ok(Some(data));
    }

    // Check preload cache next.
    let cached = {
        let mut preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, url)) {
            preloaded.take().map(|p| p.data)
        } else {
            None
        }
    };

    if let Some(data) = cached {
        return Ok(Some(data));
    }

    // Offline cache — local file written by download_track_offline.
    if let Some(path) = url.strip_prefix("psysonic-local://") {
        let data = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        return Ok(Some(data));
    }

    let response = crate::audio::engine::audio_http_client(&state).get(url).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let ct = response.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    let server_hdr = response.headers()
        .get("server")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    // Strip auth params from URL before logging.
    let safe_url = url.split('?').next().unwrap_or(url);
    crate::app_deprintln!(
        "[audio] fetch {} → {} | content-type: {} | server: {}",
        safe_url, status, ct, server_hdr
    );
    if !response.status().is_success() {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded
        }
        let status = response.status().as_u16();
        let msg = format!("HTTP {status}");
        app.emit("audio:error", &msg).ok();
        return Err(msg);
    }
    // Stream the body, checking gen between chunks so a rapid manual skip can
    // abort a superseded download mid-flight and free bandwidth for the new one.
    let hint = response.content_length().unwrap_or(0) as usize;
    let mut stream = response.bytes_stream();
    let mut data = Vec::with_capacity(hint);
    while let Some(chunk) = stream.next().await {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded — abort
        }
        data.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
    }
    Ok(Some(data))
}

/// When playback uses full track bytes already in RAM (gapless `reuse_chained_bytes`,
/// `preloaded`, or `stream_completed_cache` via `fetch_data`), the `psysonic-local`
/// disk-read seed path never runs. Submit the same full-buffer analysis via the cpu-seed queue so waveform /
/// loudness SQLite can fill **offline** without `analysis_enqueue_seed_from_url` HTTP.
pub(crate) fn spawn_analysis_seed_from_in_memory_bytes(
    app: &AppHandle,
    cache_track_id: Option<&str>,
    gen: u64,
    gen_arc: &Arc<AtomicU64>,
    bytes: &[u8],
) {
    let Some(track_id) = cache_track_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    if bytes.is_empty() || bytes.len() > crate::audio::stream::TRACK_STREAM_PROMOTE_MAX_BYTES {
        return;
    }
    let track_id = track_id.to_string();
    let bytes = bytes.to_vec();
    let app = app.clone();
    let gen_arc = gen_arc.clone();
    crate::app_deprintln!(
        "[stream] in-memory play path: scheduling full-track analysis track_id={} size_mib={:.2}",
        track_id,
        bytes.len() as f64 / (1024.0 * 1024.0)
    );
    let high = crate::audio::engine::analysis_seed_high_priority_for_track(&app, &track_id);
    tokio::spawn(async move {
        if gen_arc.load(Ordering::SeqCst) != gen {
            return;
        }
        if let Err(e) = crate::submit_analysis_cpu_seed(app.clone(), track_id.clone(), bytes, high).await {
            crate::app_eprintln!(
                "[analysis] in-memory play path seed failed for {}: {}",
                track_id,
                e
            );
        }
    });
}

/// -1 dB headroom applied at full scale to prevent inter-sample clipping.
/// Modern masters are often at 0 dBFS; the EQ biquad chain and resampler
/// can produce inter-sample peaks slightly above ±1.0 → audible distortion.
/// 10^(-1/20) ≈ 0.891 — inaudible volume difference, eliminates clipping.
pub(crate) const MASTER_HEADROOM: f32 = 0.891_254;
pub(crate) const PARTIAL_LOUDNESS_MIN_BYTES: usize = 256 * 1024;
pub(crate) const PARTIAL_LOUDNESS_EMIT_INTERVAL_MS: u64 = 900;

pub(crate) fn compute_gain(
    normalization_engine: u32,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    loudness_gain_db: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    volume: f32,
) -> (f32, f32) {
    let gain_linear = match normalization_engine {
        2 => loudness_gain_db
            .map(|db| 10f32.powf(db / 20.0))
            .unwrap_or(1.0),
        1 => replay_gain_db
            .map(|db| 10f32.powf((db + pre_gain_db) / 20.0))
            .unwrap_or_else(|| 10f32.powf(fallback_db / 20.0)),
        _ => 1.0,
    };
    let peak = if normalization_engine == 1 {
        replay_gain_peak.unwrap_or(1.0).max(0.001)
    } else {
        1.0
    };
    let gain_linear = gain_linear.min(1.0 / peak);
    let effective = (volume.clamp(0.0, 1.0) * gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    (gain_linear, effective)
}

pub(crate) fn normalization_engine_name(mode: u32) -> &'static str {
    match mode {
        1 => "replaygain",
        2 => "loudness",
        _ => "off",
    }
}

pub(crate) fn gain_linear_to_db(gain_linear: f32) -> Option<f32> {
    if gain_linear.is_finite() && gain_linear > 0.0 {
        Some(20.0 * gain_linear.log10())
    } else {
        None
    }
}

/// `audio:normalization-state` “Now dB” for the UI: effective applied gain, including
/// loudness pre-analysis trim from settings when no cache row exists yet (matches audible level).
pub(crate) fn loudness_ui_current_gain_db(gain_linear: f32) -> Option<f32> {
    gain_linear_to_db(gain_linear)
}

pub(crate) fn ramp_sink_volume(sink: Arc<Sink>, from: f32, to: f32) {
    let from = from.clamp(0.0, 1.0);
    let to = to.clamp(0.0, 1.0);
    if (to - from).abs() < 0.002 {
        sink.set_volume(to);
        return;
    }
    static RAMP_GEN: AtomicU64 = AtomicU64::new(0);
    let my_gen = RAMP_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let delta = (to - from).abs();
        // Stretch large corrections to avoid audible "step down" moments.
        let (steps, step_ms): (usize, u64) = if delta > 0.30 {
            (24, 35)
        } else if delta > 0.18 {
            (18, 30)
        } else if delta > 0.10 {
            (14, 24)
        } else {
            (8, 16)
        };
        for i in 1..=steps {
            if RAMP_GEN.load(Ordering::SeqCst) != my_gen {
                return;
            }
            let t = i as f32 / steps as f32;
            let v = from + (to - from) * t;
            sink.set_volume(v.clamp(0.0, 1.0));
            std::thread::sleep(Duration::from_millis(step_ms));
        }
    });
}

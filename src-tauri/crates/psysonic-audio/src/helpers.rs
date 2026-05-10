//! URL identity, loudness cache resolution, fetch, gain math, and stream analysis helpers.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rodio::Player;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::engine::AudioEngine;
use crate::ipc::{
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
    if !partial_loudness_should_emit(&track_key, gain_db) {
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
            gain_db,
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
    // AAC/ALAC in MP4 — Navidrome/nginx often send `audio/mp4`; without a hint we skipped ranged open.
    else if ct.contains("audio/mp4") || ct.contains("x-m4a") || ct.contains("/m4a") {
        Some("m4a".into())
    }
    else { None }
}

/// `Content-Disposition: attachment; filename="…"` from some Subsonic proxies.
pub(crate) fn format_hint_from_content_disposition(cd: &str) -> Option<String> {
    fn ext_ok(ext: &str) -> Option<String> {
        let ext = ext.trim_matches(|c| c == '"' || c == '\'' || c == ' ').split(';').next()?.trim();
        if !(1..=5).contains(&ext.len()) {
            return None;
        }
        if !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        let e = ext.to_ascii_lowercase();
        if matches!(
            e.as_str(),
            "mp3" | "flac" | "ogg" | "oga" | "opus" | "m4a" | "mp4" | "aac" | "wav" | "wave" | "ape" | "wv"
                | "webm" | "mka"
        ) {
            Some(e)
        } else {
            None
        }
    }
    fn ext_from_filename(path: &str) -> Option<String> {
        let base = path.rsplit('/').next()?.trim_matches(|c| c == '"' || c == ' ');
        if base.is_empty() {
            return None;
        }
        let ext = base.rsplit('.').next()?;
        if ext == base {
            return None;
        }
        ext_ok(ext)
    }
    for part in cd.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            // RFC 5987: `charset'lang'value`
            let value = rest.split("''").nth(1).unwrap_or(rest).trim().trim_matches('"');
            if let Some(ext) = ext_from_filename(value) {
                return Some(ext);
            }
        } else if let Some(rest) = part.strip_prefix("filename=") {
            let value = rest.trim().trim_matches('"');
            if let Some(ext) = ext_from_filename(value) {
                return Some(ext);
            }
        }
    }
    None
}

/// Subsonic [`song.suffix`](https://www.subsonic.org/pages/api.jsp#getSong) — stream.view URLs
/// usually have no file extension; this supplies `format_hint` for ranged open.
pub(crate) fn normalize_stream_suffix_for_hint(suffix: Option<&str>) -> Option<String> {
    let s = suffix?.trim();
    if s.is_empty() {
        return None;
    }
    let e = s.to_ascii_lowercase();
    if matches!(
        e.as_str(),
        "mp3" | "flac" | "ogg" | "oga" | "opus" | "m4a" | "mp4" | "aac" | "wav" | "wave" | "ape" | "wv"
            | "webm" | "mka"
    ) {
        Some(e)
    } else {
        None
    }
}

/// Max prefix length for an optional `Range` probe GET when ranged open needs a format hint.
pub(crate) const STREAM_FORMAT_SNIFF_PROBE_BYTES: usize = 256 * 1024;

fn id3v2_tag_len(data: &[u8]) -> usize {
    if data.len() >= 10 && data[0..3] == *b"ID3" {
        let size = ((data[6] as usize & 0x7f) << 21)
            | ((data[7] as usize & 0x7f) << 14)
            | ((data[8] as usize & 0x7f) << 7)
            | (data[9] as usize & 0x7f);
        10usize.saturating_add(size)
    } else {
        0
    }
}

fn adts_frame_sync(b0: u8, b1: u8) -> bool {
    b0 == 0xff && (b1 & 0xf6) == 0xf0
}

fn mp3_frame_sync(b0: u8, b1: u8) -> bool {
    b0 == 0xff && (b1 & 0xe0) == 0xe0
}

/// Magic-byte sniff on the start of an HTTP body when headers / Subsonic suffix / path
/// did not yield a Symphonia [`Hint`] extension (needed for `RangedHttpSource`).
pub(crate) fn sniff_stream_format_extension(data: &[u8]) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    if data.len() >= 4 && data[0..4] == *b"fLaC" {
        return Some("flac".into());
    }
    if data.len() >= 4 && data[0..4] == *b"OggS" {
        return Some("ogg".into());
    }
    if data.len() >= 12 && data[0..4] == *b"RIFF" && data[8..12] == *b"WAVE" {
        return Some("wav".into());
    }
    // ISO-BMFF — `ftyp` inside a box; scan a small window (large `free`/`skip` before `ftyp` is rare but exists).
    let scan = data.len().min(4096).saturating_sub(4);
    for i in 0..=scan {
        if data[i..i + 4] == *b"ftyp" {
            return Some("m4a".into());
        }
    }
    // EBML — WebM / Matroska (.mka)
    if data.len() >= 4 && data[0] == 0x1a && data[1] == 0x45 && data[2] == 0xdf && data[3] == 0xa3 {
        return Some("mka".into());
    }
    // AAC ADTS
    let id3 = id3v2_tag_len(data);
    if id3 < data.len().saturating_sub(2) && adts_frame_sync(data[id3], data[id3 + 1]) {
        return Some("aac".into());
    }
    if data.len() >= 2 && adts_frame_sync(data[0], data[1]) {
        return Some("aac".into());
    }
    // MPEG layer III / II — after ID3
    let off = id3;
    if off + 2 <= data.len() && mp3_frame_sync(data[off], data[off + 1]) {
        return Some("mp3".into());
    }
    None
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
    let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() else {
        if opts.log_soft_misses {
            crate::app_deprintln!(
                "[normalization] resolve_loudness_gain source=no-analysis-cache track_id={}",
                track_id
            );
        }
        return None;
    };
    resolve_loudness_gain_with_cache(cache.inner(), &track_id, target_lufs, opts)
}

/// AppHandle-free core of [`resolve_loudness_gain_from_cache_impl`]. Looks up
/// the latest loudness row for `track_id` in `cache` and returns the
/// recommended gain in dB, or `None` for any miss / non-finite / error case.
/// Pulled out so tests can drive every branch via `AnalysisCache::open_in_memory()`.
///
/// `opts.touch_waveform` keeps parity with production behaviour: when binding
/// a track, we also touch `get_latest_waveform_for_track` so the SQLite
/// connection's row cache is warm for the next IPC tick.
pub(crate) fn resolve_loudness_gain_with_cache(
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
    track_id: &str,
    target_lufs: f32,
    opts: ResolveLoudnessCacheOpts,
) -> Option<f32> {
    if opts.touch_waveform {
        // Bind / preload: verify waveform context exists alongside loudness lookup.
        let _ = cache.get_latest_waveform_for_track(track_id);
    }
    match cache.get_latest_loudness_for_track(track_id) {
        Ok(Some(row)) if row.integrated_lufs.is_finite() => {
            let recommended = psysonic_analysis::analysis_cache::recommended_gain_for_target(
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
    let pivot = psysonic_analysis::analysis_cache::recommended_gain_for_target(
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

/// Resolved gain inputs that both `audio_play` and `audio_chain_preload` need
/// before calling [`compute_gain`]. Bundles the engine state reads + cache
/// resolution in one shot so the call sites don't drift apart on subtle
/// behaviour (e.g. one accidentally skipping the post-resolve step for
/// LUFS mode).
#[derive(Debug, Clone, Copy)]
pub(crate) struct TrackGainInputs {
    pub(crate) target_lufs: f32,
    pub(crate) norm_mode: u32,
    /// Pre-resolve cache value — kept around for logging in `audio_play`.
    pub(crate) cache_loudness_db: Option<f32>,
    /// Value to feed into `compute_gain` — for LUFS mode this is the
    /// post-`loudness_gain_db_after_resolve` value, otherwise the raw cache
    /// resolution (or `None` when not in normalisation mode).
    pub(crate) effective_loudness_db: Option<f32>,
}

/// Read engine state + resolve the loudness cache for a track that's about to
/// start playing. JS-supplied `loudness_gain_db` is **not** consulted at bind
/// time (only post-cache via `audio_update_replay_gain`).
pub(crate) fn resolve_track_gain_inputs(
    state: &AudioEngine,
    app: &AppHandle,
    url: &str,
    logical_track_id: Option<&str>,
    js_loudness_gain_db: Option<f32>,
) -> TrackGainInputs {
    let target_lufs = f32::from_bits(state.normalization_target_lufs.load(Ordering::Relaxed));
    let norm_mode = state.normalization_engine.load(Ordering::Relaxed);
    let pre_analysis_db = loudness_pre_analysis_db_for_engine(state);
    let cache_loudness_db = resolve_loudness_gain_from_cache(app, url, target_lufs, logical_track_id);
    let effective_loudness_db = if norm_mode == 2 {
        loudness_gain_db_after_resolve(
            cache_loudness_db,
            target_lufs,
            pre_analysis_db,
            false,
            js_loudness_gain_db,
        )
    } else {
        cache_loudness_db
    };
    TrackGainInputs {
        target_lufs,
        norm_mode,
        cache_loudness_db,
        effective_loudness_db,
    }
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

    let response = crate::engine::audio_http_client(state).get(url).send().await.map_err(|e| e.to_string())?;
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
    if bytes.is_empty() || bytes.len() > crate::stream::TRACK_STREAM_PROMOTE_MAX_BYTES {
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
    let high = crate::engine::analysis_seed_high_priority_for_track(&app, &track_id);
    tokio::spawn(async move {
        if gen_arc.load(Ordering::SeqCst) != gen {
            return;
        }
        if let Err(e) = psysonic_analysis::analysis_runtime::submit_analysis_cpu_seed(app.clone(), track_id.clone(), bytes, high).await {
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

pub(crate) fn ramp_sink_volume(sink: Arc<Player>, from: f32, to: f32) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) {
        assert!((a - b).abs() < eps, "expected {b}, got {a}");
    }

    // ── provisional_loudness_gain_from_progress ───────────────────────────────

    #[test]
    fn provisional_returns_none_for_zero_total() {
        assert!(provisional_loudness_gain_from_progress(100, 0, -14.0, -2.0).is_none());
    }

    #[test]
    fn provisional_returns_none_for_zero_downloaded() {
        assert!(provisional_loudness_gain_from_progress(0, 1000, -14.0, -2.0).is_none());
    }

    #[test]
    fn provisional_clamps_start_db_into_range() {
        // start_db_in is clamped to [-24, 0] then min(0). +5 dB is invalid → 0.
        let g = provisional_loudness_gain_from_progress(1, 100, -14.0, 5.0).unwrap();
        // At progress ≈ 0, gain ≈ start_db; clamp pushed start_db to 0.
        // shaped(0.01) = 0.01.powf(0.75) ≈ 0.0316; gain ≈ 0 + (end_db - 0)*0.0316.
        // end_db = (-14 + 6).clamp(-10, -3) = -8 → gain ≈ -0.253
        approx(g, -0.253, 0.05);
    }

    #[test]
    fn provisional_at_full_progress_reaches_end_db() {
        // end_db = (target_lufs + 6).clamp(-10, -3).min(0)
        // target_lufs = -14 → -8
        let g = provisional_loudness_gain_from_progress(100, 100, -14.0, -2.0).unwrap();
        approx(g, -8.0, 0.001);
    }

    #[test]
    fn provisional_clamps_end_db_to_minus_three_floor() {
        // target_lufs = 0 → end_db = (0 + 6).clamp(-10, -3) = -3
        let g = provisional_loudness_gain_from_progress(100, 100, 0.0, 0.0).unwrap();
        approx(g, -3.0, 0.001);
    }

    // ── content_type_to_hint ──────────────────────────────────────────────────

    #[test]
    fn content_type_recognises_common_audio_mimes() {
        assert_eq!(content_type_to_hint("audio/mpeg"), Some("mp3".into()));
        assert_eq!(content_type_to_hint("audio/aac"), Some("aac".into()));
        assert_eq!(content_type_to_hint("audio/aacp"), Some("aac".into()));
        assert_eq!(content_type_to_hint("audio/ogg"), Some("ogg".into()));
        assert_eq!(content_type_to_hint("audio/flac"), Some("flac".into()));
        assert_eq!(content_type_to_hint("audio/wav"), Some("wav".into()));
        assert_eq!(content_type_to_hint("audio/wave"), Some("wav".into()));
        assert_eq!(content_type_to_hint("audio/opus"), Some("opus".into()));
        assert_eq!(content_type_to_hint("audio/mp4"), Some("m4a".into()));
        assert_eq!(content_type_to_hint("audio/x-m4a"), Some("m4a".into()));
    }

    #[test]
    fn content_type_is_case_insensitive() {
        assert_eq!(content_type_to_hint("AUDIO/MPEG"), Some("mp3".into()));
        assert_eq!(content_type_to_hint("Audio/FLAC"), Some("flac".into()));
    }

    #[test]
    fn content_type_returns_none_for_unknown() {
        assert_eq!(content_type_to_hint("text/html"), None);
        assert_eq!(content_type_to_hint("application/octet-stream"), None);
        assert_eq!(content_type_to_hint(""), None);
    }

    // ── format_hint_from_content_disposition ──────────────────────────────────

    #[test]
    fn cd_extracts_extension_from_quoted_filename() {
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"track.flac\""),
            Some("flac".into()),
        );
    }

    #[test]
    fn cd_extracts_extension_from_rfc5987_filename_star() {
        assert_eq!(
            format_hint_from_content_disposition("filename*=UTF-8''track.opus"),
            Some("opus".into()),
        );
    }

    #[test]
    fn cd_returns_none_for_unknown_extension() {
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"track.xyz\""),
            None,
        );
    }

    #[test]
    fn cd_returns_none_when_filename_has_no_extension() {
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"trackname\""),
            None,
        );
    }

    #[test]
    fn cd_returns_none_when_no_filename_present() {
        assert_eq!(format_hint_from_content_disposition("inline"), None);
    }

    // ── normalize_stream_suffix_for_hint ──────────────────────────────────────

    #[test]
    fn suffix_normalises_known_extensions_lowercase() {
        assert_eq!(normalize_stream_suffix_for_hint(Some("MP3")), Some("mp3".into()));
        assert_eq!(normalize_stream_suffix_for_hint(Some("Flac")), Some("flac".into()));
    }

    #[test]
    fn suffix_returns_none_for_empty_or_whitespace() {
        assert_eq!(normalize_stream_suffix_for_hint(None), None);
        assert_eq!(normalize_stream_suffix_for_hint(Some("")), None);
        assert_eq!(normalize_stream_suffix_for_hint(Some("   ")), None);
    }

    #[test]
    fn suffix_returns_none_for_unknown_extension() {
        assert_eq!(normalize_stream_suffix_for_hint(Some("xyz")), None);
        assert_eq!(normalize_stream_suffix_for_hint(Some("psy")), None);
    }

    // ── sniff_stream_format_extension ─────────────────────────────────────────

    #[test]
    fn sniff_detects_flac_magic() {
        assert_eq!(sniff_stream_format_extension(b"fLaC\x00\x00"), Some("flac".into()));
    }

    #[test]
    fn sniff_detects_ogg_magic() {
        assert_eq!(sniff_stream_format_extension(b"OggS......"), Some("ogg".into()));
    }

    #[test]
    fn sniff_detects_riff_wave() {
        let mut buf = b"RIFF".to_vec();
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(b"WAVE");
        assert_eq!(sniff_stream_format_extension(&buf), Some("wav".into()));
    }

    #[test]
    fn sniff_detects_mp4_ftyp_box() {
        // 4 leading size bytes, then "ftyp" — common MP4 layout.
        let mut buf = vec![0u8; 4];
        buf.extend_from_slice(b"ftyp");
        buf.extend_from_slice(b"M4A \x00\x00\x02\x00");
        assert_eq!(sniff_stream_format_extension(&buf), Some("m4a".into()));
    }

    #[test]
    fn sniff_detects_ebml_matroska() {
        assert_eq!(
            sniff_stream_format_extension(&[0x1a, 0x45, 0xdf, 0xa3, 0x00]),
            Some("mka".into()),
        );
    }

    #[test]
    fn sniff_detects_adts_aac_with_no_id3() {
        assert_eq!(sniff_stream_format_extension(&[0xff, 0xf1, 0x00, 0x00]), Some("aac".into()));
    }

    #[test]
    fn sniff_detects_mp3_frame_sync_with_no_id3() {
        assert_eq!(sniff_stream_format_extension(&[0xff, 0xfb, 0x00, 0x00]), Some("mp3".into()));
    }

    #[test]
    fn sniff_detects_mp3_after_id3v2_tag() {
        // ID3v2 header (10 bytes): "ID3" + 2 version bytes + flags byte + 4 size bytes (synchsafe).
        // Use size = 0 so the MP3 frame sync starts immediately at offset 10.
        let mut buf = vec![b'I', b'D', b'3', 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        buf.extend_from_slice(&[0xff, 0xfb]);
        assert_eq!(sniff_stream_format_extension(&buf), Some("mp3".into()));
    }

    #[test]
    fn sniff_returns_none_for_empty_or_random_bytes() {
        assert_eq!(sniff_stream_format_extension(&[]), None);
        assert_eq!(sniff_stream_format_extension(&[0x00, 0x01, 0x02, 0x03]), None);
    }

    // ── playback_identity ─────────────────────────────────────────────────────

    #[test]
    fn playback_identity_for_local_path() {
        assert_eq!(
            playback_identity("psysonic-local:///cache/track.flac"),
            Some("local:/cache/track.flac".into()),
        );
    }

    #[test]
    fn playback_identity_for_subsonic_stream_url() {
        assert_eq!(
            playback_identity("https://server/rest/stream.view?u=user&t=abc&id=42"),
            Some("stream:42".into()),
        );
    }

    #[test]
    fn playback_identity_returns_none_for_url_without_stream_view() {
        assert!(playback_identity("https://server/something").is_none());
    }

    #[test]
    fn playback_identity_returns_none_when_no_id_param_present() {
        assert!(
            playback_identity("https://server/rest/stream.view?u=user&t=abc").is_none(),
            "stream.view URL without an id= param has no stable identity"
        );
    }

    // ── analysis_cache_track_id ───────────────────────────────────────────────

    #[test]
    fn analysis_cache_id_prefers_logical_track_id() {
        assert_eq!(
            analysis_cache_track_id(Some("abc"), "https://server/rest/stream.view?id=42"),
            Some("abc".into()),
        );
    }

    #[test]
    fn analysis_cache_id_falls_back_to_playback_identity() {
        assert_eq!(
            analysis_cache_track_id(None, "https://server/rest/stream.view?id=42"),
            Some("stream:42".into()),
        );
    }

    #[test]
    fn analysis_cache_id_treats_whitespace_logical_id_as_missing() {
        assert_eq!(
            analysis_cache_track_id(Some("   "), "https://server/rest/stream.view?id=42"),
            Some("stream:42".into()),
        );
    }

    #[test]
    fn analysis_cache_id_returns_none_when_neither_source_resolves() {
        assert!(analysis_cache_track_id(None, "https://server/other").is_none());
    }

    // ── same_playback_target ──────────────────────────────────────────────────

    #[test]
    fn same_target_treats_different_salts_as_same_track() {
        let a = "https://server/rest/stream.view?id=42&u=user&t=AAA&s=salt1";
        let b = "https://server/rest/stream.view?id=42&u=user&t=BBB&s=salt2";
        assert!(same_playback_target(a, b));
    }

    #[test]
    fn same_target_treats_different_ids_as_different_tracks() {
        let a = "https://server/rest/stream.view?id=42&u=user&t=AAA";
        let b = "https://server/rest/stream.view?id=99&u=user&t=AAA";
        assert!(!same_playback_target(a, b));
    }

    #[test]
    fn same_target_falls_back_to_string_compare_for_unknown_urls() {
        assert!(same_playback_target("foo://x", "foo://x"));
        assert!(!same_playback_target("foo://x", "foo://y"));
    }

    // ── loudness_gain_placeholder_until_cache ─────────────────────────────────

    #[test]
    fn placeholder_clamps_pre_analysis_into_negative_range() {
        // Pre = +5 → clamped to 0; pivot is just recommended_gain_for_target value.
        let g_pos = loudness_gain_placeholder_until_cache(-14.0, 5.0);
        let g_zero = loudness_gain_placeholder_until_cache(-14.0, 0.0);
        assert_eq!(g_pos, g_zero, "positive pre-analysis must be clamped to 0");
    }

    #[test]
    fn placeholder_lifts_when_target_above_pivot() {
        // Pivot integrated LUFS = -14. Higher target (e.g. -10) means more gain.
        let lower = loudness_gain_placeholder_until_cache(-23.0, 0.0);
        let higher = loudness_gain_placeholder_until_cache(-10.0, 0.0);
        assert!(higher > lower, "higher target_lufs must yield higher gain");
    }

    #[test]
    fn placeholder_clamps_result_into_plus_minus_24() {
        let g = loudness_gain_placeholder_until_cache(-14.0, -50.0);
        assert!((-24.0..=24.0).contains(&g));
    }

    // ── loudness_gain_db_after_resolve ────────────────────────────────────────

    #[test]
    fn after_resolve_returns_cache_value_when_present() {
        assert_eq!(
            loudness_gain_db_after_resolve(Some(-3.5), -14.0, 0.0, true, Some(-9.9)),
            Some(-3.5),
            "cache hit must win over JS hint"
        );
    }

    #[test]
    fn after_resolve_uses_js_hint_when_uncached_and_allowed() {
        assert_eq!(
            loudness_gain_db_after_resolve(None, -14.0, 0.0, true, Some(-7.0)),
            Some(-7.0),
        );
    }

    #[test]
    fn after_resolve_ignores_non_finite_js_hint() {
        let g = loudness_gain_db_after_resolve(None, -14.0, 0.0, true, Some(f32::INFINITY))
            .expect("uncached fallback always returns Some");
        // Falls through to placeholder; just verify it's a valid finite gain.
        assert!(g.is_finite());
    }

    #[test]
    fn after_resolve_uses_placeholder_when_js_disabled() {
        let with_js = loudness_gain_db_after_resolve(None, -14.0, 0.0, true, Some(-2.0));
        let without_js = loudness_gain_db_after_resolve(None, -14.0, 0.0, false, Some(-2.0));
        assert_eq!(with_js, Some(-2.0));
        assert_ne!(with_js, without_js, "allow_js_when_uncached=false ignores js hint");
    }

    // ── compute_gain ──────────────────────────────────────────────────────────

    #[test]
    fn compute_gain_off_mode_returns_unity_linear() {
        let (lin, eff) = compute_gain(0, Some(-3.0), Some(1.0), Some(-3.0), 0.0, 0.0, 1.0);
        assert_eq!(lin, 1.0, "off mode ignores all gain inputs");
        approx(eff, MASTER_HEADROOM, 0.001);
    }

    #[test]
    fn compute_gain_clamps_volume_into_zero_one() {
        let (_, eff_low) = compute_gain(0, None, None, None, 0.0, 0.0, -1.0);
        let (_, eff_high) = compute_gain(0, None, None, None, 0.0, 0.0, 5.0);
        assert_eq!(eff_low, 0.0, "negative volume clamps to 0");
        approx(eff_high, MASTER_HEADROOM, 0.001);
    }

    #[test]
    fn compute_gain_replaygain_mode_uses_replay_gain_db_with_pre_gain() {
        // replay_gain_db = -6, pre_gain_db = +3 → effective dB = -3 → linear ≈ 0.7079
        let (lin, _) = compute_gain(1, Some(-6.0), Some(1.0), None, 3.0, 0.0, 1.0);
        approx(lin, 10f32.powf(-3.0 / 20.0), 0.001);
    }

    #[test]
    fn compute_gain_replaygain_falls_back_when_replay_gain_db_missing() {
        // No replay_gain_db → uses fallback_db (-6 → linear ≈ 0.5)
        let (lin, _) = compute_gain(1, None, Some(1.0), None, 0.0, -6.0, 1.0);
        approx(lin, 10f32.powf(-6.0 / 20.0), 0.001);
    }

    #[test]
    fn compute_gain_replaygain_caps_by_inverse_peak() {
        // replay_gain_db = +12 → linear ≈ 3.98, but peak = 2 caps it to 1/2 = 0.5.
        let (lin, _) = compute_gain(1, Some(12.0), Some(2.0), None, 0.0, 0.0, 1.0);
        approx(lin, 0.5, 0.001);
    }

    #[test]
    fn compute_gain_loudness_mode_applies_attenuation_db() {
        // loudness_gain_db = -6 → linear ≈ 0.501. Negative gain passes through
        // the implicit unity cap.
        let (lin, _) = compute_gain(2, None, None, Some(-6.0), 0.0, 0.0, 1.0);
        approx(lin, 10f32.powf(-6.0 / 20.0), 0.001);
    }

    #[test]
    fn compute_gain_loudness_mode_caps_positive_gain_at_unity() {
        // Loudness normalisation must not boost above 0 dBFS — it would clip.
        // The implementation forces peak = 1.0 in mode 2, so any positive gain
        // is capped at unity by the `gain_linear.min(1.0 / peak)` step.
        let (lin, _) = compute_gain(2, None, None, Some(6.0), 0.0, 0.0, 1.0);
        assert_eq!(lin, 1.0, "+6 dB loudness gain must cap at unity");
    }

    #[test]
    fn compute_gain_loudness_mode_ignores_replay_gain_peak() {
        // The replay_gain_peak field is irrelevant in loudness mode — different
        // peaks must yield identical gain_linear for the same loudness_gain_db.
        let (lin_low_peak, _) = compute_gain(2, None, Some(0.5), Some(-6.0), 0.0, 0.0, 1.0);
        let (lin_high_peak, _) = compute_gain(2, None, Some(2.0), Some(-6.0), 0.0, 0.0, 1.0);
        assert_eq!(lin_low_peak, lin_high_peak);
    }

    #[test]
    fn compute_gain_loudness_mode_returns_unity_when_no_db_supplied() {
        let (lin, _) = compute_gain(2, None, None, None, 0.0, 0.0, 1.0);
        assert_eq!(lin, 1.0);
    }

    // ── normalization_engine_name ─────────────────────────────────────────────

    #[test]
    fn engine_name_maps_known_modes() {
        assert_eq!(normalization_engine_name(0), "off");
        assert_eq!(normalization_engine_name(1), "replaygain");
        assert_eq!(normalization_engine_name(2), "loudness");
    }

    #[test]
    fn engine_name_falls_back_to_off_for_unknown_modes() {
        assert_eq!(normalization_engine_name(3), "off");
        assert_eq!(normalization_engine_name(99), "off");
    }

    // ── gain_linear_to_db ─────────────────────────────────────────────────────

    #[test]
    fn linear_to_db_for_unity_is_zero() {
        approx(gain_linear_to_db(1.0).unwrap(), 0.0, 0.001);
    }

    #[test]
    fn linear_to_db_for_half_is_minus_six() {
        approx(gain_linear_to_db(0.5).unwrap(), -6.020_6, 0.01);
    }

    #[test]
    fn linear_to_db_rejects_zero_and_negative() {
        assert!(gain_linear_to_db(0.0).is_none());
        assert!(gain_linear_to_db(-1.0).is_none());
    }

    #[test]
    fn linear_to_db_rejects_non_finite() {
        assert!(gain_linear_to_db(f32::NAN).is_none());
        assert!(gain_linear_to_db(f32::INFINITY).is_none());
    }

    // ── resolve_loudness_gain_with_cache (AppHandle-free) ────────────────────

    use psysonic_analysis::analysis_cache::{AnalysisCache, LoudnessEntry, TrackKey};

    fn upsert_loudness_row(cache: &AnalysisCache, track_id: &str, integrated: f64, target: f64) {
        let k = TrackKey {
            track_id: track_id.to_string(),
            md5_16kb: "deadbeef".to_string(),
        };
        cache.touch_track_status(&k, "ready").unwrap();
        cache
            .upsert_loudness(
                &k,
                &LoudnessEntry {
                    integrated_lufs: integrated,
                    true_peak: 0.5,
                    recommended_gain_db: 0.0,
                    target_lufs: target,
                    updated_at: 1_700_000_000,
                },
            )
            .unwrap();
    }

    #[test]
    fn resolve_with_cache_returns_none_for_missing_loudness() {
        let cache = AnalysisCache::open_in_memory();
        let g = resolve_loudness_gain_with_cache(
            &cache,
            "no-such-track",
            -14.0,
            ResolveLoudnessCacheOpts::default(),
        );
        assert!(g.is_none());
    }

    #[test]
    fn resolve_with_cache_returns_recommended_gain_for_existing_row() {
        let cache = AnalysisCache::open_in_memory();
        // Track at -23 LUFS, target -14 → recommended gain capped by true-peak (0.5 ≈ -6 dB).
        upsert_loudness_row(&cache, "abc", -23.0, -14.0);
        let g = resolve_loudness_gain_with_cache(
            &cache,
            "abc",
            -14.0,
            ResolveLoudnessCacheOpts::default(),
        )
        .expect("loudness row → Some(gain_db)");
        assert!(g.is_finite());
        // Target - integrated = +9, but true-peak guard caps it: max = -1 - 20*log10(0.5) ≈ +5.
        assert!((-1.0..=10.0).contains(&g), "gain_db = {g}");
    }

    // (NaN-roundtrip through SQLite is platform-dependent — rusqlite often
    // serialises f64::NAN as NULL, which fails column-decode rather than
    // round-tripping a non-finite value. The `.is_finite()` guard inside
    // `resolve_loudness_gain_with_cache` is defensive code that protects
    // against in-memory corruption; not directly testable via the cache API.)

    #[test]
    fn resolve_with_cache_finds_row_under_other_id_variant() {
        let cache = AnalysisCache::open_in_memory();
        // Insert under stream:abc, look up with bare abc — get_latest_*_for_track
        // walks both id variants.
        upsert_loudness_row(&cache, "stream:abc", -16.0, -14.0);
        let g = resolve_loudness_gain_with_cache(
            &cache,
            "abc",
            -14.0,
            ResolveLoudnessCacheOpts::default(),
        );
        assert!(g.is_some(), "bare-id lookup must find stream-prefixed row");
    }

    #[test]
    fn resolve_with_cache_respects_target_lufs_for_recommended_gain() {
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness_row(&cache, "abc", -20.0, -14.0);
        let g_quiet = resolve_loudness_gain_with_cache(
            &cache,
            "abc",
            -20.0,
            ResolveLoudnessCacheOpts::default(),
        )
        .unwrap();
        let g_loud = resolve_loudness_gain_with_cache(
            &cache,
            "abc",
            -10.0,
            ResolveLoudnessCacheOpts::default(),
        )
        .unwrap();
        assert!(
            g_loud > g_quiet,
            "higher target_lufs must yield higher recommended gain (quiet={g_quiet}, loud={g_loud})"
        );
    }

    #[test]
    fn resolve_with_cache_touch_waveform_false_does_not_panic() {
        // Smoke: opts.touch_waveform=false must not cause an SQL error or panic.
        let cache = AnalysisCache::open_in_memory();
        upsert_loudness_row(&cache, "abc", -20.0, -14.0);
        let opts = ResolveLoudnessCacheOpts {
            touch_waveform: false,
            log_soft_misses: false,
        };
        let g = resolve_loudness_gain_with_cache(&cache, "abc", -14.0, opts);
        assert!(g.is_some());
    }
}

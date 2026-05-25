use std::io::Cursor;
use std::time::Instant;

use ebur128::{EbuR128, Mode as Ebur128Mode};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use tauri::{Manager, Runtime};
use psysonic_core::track_enrichment::TrackEnrichmentOutcome;

use crate::analysis_perf::AnalysisSeedTimings;

use super::store::{now_unix_ts, AnalysisCache, LoudnessEntry, TrackKey, WaveformEntry};

pub fn recommended_gain_for_target(integrated_lufs: f64, true_peak: f64, target_lufs: f64) -> f64 {
    let mut recommended_gain_db = target_lufs - integrated_lufs;
    if true_peak > 0.0 {
        let true_peak_dbtp = 20.0 * true_peak.log10();
        let max_gain_db = -1.0 - true_peak_dbtp;
        if recommended_gain_db > max_gain_db {
            recommended_gain_db = max_gain_db;
        }
    }
    recommended_gain_db.clamp(-24.0, 24.0)
}

/// Result of [`seed_from_bytes_execute`] / CPU seed queue: callers use it to avoid redundant UI events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedFromBytesOutcome {
    /// Wrote waveform (and loudness when PCM decode succeeded).
    Upserted,
    /// Same `track_id` + `md5_16kb` already had a non-empty waveform for this algo version.
    SkippedWaveformCacheHit,
    /// `AnalysisCache` was not registered on the app handle.
    SkippedNoAnalysisCache,
}

/// Full Symphonia + (optional) EBU decode for waveform + loudness. Call only from the
/// single CPU-seed worker in `lib.rs` (`spawn_blocking`) so at most one heavy decode runs.
pub fn seed_from_bytes_execute<R: Runtime>(
    app: &tauri::AppHandle<R>,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
) -> Result<(SeedFromBytesOutcome, AnalysisSeedTimings), String> {
    let seed_started = Instant::now();
    let Some(cache) = app.try_state::<AnalysisCache>() else {
        crate::app_deprintln!(
            "[analysis][waveform] build skip track_id={} reason=no_analysis_cache bytes={}",
            track_id,
            bytes.len()
        );
        return Ok((
            SeedFromBytesOutcome::SkippedNoAnalysisCache,
            AnalysisSeedTimings::default(),
        ));
    };
    let (outcome, md5_16kb) = seed_from_bytes_into_cache(&cache, server_id, track_id, bytes)?;
    let seed_ms = seed_started.elapsed().as_millis() as u64;
    // E2 bridge (analysis → library content_hash): once the playback-derived
    // md5_16kb is known — whether freshly written or already cached — record it
    // as `track.content_hash` via the registered sink. Decoupled from
    // psysonic-library through the psysonic-core port; a no-op when the library
    // has no row for this (server_id, track_id). Skipped when no server is known.
    if !server_id.is_empty()
        && matches!(
            outcome,
            SeedFromBytesOutcome::Upserted | SeedFromBytesOutcome::SkippedWaveformCacheHit
        )
    {
        if let Some(sink) = app.try_state::<psysonic_core::ports::ContentHashSink>() {
            sink.record_content_hash(server_id, track_id, &md5_16kb);
        }
    }
    let bpm_ms = if !server_id.is_empty() {
        let bpm_started = Instant::now();
        let enrichment_outcome = crate::track_enrichment::run_track_enrichment_if_needed(
            app,
            server_id,
            track_id,
            bytes,
        );
        if matches!(enrichment_outcome, TrackEnrichmentOutcome::Failed) {
            let key = TrackKey {
                server_id: server_id.to_string(),
                track_id: track_id.to_string(),
                md5_16kb: md5_16kb.clone(),
            };
            let _ = cache.touch_track_status(&key, "failed");
        }
        if matches!(outcome, SeedFromBytesOutcome::Upserted) {
            if let Ok(coverage) = cache.content_cache_coverage(server_id, track_id, &md5_16kb) {
                if !coverage.has_loudness {
                    let key = TrackKey {
                        server_id: server_id.to_string(),
                        track_id: track_id.to_string(),
                        md5_16kb: md5_16kb.clone(),
                    };
                    let _ = cache.touch_track_status(&key, "failed");
                }
            }
        }
        bpm_started.elapsed().as_millis() as u64
    } else {
        0
    };
    Ok((
        outcome,
        AnalysisSeedTimings { seed_ms, bpm_ms },
    ))
}

/// AppHandle-free entry point for [`seed_from_bytes_execute`]: takes the cache
/// directly, runs the same Symphonia → waveform → EBU R128 pipeline, and
/// upserts the rows. Called from `seed_from_bytes_execute` in production and
/// from tests against an in-memory cache.
/// Returns the outcome plus the computed `md5_16kb` (the content fingerprint),
/// so the AppHandle-aware caller can bridge it to the library `content_hash`
/// (E2) without re-reading the bytes.
pub fn seed_from_bytes_into_cache(
    cache: &AnalysisCache,
    server_id: &str,
    track_id: &str,
    bytes: &[u8],
) -> Result<(SeedFromBytesOutcome, String), String> {
    let started = Instant::now();
    // Write under the playback server's scope.
    let key = TrackKey {
        server_id: server_id.to_string(),
        track_id: track_id.to_string(),
        md5_16kb: md5_first_16kb(bytes),
    };
    let coverage = cache.content_cache_coverage(server_id, track_id, &key.md5_16kb)?;
    if coverage.complete() {
        crate::app_deprintln!(
            "[analysis][waveform] build skip track_id={} reason=waveform_cache_hit md5_16kb={} elapsed_ms={}",
            track_id,
            key.md5_16kb,
            started.elapsed().as_millis()
        );
        return Ok((SeedFromBytesOutcome::SkippedWaveformCacheHit, key.md5_16kb.clone()));
    }
    if coverage.has_waveform && !coverage.has_loudness {
        crate::app_deprintln!(
            "[analysis][waveform] waveform cache hit but loudness missing — full re-analysis track_id={} md5_16kb={}",
            track_id,
            key.md5_16kb
        );
    }
    let mib = bytes.len() as f64 / (1024.0 * 1024.0);
    crate::app_deprintln!(
        "[analysis] full-track analysis start track_id={} input_mib={:.2} md5_16kb={}",
        track_id,
        mib,
        key.md5_16kb
    );
    crate::app_deprintln!(
        "[analysis] full-track analysis work: Symphonia decodes the entire buffer twice (frame timeline, then PCM peak bins), then EBU R128 integrated loudness + true-peak when that succeeds — CPU-bound; large lossless files often take minutes"
    );

    let build = (|| -> Result<(bool, usize), String> {
        cache.touch_track_status(&key, "queued")?;

        let (wf_bins, loudness_opt, used_pcm_decode) = match analyze_loudness_and_waveform(bytes, -16.0, 500) {
            Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs, bins)) => {
                (
                    bins,
                    Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs)),
                    true,
                )
            }
            None => (derive_waveform_bins(bytes, 500), None, false),
        };
        let bins_len = wf_bins.len();
        let waveform = WaveformEntry {
            bins: wf_bins,
            bin_count: 500,
            is_partial: false,
            known_until_sec: 0.0,
            duration_sec: 0.0,
            updated_at: now_unix_ts(),
        };
        cache.upsert_waveform(&key, &waveform)?;

        if let Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs)) = loudness_opt {
            let loudness = LoudnessEntry {
                integrated_lufs,
                true_peak,
                recommended_gain_db,
                target_lufs,
                updated_at: now_unix_ts(),
            };
            cache.upsert_loudness(&key, &loudness)?;
        }

        cache.touch_track_status(&key, "ready")?;
        let _ = cache.checkpoint_wal("analysis.seed");
        Ok((used_pcm_decode, bins_len))
    })();

    let elapsed_ms = started.elapsed().as_millis();
    match &build {
        Ok((used_pcm_decode, bins_len)) => {
            crate::app_deprintln!(
                "[analysis] full-track analysis done track_id={} elapsed_ms={} decode_path={} bins_len={} ebu_loudness_cached={}",
                track_id,
                elapsed_ms,
                if *used_pcm_decode {
                    "pcm_ebur128"
                } else {
                    "byte_envelope_no_ebu"
                },
                bins_len,
                *used_pcm_decode
            );
        }
        Err(e) => {
            let _ = cache.touch_track_status(&key, "failed");
            crate::app_deprintln!(
                "[analysis] full-track analysis failed track_id={} elapsed_ms={} err={}",
                track_id,
                elapsed_ms,
                e
            );
        }
    }

    match build {
        Ok(_) => Ok((SeedFromBytesOutcome::Upserted, key.md5_16kb.clone())),
        Err(e) => Err(e),
    }
}

pub fn md5_first_16kb(bytes: &[u8]) -> String {
    let n = bytes.len().min(16 * 1024);
    format!("{:x}", md5::compute(&bytes[..n]))
}

fn derive_waveform_bins(bytes: &[u8], bin_count: usize) -> Vec<u8> {
    if bin_count == 0 || bytes.is_empty() {
        return Vec::new();
    }
    let mut peak_half = vec![0u8; bin_count];
    for (i, slot) in peak_half.iter_mut().enumerate() {
        let start = i * bytes.len() / bin_count;
        let end = ((i + 1) * bytes.len() / bin_count).max(start + 1).min(bytes.len());
        let mut peak: u8 = 0;
        for &b in &bytes[start..end] {
            let centered = b.abs_diff(128);
            if centered > peak {
                peak = centered;
            }
        }
        *slot = ((peak as f32 / 127.0).sqrt().clamp(0.0, 1.0) * 255.0) as u8;
    }
    let mut out = peak_half.clone();
    out.extend_from_slice(&peak_half);
    out
}

struct PcmScanResult {
    bins: Vec<u8>,
    loudness: Option<(f64, f64, f64, f64)>,
}

/// Loudness (EBU R128) plus PCM waveform bins in one decode pass after a frame count.
fn analyze_loudness_and_waveform(
    bytes: &[u8],
    target_lufs: f64,
    bin_count: usize,
) -> Option<(f64, f64, f64, f64, Vec<u8>)> {
    if bytes.is_empty() || bin_count == 0 {
        return None;
    }
    let (decoded_frames, timeline_hint) = count_mono_frames_from_audio_bytes(bytes)?;
    if decoded_frames == 0 {
        return None;
    }
    let scanned = decode_scan_pcm(bytes, bin_count, decoded_frames, timeline_hint, Some(target_lufs))?;
    let (i, t, r, tgt) = scanned.loudness?;
    Some((i, t, r, tgt, scanned.bins))
}

/// One-shot Symphonia setup: probe the byte buffer, pick a usable track, and
/// build a decoder for it. `timeline_hint` carries `codec_params.n_frames`
/// when the container reports total track length.
struct DecodeSession {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    timeline_hint: Option<u64>,
}

fn open_decode_session(bytes: &[u8]) -> Option<DecodeSession> {
    let source = Box::new(Cursor::new(bytes.to_vec()));
    let mss = MediaSourceStream::new(source, Default::default());
    let hint = Hint::new();
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let format = probed.format;
    let track = format
        .default_track()
        .filter(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .or_else(|| {
            format.tracks().iter().find(|t| {
                t.codec_params.codec != CODEC_TYPE_NULL
                    && t.codec_params.sample_rate.is_some()
                    && t.codec_params.channels.is_some()
            })
        })
        .or_else(|| format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL))?;
    let track_id = track.id;
    let timeline_hint = track.codec_params.n_frames.filter(|&n| n > 0);
    let codec_params = track.codec_params.clone();
    let decoder = match symphonia::default::get_codecs().make(&codec_params, &DecoderOptions::default()) {
        Ok(v) => v,
        Err(e) => {
            crate::app_deprintln!("[analysis] decoder make failed: {}", e);
            return None;
        }
    };
    Some(DecodeSession { format, decoder, track_id, timeline_hint })
}

/// Returns `(decoded_mono_frames, container_timeline_frames)` where the second is
/// `codec_params.n_frames` when the container reports total track length — used
/// as a **fixed** waveform time axis so partial decodes do not remap every bin
/// when the buffer grows.
fn count_mono_frames_from_audio_bytes(bytes: &[u8]) -> Option<(u64, Option<u64>)> {
    let DecodeSession { mut format, mut decoder, track_id, timeline_hint } =
        open_decode_session(bytes)?;

    let mut total: u64 = 0;
    let mut loop_i: u32 = 0;
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(buf) => buf,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let n_ch = spec.channels.count();
        if n_ch == 0 {
            continue;
        }
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        let n = samples.samples().len();
        if n < n_ch || !n.is_multiple_of(n_ch) {
            continue;
        }
        total += (n / n_ch) as u64;
        loop_i = loop_i.wrapping_add(1);
        if loop_i.is_multiple_of(128) {
            std::thread::yield_now();
        }
    }
    if total == 0 {
        None
    } else {
        Some((total, timeline_hint))
    }
}

fn normalize_peak_bins(bin_max: &[f32]) -> Vec<u8> {
    let bin_count = bin_max.len();
    if bin_count == 0 {
        return Vec::new();
    }
    let mut sorted: Vec<f32> = bin_max.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p5 = sorted[(sorted.len() * 5 / 100).min(sorted.len().saturating_sub(1))];
    let p99 = sorted[(sorted.len() * 99 / 100).min(sorted.len().saturating_sub(1))];
    let range = (p99 - p5).max(1e-8);
    let mut out = vec![0u8; bin_count];
    for i in 0..bin_count {
        let t = ((bin_max[i] - p5) / range).clamp(0.0, 1.0);
        let shaped = t.powf(0.52);
        out[i] = (8.0 + shaped * 247.0).min(255.0) as u8;
    }
    out
}

fn decode_scan_pcm(
    bytes: &[u8],
    bin_count: usize,
    decoded_frames: u64,
    timeline_hint: Option<u64>,
    loudness_target_lufs: Option<f64>,
) -> Option<PcmScanResult> {
    let DecodeSession { mut format, mut decoder, track_id, .. } = open_decode_session(bytes)?;

    let mut bin_max = vec![0.0f32; bin_count];
    let mut bin_sum = vec![0.0f32; bin_count];
    let mut bin_n = vec![0u32; bin_count];
    let mut ebu: Option<EbuR128> = None;
    let mut ebu_channels: u32 = 0;
    let mut sample_peak_abs = 0.0_f64;
    let mut fed_any_frames = false;
    let mut sample_idx: u64 = 0;
    let mut loop_i: u32 = 0;
    // Bin mapping must use the decoded mono sample count. When the container
    // reports `n_frames` **larger** than what we actually decoded (bad VBR tags,
    // wrong duration in headers) but the buffer is already the full file — all
    // CPU-seed paths pass a complete artifact — using `max(n_frames, decoded)`
    // squashes the entire waveform into the leading bins ("only the start").
    if let Some(n) = timeline_hint {
        if n > decoded_frames {
            crate::app_deprintln!(
                "[analysis][waveform] bin_grid: ignore container n_frames={} (> decoded {}) — map bins to decoded length",
                n,
                decoded_frames
            );
        }
    }
    let bin_grid_frames = decoded_frames.max(1);

    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(buf) => buf,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };

        let spec = *decoded.spec();
        let n_ch = spec.channels.count();
        if n_ch == 0 {
            continue;
        }

        if loudness_target_lufs.is_some() && ebu.is_none() {
            let ch = spec.channels.count() as u32;
            let sr = spec.rate;
            match EbuR128::new(ch, sr, Ebur128Mode::I | Ebur128Mode::TRUE_PEAK) {
                Ok(v) => {
                    ebu = Some(v);
                    ebu_channels = ch;
                }
                Err(e) => {
                    crate::app_deprintln!(
                        "[analysis] EbuR128 init failed: channels={} sample_rate={} err={}",
                        ch,
                        sr,
                        e
                    );
                    return None;
                }
            }
        }

        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        let slice = samples.samples();
        if slice.len() < n_ch || !slice.len().is_multiple_of(n_ch) {
            continue;
        }
        let frames = slice.len() / n_ch;

        for f in 0..frames {
            let base = f * n_ch;
            let mut acc = 0.0f32;
            for c in 0..n_ch {
                acc += slice[base + c];
            }
            let mono = acc / (n_ch as f32);
            let mag = mono.abs();
            if mag.is_finite() {
                let bin = ((sample_idx * bin_count as u64) / bin_grid_frames) as usize;
                let bin = bin.min(bin_count.saturating_sub(1));
                bin_max[bin] = bin_max[bin].max(mag);
                bin_sum[bin] += mag;
                bin_n[bin] = bin_n[bin].saturating_add(1);
            }
            for c in 0..n_ch {
                let v = (slice[base + c] as f64).abs();
                if v.is_finite() && v > sample_peak_abs {
                    sample_peak_abs = v;
                }
            }
            sample_idx += 1;
        }

        if loudness_target_lufs.is_some() {
            if let Some(e) = ebu.as_mut() {
                match e.add_frames_f32(samples.samples()) {
                    Ok(_) => fed_any_frames = true,
                    Err(err) => {
                        crate::app_deprintln!("[analysis] loudness add_frames failed: {}", err);
                        return None;
                    }
                }
            }
        }

        loop_i = loop_i.wrapping_add(1);
        if loop_i.is_multiple_of(128) {
            std::thread::yield_now();
        }
    }

    let mut bin_mean = vec![0.0f32; bin_count];
    for i in 0..bin_count {
        if bin_n[i] > 0 {
            bin_mean[i] = bin_sum[i] / (bin_n[i] as f32);
        }
    }
    let peak_u8 = normalize_peak_bins(&bin_max);
    let mean_u8 = normalize_peak_bins(&bin_mean);
    let mut bins = Vec::with_capacity(peak_u8.len().saturating_mul(2));
    bins.extend_from_slice(&peak_u8);
    bins.extend_from_slice(&mean_u8);

    let loudness = if let Some(target_lufs) = loudness_target_lufs {
        if !fed_any_frames {
            crate::app_deprintln!("[analysis] loudness failed: no decoded frames");
            return None;
        }
        let Some(ebu) = ebu else {
            crate::app_deprintln!("[analysis] loudness failed: ebu not initialized");
            return None;
        };
        let integrated_lufs = match ebu.loudness_global() {
            Ok(v) => v,
            Err(e) => {
                crate::app_deprintln!("[analysis] loudness_global failed: {}", e);
                return None;
            }
        };
        if !integrated_lufs.is_finite() {
            crate::app_deprintln!("[analysis] loudness failed: integrated_lufs not finite");
            return None;
        }
        let mut true_peak = 0.0_f64;
        let mut true_peak_ok = true;
        for ch in 0..ebu_channels {
            match ebu.true_peak(ch) {
                Ok(v) if v.is_finite() && v > true_peak => true_peak = v,
                Ok(_) => {}
                Err(e) => {
                    true_peak_ok = false;
                    crate::app_deprintln!("[analysis] true_peak unavailable: {}", e);
                    break;
                }
            }
        }
        if !true_peak_ok {
            true_peak = sample_peak_abs;
        }
        let recommended_gain_db =
            recommended_gain_for_target(integrated_lufs, true_peak, target_lufs);
        Some((integrated_lufs, true_peak, recommended_gain_db, target_lufs))
    } else {
        None
    };

    Some(PcmScanResult { bins, loudness })
}

/// PCM window for short MIR-style analysis (typically 60 s from track center).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PcmAnalysisWindow {
    pub start_sec: f64,
    pub duration_sec: f64,
}

/// Pick a centered analysis window, or the full track when shorter than `window_sec`.
pub fn analysis_pcm_window(total_duration_sec: f64, window_sec: f64) -> PcmAnalysisWindow {
    let total = total_duration_sec.max(0.0);
    let window = window_sec.max(0.1);
    if total <= window || !total.is_finite() {
        return PcmAnalysisWindow {
            start_sec: 0.0,
            duration_sec: if total > 0.0 { total } else { window },
        };
    }
    let start = ((total - window) / 2.0).max(0.0);
    PcmAnalysisWindow {
        start_sec: start,
        duration_sec: window,
    }
}

/// Best-effort container duration from codec metadata (seconds).
pub fn audio_duration_from_bytes(bytes: &[u8]) -> Option<f64> {
    let session = open_decode_session(bytes)?;
    let sample_rate = session
        .format
        .default_track()
        .or_else(|| session.format.tracks().first())
        .and_then(|t| t.codec_params.sample_rate)
        .filter(|&sr| sr > 0)?;
    let frames = session.timeline_hint?;
    Some(frames as f64 / sample_rate as f64)
}

/// Decode mono PCM for a time window. Seeks when `start_sec > 0`.
pub fn decode_mono_pcm_window(
    bytes: &[u8],
    start_sec: f64,
    window_sec: f64,
) -> Result<(Vec<f32>, f32), String> {
    if bytes.is_empty() {
        return Err("empty audio buffer".to_string());
    }
    let DecodeSession {
        mut format,
        mut decoder,
        track_id,
        ..
    } = open_decode_session(bytes).ok_or_else(|| "failed to open audio decode session".to_string())?;

    if start_sec.is_finite() && start_sec > 0.0 {
        let time: Time = start_sec.max(0.0).into();
        format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(track_id),
                },
            )
            .map_err(|e| format!("pcm window seek failed: {e}"))?;
    }

    decode_mono_pcm_from_session(&mut format, &mut decoder, track_id, Some(window_sec))
}

/// Decode audio bytes to mono f32 PCM, optionally capped at `max_seconds`.
pub fn decode_mono_pcm_limited(
    bytes: &[u8],
    max_seconds: Option<f64>,
) -> Result<(Vec<f32>, f32), String> {
    if bytes.is_empty() {
        return Err("empty audio buffer".to_string());
    }
    let DecodeSession {
        mut format,
        mut decoder,
        track_id,
        ..
    } = open_decode_session(bytes).ok_or_else(|| "failed to open audio decode session".to_string())?;
    decode_mono_pcm_from_session(&mut format, &mut decoder, track_id, max_seconds)
}

fn decode_mono_pcm_from_session(
    format: &mut Box<dyn FormatReader>,
    decoder: &mut Box<dyn Decoder>,
    track_id: u32,
    max_seconds: Option<f64>,
) -> Result<(Vec<f32>, f32), String> {
    let mut mono = Vec::new();
    let mut sample_rate = 0_f32;
    let mut max_frames: Option<u64> = None;
    let mut loop_i: u32 = 0;

    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(buf) => buf,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };

        let spec = *decoded.spec();
        let n_ch = spec.channels.count();
        if n_ch == 0 {
            continue;
        }
        if sample_rate <= 0.0 {
            sample_rate = spec.rate as f32;
            if sample_rate <= 0.0 {
                return Err("invalid sample rate".to_string());
            }
            max_frames = max_seconds.and_then(|sec| {
                if sec.is_finite() && sec > 0.0 {
                    Some((sec * sample_rate as f64).max(1.0) as u64)
                } else {
                    None
                }
            });
        }

        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        let slice = samples.samples();
        if slice.len() < n_ch || !slice.len().is_multiple_of(n_ch) {
            continue;
        }
        let frames = slice.len() / n_ch;
        for f in 0..frames {
            if let Some(limit) = max_frames {
                if mono.len() as u64 >= limit {
                    break;
                }
            }
            let base = f * n_ch;
            let mut acc = 0.0_f32;
            for c in 0..n_ch {
                acc += slice[base + c];
            }
            mono.push(acc / (n_ch as f32));
        }
        if max_frames.is_some_and(|limit| mono.len() as u64 >= limit) {
            break;
        }

        loop_i = loop_i.wrapping_add(1);
        if loop_i.is_multiple_of(128) {
            std::thread::yield_now();
        }
    }

    if mono.is_empty() {
        return Err("no PCM frames decoded".to_string());
    }
    Ok((mono, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_f64(a: f64, b: f64, eps: f64) {
        assert!((a - b).abs() < eps, "expected {b}, got {a}");
    }

    // ── recommended_gain_for_target ───────────────────────────────────────────

    #[test]
    fn recommended_gain_is_target_minus_integrated_when_no_peak() {
        approx_f64(recommended_gain_for_target(-14.0, 0.0, -10.0), 4.0, 1e-9);
        approx_f64(recommended_gain_for_target(-23.0, 0.0, -14.0), 9.0, 1e-9);
    }

    #[test]
    fn recommended_gain_caps_to_avoid_clipping_when_true_peak_is_high() {
        // true_peak = 1.0 (0 dBTP) → max_gain_db = -1.0 - 0 = -1.0
        // target - integrated = -10 - (-14) = 4.0, but capped to -1.0.
        let g = recommended_gain_for_target(-14.0, 1.0, -10.0);
        approx_f64(g, -1.0, 1e-6);
    }

    #[test]
    fn recommended_gain_clamps_to_plus_minus_24() {
        let huge_up = recommended_gain_for_target(-100.0, 0.0, 100.0);
        let huge_down = recommended_gain_for_target(100.0, 0.0, -100.0);
        assert_eq!(huge_up, 24.0);
        assert_eq!(huge_down, -24.0);
    }

    #[test]
    fn analysis_pcm_window_uses_center_for_long_tracks() {
        let w = analysis_pcm_window(180.0, 60.0);
        assert!((w.start_sec - 60.0).abs() < 1e-9);
        assert!((w.duration_sec - 60.0).abs() < 1e-9);
    }

    #[test]
    fn analysis_pcm_window_uses_full_track_when_short() {
        let w = analysis_pcm_window(45.0, 60.0);
        assert_eq!(w.start_sec, 0.0);
        assert!((w.duration_sec - 45.0).abs() < 1e-9);
    }

    // ── md5_first_16kb ────────────────────────────────────────────────────────

    #[test]
    fn md5_of_empty_bytes_matches_md5_empty() {
        // md5 of "" = d41d8cd98f00b204e9800998ecf8427e
        assert_eq!(md5_first_16kb(&[]), "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn md5_uses_full_data_when_under_16kb() {
        let data = b"hello world";
        let direct = format!("{:x}", md5::compute(data));
        assert_eq!(md5_first_16kb(data), direct);
    }

    #[test]
    fn md5_truncates_to_first_16kb() {
        let mut data = vec![0xAAu8; 16 * 1024];
        let prefix_only = format!("{:x}", md5::compute(&data));
        // Append distinguishing bytes past 16 KB; the digest must not change.
        data.extend_from_slice(b"---should be ignored by md5_first_16kb---");
        assert_eq!(md5_first_16kb(&data), prefix_only);
    }

    // ── derive_waveform_bins ──────────────────────────────────────────────────

    #[test]
    fn derive_waveform_returns_empty_for_zero_bin_count() {
        assert_eq!(derive_waveform_bins(&[1u8, 2, 3, 4], 0), Vec::<u8>::new());
    }

    #[test]
    fn derive_waveform_returns_empty_for_empty_bytes() {
        assert_eq!(derive_waveform_bins(&[], 4), Vec::<u8>::new());
    }

    #[test]
    fn derive_waveform_silence_at_midpoint_yields_zero_bins() {
        // 128 is the unsigned-PCM midpoint: abs_diff(128) == 0 for every sample.
        let silence = vec![128u8; 64];
        let out = derive_waveform_bins(&silence, 8);
        assert!(out.iter().all(|&b| b == 0), "silence must produce all-zero bins, got {out:?}");
    }

    #[test]
    fn derive_waveform_doubles_the_bin_buffer() {
        // The function returns peak_half twice (peak followed by mean-abs placeholder).
        let bytes = vec![0u8; 32];
        let out = derive_waveform_bins(&bytes, 4);
        assert_eq!(out.len(), 8, "output must be 2 * bin_count");
        assert_eq!(&out[..4], &out[4..]);
    }

    #[test]
    fn derive_waveform_reaches_max_for_extreme_amplitude() {
        // Extreme deviation from 128 → centered = 127 (when input is 0 or 255).
        // (127/127)^0.5 = 1.0 → 255 in u8.
        let bytes = vec![0u8; 16];
        let out = derive_waveform_bins(&bytes, 4);
        assert!(out.iter().all(|&b| b == 255), "max amplitude must yield 255 bins");
    }

    // ── normalize_peak_bins ───────────────────────────────────────────────────

    #[test]
    fn normalize_peak_returns_empty_for_empty_input() {
        assert_eq!(normalize_peak_bins(&[]), Vec::<u8>::new());
    }

    #[test]
    fn normalize_peak_uniform_input_collapses_to_base_offset() {
        // p5 == p99 → range collapses to 1e-8 floor; t = (x - p5)/range = 0 for all.
        // shaped = 0; out = 8 (base offset).
        let bins = vec![0.5f32; 16];
        let out = normalize_peak_bins(&bins);
        assert_eq!(out.len(), 16);
        assert!(out.iter().all(|&b| b == 8), "got {out:?}");
    }

    #[test]
    fn normalize_peak_monotonic_input_yields_increasing_output() {
        // Strictly increasing input must produce non-decreasing output.
        let bins: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        let out = normalize_peak_bins(&bins);
        for win in out.windows(2) {
            assert!(win[0] <= win[1], "non-monotonic output around {:?}", win);
        }
        // Output range ⊆ [8, 255].
        assert!(out.iter().all(|&b| (8..=255).contains(&b)));
    }

    // ── End-to-end: WAV decode → waveform + loudness pipeline ────────────────
    //
    // Symphonia's PCM/WAV decoder is the cheapest format we can feed end-to-end
    // without committing a binary fixture. Every test here generates a tiny
    // mono 16-bit-PCM WAV (~150 KB for 1.5 s @ 44.1 kHz) at runtime, hands the
    // bytes to the real seed pipeline, and asserts on the cached rows.

    /// Build a mono signed-16-bit-PCM WAV from a sample buffer at `sample_rate`.
    /// Produces a buffer ready to be probed by Symphonia's WAV format reader.
    fn build_mono_pcm16_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
        let num_channels: u16 = 1;
        let bits_per_sample: u16 = 16;
        let byte_rate = sample_rate * (bits_per_sample as u32 / 8) * num_channels as u32;
        let block_align = num_channels * (bits_per_sample / 8);
        let data_size = (samples.len() * 2) as u32;
        let riff_size = 36 + data_size;

        let mut out = Vec::with_capacity(44 + data_size as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&riff_size.to_le_bytes());
        out.extend_from_slice(b"WAVE");
        // fmt chunk
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes()); // sub-chunk size
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM format tag
        out.extend_from_slice(&num_channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&bits_per_sample.to_le_bytes());
        // data chunk
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_size.to_le_bytes());
        for s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    /// Generate a 1-second 440 Hz sine wave at -6 dBFS as a Vec<i16>.
    fn sine_440_at_minus_6db(sample_rate: u32, secs: f32) -> Vec<i16> {
        let n = (sample_rate as f32 * secs) as usize;
        let amplitude: f32 = 0.5 * i16::MAX as f32; // -6 dBFS
        (0..n)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                let v = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * amplitude;
                v as i16
            })
            .collect()
    }

    #[test]
    fn count_mono_frames_returns_decoded_length_for_synthetic_wav() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let (frames, _hint) = count_mono_frames_from_audio_bytes(&wav)
            .expect("WAV decode must succeed");
        // 1 second × 44.1 kHz mono = 44 100 frames; allow ±1 packet tolerance.
        assert!(
            (43_900..=44_300).contains(&frames),
            "expected ~44100 frames, got {frames}"
        );
    }

    #[test]
    fn count_mono_frames_returns_none_for_garbage_bytes() {
        assert!(count_mono_frames_from_audio_bytes(b"not an audio file").is_none());
    }

    #[test]
    fn count_mono_frames_returns_none_for_empty_bytes() {
        assert!(count_mono_frames_from_audio_bytes(&[]).is_none());
    }

    #[test]
    fn analyze_loudness_and_waveform_returns_loudness_for_synthetic_sine() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.5), 44_100);
        let result = analyze_loudness_and_waveform(&wav, -14.0, 100)
            .expect("WAV decode must succeed");
        let (integrated_lufs, true_peak, recommended_gain_db, target_lufs, bins) = result;
        assert_eq!(bins.len(), 200, "bins layout is peak_u8 + mean_u8 = 2 * bin_count");
        assert_eq!(target_lufs, -14.0);
        // -6 dBFS sine ≈ -9 LUFS integrated for 1.5 s. EBU R128 needs >=400 ms
        // of audio; we have 1.5 s so the measurement is valid.
        assert!(
            (-30.0..0.0).contains(&integrated_lufs),
            "integrated LUFS must be in a sane range, got {integrated_lufs}"
        );
        // True peak for -6 dBFS sine ≈ 0.5 linear amplitude.
        assert!(
            (0.4..=0.6).contains(&true_peak),
            "true peak must reflect -6 dBFS amplitude, got {true_peak}"
        );
        // Recommended gain pushes the track toward the target LUFS,
        // capped per `recommended_gain_for_target`.
        assert!(recommended_gain_db.is_finite());
        assert!((-24.0..=24.0).contains(&recommended_gain_db));
    }

    #[test]
    fn analyze_loudness_returns_none_for_zero_bin_count() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 0.5), 44_100);
        assert!(analyze_loudness_and_waveform(&wav, -14.0, 0).is_none());
    }

    #[test]
    fn analyze_loudness_returns_none_for_empty_bytes() {
        assert!(analyze_loudness_and_waveform(&[], -14.0, 100).is_none());
    }

    #[test]
    fn seed_from_bytes_into_cache_upserts_waveform_and_loudness_for_wav() {
        let cache = AnalysisCache::open_in_memory();
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.5), 44_100);
        let (outcome, md5) = seed_from_bytes_into_cache(&cache, "server-a", "wav-track", &wav).unwrap();
        assert_eq!(outcome, SeedFromBytesOutcome::Upserted);
        assert_eq!(md5, md5_first_16kb(&wav), "outcome carries the content fingerprint");

        // Both a waveform AND a loudness row must exist after a successful
        // PCM decode + EBU R128 analysis.
        let key = TrackKey {
            server_id: "server-a".to_string(),
            track_id: "wav-track".to_string(),
            md5_16kb: md5_first_16kb(&wav),
        };
        let waveform = cache.get_waveform(&key).unwrap().expect("waveform cached");
        assert_eq!(waveform.bin_count, 500);
        assert_eq!(waveform.bins.len(), 1000, "bins are 2 * bin_count");
        assert!(cache.loudness_row_exists_for_key(&key).unwrap());
    }

    #[test]
    fn seed_from_bytes_into_cache_writes_under_the_given_server_scope() {
        let cache = AnalysisCache::open_in_memory();
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.5), 44_100);
        seed_from_bytes_into_cache(&cache, "server-x", "scoped-track", &wav).unwrap();

        let md5 = md5_first_16kb(&wav);
        let scoped = TrackKey {
            server_id: "server-x".to_string(),
            track_id: "scoped-track".to_string(),
            md5_16kb: md5.clone(),
        };
        assert!(cache.get_waveform(&scoped).unwrap().is_some(), "row lands under server scope");
        let other = TrackKey {
            server_id: "server-y".to_string(),
            track_id: "scoped-track".to_string(),
            md5_16kb: md5,
        };
        assert!(cache.get_waveform(&other).unwrap().is_none(), "row stays under the exact server");
    }

    #[test]
    fn seed_from_bytes_into_cache_returns_skipped_on_second_call() {
        let cache = AnalysisCache::open_in_memory();
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let (first, _) = seed_from_bytes_into_cache(&cache, "server-a", "wav-track-2", &wav).unwrap();
        assert_eq!(first, SeedFromBytesOutcome::Upserted);
        let (second, _) = seed_from_bytes_into_cache(&cache, "server-a", "wav-track-2", &wav).unwrap();
        assert_eq!(
            second,
            SeedFromBytesOutcome::SkippedWaveformCacheHit,
            "second seed sees cache + loudness rows and short-circuits"
        );
    }

    #[test]
    fn seed_from_bytes_into_cache_falls_back_to_byte_envelope_for_undecodable_input() {
        let cache = AnalysisCache::open_in_memory();
        // Garbage bytes — Symphonia probe fails, the pipeline falls back to
        // `derive_waveform_bins` (no loudness row gets cached).
        let bytes = vec![0xAAu8; 8 * 1024];
        let (outcome, _) = seed_from_bytes_into_cache(&cache, "server-a", "garbage", &bytes).unwrap();
        assert_eq!(outcome, SeedFromBytesOutcome::Upserted);

        let key = TrackKey {
            server_id: "server-a".to_string(),
            track_id: "garbage".to_string(),
            md5_16kb: md5_first_16kb(&bytes),
        };
        let waveform = cache.get_waveform(&key).unwrap().expect("byte-envelope waveform cached");
        assert_eq!(waveform.bin_count, 500);
        assert!(
            !cache.loudness_row_exists_for_key(&key).unwrap(),
            "byte-envelope fallback must not cache loudness"
        );
    }

    #[test]
    fn audio_duration_from_bytes_reports_duration_for_wav() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 2.0), 44_100);
        let duration = audio_duration_from_bytes(&wav).expect("duration must be available");
        assert!(
            (1.8..=2.2).contains(&duration),
            "expected ~2s duration, got {duration}"
        );
    }

    #[test]
    fn audio_duration_from_bytes_returns_none_for_garbage() {
        assert!(audio_duration_from_bytes(b"not audio").is_none());
    }

    #[test]
    fn decode_mono_pcm_limited_decodes_and_respects_limit() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(48_000, 2.0), 48_000);
        let (full_pcm, sr_full) = decode_mono_pcm_limited(&wav, None).expect("full decode");
        assert_eq!(sr_full, 48_000.0);
        assert!(
            full_pcm.len() >= 95_000,
            "2 seconds at 48kHz should decode close to 96k samples"
        );

        let (limited_pcm, sr_limited) =
            decode_mono_pcm_limited(&wav, Some(0.25)).expect("limited decode");
        assert_eq!(sr_limited, 48_000.0);
        assert!(
            (11_500..=12_500).contains(&limited_pcm.len()),
            "0.25 seconds at 48kHz should decode ~12k samples, got {}",
            limited_pcm.len()
        );
        assert!(limited_pcm.len() < full_pcm.len());
    }

    #[test]
    fn decode_mono_pcm_limited_rejects_empty_buffer() {
        let err = decode_mono_pcm_limited(&[], Some(1.0)).unwrap_err();
        assert!(err.contains("empty audio buffer"));
    }

    #[test]
    fn decode_mono_pcm_window_decodes_center_slice() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 2.0), 44_100);
        let (window_pcm, sr) = decode_mono_pcm_window(&wav, 0.75, 0.5).expect("window decode");
        assert_eq!(sr, 44_100.0);
        assert!(
            (20_000..=24_000).contains(&window_pcm.len()),
            "0.5 seconds at 44.1kHz should decode ~22k samples, got {}",
            window_pcm.len()
        );
    }

    #[test]
    fn decode_mono_pcm_window_rejects_invalid_bytes() {
        let err = decode_mono_pcm_window(b"not-audio", 0.0, 1.0).unwrap_err();
        assert!(
            err.contains("failed to open audio decode session"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn decode_scan_pcm_supports_waveform_only_mode_without_loudness() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let (frames, hint) = count_mono_frames_from_audio_bytes(&wav).expect("frame counting");
        let scanned = decode_scan_pcm(&wav, 64, frames, hint, None).expect("scan must succeed");
        assert_eq!(scanned.bins.len(), 128);
        assert!(scanned.loudness.is_none());
    }

    #[test]
    fn decode_scan_pcm_with_loudness_target_returns_loudness_tuple() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let (frames, hint) = count_mono_frames_from_audio_bytes(&wav).expect("frame counting");
        let scanned = decode_scan_pcm(&wav, 64, frames, hint, Some(-14.0)).expect("scan must succeed");
        assert_eq!(scanned.bins.len(), 128);
        let (integrated_lufs, true_peak, recommended_gain_db, target_lufs) =
            scanned.loudness.expect("loudness tuple must be present");
        assert!(integrated_lufs.is_finite());
        assert!(true_peak.is_finite());
        assert!((-24.0..=24.0).contains(&recommended_gain_db));
        assert_eq!(target_lufs, -14.0);
    }

    #[test]
    fn decode_scan_pcm_returns_none_for_non_audio_input() {
        assert!(decode_scan_pcm(b"nope", 32, 10, None, Some(-14.0)).is_none());
    }

    #[test]
    fn seed_from_bytes_reanalyzes_when_waveform_exists_without_loudness() {
        let cache = AnalysisCache::open_in_memory();
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let md5 = md5_first_16kb(&wav);
        let key = TrackKey {
            server_id: "server-a".to_string(),
            track_id: "track-reseed".to_string(),
            md5_16kb: md5,
        };
        cache.touch_track_status(&key, "ready").unwrap();
        cache
            .upsert_waveform(
                &key,
                &WaveformEntry {
                    bins: vec![8u8; 1000],
                    bin_count: 500,
                    is_partial: false,
                    known_until_sec: 0.0,
                    duration_sec: 0.0,
                    updated_at: now_unix_ts(),
                },
            )
            .unwrap();
        assert!(!cache.loudness_row_exists_for_key(&key).unwrap());

        let (outcome, _) =
            seed_from_bytes_into_cache(&cache, "server-a", "track-reseed", &wav).unwrap();
        assert_eq!(outcome, SeedFromBytesOutcome::Upserted);
        assert!(cache.loudness_row_exists_for_key(&key).unwrap());
    }

    #[test]
    fn analysis_pcm_window_handles_negative_and_non_finite_durations() {
        let neg = analysis_pcm_window(-42.0, 60.0);
        assert_eq!(neg.start_sec, 0.0);
        assert_eq!(neg.duration_sec, 60.0);

        let inf = analysis_pcm_window(f64::INFINITY, 60.0);
        assert_eq!(inf.start_sec, 0.0);
        assert!(!inf.duration_sec.is_finite());
    }

    #[test]
    fn decode_mono_pcm_window_rejects_empty_buffer() {
        let err = decode_mono_pcm_window(&[], 0.0, 1.0).unwrap_err();
        assert!(err.contains("empty audio buffer"));
    }

    #[test]
    fn decode_mono_pcm_limited_rejects_invalid_bytes() {
        let err = decode_mono_pcm_limited(b"not-audio", Some(0.5)).unwrap_err();
        assert!(err.contains("failed to open audio decode session"));
    }

    #[test]
    fn decode_mono_pcm_limited_ignores_non_positive_or_non_finite_cap() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let (full_a, _) = decode_mono_pcm_limited(&wav, None).unwrap();
        let (full_b, _) = decode_mono_pcm_limited(&wav, Some(0.0)).unwrap();
        let (full_c, _) = decode_mono_pcm_limited(&wav, Some(f64::NAN)).unwrap();
        assert_eq!(full_a.len(), full_b.len());
        assert_eq!(full_a.len(), full_c.len());
    }

    #[test]
    fn decode_scan_pcm_returns_none_when_no_frames_decoded() {
        let wav = build_mono_pcm16_wav(&[], 44_100);
        assert!(analyze_loudness_and_waveform(&wav, -14.0, 64).is_none());
    }

    #[test]
    fn decode_scan_pcm_ignores_oversized_timeline_hint() {
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 1.0), 44_100);
        let (frames, _hint) = count_mono_frames_from_audio_bytes(&wav).expect("frame counting");
        let scanned = decode_scan_pcm(&wav, 64, frames, Some(frames * 10), None).unwrap();
        assert_eq!(scanned.bins.len(), 128);
    }

    #[test]
    fn seed_from_bytes_execute_returns_no_cache_without_registered_state() {
        let app = tauri::test::mock_app();
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 0.25), 44_100);
        let handle = app.handle().clone();
        let (outcome, timings) = seed_from_bytes_execute(&handle, "s", "t", &wav)
            .expect("seed execute should return a graceful skip");
        assert_eq!(outcome, SeedFromBytesOutcome::SkippedNoAnalysisCache);
        assert_eq!(timings.seed_ms, 0);
        assert_eq!(timings.bpm_ms, 0);
    }

    #[test]
    fn seed_from_bytes_execute_runs_with_registered_cache() {
        let app = tauri::test::mock_app();
        app.manage(AnalysisCache::open_in_memory());
        let wav = build_mono_pcm16_wav(&sine_440_at_minus_6db(44_100, 0.5), 44_100);
        let handle = app.handle().clone();

        let (first, timings_first) =
            seed_from_bytes_execute(&handle, "server-a", "track-exec", &wav).unwrap();
        assert_eq!(first, SeedFromBytesOutcome::Upserted);
        assert!(timings_first.seed_ms <= 30_000);

        let (second, timings_second) =
            seed_from_bytes_execute(&handle, "server-a", "track-exec", &wav).unwrap();
        assert_eq!(second, SeedFromBytesOutcome::SkippedWaveformCacheHit);
        assert!(timings_second.seed_ms <= 30_000);
    }
}

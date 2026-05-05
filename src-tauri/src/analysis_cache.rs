use std::path::PathBuf;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ebur128::{EbuR128, Mode as Ebur128Mode};
use rusqlite::{params, Connection, OptionalExtension};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{CODEC_TYPE_NULL, DecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::Manager;

pub const WAVEFORM_ALGO_VERSION: i64 = 4;
pub const LOUDNESS_ALGO_VERSION: i64 = 1;

/// Bins in waveform BLOB: `2 * bin_count` bytes (peak u8, then mean-abs u8 per time bin).
pub fn waveform_cache_blob_len_ok(bins: &[u8], bin_count: i64) -> bool {
    if bin_count <= 0 {
        return false;
    }
    let n = bin_count as usize;
    bins.len() == n.saturating_mul(2)
}

#[derive(Debug, Clone)]
pub struct TrackKey {
    pub track_id: String,
    pub md5_16kb: String,
}

#[derive(Debug, Clone)]
pub struct WaveformEntry {
    pub bins: Vec<u8>,
    pub bin_count: i64,
    pub is_partial: bool,
    pub known_until_sec: f64,
    pub duration_sec: f64,
    pub updated_at: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct LoudnessEntry {
    pub integrated_lufs: f64,
    pub true_peak: f64,
    pub recommended_gain_db: f64,
    pub target_lufs: f64,
    pub updated_at: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct LoudnessSnapshot {
    pub integrated_lufs: f64,
    pub true_peak: f64,
    pub recommended_gain_db: f64,
    pub target_lufs: f64,
    pub updated_at: i64,
}

pub struct AnalysisCache {
    conn: Mutex<Connection>,
}

/// Ranged HTTP seeding uses `stream:<subsonicId>` (see `playback_identity`); backfill
/// and IPC often use the bare `<subsonicId>`. Rows may exist under either key.
fn track_id_cache_variants(id: &str) -> Vec<String> {
    let mut out = vec![id.to_string()];
    if let Some(bare) = id.strip_prefix("stream:") {
        if !bare.is_empty() {
            out.push(bare.to_string());
        }
    } else {
        out.push(format!("stream:{id}"));
    }
    out
}

impl AnalysisCache {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let db_path = analysis_db_path(app)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn).map_err(|e| e.to_string())?;
        migrate_schema(&conn).map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Remove all `loudness_cache` rows for this logical track (bare id and `stream:` variant).
    pub fn delete_loudness_for_track_id(&self, track_id: &str) -> Result<u64, String> {
        if track_id.trim().is_empty() {
            return Ok(0);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let mut total: u64 = 0;
        for tid in track_id_cache_variants(track_id) {
            let n = conn
                .execute("DELETE FROM loudness_cache WHERE track_id = ?1", params![tid])
                .map_err(|e| e.to_string())?;
            total = total.saturating_add(n as u64);
        }
        Ok(total)
    }

    /// Remove all cached waveform rows across all tracks/variants.
    pub fn delete_all_waveforms(&self) -> Result<u64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let n = conn
            .execute("DELETE FROM waveform_cache", [])
            .map_err(|e| e.to_string())?;
        Ok(n as u64)
    }

    pub fn touch_track_status(&self, key: &TrackKey, status: &str) -> Result<(), String> {
        let now = now_unix_ts();
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.execute(
            r#"
            INSERT INTO analysis_track (
                track_id, md5_16kb, status, waveform_algo_version, loudness_algo_version, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(track_id, md5_16kb) DO UPDATE SET
                status = excluded.status,
                waveform_algo_version = excluded.waveform_algo_version,
                loudness_algo_version = excluded.loudness_algo_version,
                updated_at = excluded.updated_at
            "#,
            params![
                key.track_id,
                key.md5_16kb,
                status,
                WAVEFORM_ALGO_VERSION,
                LOUDNESS_ALGO_VERSION,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_waveform(&self, key: &TrackKey, entry: &WaveformEntry) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.execute(
            r#"
            INSERT INTO waveform_cache (
                track_id, md5_16kb, bins, bin_count, is_partial, known_until_sec, duration_sec, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(track_id, md5_16kb) DO UPDATE SET
                bins = excluded.bins,
                bin_count = excluded.bin_count,
                is_partial = excluded.is_partial,
                known_until_sec = excluded.known_until_sec,
                duration_sec = excluded.duration_sec,
                updated_at = excluded.updated_at
            "#,
            params![
                key.track_id,
                key.md5_16kb,
                entry.bins,
                entry.bin_count,
                if entry.is_partial { 1 } else { 0 },
                entry.known_until_sec,
                entry.duration_sec,
                entry.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_loudness(&self, key: &TrackKey, entry: &LoudnessEntry) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        conn.execute(
            r#"
            INSERT INTO loudness_cache (
                track_id, md5_16kb, integrated_lufs, true_peak, recommended_gain_db, target_lufs, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(track_id, md5_16kb, target_lufs) DO UPDATE SET
                integrated_lufs = excluded.integrated_lufs,
                true_peak = excluded.true_peak,
                recommended_gain_db = excluded.recommended_gain_db,
                updated_at = excluded.updated_at
            "#,
            params![
                key.track_id,
                key.md5_16kb,
                entry.integrated_lufs,
                entry.true_peak,
                entry.recommended_gain_db,
                entry.target_lufs,
                entry.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_waveform(&self, key: &TrackKey) -> Result<Option<WaveformEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let row = conn
            .query_row(
                r#"
            SELECT w.bins, w.bin_count, w.is_partial, w.known_until_sec, w.duration_sec, w.updated_at
            FROM waveform_cache w
            JOIN analysis_track a
              ON a.track_id = w.track_id
             AND a.md5_16kb = w.md5_16kb
            WHERE w.track_id = ?1
              AND w.md5_16kb = ?2
              AND a.waveform_algo_version = ?3
            "#,
                params![key.track_id, key.md5_16kb, WAVEFORM_ALGO_VERSION],
                |row| {
                    Ok(WaveformEntry {
                        bins: row.get(0)?,
                        bin_count: row.get(1)?,
                        is_partial: row.get::<_, i64>(2)? != 0,
                        known_until_sec: row.get(3)?,
                        duration_sec: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row.filter(|e| waveform_cache_blob_len_ok(&e.bins, e.bin_count)))
    }

    /// True when this exact `(track_id, md5_16kb)` has a loudness row for the current algo version.
    /// Used after `delete_loudness_for_track_id`: waveform may still be cached, but EBU data was removed.
    pub fn loudness_row_exists_for_key(&self, key: &TrackKey) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let exists: i64 = conn
            .query_row(
                r#"
            SELECT EXISTS (
              SELECT 1
              FROM loudness_cache l
              JOIN analysis_track a
                ON a.track_id = l.track_id
               AND a.md5_16kb = l.md5_16kb
              WHERE l.track_id = ?1
                AND l.md5_16kb = ?2
                AND a.loudness_algo_version = ?3
            )
            "#,
                params![key.track_id, key.md5_16kb, LOUDNESS_ALGO_VERSION],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(exists != 0)
    }

    pub fn get_latest_waveform_for_track(&self, track_id: &str) -> Result<Option<WaveformEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        const SQL: &str = r#"
            SELECT w.bins, w.bin_count, w.is_partial, w.known_until_sec, w.duration_sec, w.updated_at
            FROM waveform_cache w
            JOIN analysis_track a
              ON a.track_id = w.track_id
             AND a.md5_16kb = w.md5_16kb
            WHERE w.track_id = ?1
              AND a.waveform_algo_version = ?2
            ORDER BY w.updated_at DESC
            LIMIT 1
            "#;
        for tid in track_id_cache_variants(track_id) {
            let row = conn
                .query_row(
                    SQL,
                    params![tid, WAVEFORM_ALGO_VERSION],
                    |row| {
                        Ok(WaveformEntry {
                            bins: row.get(0)?,
                            bin_count: row.get(1)?,
                            is_partial: row.get::<_, i64>(2)? != 0,
                            known_until_sec: row.get(3)?,
                            duration_sec: row.get(4)?,
                            updated_at: row.get(5)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(e) = row {
                if waveform_cache_blob_len_ok(&e.bins, e.bin_count) {
                    return Ok(Some(e));
                }
            }
        }
        Ok(None)
    }

    /// Both waveform and loudness rows exist — a CPU seed from bytes/file would only
    /// decode the file to immediately skip with `SkippedWaveformCacheHit`.
    pub fn cpu_seed_redundant_for_track(&self, track_id: &str) -> Result<bool, String> {
        Ok(
            self.get_latest_waveform_for_track(track_id)?.is_some()
                && self.get_latest_loudness_for_track(track_id)?.is_some(),
        )
    }

    pub fn get_latest_loudness_for_track(&self, track_id: &str) -> Result<Option<LoudnessSnapshot>, String> {
        let conn = self.conn.lock().map_err(|_| "analysis_cache lock poisoned".to_string())?;
        const SQL: &str = r#"
            SELECT l.integrated_lufs, l.true_peak, l.recommended_gain_db, l.target_lufs, l.updated_at
            FROM loudness_cache l
            JOIN analysis_track a
              ON a.track_id = l.track_id
             AND a.md5_16kb = l.md5_16kb
            WHERE l.track_id = ?1
              AND a.loudness_algo_version = ?2
            ORDER BY l.updated_at DESC
            LIMIT 1
            "#;
        for tid in track_id_cache_variants(track_id) {
            let row = conn
                .query_row(
                    SQL,
                    params![tid, LOUDNESS_ALGO_VERSION],
                    |row| {
                        Ok(LoudnessSnapshot {
                            integrated_lufs: row.get(0)?,
                            true_peak: row.get(1)?,
                            recommended_gain_db: row.get(2)?,
                            target_lufs: row.get(3)?,
                            updated_at: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if row.is_some() {
                return Ok(row);
            }
        }
        Ok(None)
    }
}

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
pub fn seed_from_bytes_execute(
    app: &tauri::AppHandle,
    track_id: &str,
    bytes: &[u8],
) -> Result<SeedFromBytesOutcome, String> {
    let started = Instant::now();
    let Some(cache) = app.try_state::<AnalysisCache>() else {
        crate::app_deprintln!(
            "[analysis][waveform] build skip track_id={} reason=no_analysis_cache bytes={}",
            track_id,
            bytes.len()
        );
        return Ok(SeedFromBytesOutcome::SkippedNoAnalysisCache);
    };
    let key = TrackKey {
        track_id: track_id.to_string(),
        md5_16kb: md5_first_16kb(bytes),
    };
    if let Some(existing) = cache.get_waveform(&key)? {
        if !existing.bins.is_empty() {
            if cache.loudness_row_exists_for_key(&key)? {
                crate::app_deprintln!(
                    "[analysis][waveform] build skip track_id={} reason=waveform_cache_hit md5_16kb={} bins_len={} elapsed_ms={}",
                    track_id,
                    key.md5_16kb,
                    existing.bins.len(),
                    started.elapsed().as_millis()
                );
                return Ok(SeedFromBytesOutcome::SkippedWaveformCacheHit);
            }
            crate::app_deprintln!(
                "[analysis][waveform] waveform cache hit but loudness missing — full re-analysis track_id={} md5_16kb={}",
                track_id,
                key.md5_16kb
            );
        }
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
            crate::app_deprintln!(
                "[analysis] full-track analysis failed track_id={} elapsed_ms={} err={}",
                track_id,
                elapsed_ms,
                e
            );
        }
    }

    match build {
        Ok(_) => Ok(SeedFromBytesOutcome::Upserted),
        Err(e) => Err(e),
    }
}

fn now_unix_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn md5_first_16kb(bytes: &[u8]) -> String {
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
            let centered = if b >= 128 { b - 128 } else { 128 - b };
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

/// Returns `(decoded_mono_frames, container_timeline_frames)` where the second is
/// `codec_params.n_frames` when the container reports total track length — used
/// as a **fixed** waveform time axis so partial decodes do not remap every bin
/// when the buffer grows.
fn count_mono_frames_from_audio_bytes(bytes: &[u8]) -> Option<(u64, Option<u64>)> {
    let source = Box::new(Cursor::new(bytes.to_vec()));
    let mss = MediaSourceStream::new(source, Default::default());
    let hint = Hint::new();
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;
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
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .ok()?;

    let mut total: u64 = 0;
    let mut loop_i: u32 = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(_) => break,
        };
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
        if n < n_ch || n % n_ch != 0 {
            continue;
        }
        total += (n / n_ch) as u64;
        loop_i = loop_i.wrapping_add(1);
        if loop_i % 128 == 0 {
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
    let source = Box::new(Cursor::new(bytes.to_vec()));
    let mss = MediaSourceStream::new(source, Default::default());
    let hint = Hint::new();
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;
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
    let codec_params = track.codec_params.clone();
    let mut decoder = match symphonia::default::get_codecs().make(&codec_params, &DecoderOptions::default()) {
        Ok(v) => v,
        Err(e) => {
            crate::app_deprintln!("[analysis] decoder make failed: {}", e);
            return None;
        }
    };

    let mut bin_max = vec![0.0f32; bin_count];
    let mut bin_sum = vec![0.0f32; bin_count];
    let mut bin_n = vec![0u32; bin_count];
    let mut ebu: Option<EbuR128> = None;
    let mut ebu_channels: u32 = 0;
    let mut sample_peak_abs = 0.0_f64;
    let mut fed_any_frames = false;
    let mut sample_idx: u64 = 0;
    let mut loop_i: u32 = 0;
    // Fixed timeline from metadata when available; otherwise fall back to decoded
    // length (full-buffer analysis only — partial byte windows still shift, but
    // then we usually lack n_frames anyway).
    let bin_grid_frames = timeline_hint
        .map(|n| n.max(decoded_frames))
        .unwrap_or(decoded_frames)
        .max(1);

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(_) => break,
        };
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
        if slice.len() < n_ch || slice.len() % n_ch != 0 {
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
        if loop_i % 128 == 0 {
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

fn analysis_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(base.join("audio-analysis.sqlite"))
}

fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn migrate_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS analysis_track (
            track_id TEXT NOT NULL,
            md5_16kb TEXT NOT NULL,
            status TEXT NOT NULL,
            waveform_algo_version INTEGER NOT NULL,
            loudness_algo_version INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (track_id, md5_16kb)
        );

        CREATE TABLE IF NOT EXISTS waveform_cache (
            track_id TEXT NOT NULL,
            md5_16kb TEXT NOT NULL,
            bins BLOB NOT NULL,
            bin_count INTEGER NOT NULL,
            is_partial INTEGER NOT NULL,
            known_until_sec REAL NOT NULL,
            duration_sec REAL NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (track_id, md5_16kb)
        );

        CREATE TABLE IF NOT EXISTS loudness_cache (
            track_id TEXT NOT NULL,
            md5_16kb TEXT NOT NULL,
            integrated_lufs REAL NOT NULL,
            true_peak REAL NOT NULL,
            recommended_gain_db REAL NOT NULL,
            target_lufs REAL NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (track_id, md5_16kb, target_lufs)
        );

        CREATE INDEX IF NOT EXISTS idx_analysis_track_status
            ON analysis_track(status);
        "#,
    )?;
    Ok(())
}

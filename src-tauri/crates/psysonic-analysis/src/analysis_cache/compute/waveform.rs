use ebur128::{EbuR128, Mode as Ebur128Mode};
use symphonia::core::errors::Error as SymphoniaError;

use super::decoder::{count_mono_frames_from_audio_bytes, open_decode_session, DecodeSession};

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

pub(super) fn derive_waveform_bins(bytes: &[u8], bin_count: usize) -> Vec<u8> {
    if bin_count == 0 || bytes.is_empty() {
        return Vec::new();
    }
    let mut peak_half = vec![0u8; bin_count];
    for (i, slot) in peak_half.iter_mut().enumerate() {
        let start = i * bytes.len() / bin_count;
        let end = ((i + 1) * bytes.len() / bin_count)
            .max(start + 1)
            .min(bytes.len());
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

pub(super) struct PcmScanResult {
    pub(super) bins: Vec<u8>,
    pub(super) loudness: Option<(f64, f64, f64, f64)>,
}

/// Loudness (EBU R128) plus PCM waveform bins in one decode pass after a frame count.
pub(super) fn analyze_loudness_and_waveform(
    bytes: &[u8],
    target_lufs: f64,
    bin_count: usize,
    format_hint: Option<&str>,
) -> Option<(f64, f64, f64, f64, Vec<u8>)> {
    if bytes.is_empty() || bin_count == 0 {
        return None;
    }
    let (decoded_frames, timeline_hint) = count_mono_frames_from_audio_bytes(bytes, format_hint)?;
    if decoded_frames == 0 {
        return None;
    }
    let scanned = decode_scan_pcm(
        bytes,
        bin_count,
        decoded_frames,
        timeline_hint,
        Some(target_lufs),
        format_hint,
    )?;
    let (i, t, r, tgt) = scanned.loudness?;
    Some((i, t, r, tgt, scanned.bins))
}

pub(super) fn normalize_peak_bins(bin_max: &[f32]) -> Vec<u8> {
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

pub(super) fn decode_scan_pcm(
    bytes: &[u8],
    bin_count: usize,
    decoded_frames: u64,
    timeline_hint: Option<u64>,
    loudness_target_lufs: Option<f64>,
    format_hint: Option<&str>,
) -> Option<PcmScanResult> {
    let DecodeSession {
        mut format,
        mut decoder,
        track_id,
        ..
    } = open_decode_session(bytes, format_hint)?;

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

    let mut samples_buf: Vec<f32> = Vec::new();
    while let Ok(Some(packet)) = format.next_packet() {
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(buf) => buf,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };

        let n_ch = decoded.spec().channels().count();
        if n_ch == 0 {
            continue;
        }

        if loudness_target_lufs.is_some() && ebu.is_none() {
            let ch = decoded.spec().channels().count() as u32;
            let sr = decoded.spec().rate();
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

        decoded.copy_to_vec_interleaved(&mut samples_buf);
        let slice = samples_buf.as_slice();
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
                match e.add_frames_f32(&samples_buf) {
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

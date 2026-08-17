use std::io::Cursor;

use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

use crate::codec::make_decoder;

/// One-shot Symphonia setup: probe the byte buffer, pick a usable track, and
/// build a decoder for it. `timeline_hint` carries `codec_params.n_frames`
/// when the container reports total track length.
pub(super) struct DecodeSession {
    pub(super) format: Box<dyn FormatReader>,
    pub(super) decoder: Box<dyn AudioDecoder>,
    pub(super) track_id: u32,
    pub(super) timeline_hint: Option<u64>,
}

pub(super) fn format_hint_from_bytes(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes[0..4] == *b"OggS" {
        return Some("ogg".into());
    }
    if bytes.len() >= 4 && bytes[0..4] == *b"fLaC" {
        return Some("flac".into());
    }
    if bytes.len() >= 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WAVE" {
        return Some("wav".into());
    }
    if bytes.len() >= 12
        && bytes[0..4] == *b"FORM"
        && (bytes[8..12] == *b"AIFF" || bytes[8..12] == *b"AIFC")
    {
        return Some("aiff".into());
    }
    let scan = bytes.len().min(4096).saturating_sub(4);
    for i in 0..=scan {
        if bytes[i..i + 4] == *b"ftyp" {
            return Some("m4a".into());
        }
    }
    None
}

pub(super) fn open_decode_session(
    bytes: &[u8],
    format_hint: Option<&str>,
) -> Option<DecodeSession> {
    let source = Box::new(Cursor::new(bytes.to_vec()));
    let mss = MediaSourceStream::new(source, Default::default());
    let sniffed = format_hint_from_bytes(bytes);
    let mut hint = Hint::new();
    if let Some(ext) = format_hint.or(sniffed.as_deref()) {
        hint.with_extension(ext);
    }
    let format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    // Prefer an audio track that reports both sample rate and channels; fall back to
    // the first audio track with a known codec (skips e.g. MJPEG cover-art tracks).
    let track = format
        .tracks()
        .iter()
        .find(|t| {
            t.codec_params
                .as_ref()
                .and_then(|c| c.audio())
                .is_some_and(|a| a.sample_rate.is_some() && a.channels.is_some())
        })
        .or_else(|| format.first_track_known_codec(TrackType::Audio))?;
    let track_id = track.id;
    let timeline_hint = track.num_frames.filter(|&n| n > 0);
    let audio_params = track.codec_params.as_ref()?.audio()?.clone();
    let decoder = match make_decoder(
        &audio_params,
        &AudioDecoderOptions::default().gapless(false),
    ) {
        Ok(v) => v,
        Err(e) => {
            crate::app_deprintln!("[analysis] decoder make failed: {}", e);
            return None;
        }
    };
    Some(DecodeSession {
        format,
        decoder,
        track_id,
        timeline_hint,
    })
}

/// Returns `(decoded_mono_frames, container_timeline_frames)` where the second is
/// `codec_params.n_frames` when the container reports total track length — used
/// as a **fixed** waveform time axis so partial decodes do not remap every bin
/// when the buffer grows.
pub(super) fn count_mono_frames_from_audio_bytes(
    bytes: &[u8],
    format_hint: Option<&str>,
) -> Option<(u64, Option<u64>)> {
    let DecodeSession {
        mut format,
        mut decoder,
        track_id,
        timeline_hint,
    } = open_decode_session(bytes, format_hint)?;

    let mut total: u64 = 0;
    let mut loop_i: u32 = 0;
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
        decoded.copy_to_vec_interleaved(&mut samples_buf);
        let n = samples_buf.len();
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
    let session = open_decode_session(bytes, None)?;
    let sample_rate = session
        .format
        .default_track(TrackType::Audio)
        .or_else(|| session.format.tracks().first())
        .and_then(|t| t.codec_params.as_ref())
        .and_then(|c| c.audio())
        .and_then(|a| a.sample_rate)
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
    } = open_decode_session(bytes, None)
        .ok_or_else(|| "failed to open audio decode session".to_string())?;

    if start_sec.is_finite() && start_sec > 0.0 {
        let time = Time::try_from_secs_f64(start_sec.max(0.0))
            .ok_or_else(|| "pcm window: invalid seek time".to_string())?;
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
    } = open_decode_session(bytes, None)
        .ok_or_else(|| "failed to open audio decode session".to_string())?;
    decode_mono_pcm_from_session(&mut format, &mut decoder, track_id, max_seconds)
}

fn decode_mono_pcm_from_session(
    format: &mut Box<dyn FormatReader>,
    decoder: &mut Box<dyn AudioDecoder>,
    track_id: u32,
    max_seconds: Option<f64>,
) -> Result<(Vec<f32>, f32), String> {
    let mut mono = Vec::new();
    let mut sample_rate = 0_f32;
    let mut max_frames: Option<u64> = None;
    let mut loop_i: u32 = 0;
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
        if sample_rate <= 0.0 {
            sample_rate = decoded.spec().rate() as f32;
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

        decoded.copy_to_vec_interleaved(&mut samples_buf);
        let slice = samples_buf.as_slice();
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

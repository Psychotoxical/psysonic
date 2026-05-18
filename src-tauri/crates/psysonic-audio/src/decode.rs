//! Symphonia `SizedDecoder`, gapless trim, and `build_source` / `build_streaming_source`.
use std::io::{Cursor, Read, Seek};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::UniformSourceIterator;
use rodio::Source;
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer, SignalSpec},
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    probe::Hint,
    units::{self, Time},
};

use super::codec::{psysonic_codec_registry, try_make_radio_decoder};
use super::sources::*;

// ─── SizedCursorSource — correct byte_len for seekable in-memory sources ──────
//
// rodio's internal ReadSeekSource wraps Cursor<Vec<u8>> but hardcodes
// byte_len() → None.  This tells symphonia "stream length unknown", which
// prevents the FLAC demuxer from seeking (it validates seek offsets against
// the total stream length from byte_len).  MP3 is unaffected because its
// demuxer uses Xing/LAME headers instead.
//
// This wrapper provides the actual byte length, fixing seek for all formats.

pub(crate) struct SizedCursorSource {
    inner: Cursor<Vec<u8>>,
    len: u64,
}

impl Read for SizedCursorSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for SizedCursorSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for SizedCursorSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.len) }
}

// ─── SizedDecoder — symphonia decoder with correct byte_len ───────────────────
//
// Replaces rodio::Decoder::new() which wraps the source in ReadSeekSource
// (byte_len = None).  This constructs the symphonia pipeline directly,
// providing the correct byte_len via SizedCursorSource.
//
// Implements Iterator<Item = i16> + Source — identical interface to
// rodio::Decoder, so the rest of the source chain is unchanged.

/// Debug logging: codec parameters in human-readable form to verify whether
/// playback is genuinely lossless.
pub(crate) fn log_codec_resolution(
    tag: &str,
    params: &symphonia::core::codecs::CodecParameters,
    container_hint: Option<&str>,
) {
    let codec_name = symphonia::default::get_codecs()
        .get_codec(params.codec)
        .map(|d| d.short_name)
        .unwrap_or("?");
    let rate = params.sample_rate.map(|r| format!("{} Hz", r)).unwrap_or_else(|| "? Hz".into());
    let bits = params.bits_per_sample
        .or(params.bits_per_coded_sample)
        .map(|b| format!("{}-bit", b))
        .unwrap_or_else(|| "?-bit".into());
    let ch = params.channels
        .map(|c| format!("{}ch", c.count()))
        .unwrap_or_else(|| "?ch".into());
    let lossless = codec_name.starts_with("pcm")
        || matches!(
            codec_name,
            "flac" | "alac" | "wavpack" | "monkeys-audio" | "tta" | "shorten"
        );
    let kind = if lossless { "LOSSLESS" } else { "lossy" };
    crate::app_deprintln!(
        "[stream] {tag}: codec={codec_name} ({kind}) {bits} {rate} {ch} container={}",
        container_hint.unwrap_or("?")
    );
}

/// Max retries for IO/packet-read errors (fatal — network drop, truncated file).
const DECODE_MAX_RETRIES: usize = 3;
/// Max *consecutive* DecodeErrors before giving up on a file.
/// Non-fatal errors like "invalid main_data offset" are silently dropped up to
/// this limit so a handful of corrupt MP3 frames never aborts an otherwise
/// playable track (VLC-style frame dropping).
const MAX_CONSECUTIVE_DECODE_ERRORS: usize = 100;

pub(crate) struct SizedDecoder {
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    current_frame_offset: usize,
    format: Box<dyn FormatReader>,
    total_duration: Option<Time>,
    buffer: SampleBuffer<f32>,
    spec: SignalSpec,
    /// Counts consecutive DecodeErrors in the hot-path. Reset to 0 on every
    /// successfully decoded frame. Used to detect fully undecodable streams.
    consecutive_decode_errors: usize,
}

impl SizedDecoder {
    pub(crate) fn new(data: Vec<u8>, format_hint: Option<&str>, hi_res: bool) -> Result<Self, String> {
        let data_len = data.len() as u64;
        let source = SizedCursorSource {
            inner: Cursor::new(data),
            len: data_len,
        };
        // Hi-Res: 4 MB read-ahead so Symphonia demuxes fewer Read calls for
        // high-bitrate files (88.2 kHz/24-bit FLAC ≈ 1800 kbps).
        // Standard: 512 KB is plenty for MP3/AAC — larger buffers waste allocation
        // and compete with the playback thread at track start.
        let buf_len = if hi_res { 4 * 1024 * 1024 } else { 512 * 1024 };
        let mss = MediaSourceStream::new(
            Box::new(source) as Box<dyn MediaSource>,
            MediaSourceStreamOptions { buffer_len: buf_len },
        );

        let mut hint = Hint::new();
        if let Some(ext) = format_hint {
            hint.with_extension(ext);
        }
        let format_opts = FormatOptions {
            // Disable gapless parsing — Symphonia 0.5.5 crashes on `edts` atoms
            // present in older iTunes-purchased M4A files.
            enable_gapless: false,
            ..Default::default()
        };

        let meta_opts = symphonia::core::meta::MetadataOptions {
            // Cap embedded cover art at 8 MiB so oversized MJPEG images in
            // iTunes M4A files don't choke the parser.
            limit_visual_bytes: symphonia::core::meta::Limit::Maximum(8 * 1024 * 1024),
            ..Default::default()
        };

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &meta_opts)
            .map_err(|e| {
                let hint_str = format_hint.unwrap_or("unknown");
                // Always print the raw Symphonia error to the terminal for diagnosis.
                crate::app_eprintln!("[psysonic] probe failed (hint={hint_str}): {e}");
                if e.to_string().to_lowercase().contains("unsupported") {
                    format!("unsupported format: .{hint_str} files cannot be played (no demuxer)")
                } else {
                    format!("could not open audio stream (.{hint_str}): {e}")
                }
            })?;

        let track = probed.format
            .tracks()
            .iter()
            // Explicitly select only audio tracks: must have a valid codec and a
            // sample_rate. This skips MJPEG cover-art streams that iTunes M4A
            // files embed as a secondary video track.
            .find(|t| {
                t.codec_params.codec != CODEC_TYPE_NULL
                    && t.codec_params.sample_rate.is_some()
            })
            .ok_or_else(|| {
                crate::app_eprintln!("[psysonic] no audio track found among {} tracks", probed.format.tracks().len());
                "no playable audio track found in file".to_string()
            })?;

        let track_id = track.id;
        let total_duration = track.codec_params.time_base
            .zip(track.codec_params.n_frames)
            .map(|(base, frames)| base.calc_time(frames));

        log_codec_resolution("bytes", &track.codec_params, format_hint);

        let mut decoder = psysonic_codec_registry()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| {
                crate::app_eprintln!("[psysonic] codec init failed: {e}");
                if e.to_string().to_lowercase().contains("unsupported") {
                    "unsupported codec: no decoder available for this audio format".to_string()
                } else {
                    format!("failed to initialise audio decoder: {e}")
                }
            })?;

        let mut format = probed.format;

        // Decode the first packet to initialise spec + buffer.
        // DecodeErrors (e.g. "invalid main_data offset") are non-fatal: drop the
        // frame and try the next packet up to MAX_CONSECUTIVE_DECODE_ERRORS times.
        let mut decode_errors: usize = 0;
        let decoded = loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(_)) => {
                    break decoder.last_decoded();
                }
                Err(e) => {
                    crate::app_eprintln!("[psysonic] next_packet error: {e}");
                    return Err(format!("could not read audio data: {e}"));
                }
            };
            if packet.track_id() != track_id {
                crate::app_eprintln!("[psysonic] skipping packet for track {} (want {})", packet.track_id(), track_id);
                continue;
            }
            match decoder.decode(&packet) {
                Ok(decoded) => break decoded,
                Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                    decode_errors += 1;
                    crate::app_eprintln!("[psysonic] init: dropped corrupt frame #{decode_errors}: {msg}");
                    if decode_errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err("too many consecutive decode errors during init — file may be corrupt".into());
                    }
                }
                Err(e) => {
                    crate::app_eprintln!("[psysonic] fatal decode error: {e}");
                    return Err(format!("audio decode error: {e}"));
                }
            }
        };

        let spec = decoded.spec().to_owned();
        let buffer = Self::make_buffer(decoded, &spec);

        Ok(SizedDecoder {
            decoder,
            current_frame_offset: 0,
            format,
            total_duration,
            buffer,
            spec,
            consecutive_decode_errors: 0,
        })
    }

    /// Build a decoder from any `MediaSource` (e.g. track-stream or radio).
    /// Uses `enable_gapless: false` — live streams are not seekable; gapless
    /// trimming requires seeking to read the LAME/iTunSMPB end-padding info.
    pub(crate) fn new_streaming(
        media: Box<dyn MediaSource>,
        format_hint: Option<&str>,
        source_tag: &str,
    ) -> Result<Self, String> {
        // Larger read-ahead buffer for the live streaming SPSC consumer — reduces
        // read() call frequency into the ring buffer, easing I/O spikes.
        let mss = MediaSourceStream::new(media, MediaSourceStreamOptions { buffer_len: 512 * 1024 });
        let mut hint = Hint::new();
        if let Some(ext) = format_hint { hint.with_extension(ext); }
        let format_opts = FormatOptions { enable_gapless: false, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &MetadataOptions::default())
            .map_err(|e| format!("{source_tag}: format probe failed: {e}"))?;

        let track = probed.format.tracks().iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| format!("{source_tag}: no audio track found"))?;
        let track_id = track.id;
        log_codec_resolution(source_tag, &track.codec_params, format_hint);
        // Live streams have no known total frame count → total_duration = None.
        let total_duration = None;
        let mut decoder = try_make_radio_decoder(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("{source_tag}: codec init failed: {e}"))?;
        let mut format = probed.format;

        let mut errors = 0usize;
        let decoded = loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(_) => break decoder.last_decoded(),
            };
            if packet.track_id() != track_id { continue; }
            match decoder.decode(&packet) {
                Ok(d) => break d,
                Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                    errors += 1;
                    crate::app_eprintln!("[psysonic] {source_tag} init: dropped corrupt frame #{errors}: {msg}");
                    if errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(format!("{source_tag}: too many consecutive decode errors"));
                    }
                }
                Err(e) => return Err(format!("{source_tag}: decode error: {e}")),
            }
        };
        let spec = decoded.spec().to_owned();
        let buffer = Self::make_buffer(decoded, &spec);
        Ok(SizedDecoder { decoder, current_frame_offset: 0, format, total_duration, buffer, spec, consecutive_decode_errors: 0 })
    }

    #[inline]
    fn make_buffer(decoded: AudioBufferRef, spec: &SignalSpec) -> SampleBuffer<f32> {
        let duration = units::Duration::from(decoded.capacity() as u64);
        let mut buffer = SampleBuffer::<f32>::new(duration, *spec);
        buffer.copy_interleaved_ref(decoded);
        buffer
    }

    /// Refine position after a coarse seek — decode packets until we reach the
    /// exact requested timestamp.
    fn refine_position(
        &mut self,
        seek_res: symphonia::core::formats::SeekedTo,
    ) -> Result<(), String> {
        let mut samples_to_pass = seek_res.required_ts - seek_res.actual_ts;
        let packet = loop {
            let candidate = self.format.next_packet()
                .map_err(|e| format!("refine seek: {e}"))?;
            if candidate.dur() > samples_to_pass {
                break candidate;
            }
            samples_to_pass -= candidate.dur();
        };

        let mut decoded = self.decoder.decode(&packet);
        for _ in 0..DECODE_MAX_RETRIES {
            if decoded.is_err() {
                let p = self.format.next_packet()
                    .map_err(|e| format!("refine retry: {e}"))?;
                decoded = self.decoder.decode(&p);
            }
        }

        let decoded = decoded.map_err(|e| format!("refine decode: {e}"))?;
        decoded.spec().clone_into(&mut self.spec);
        self.buffer = Self::make_buffer(decoded, &self.spec);
        self.current_frame_offset = samples_to_pass as usize * self.spec.channels.count();
        Ok(())
    }
}

impl Iterator for SizedDecoder {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.current_frame_offset >= self.buffer.len() {
            // Loop until a decodable packet is found or the stream ends.
            // DecodeErrors (e.g. MP3 "invalid main_data offset") are non-fatal:
            // drop the frame and advance to the next packet. IO errors and a
            // clean end-of-stream both terminate the iterator normally.
            loop {
                let packet = self.format.next_packet().ok()?;
                match self.decoder.decode(&packet) {
                    Ok(decoded) => {
                        self.consecutive_decode_errors = 0;
                        decoded.spec().clone_into(&mut self.spec);
                        self.buffer = Self::make_buffer(decoded, &self.spec);
                        self.current_frame_offset = 0;
                        break;
                    }
                    Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                        #[cfg(not(debug_assertions))]
                        let _ = msg;
                        self.consecutive_decode_errors += 1;
                        // Log sparingly: first drop, then every 10th to avoid spam.
                        if self.consecutive_decode_errors == 1
                            || self.consecutive_decode_errors.is_multiple_of(10)
                        {
                            crate::app_deprintln!(
                                "[psysonic] dropped corrupt frame #{}: {msg}",
                                self.consecutive_decode_errors
                            );
                        }
                        if self.consecutive_decode_errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                            crate::app_deprintln!(
                                "[psysonic] {MAX_CONSECUTIVE_DECODE_ERRORS} consecutive decode \
                                 failures — stream appears unrecoverable, stopping"
                            );
                            return None;
                        }
                        // continue → fetch next packet
                    }
                    Err(_) => return None, // IO error or fatal codec error → end of stream
                }
            }
        }

        let sample = *self.buffer.samples().get(self.current_frame_offset)?;
        self.current_frame_offset += 1;
        Some(sample)
    }
}

impl Source for SizedDecoder {
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        Some(self.buffer.samples().len())
    }

    #[inline]
    fn channels(&self) -> rodio::ChannelCount {
        std::num::NonZeroU16::new(self.spec.channels.count() as u16)
            .unwrap_or(std::num::NonZeroU16::MIN)
    }

    #[inline]
    fn sample_rate(&self) -> rodio::SampleRate {
        std::num::NonZeroU32::new(self.spec.rate).unwrap_or(std::num::NonZeroU32::MIN)
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration.map(|Time { seconds, frac }| {
            Duration::new(seconds, (frac * 1_000_000_000.0) as u32)
        })
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let seek_beyond_end = self
            .total_duration()
            .is_some_and(|dur| dur.saturating_sub(pos).as_millis() < 1);

        let time: Time = if seek_beyond_end {
            let t = self.total_duration.unwrap_or(pos.as_secs_f64().into());
            // Step back a tiny bit — some demuxers can't seek to the exact end.
            let mut secs = t.seconds;
            let mut frac = t.frac - 0.0001;
            if frac < 0.0 {
                secs = secs.saturating_sub(1);
                frac = 1.0 - frac;
            }
            Time { seconds: secs, frac }
        } else {
            pos.as_secs_f64().into()
        };

        let to_skip = self.current_frame_offset % self.channels().get() as usize;

        let seek_res = self
            .format
            .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: None })
            .map_err(|e| rodio::source::SeekError::Other(
                std::sync::Arc::new(std::io::Error::other(e.to_string()))
            ))?;

        self.refine_position(seek_res)
            .map_err(|e| rodio::source::SeekError::Other(
                std::sync::Arc::new(std::io::Error::other(e))
            ))?;

        self.current_frame_offset += to_skip;
        Ok(())
    }
}

// ─── Encoder-gap trimming (iTunSMPB) ─────────────────────────────────────────
//
// MP3/AAC encoders prepend an "encoder delay" (typically 576–2112 silent
// samples for LAME) and append end-padding to fill the final frame.
// iTunes embeds the exact counts in an ID3v2 COMM frame with description
// "iTunSMPB". Format: " 00000000 DELAY PADDING TOTAL ..."  (space-separated hex)
//
// Parsing strategy: scan raw bytes for the ASCII marker, then extract the
// first whitespace-separated hex tokens after it.

#[derive(Default)]
pub(crate) struct GaplessInfo {
    delay_samples: u64,
    total_valid_samples: Option<u64>,
}

pub(crate) fn find_subsequence(data: &[u8], needle: &[u8]) -> Option<usize> {
    data.windows(needle.len()).position(|w| w == needle)
}

pub(crate) fn parse_gapless_info(data: &[u8]) -> GaplessInfo {
    let pos = match find_subsequence(data, b"iTunSMPB") {
        Some(p) => p,
        None => return GaplessInfo::default(),
    };

    // In M4A/iTunes files the key is followed by a binary 'data' atom header
    // (16 bytes: size[4] + "data"[4] + type_flags[4] + locale[4]) before the
    // actual value string. Search for the " 00000000 " sentinel that every
    // iTunSMPB value starts with to locate the true start of the text.
    let search_end = data.len().min(pos + 8 + 128);
    let search_window = &data[pos + 8..search_end];
    let value_start = find_subsequence(search_window, b" 00000000 ")
        .map(|off| pos + 8 + off)
        .unwrap_or(pos + 8);

    let tail = &data[value_start..data.len().min(value_start + 256)];
    let text: String = tail.iter()
        .map(|&b| b as char)
        .filter(|c| c.is_ascii_hexdigit() || *c == ' ')
        .collect();

    let parts: Vec<&str> = text.split_whitespace().collect();
    // parts[0] = "00000000", parts[1] = delay, parts[2] = padding, parts[3] = total
    if parts.len() < 3 {
        return GaplessInfo::default();
    }
    let delay = u64::from_str_radix(parts.get(1).unwrap_or(&"0"), 16).unwrap_or(0);
    let padding = u64::from_str_radix(parts.get(2).unwrap_or(&"0"), 16).unwrap_or(0);
    let total_raw = parts.get(3).and_then(|s| u64::from_str_radix(s, 16).ok());

    let total_valid = total_raw.filter(|&t| t > 0).or_else(|| {
        // Derive from delay + padding if total not available:
        // Not possible without knowing total encoded samples, so just use None.
        let _ = padding;
        None
    });

    GaplessInfo { delay_samples: delay, total_valid_samples: total_valid }
}

pub(crate) type BuiltSourceStack =
    PriorityBoostSource<CountingSource<NotifyingSource<TriggeredFadeOut<EqualPowerFadeIn<EqSource<DynSource>>>>>>;

/// Result of build_source: the fully-wrapped source plus metadata and control Arcs.
pub(crate) struct BuiltSource {
    pub(crate) source: BuiltSourceStack,
    pub(crate) duration_secs: f64,
    pub(crate) output_rate: u32,
    pub(crate) output_channels: u16,
    /// Trigger for the sample-level crossfade fade-out.
    pub(crate) fadeout_trigger: Arc<AtomicBool>,
    /// Total samples for the fade-out (set before triggering).
    pub(crate) fadeout_samples: Arc<AtomicU64>,
}

/// Build a fully-prepared playback source:
///   decode → trim → resample → EQ → fade-in → triggered-fade-out → notify → count
///
/// `fade_in_dur`:
///   • `Duration::ZERO`          — unity gain; used for gapless chain (no click)
///   • `Duration::from_millis(5)` — micro-fade; used for hard cuts (anti-click)
///   • `Duration::from_secs_f32(cf)` — full equal-power fade-in for crossfade
///
/// `sample_counter`: atomic counter incremented per sample for drift-free position.
/// `target_rate`: canonical output sample rate for resampling (0 = no resampling).
/// `format_hint`: optional file extension (e.g. "flac", "mp3") to help symphonia probe.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_source(
    data: Vec<u8>,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    eq_pre_gain: Arc<AtomicU32>,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    format_hint: Option<&str>,
    hi_res: bool,
) -> Result<BuiltSource, String> {
    let gapless = parse_gapless_info(&data);

    let decoder = SizedDecoder::new(data, format_hint, hi_res)?;
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();

    // Determine effective duration.
    // Prefer hint from Subsonic API (reliable) over decoder (unreliable for VBR MP3).
    let effective_dur = if duration_hint > 1.0 {
        duration_hint
    } else {
        decoder.total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(duration_hint)
    };

    // Apply encoder-delay trim and optional end-padding trim,
    // then resample to the canonical target rate if needed.
    let dyn_src: DynSource = if gapless.delay_samples > 0 || gapless.total_valid_samples.is_some() {
        let delay_dur = Duration::from_secs_f64(
            gapless.delay_samples as f64 / sample_rate.get() as f64
        );
        let base = decoder.skip_duration(delay_dur);

        if let Some(total) = gapless.total_valid_samples {
            let valid_dur = Duration::from_secs_f64(total as f64 / sample_rate.get() as f64);
            let trimmed = base.take_duration(valid_dur);
            if target_rate > 0 && sample_rate.get() != target_rate {
                DynSource::new(UniformSourceIterator::new(
                    trimmed,
                    channels,
                    std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
                ))
            } else {
                DynSource::new(trimmed)
            }
        } else if target_rate > 0 && sample_rate.get() != target_rate {
            DynSource::new(UniformSourceIterator::new(
                base,
                channels,
                std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
            ))
        } else {
            DynSource::new(base)
        }
    } else {
        let converted = decoder;
        if target_rate > 0 && sample_rate.get() != target_rate {
            DynSource::new(UniformSourceIterator::new(
                converted,
                channels,
                std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
            ))
        } else {
            DynSource::new(converted)
        }
    };

    let output_rate = if target_rate > 0 && sample_rate.get() != target_rate { target_rate } else { sample_rate.get() };

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let eq_src = EqSource::new(dyn_src, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag);
    let counting = CountingSource::new(notifying, sample_counter);
    let boosted = PriorityBoostSource::new(counting);

    Ok(BuiltSource {
        source: boosted,
        duration_secs: effective_dur,
        output_rate,
        output_channels: channels.get(),
        fadeout_trigger,
        fadeout_samples,
    })
}

/// Streaming variant of `build_source`: uses a live `SizedDecoder` source
/// (non-seekable) and skips iTunSMPB parsing, but preserves the same EQ/fade/
/// counting wrappers and output metadata.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_streaming_source(
    decoder: SizedDecoder,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    eq_pre_gain: Arc<AtomicU32>,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    count_gate: Option<Arc<AtomicBool>>,
) -> Result<BuiltSource, String> {
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();

    // For streaming starts prefer server-provided duration when available.
    let effective_dur = if duration_hint > 1.0 {
        duration_hint
    } else {
        decoder
            .total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(duration_hint)
    };

    let converted = decoder;
    let dyn_src: DynSource = if target_rate > 0 && sample_rate.get() != target_rate {
        DynSource::new(UniformSourceIterator::new(
            converted,
            channels,
            std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
        ))
    } else {
        DynSource::new(converted)
    };

    let output_rate = if target_rate > 0 && sample_rate.get() != target_rate {
        target_rate
    } else {
        sample_rate.get()
    };

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let eq_src = EqSource::new(dyn_src, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag);
    let counting = match count_gate {
        Some(gate) => CountingSource::new_gated(notifying, sample_counter, gate),
        None => CountingSource::new(notifying, sample_counter),
    };
    let boosted = PriorityBoostSource::new(counting);

    Ok(BuiltSource {
        source: boosted,
        duration_secs: effective_dur,
        output_rate,
        output_channels: channels.get(),
        fadeout_trigger,
        fadeout_samples,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── find_subsequence ─────────────────────────────────────────────────────

    #[test]
    fn find_subsequence_locates_needle_at_start() {
        assert_eq!(find_subsequence(b"abcdef", b"abc"), Some(0));
    }

    #[test]
    fn find_subsequence_locates_needle_in_middle() {
        assert_eq!(find_subsequence(b"abcdef", b"cd"), Some(2));
    }

    #[test]
    fn find_subsequence_returns_none_when_absent() {
        assert!(find_subsequence(b"abcdef", b"xyz").is_none());
    }

    #[test]
    fn find_subsequence_returns_none_for_needle_longer_than_haystack() {
        assert!(find_subsequence(b"ab", b"abcd").is_none());
    }

    #[test]
    fn find_subsequence_finds_first_occurrence_of_repeated_pattern() {
        assert_eq!(find_subsequence(b"abab", b"ab"), Some(0));
    }

    // ── parse_gapless_info ───────────────────────────────────────────────────

    #[test]
    fn parse_gapless_returns_default_when_itunsmpb_absent() {
        let info = parse_gapless_info(b"no marker here");
        assert_eq!(info.delay_samples, 0);
        assert!(info.total_valid_samples.is_none());
    }

    fn synth_itunsmpb_blob(delay_hex: &str, padding_hex: &str, total_hex: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"random preamble bytes ");
        v.extend_from_slice(b"iTunSMPB");
        v.extend_from_slice(&[0u8; 16]);
        v.push(b' ');
        v.extend_from_slice(b"00000000");
        v.push(b' ');
        v.extend_from_slice(delay_hex.as_bytes());
        v.push(b' ');
        v.extend_from_slice(padding_hex.as_bytes());
        v.push(b' ');
        v.extend_from_slice(total_hex.as_bytes());
        v.push(b' ');
        v
    }

    #[test]
    fn parse_gapless_extracts_delay_from_itunsmpb_blob() {
        let blob = synth_itunsmpb_blob("00000840", "00000000", "00ABCDEF");
        let info = parse_gapless_info(&blob);
        assert_eq!(info.delay_samples, 0x840, "delay decoded as hex");
        assert_eq!(info.total_valid_samples, Some(0x00AB_CDEF));
    }

    #[test]
    fn parse_gapless_returns_none_total_when_total_field_is_zero() {
        let blob = synth_itunsmpb_blob("00000840", "00000000", "00000000");
        let info = parse_gapless_info(&blob);
        assert_eq!(info.delay_samples, 0x840);
        assert!(
            info.total_valid_samples.is_none(),
            "zero-total filters out per the implementation"
        );
    }

    #[test]
    fn parse_gapless_handles_itunsmpb_without_value_string() {
        let mut v = b"iTunSMPB".to_vec();
        v.extend_from_slice(&[0u8; 16]);
        let info = parse_gapless_info(&v);
        assert_eq!(info.delay_samples, 0);
        assert!(info.total_valid_samples.is_none());
    }

    // ── SizedDecoder::new with a synthetic WAV ───────────────────────────────

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
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&num_channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&bits_per_sample.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_size.to_le_bytes());
        for s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    fn synthetic_wav_bytes(secs: f32) -> Vec<u8> {
        let sample_rate = 44_100u32;
        let n = (sample_rate as f32 * secs) as usize;
        let amp: f32 = 0.5 * i16::MAX as f32;
        let samples: Vec<i16> = (0..n)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * amp) as i16
            })
            .collect();
        build_mono_pcm16_wav(&samples, sample_rate)
    }

    #[test]
    fn sized_decoder_constructs_from_synthetic_wav() {
        let wav = synthetic_wav_bytes(0.5);
        let decoder = SizedDecoder::new(wav, Some("wav"), false).expect("WAV decode setup");
        assert_eq!(decoder.spec.rate, 44_100);
        assert_eq!(decoder.spec.channels.count(), 1);
    }

    #[test]
    fn sized_decoder_returns_err_for_garbage_input() {
        let result = SizedDecoder::new(vec![0x00u8; 64], None, false);
        assert!(result.is_err());
    }

    #[test]
    fn sized_decoder_uses_format_hint_when_provided() {
        let wav = synthetic_wav_bytes(0.3);
        let _decoder = SizedDecoder::new(wav, Some("wav"), true).expect("WAV decode with hi-res");
    }

    // ── log_codec_resolution ─────────────────────────────────────────────────

    #[test]
    fn log_codec_resolution_does_not_panic_for_valid_params() {
        let mut params = symphonia::core::codecs::CodecParameters::new();
        params.codec = symphonia::core::codecs::CODEC_TYPE_PCM_S16LE;
        params.sample_rate = Some(44_100);
        params.bits_per_sample = Some(16);
        params.channels = Some(symphonia::core::audio::Channels::FRONT_LEFT);
        log_codec_resolution("test-tag", &params, Some("wav"));
    }

    #[test]
    fn log_codec_resolution_handles_unknown_codec_gracefully() {
        let params = symphonia::core::codecs::CodecParameters::new();
        log_codec_resolution("unknown", &params, None);
    }
}

#[cfg(test)]
mod build_source_tests {
    use super::*;

    fn build_mono_pcm16_wav_local(samples: &[i16], sample_rate: u32) -> Vec<u8> {
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
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&num_channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&bits_per_sample.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_size.to_le_bytes());
        for s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    fn synthetic_wav_bytes_local(secs: f32) -> Vec<u8> {
        let sample_rate = 44_100u32;
        let n = (sample_rate as f32 * secs) as usize;
        let amp: f32 = 0.5 * i16::MAX as f32;
        let samples: Vec<i16> = (0..n)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * amp) as i16
            })
            .collect();
        build_mono_pcm16_wav_local(&samples, sample_rate)
    }

    type EqGains = Arc<[AtomicU32; 10]>;
    type SourceArgs = (EqGains, Arc<AtomicBool>, Arc<AtomicU32>, Arc<AtomicBool>, Arc<AtomicU64>);

    fn default_source_args() -> SourceArgs {
        let eq_gains: Arc<[AtomicU32; 10]> =
            Arc::new(std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())));
        let eq_enabled = Arc::new(AtomicBool::new(false));
        let eq_pre_gain = Arc::new(AtomicU32::new(0f32.to_bits()));
        let done_flag = Arc::new(AtomicBool::new(false));
        let sample_counter = Arc::new(AtomicU64::new(0));
        (eq_gains, eq_enabled, eq_pre_gain, done_flag, sample_counter)
    }

    #[test]
    fn build_source_succeeds_for_synthetic_wav() {
        let (eq_gains, eq_enabled, eq_pre_gain, done_flag, sample_counter) = default_source_args();
        let wav = synthetic_wav_bytes_local(0.4);
        let built = build_source(
            wav,
            0.4,
            eq_gains,
            eq_enabled,
            eq_pre_gain,
            done_flag,
            Duration::ZERO,
            sample_counter,
            0,
            Some("wav"),
            false,
        )
        .expect("build_source must succeed for a valid WAV");
        assert_eq!(built.output_channels, 1);
        assert!(built.duration_secs > 0.0);
        assert!(built.output_rate > 0);
    }

    #[test]
    fn build_source_returns_err_for_garbage_bytes() {
        let (eq_gains, eq_enabled, eq_pre_gain, done_flag, sample_counter) = default_source_args();
        let result = build_source(
            vec![0u8; 32],
            0.0,
            eq_gains,
            eq_enabled,
            eq_pre_gain,
            done_flag,
            Duration::ZERO,
            sample_counter,
            0,
            None,
            false,
        );
        assert!(result.is_err());
    }

    #[test]
    fn build_streaming_source_succeeds_for_synthetic_wav() {
        let (eq_gains, eq_enabled, eq_pre_gain, done_flag, sample_counter) = default_source_args();
        let wav = synthetic_wav_bytes_local(0.4);
        let decoder = SizedDecoder::new(wav, Some("wav"), false).unwrap();
        let built = build_streaming_source(
            decoder,
            0.4,
            eq_gains,
            eq_enabled,
            eq_pre_gain,
            done_flag,
            Duration::ZERO,
            sample_counter,
            0,
            None,
        )
        .expect("build_streaming_source must succeed for a valid WAV decoder");
        assert_eq!(built.output_channels, 1);
        assert!(built.output_rate > 0);
    }

    #[test]
    fn build_source_with_target_rate_resamples() {
        let (eq_gains, eq_enabled, eq_pre_gain, done_flag, sample_counter) = default_source_args();
        let wav = synthetic_wav_bytes_local(0.3);
        let built = build_source(
            wav,
            0.3,
            eq_gains,
            eq_enabled,
            eq_pre_gain,
            done_flag,
            Duration::from_millis(5),
            sample_counter,
            48_000,
            Some("wav"),
            false,
        )
        .expect("resampled build_source must succeed");
        assert_eq!(built.output_rate, 48_000);
    }
}

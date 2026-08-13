//! Symphonia `SizedDecoder`, gapless trim, and `build_source` / `build_streaming_source`.
use std::io::{Cursor, Read, Seek};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::UniformSourceIterator;
use rodio::Source;
use symphonia::core::{
    audio::{AudioSpec, GenericAudioBufferRef},
    codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions},
    formats::probe::Hint,
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    common::Limit,
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    units::{Time, Timestamp},
};

use super::codec::{psysonic_codec_registry, try_make_radio_decoder};
use super::playback_rate::{PlaybackRateAtomics, PlaybackRateSource};
use super::sources::*;
use super::spectrum::SpectrumTapSource;

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

// ─── ProbeSeekGate — temporarily hide seekability during probing ──────────────
//
// Symphonia 0.6's `Probe::probe` scans for *trailing* metadata (ID3v1/APEv2/…)
// whenever the source reports `is_seekable() == true` and a known `byte_len()`.
// That scan seeks to the end of the stream. For a progressive ranged-HTTP source
// this forces a download all the way to EOF before the first sample can play
// (FLAC/MP3/OGG regressed to "won't start until fully downloaded").
//
// These formats are demuxed sequentially from the start, and their seek paths
// re-check `is_seekable()` dynamically, so we can advertise the source as
// non-seekable for the duration of the probe (skipping the trailing scan) and
// flip it back to seekable afterwards to preserve scrubbing. MP4/ISO-BMFF is
// excluded because its demuxer captures seekability at construction and relies
// on seeking to locate `moov` (its tail is prefetched separately instead).
struct ProbeSeekGate {
    inner: Box<dyn MediaSource>,
    seekable: Arc<AtomicBool>,
}

impl Read for ProbeSeekGate {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for ProbeSeekGate {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for ProbeSeekGate {
    fn is_seekable(&self) -> bool {
        self.seekable.load(Ordering::Relaxed) && self.inner.is_seekable()
    }
    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}

// ─── SizedDecoder — symphonia decoder with correct byte_len ───────────────────
//
// Replaces rodio::Decoder::new() which wraps the source in ReadSeekSource
// (byte_len = None).  This constructs the symphonia pipeline directly,
// providing the correct byte_len via SizedCursorSource.
//
// Implements Iterator<Item = i16> + Source — identical interface to
// rodio::Decoder, so the rest of the source chain is unchanged.

/// Resolved audio format of a decoded stream — the real codec/rate/depth the
/// engine is playing, which can differ from the server's stored file metadata
/// when the server transcodes on the fly.
#[derive(Clone, Debug)]
pub(crate) struct ResolvedCodecInfo {
    /// Symphonia codec short name, e.g. `mp3`, `flac`, `aac`, `pcm_s16le`.
    pub(crate) codec_name: &'static str,
    pub(crate) sample_rate: Option<u32>,
    pub(crate) bits_per_sample: Option<u32>,
    pub(crate) channels: Option<u16>,
    pub(crate) lossless: bool,
}

/// Extract the human/UI-facing format from symphonia codec parameters.
pub(crate) fn resolve_codec_info(params: &AudioCodecParameters) -> ResolvedCodecInfo {
    // Resolve the codec name from the SAME registry the engine decodes with
    // (`psysonic_codec_registry`), not `symphonia::default::get_codecs()`. The
    // app registry adds decoders the stock one lacks (e.g. the libopus adapter);
    // using the stock registry would render those as "?" even though playback
    // works — which is exactly what a server Opus transcode would show.
    let codec_name = psysonic_codec_registry()
        .get_audio_decoder(params.codec)
        .map(|d| d.codec.info.short_name)
        .unwrap_or("?");
    let lossless = codec_name.starts_with("pcm")
        || matches!(
            codec_name,
            "flac" | "alac" | "wavpack" | "monkeys-audio" | "tta" | "shorten"
        );
    ResolvedCodecInfo {
        codec_name,
        sample_rate: params.sample_rate,
        bits_per_sample: params.bits_per_sample.or(params.bits_per_coded_sample),
        channels: params.channels.as_ref().map(|c| c.count() as u16),
        lossless,
    }
}

/// `audio:format` event payload — the actually-decoded stream format, sent to
/// the frontend so now-playing badges can show real transmitted quality.
/// Hand-serialized (not tauri-specta) to match the `audio:*` event convention.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioFormatEvent {
    /// Track this format was resolved for — lets the frontend drop the event if
    /// the user has since skipped. `None` on legacy/identity-less emits.
    pub(crate) track_id: Option<String>,
    /// Playback server index key — disambiguates duplicate ids across servers.
    pub(crate) server_id: Option<String>,
    /// Playback generation the stream belongs to (stale-event rejection).
    pub(crate) generation: Option<u64>,
    /// `maxBitRate` cap (kbps) the stream URL was opened with — latched per
    /// stream, so a mid-playback settings change never relabels the current one.
    pub(crate) stream_cap_kbps: Option<u32>,
    pub(crate) codec: String,
    pub(crate) sample_rate: Option<u32>,
    pub(crate) bits_per_sample: Option<u32>,
    pub(crate) channels: Option<u16>,
    pub(crate) lossless: bool,
}

/// Identity a resolved-format event is stamped with (who/which stream).
#[derive(Clone, Default)]
pub(crate) struct AudioFormatIdentity {
    pub(crate) track_id: Option<String>,
    pub(crate) server_id: Option<String>,
    pub(crate) generation: Option<u64>,
    pub(crate) stream_cap_kbps: Option<u32>,
}

impl AudioFormatEvent {
    pub(crate) fn from_info(info: &ResolvedCodecInfo, id: AudioFormatIdentity) -> Self {
        Self {
            track_id: id.track_id,
            server_id: id.server_id,
            generation: id.generation,
            stream_cap_kbps: id.stream_cap_kbps,
            codec: info.codec_name.to_string(),
            // Bit depth is only meaningful for lossless output.
            bits_per_sample: if info.lossless { info.bits_per_sample } else { None },
            sample_rate: info.sample_rate,
            channels: info.channels,
            lossless: info.lossless,
        }
    }
}

/// Debug logging: codec parameters in human-readable form to verify whether
/// playback is genuinely lossless.
pub(crate) fn log_codec_resolution(
    tag: &str,
    params: &AudioCodecParameters,
    container_hint: Option<&str>,
) {
    let info = resolve_codec_info(params);
    let rate = info.sample_rate.map(|r| format!("{} Hz", r)).unwrap_or_else(|| "? Hz".into());
    let bits = info.bits_per_sample
        .map(|b| format!("{}-bit", b))
        .unwrap_or_else(|| "?-bit".into());
    let ch = info.channels
        .map(|c| format!("{}ch", c))
        .unwrap_or_else(|| "?ch".into());
    let kind = if info.lossless { "LOSSLESS" } else { "lossy" };
    crate::app_deprintln!(
        "[stream] {tag}: codec={} ({kind}) {bits} {rate} {ch} container={}",
        info.codec_name,
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
/// Wall-clock cap for the streaming `probe()` call. A ranged-HTTP source whose
/// download stalls (e.g. right after a server switch) can otherwise block the
/// probe — and therefore playback start — indefinitely. On timeout we abort with
/// an error so the player can recover/retry instead of hanging until a restart.
const STREAM_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) struct SizedDecoder {
    decoder: Box<dyn AudioDecoder>,
    current_frame_offset: usize,
    format: Box<dyn FormatReader>,
    total_duration: Option<Time>,
    /// Interleaved f32 samples of the currently decoded packet.
    buffer: Vec<f32>,
    spec: AudioSpec,
    /// Real decoded format (codec/rate/depth) for the now-playing UI badge.
    codec_info: ResolvedCodecInfo,
    /// Whether Symphonia's own encoder-gap trimming is active for this stream.
    /// When true the decoder already removed encoder delay/padding, so
    /// `build_source` must not apply its manual `iTunSMPB` trim on top.
    builtin_gapless: bool,
    /// Whether that trimming reaches the *end* of the stream. LAME writes its
    /// delay/padding extension independently of Xing's optional frame count, and
    /// without a count the demuxer has no end timestamp, so `PacketBuilder` never
    /// produces a `trim_end` — the decoder removes the front gap and leaves the
    /// padding. `build_source` keeps its manual end trim for that case.
    builtin_gapless_trims_end: bool,
    /// The encoder delay the demuxer reported, in frames — what built-in gapless
    /// removed from the front. `build_source` needs it to place an `iTunSMPB`
    /// total, which counts from *its own* delay, against an already-trimmed
    /// stream. Zero whenever built-in gapless is off.
    builtin_gapless_delay: u32,
    /// Counts consecutive DecodeErrors in the hot-path. Reset to 0 on every
    /// successfully decoded frame. Used to detect fully undecodable streams.
    consecutive_decode_errors: usize,
}

/// Codecs whose encoder delay and end padding live in container metadata that
/// Symphonia parses and can apply itself.
///
/// MP3 carries them in the Xing/LAME header. Symphonia 0.6 reads those values
/// and puts them on the packet trim fields, but its MP3 decoder only applies
/// them when decoder gapless mode is on — so leaving it off plays the encoder
/// delay of every track and the padding of the previous one, which is the
/// audible seam in a gapless chain (issue #1373).
///
/// M4A/AAC deliberately stays out: where those files are played from a byte
/// buffer, `build_source`'s manual `iTunSMPB` parser owns the trim, and enabling
/// both would trim twice. (On the streaming paths AAC currently gets no trim at
/// all — pre-existing, out of scope here, see `build_streaming_source`.)
///
/// Decided on the resolved codec, never on a file extension — a server can
/// transcode and hand us a different codec than the URL suggests. Pair it with
/// [`encoder_gap_reported`]: the codec says *who could* trim, the demuxer values
/// say *whether there is* anything to trim.
fn should_use_builtin_gapless(codec_name: &str) -> bool {
    codec_name == "mp3"
}

/// Whether the demuxer actually reported an encoder **delay** for this track.
///
/// Symphonia fills `delay`/`padding` only when it recognised the encoder that
/// wrote the Xing extension. When it reports no delay it will trim nothing off
/// the front, so the manual `iTunSMPB` path has to stay in charge — otherwise a
/// file that carries only the iTunes tag would end up with no trimming at all.
///
/// `manual_fallback_available` says whether a second owner exists for this
/// stream, and it changes the answer:
///
/// * `true` (the `build_source` bytes path): only the **delay** counts. Trim
///   ownership is all-or-nothing, so a file reporting padding but no delay would
///   hand the front trim to a decoder that does not perform it while the manual
///   `iTunSMPB` parser — which may hold a real delay — has already stood down.
/// * `false` (`new_streaming`): there is no second owner, so whatever the demuxer
///   reports is all that will ever be trimmed. Requiring a delay here would leave
///   a padding-only file completely untrimmed, which is the predecessor half of
///   the seam this module exists to close.
fn encoder_gap_reported(
    delay: Option<u32>,
    padding: Option<u32>,
    manual_fallback_available: bool,
) -> bool {
    if manual_fallback_available {
        delay.unwrap_or(0) > 0
    } else {
        delay.unwrap_or(0) > 0 || padding.unwrap_or(0) > 0
    }
}

impl SizedDecoder {
    pub(crate) fn new(data: Vec<u8>, format_hint: Option<&str>, hi_res: bool) -> Result<Self, String> {
        let data_len = data.len() as u64;
        let sniffed_hint = crate::helpers::sniff_stream_format_extension(&data);
        let format_hint = format_hint.or(sniffed_hint.as_deref());
        let gate_hint = sniffed_hint.as_deref().or(format_hint);
        let source = SizedCursorSource {
            inner: Cursor::new(data),
            len: data_len,
        };
        // Symphonia 0.6 scans trailing metadata on seekable sources — hide
        // seekability during probe (same as `new_streaming`) so preview does not
        // read the entire in-memory file before the first sample.
        //
        // Exception: Ogg (Vorbis/Opus/…) and AIFF must stay seekable through the
        // probe. Ogg records its physical byte range there; AIFF permits `SSND`
        // before `COMM` and must scan then seek back. This source is fully
        // in-memory, so the trailing scan these exceptions enable is free.
        let gate_needed = !crate::stream::container_hint_is_mp4(gate_hint)
            && !crate::stream::container_hint_is_ogg(gate_hint)
            && !crate::stream::container_hint_is_aiff(gate_hint);
        let probe_seek_gate = gate_needed.then(|| Arc::new(AtomicBool::new(false)));
        let media: Box<dyn MediaSource> = match &probe_seek_gate {
            Some(gate) => Box::new(ProbeSeekGate {
                inner: Box::new(source),
                seekable: gate.clone(),
            }),
            None => Box::new(source),
        };
        // Hi-Res: 4 MB read-ahead so Symphonia demuxes fewer Read calls for
        // high-bitrate files (88.2 kHz/24-bit FLAC ≈ 1800 kbps).
        // Standard: 512 KB is plenty for MP3/AAC — larger buffers waste allocation
        // and compete with the playback thread at track start.
        let buf_len = if hi_res { 4 * 1024 * 1024 } else { 512 * 1024 };
        let mss = MediaSourceStream::new(media, MediaSourceStreamOptions { buffer_len: buf_len });

        let mut hint = Hint::new();
        if let Some(ext) = format_hint {
            hint.with_extension(ext);
        }
        let format_opts = FormatOptions::default();

        // Cap embedded cover art at 8 MiB so oversized MJPEG images in
        // iTunes M4A files don't choke the parser.
        let meta_opts =
            MetadataOptions::default().limit_visual_bytes(Limit::Maximum(8 * 1024 * 1024));

        let mut format = symphonia::default::get_probe()
            .probe(&hint, mss, format_opts, meta_opts)
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

        if let Some(gate) = &probe_seek_gate {
            gate.store(true, Ordering::Relaxed);
        }

        let track = format
            .tracks()
            .iter()
            // Explicitly select only audio tracks: must have an audio codec and a
            // sample_rate. This skips MJPEG cover-art streams that iTunes M4A
            // files embed as a secondary video track.
            .find(|t| {
                t.codec_params
                    .as_ref()
                    .and_then(|c| c.audio())
                    .is_some_and(|a| a.sample_rate.is_some())
            })
            .ok_or_else(|| {
                crate::app_eprintln!("[psysonic] no audio track found among {} tracks", format.tracks().len());
                "no playable audio track found in file".to_string()
            })?;

        let track_id = track.id;
        // Read before `track` goes out of scope; drives the gapless ownership
        // decision below.
        let (track_delay, track_padding) = (track.delay, track.padding);
        let track_num_frames = track.num_frames;
        // Encoder-delay-aware total duration (timebase units → Time).
        //
        // Zero is not a duration — see the same filter in `new_streaming`. A Xing
        // header that declares the FRAMES field and leaves it empty yields
        // `num_frames = Some(0)`, and `try_seek`'s seek-past-end clamp would then
        // send every scrub back to the start. The bytes path reaches this through
        // buffered playback, preview and the full-buffer retry.
        let total_duration = track
            .time_base
            .zip(track.num_frames)
            .and_then(|(base, frames)| {
                Timestamp::try_from(frames).ok().and_then(|ts| base.calc_time(ts))
            })
            .filter(|t| t.as_secs_f64() > 0.0);

        let audio_params = track
            .codec_params
            .as_ref()
            .and_then(|c| c.audio())
            .ok_or_else(|| "selected track has no audio codec parameters".to_string())?
            .clone();

        log_codec_resolution("bytes", &audio_params, format_hint);
        let codec_info = resolve_codec_info(&audio_params);

        // Encoder-gap trimming has exactly one owner per stream:
        //   • the decoder, when the demuxer actually reported an encoder gap
        //     (MP3 with a Xing/LAME header) — enabled here;
        //   • otherwise `build_source`'s manual `iTunSMPB` trim.
        // `build_source` reads `applies_builtin_gapless()` and skips its own trim
        // when this is on, so no stream is ever trimmed twice.
        //
        // The decision is data-driven on purpose: symphonia only fills delay and
        // padding when the Xing extension names LAME/Lavf/Lavc as the encoder
        // (`symphonia-bundle-mp3/src/demuxer.rs`). An iTunes-encoded MP3 reports
        // nothing there but carries an `iTunSMPB` tag, so keying only on the codec
        // would take its trim away and leave it with none at all.
        let builtin_gapless = should_use_builtin_gapless(codec_info.codec_name)
            && encoder_gap_reported(track_delay, track_padding, true);
        // `> 0` for the same reason the duration filters it: a Xing header that
        // declares FRAMES and leaves it empty reports `Some(0)`, which describes no
        // end at all.
        let builtin_gapless_trims_end =
            builtin_gapless && track_num_frames.is_some_and(|n| n > 0);
        let builtin_gapless_delay = if builtin_gapless { track_delay.unwrap_or(0) } else { 0 };
        let mut decoder = psysonic_codec_registry()
            .make_audio_decoder(
                &audio_params,
                &AudioDecoderOptions::default().gapless(builtin_gapless),
            )
            .map_err(|e| {
                crate::app_eprintln!("[psysonic] codec init failed: {e}");
                if e.to_string().to_lowercase().contains("unsupported") {
                    "unsupported codec: no decoder available for this audio format".to_string()
                } else {
                    format!("failed to initialise audio decoder: {e}")
                }
            })?;

        // Decode the first packet to initialise spec + buffer.
        // DecodeErrors (e.g. "invalid main_data offset") are non-fatal: drop the
        // frame and try the next packet up to MAX_CONSECUTIVE_DECODE_ERRORS times.
        let mut decode_errors: usize = 0;
        let (spec, buffer) = loop {
            let packet = match format.next_packet() {
                Ok(Some(p)) => p,
                // Clean EOF, and the reader running out of bytes, are the two ways a
                // finite buffer ends. Any other I/O error is a real failure and falls
                // through to the arm below instead of masquerading as end-of-media.
                Ok(None) => break Self::spec_and_buffer_at_eof(decoder.last_decoded()),
                Err(symphonia::core::errors::Error::IoError(ref io))
                    if io.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break Self::spec_and_buffer_at_eof(decoder.last_decoded());
                }
                Err(e) => {
                    crate::app_eprintln!("[psysonic] next_packet error: {e}");
                    return Err(format!("could not read audio data: {e}"));
                }
            };
            if packet.track_id != track_id {
                crate::app_eprintln!("[psysonic] skipping packet for track {} (want {})", packet.track_id, track_id);
                continue;
            }
            match decoder.decode(&packet) {
                Ok(decoded) => {
                    // With gapless trimming enabled a packet can be trimmed away
                    // *entirely*: an MPEG-2/2.5 Layer III frame carries only 576
                    // samples while a LAME encoder delay is ~1105, so the first
                    // frame of a 22.05 kHz MP3 decodes to zero frames. That is not
                    // end-of-stream — keep reading. Breaking here would take the
                    // stream's spec from a packet that carried no audio, and would
                    // report a source as constructed without having decoded a
                    // single frame; reaching real EOF that way is an error, not a
                    // silent zero-length track.
                    let buffer = Self::make_buffer(&decoded);
                    if !buffer.is_empty() {
                        break (decoded.spec().clone(), buffer);
                    }
                }
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

        Ok(SizedDecoder {
            decoder,
            current_frame_offset: 0,
            format,
            total_duration,
            buffer,
            spec,
            codec_info,
            builtin_gapless,
            builtin_gapless_trims_end,
            builtin_gapless_delay,
            consecutive_decode_errors: 0,
        })
    }

    /// Build a decoder from any `MediaSource` (e.g. track-stream or radio).
    ///
    /// Gapless trimming uses the same *decision* as [`Self::new`], but this path
    /// has no second owner: [`build_streaming_source`] never sees the raw bytes,
    /// so there is no manual `iTunSMPB` fallback here. A stream whose demuxer
    /// reports no encoder gap therefore stays untrimmed — as it did before this
    /// path learned to trim at all. Open-ended sources (radio, preview, the
    /// non-seekable fallback) stay untrimmed regardless.
    ///
    /// `source_random_access`: the underlying source can cheaply seek to EOF
    /// (e.g. a local file or the ranged-HTTP reader), so the probe-time
    /// trailing-metadata / stream-end scan is not a full download. Radio and the
    /// non-seekable streaming fallback pass `false`.
    ///
    /// Note that "streaming" here is about the *reader*, not the feature: ranged
    /// HTTP passes `true` (`play_input.rs`) and is therefore trimmed. Buffered
    /// preview decodes from bytes via [`Self::new`] and trims independently of
    /// this flag, but the *ranged* preview path does come through here
    /// (`preview.rs`, tag `preview-stream`) with `false`.
    ///
    /// `superseded` carries the reader's own playback generation where one
    /// exists. Without it an abandoned read and a truncated stream look the same
    /// at end-of-media; see [`crate::stream::GenerationGuard`].
    pub(crate) fn new_streaming(
        media: Box<dyn MediaSource>,
        format_hint: Option<&str>,
        source_tag: &str,
        source_random_access: bool,
        superseded: Option<crate::stream::GenerationGuard>,
    ) -> Result<Self, String> {
        // For non-MP4 progressive streams, hide seekability during the probe so
        // Symphonia 0.6 skips its trailing-metadata scan (which would seek to EOF
        // and block until the whole file is downloaded). Re-enabled right after.
        // MP4 keeps seekability (its demuxer needs it to find `moov`; tail is
        // prefetched separately).
        //
        // Ogg and AIFF also keep seekability through the probe on random-access
        // sources. Ogg records its physical byte range there; AIFF may need to
        // scan past `SSND` to find `COMM`, then seek back. Local files, Hot Cache,
        // and ranged sources with on-demand fetches all make those seeks cheap.
        // Legacy non-seekable AIFF retries from completed full-buffer bytes.
        let stream_len = media.byte_len();
        let random_access_needs_seekable_probe = source_random_access
            && (crate::stream::container_hint_is_ogg(format_hint)
                || crate::stream::container_hint_is_aiff(format_hint));
        let gate_needed = !crate::stream::container_hint_is_mp4(format_hint)
            && !random_access_needs_seekable_probe;
        let probe_seek_gate = gate_needed.then(|| Arc::new(AtomicBool::new(false)));
        let media: Box<dyn MediaSource> = match &probe_seek_gate {
            Some(gate) => Box::new(ProbeSeekGate { inner: media, seekable: gate.clone() }),
            None => media,
        };

        // Larger read-ahead buffer for the live streaming SPSC consumer — reduces
        // read() call frequency into the ring buffer, easing I/O spikes.
        let mss = MediaSourceStream::new(media, MediaSourceStreamOptions { buffer_len: 512 * 1024 });
        let format_opts = FormatOptions::default();
        let meta_opts = MetadataOptions::default();

        crate::app_deprintln!(
            "[stream] {source_tag}: probe start (hint={}, stream_len={})",
            format_hint.unwrap_or("?"),
            stream_len.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
        );
        let probe_start = std::time::Instant::now();

        // Run the probe on a dedicated thread guarded by a timeout. If a ranged
        // source stalls (download never reaches the bytes Symphonia needs), the
        // probe blocks forever; without this guard playback start would hang until
        // the user restarts the player. On timeout we abandon the worker thread
        // (it unblocks once the underlying read errors/returns) and surface an
        // error so the caller can retry.
        let hint_ext = format_hint.map(|s| s.to_string());
        let tag_owned = source_tag.to_string();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("symphonia-probe".into())
            .spawn(move || {
                let mut hint = Hint::new();
                if let Some(ext) = &hint_ext {
                    hint.with_extension(ext);
                }
                let result = symphonia::default::get_probe()
                    .probe(&hint, mss, format_opts, meta_opts)
                    .map_err(|e| format!("{tag_owned}: format probe failed: {e}"));
                // Receiver is gone if we already timed out — ignore the send error.
                let _ = tx.send(result);
            })
            .map_err(|e| format!("{source_tag}: failed to spawn probe thread: {e}"))?;

        let mut format = match rx.recv_timeout(STREAM_PROBE_TIMEOUT) {
            Ok(Ok(format)) => format,
            Ok(Err(e)) => return Err(e),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                crate::app_eprintln!(
                    "[stream] {source_tag}: probe timed out after {STREAM_PROBE_TIMEOUT:?} \
                     (stream stalled?) — aborting so the player can retry"
                );
                return Err(format!(
                    "{source_tag}: format probe timed out after {STREAM_PROBE_TIMEOUT:?}"
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(format!("{source_tag}: probe thread ended unexpectedly"));
            }
        };

        crate::app_deprintln!(
            "[stream] {source_tag}: probe done in {} ms",
            probe_start.elapsed().as_millis()
        );

        // Trailing-metadata scan is done; restore real seekability for scrubbing.
        if let Some(gate) = &probe_seek_gate {
            gate.store(true, Ordering::Relaxed);
        }

        let track = format.tracks().iter()
            .find(|t| t.codec_params.as_ref().and_then(|c| c.audio()).is_some())
            .ok_or_else(|| format!("{source_tag}: no audio track found"))?;
        let track_id = track.id;
        let (track_delay, track_padding) = (track.delay, track.padding);
        let track_num_frames = track.num_frames;
        let audio_params = track
            .codec_params
            .as_ref()
            .and_then(|c| c.audio())
            .ok_or_else(|| format!("{source_tag}: track has no audio codec parameters"))?
            .clone();
        log_codec_resolution(source_tag, &audio_params, format_hint);
        let codec_info = resolve_codec_info(&audio_params);
        // A finite, seekable source (local file, ranged HTTP) carries a real frame
        // count, and with trimming active that count is what actually comes out —
        // the server's duration is the untrimmed length. Consumers that schedule
        // from the reported duration (the crossfade computes its fade length as
        // `duration_secs - position()`) would otherwise start the fade against a
        // source that ends ~48 ms earlier and cut it mid-curve. Radio and the
        // non-seekable fallback keep `None`: their frame count cannot be trusted.
        // A zero frame count is not a duration. Containers report one routinely:
        // symphonia's MP3 demuxer sets `num_frames(0)` when a Xing header claims
        // the FRAMES field but leaves it empty, which is what a server-side
        // transcode writes for a stream it cannot seek. Passing that on would arm
        // `try_seek`'s `seek_beyond_end` clamp against zero and send every scrub
        // back to the start.
        // Only a count the container measured, never one symphonia guessed. Without
        // a Xing/VBRI header it derives the MP3 frame count from the bitrate ("may
        // be inaccurate for vbr files", `demuxer.rs`), and an estimate here is
        // worse than no duration at all: `try_seek`'s `seek_beyond_end` treats any
        // scrub past it as a seek to the end while the transport writes back the
        // position the user asked for, so the readout and the audio drift apart for
        // the rest of the track.
        //
        // The estimate exists only where the probe ran on a seekable source, so the
        // gate is the signal — not anything about the tag. `ProbeSeekGate` hides
        // seekability for the whole probe, and symphonia estimates only when it is
        // seekable; wherever the gate was installed, any count it reports came from
        // a header. The gate is chosen from the caller's hint before the container
        // is known, though, and it deliberately exempts Ogg, AIFF and MP4 — a
        // server labelling an MP3 as one of those leaves the source seekable, and
        // the estimate arrives after all.
        //
        // Reading provenance off the encoder gap instead would be wrong in both
        // directions: symphonia reports no gap for a Xing header whose encoder
        // string it does not recognise, and none for VBRI, while both carry an
        // exact frame count.
        let mp3_frame_count_may_be_estimated =
            should_use_builtin_gapless(codec_info.codec_name) && !gate_needed;
        let total_duration = source_random_access
            .then(|| {
                track.time_base.zip(track.num_frames).and_then(|(base, frames)| {
                    Timestamp::try_from(frames).ok().and_then(|ts| base.calc_time(ts))
                })
            })
            .flatten()
            .filter(|t| t.as_secs_f64() > 0.0)
            .filter(|_| !mp3_frame_count_may_be_estimated);
        // Same decision as `new`, restricted to random-access sources.
        //
        // `source_random_access` is true for local files *and* for the ranged-HTTP
        // reader (`play_input.rs`), false for radio, preview and the non-seekable
        // streaming fallback. Those three deliver an open-ended stream where the
        // container's frame count cannot be trusted, so they keep the previous
        // untrimmed behaviour.
        //
        // The non-seekable fallback is the deliberately conservative case: it does
        // carry a finite track and its first frame could expose an exact Xing/LAME
        // gap, so it *could* be trimmed. Distinguishing "finite track delivered
        // sequentially" from radio needs a stream-kind signal this constructor does
        // not get, and inventing one would change playback for servers without
        // range support — out of scope for a seam fix.
        //
        // This matters because a locally cached MP3 plays through *this*
        // constructor, not `new`: without it the predecessor of a gapless boundary
        // would still emit its end padding — half the seam of issue #1373.
        let builtin_gapless = source_random_access
            && should_use_builtin_gapless(codec_info.codec_name)
            && encoder_gap_reported(track_delay, track_padding, false);
        // `> 0` for the same reason the duration filters it: a Xing header that
        // declares FRAMES and leaves it empty reports `Some(0)`, which describes no
        // end at all.
        let builtin_gapless_trims_end =
            builtin_gapless && track_num_frames.is_some_and(|n| n > 0);
        let builtin_gapless_delay = if builtin_gapless { track_delay.unwrap_or(0) } else { 0 };
        let mut decoder = try_make_radio_decoder(
            &audio_params,
            &AudioDecoderOptions::default().gapless(builtin_gapless),
        )
        .map_err(|e| format!("{source_tag}: codec init failed: {e}"))?;

        let mut errors = 0usize;
        let (spec, buffer) = loop {
            let packet = match format.next_packet() {
                Ok(Some(p)) => p,
                // `Ok(None)` is symphonia 0.6's clean end of media.
                Ok(None) => break Self::buffer_at_end_of_media(
                    decoder.last_decoded(),
                    source_tag,
                    superseded.as_ref(),
                    "stream ended",
                )?,
                // A reader running out of bytes ends a finite stream the same way
                // `Ok(None)` does — `new` treats it that way too, and the two
                // constructors must not disagree about what EOF means for identical
                // bytes. Which of the two situations this is now depends on the
                // generation, not on the error kind.
                Err(symphonia::core::errors::Error::IoError(ref io))
                    if io.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    break Self::buffer_at_end_of_media(
                        decoder.last_decoded(),
                        source_tag,
                        superseded.as_ref(),
                        "reader ran out of bytes",
                    )?;
                }
                // Anything else is a real read failure (range read reset, timeout,
                // malformed stream). Surfacing it lets the caller retry; folding it
                // into EOF would hand the player a silent track instead — and with
                // gapless trimming a fully trimmed first packet leaves the buffer
                // empty, so that silence would look like a valid decode.
                //
                // Same wording constraint as the end-of-media arm above: a stall
                // that happens one packet after a successful probe is just as
                // recoverable as one during it, and
                // `is_stream_probe_failure_with_full_buffer_retry` decides on the
                // text alone.
                Err(e) => {
                    return Err(format!(
                        "{source_tag}: end of stream before any audio could be decoded \
                         (could not read audio data: {e})"
                    ))
                }
            };
            if packet.track_id != track_id { continue; }
            match decoder.decode(&packet) {
                // Same rule as `new`: with gapless trimming on, the first packet of
                // an MPEG-2/2.5 Layer III stream (576 samples) is shorter than the
                // encoder delay and decodes to zero frames. Keeping that as the
                // initial buffer would take the spec from a packet carrying no
                // audio and construct a source that never decoded a frame. Keep
                // reading instead.
                Ok(d) => {
                    let buffer = Self::make_buffer(&d);
                    if !buffer.is_empty() {
                        break (d.spec().clone(), buffer);
                    }
                }
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
        Ok(SizedDecoder { decoder, current_frame_offset: 0, format, total_duration, buffer, spec, codec_info, builtin_gapless, builtin_gapless_trims_end, builtin_gapless_delay, consecutive_decode_errors: 0 })
    }

    /// Turn the decoder's last buffer into the initial `(spec, buffer)` pair when
    /// the stream ends during initialization.
    ///
    /// Shared by every end-of-media arm in both constructors — clean `Ok(None)`
    /// and a reader running out of bytes are the same situation and must stay in
    /// lockstep.
    ///
    /// Note that an empty result is not decided here — see
    /// [`Self::buffer_at_end_of_media`], which is where the streaming constructor
    /// tells an abandoned build from a truncated stream.
    fn spec_and_buffer_at_eof(last: GenericAudioBufferRef<'_>) -> (AudioSpec, Vec<f32>) {
        (last.spec().clone(), Self::make_buffer(&last))
    }

    /// End of media during initialization: an abandoned build, or a failure.
    ///
    /// Reaching this with something decoded is ordinary — a short stream ends
    /// after its first packets. Reaching it with *nothing* decoded is not, and
    /// the reason decides what happens:
    ///
    /// * the read was superseded — the user skipped the track or moved off the
    ///   hovered row, and the reader answered with `Ok(0)`. Nothing is wrong;
    ///   reporting it turns an ordinary skip into a playback error on the paths
    ///   that do not suppress toasts (measured, and the reason an earlier
    ///   unconditional version of this had to be reverted).
    /// * no generation moved — the stream is truncated or broken. Symphonia 0.6
    ///   reserves `Ok(None)` for clean end-of-media and calls everything else
    ///   unrecoverable, so handing back a zero-length source would let the player
    ///   present silence as a successfully opened track instead of retrying.
    fn buffer_at_end_of_media(
        last: GenericAudioBufferRef<'_>,
        source_tag: &str,
        superseded: Option<&crate::stream::GenerationGuard>,
        reason: &str,
    ) -> Result<(AudioSpec, Vec<f32>), String> {
        let (spec, buffer) = Self::spec_and_buffer_at_eof(last);
        if !buffer.is_empty() || superseded.is_some_and(|guard| guard.is_superseded()) {
            return Ok((spec, buffer));
        }
        // The wording is load-bearing: `is_stream_probe_failure_with_full_buffer_retry`
        // (`source_build.rs`) matches on "end of stream" to decide whether a ranged
        // start may wait for the full download and retry from bytes. A message that
        // misses it turns a recoverable partial stream into a hard playback error.
        Err(format!(
            "{source_tag}: end of stream before any audio could be decoded ({reason})"
        ))
    }

    #[inline]
    fn make_buffer(decoded: &GenericAudioBufferRef<'_>) -> Vec<f32> {
        let mut buffer = Vec::new();
        decoded.copy_to_vec_interleaved(&mut buffer);
        buffer
    }

    /// Real decoded format (codec/rate/depth) for the now-playing UI badge.
    #[inline]
    pub(crate) fn codec_info(&self) -> &ResolvedCodecInfo {
        &self.codec_info
    }

    /// True when Symphonia already removed this stream's encoder delay/padding.
    /// `build_source` uses it to skip its manual `iTunSMPB` trim (no double-trim).
    pub(crate) fn applies_builtin_gapless(&self) -> bool {
        self.builtin_gapless
    }

    /// Whether the decoder's own trimming also removes the padding at the end.
    /// False for a file whose LAME extension reports a gap while the Xing header
    /// omits `FRAMES`: there is no end timestamp, so only the front is trimmed.
    pub(crate) fn applies_builtin_end_trim(&self) -> bool {
        self.builtin_gapless_trims_end
    }

    /// Frames the decoder already removed from the front, zero when it removed
    /// none.
    pub(crate) fn builtin_gapless_delay_frames(&self) -> u32 {
        self.builtin_gapless_delay
    }

    /// Refine position after a coarse seek — decode packets until we reach the
    /// exact requested timestamp.
    fn refine_position(
        &mut self,
        seek_res: symphonia::core::formats::SeekedTo,
    ) -> Result<(), String> {
        // Number of frames between where the demuxer landed and the requested ts.
        let mut samples_to_pass: u64 = seek_res
            .required_ts
            .get()
            .saturating_sub(seek_res.actual_ts.get())
            .max(0) as u64;
        let packet = loop {
            let candidate = match self.format.next_packet()
                .map_err(|e| format!("refine seek: {e}"))?
            {
                Some(p) => p,
                // EOF while refining — nothing more to skip. The buffer still
                // holds samples decoded *before* the seek, and the demuxer has
                // moved; replaying them would emit audio from the old position
                // after the seek reported success. Dropping them is safe now that
                // an empty buffer reports `Some(1)` rather than `Some(0)`: the
                // source is not mistaken for finished, and `next()` refills it.
                None => {
                    self.buffer.clear();
                    self.current_frame_offset = 0;
                    return Ok(());
                }
            };
            if candidate.dur.get() > samples_to_pass {
                break candidate;
            }
            samples_to_pass -= candidate.dur.get();
        };

        // Belongs to the packet the buffer came from; a retry decodes a later one
        // and discards the value, so it is only read on the straight-through path.
        let packet_trim_start = packet.trim_start.get();
        let mut retried = false;
        let mut decoded = self.decoder.decode(&packet);
        for _ in 0..DECODE_MAX_RETRIES {
            if decoded.is_err() {
                let p = match self.format.next_packet()
                    .map_err(|e| format!("refine retry: {e}"))?
                {
                    Some(p) => p,
                    None => break,
                };
                retried = true;
                decoded = self.decoder.decode(&p);
            }
        }

        // `samples_to_pass` was derived from `packet.dur`, which counts the frames
        // the packet carries *before* trimming. The decoder removed `trim_start` of
        // them from the front, so the buffer starts that much later; skipping the
        // full amount would point past its end and `next()` would discard the whole
        // packet — a seek to the start of a trimmed MP3 used to lose the remainder
        // of its first frame. `trim_end` needs no handling here: it shortens the
        // buffer at the back, which the offset never reaches.
        //
        // A retry lands on a packet the target sits at or before — the selection
        // loop only breaks on a packet longer than what is left to skip — so the
        // remainder is spent and the new packet is entered at its start.
        //
        // The subtraction is gated on the decoder actually trimming: the Ogg
        // demuxer fills `trim_start` with the Opus pre-skip regardless, but with
        // `gapless(false)` those frames stay in the buffer, and taking them off
        // the offset would land the seek up to 80 ms early.
        let offset_frames = if retried {
            0
        } else if self.builtin_gapless {
            samples_to_pass.saturating_sub(packet_trim_start)
        } else {
            samples_to_pass
        };

        let decoded = decoded.map_err(|e| format!("refine decode: {e}"))?;
        self.spec = decoded.spec().clone();
        self.buffer = Self::make_buffer(&decoded);
        self.current_frame_offset = offset_frames as usize * self.spec.channels().count();

        // A packet that trimming emptied needs no special handling here:
        // `current_span_len()` reports one frame rather than zero for an empty
        // buffer, so the source is not mistaken for finished, and `next()` reads
        // past it on its own. Refilling on this thread was tried and removed — it
        // put a blocking read on rodio's output callback and could still end with
        // an empty buffer, which is what it existed to prevent.
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
                let packet = self.format.next_packet().ok()??;
                match self.decoder.decode(&packet) {
                    Ok(decoded) => {
                        self.consecutive_decode_errors = 0;
                        self.spec = decoded.spec().clone();
                        self.buffer = Self::make_buffer(&decoded);
                        self.current_frame_offset = 0;
                        // A packet that gapless trimming emptied is not the end of
                        // the stream — the same rule both constructors follow.
                        // Breaking here would hand `buffer.get(0)` a `None` and end
                        // the iterator while packets are still coming.
                        if self.buffer.is_empty() {
                            continue;
                        }
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

        let sample = *self.buffer.get(self.current_frame_offset)?;
        self.current_frame_offset += 1;
        Some(sample)
    }
}

impl Source for SizedDecoder {
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        // The size of the current span, not what is left of it. Reporting the
        // remainder was tried and reverted: rodio reads this once per span and
        // then pulls that many samples, so a value that shrinks with every
        // consumed sample truncates the span and drops audio — measurably, in
        // three of the fixture tests.
        //
        // Gapless trimming can empty a packet outright, and `Some(0)` is what
        // rodio's resampling wrapper reads as end-of-source — the silent track
        // that issue #1373's own fix would otherwise introduce. `next()` keeps
        // reading past such a packet, so the source is not finished.
        //
        // `None` is not the way to say that: rodio 0.22 reads it as an *infinite*
        // span (`UniformSourceIterator::bootstrap` builds `Take { n: None }`,
        // `uniform.rs:55`), and since it only re-bootstraps when that `Take` runs
        // out, the sample-rate and channel converters would stay pinned to
        // whatever spec was current while the buffer happened to be empty. A
        // stream that changes rate or channel count later would play the rest at
        // the wrong pitch. One frame says "not finished, ask again": the samples
        // are pulled — which refills the buffer — and the span ends immediately,
        // so the next bootstrap sees the real spec.
        //
        // A whole frame, not a single sample: every other span this reports is
        // `buffer.len()`, an exact number of frames, and the consumers downstream
        // count samples within a frame from the start of a span
        // (`ChannelCountConverter::next_output_sample_pos`, reset on each
        // bootstrap). Half a frame here would only stay harmless as long as
        // that converter runs pass-through, which holds today because every
        // `UniformSourceIterator` below is built with this source's own channel
        // count — an invariant this value should not depend on.
        if self.buffer.is_empty() {
            return Some(self.channels().get() as usize);
        }
        Some(self.buffer.len())
    }

    #[inline]
    fn channels(&self) -> rodio::ChannelCount {
        std::num::NonZeroU16::new(self.spec.channels().count() as u16)
            .unwrap_or(std::num::NonZeroU16::MIN)
    }

    #[inline]
    fn sample_rate(&self) -> rodio::SampleRate {
        std::num::NonZeroU32::new(self.spec.rate()).unwrap_or(std::num::NonZeroU32::MIN)
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration
            .map(|t| Duration::from_secs_f64(t.as_secs_f64().max(0.0)))
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let seek_beyond_end = self
            .total_duration()
            .is_some_and(|dur| dur.saturating_sub(pos).as_millis() < 1);

        let target_secs = if seek_beyond_end {
            // Step back a tiny bit — some demuxers can't seek to the exact end.
            let total = self
                .total_duration
                .map(|t| t.as_secs_f64())
                .unwrap_or_else(|| pos.as_secs_f64());
            (total - 0.0001).max(0.0)
        } else {
            pos.as_secs_f64()
        };

        let time = Time::try_from_secs_f64(target_secs).unwrap_or(Time::ZERO);

        let to_skip = self.current_frame_offset % self.channels().get() as usize;

        // symphonia 0.6's OGG demuxer can `panic!` (e.g. `Option::unwrap()` on
        // `None` in `OggReader::do_seek`) on some streams instead of returning
        // an `Err`. `try_seek` runs on rodio's cpal output thread, so an escaping
        // panic poisons the engine mutexes and then aborts the whole process at
        // the non-unwinding cpal FFI boundary (the "crash on Stop" is a downstream
        // symptom of that poison). Contain the unwind here — including the packet
        // reads in `refine_position`, which can hit the same broken demuxer state —
        // and surface it as a recoverable `SeekError` so the engine stays alive
        // (the seek becomes a no-op rather than killing playback).
        let seek_outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let seek_res = self
                .format
                .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: None })
                .map_err(|e| e.to_string())?;
            // Symphonia requires this: "A decoder must be reset when the next packet
            // is discontinuous with respect to the last decoded packet. Most notably,
            // this occurs after a seek." For MP3 the carried-over state is the bit
            // reservoir and the synthesis overlap, so without the reset the first
            // frames after a seek can be contaminated or rejected even when the
            // frame arithmetic below is correct.
            self.decoder.reset();
            self.refine_position(seek_res)?;
            Ok::<(), String>(())
        }));

        // A failure after `format.seek` has already moved the demuxer leaves the
        // source at the new position while `CountingSource` and
        // `transport_commands` keep the old one — they only update on `Ok`. That
        // split is pre-existing and unchanged here: a fix for it was built and
        // withdrawn in review, because committing to the target left the buffer
        // empty, which at that point reported `Some(0)` — the silent-source
        // failure this whole change exists to remove. It needs its own pass, not
        // a correction inside a seam fix.
        match seek_outcome {
            Ok(Ok(())) => {
                self.current_frame_offset += to_skip;
                Ok(())
            }
            Ok(Err(e)) => Err(rodio::source::SeekError::Other(std::sync::Arc::new(
                std::io::Error::other(e),
            ))),
            Err(_panic) => Err(rodio::source::SeekError::Other(std::sync::Arc::new(
                std::io::Error::other("seek panicked inside the demuxer (contained)"),
            ))),
        }
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

pub(crate) type BuiltSourceStack = PriorityBoostSource<
    CountingSource<
        NotifyingSource<SpectrumTapSource<TriggeredFadeOut<EqualPowerFadeIn<EqSource<DynSource>>>>>,
    >,
>;

/// Result of build_source: the fully-wrapped source plus metadata and control Arcs.
pub(crate) struct BuiltSource {
    pub(crate) source: BuiltSourceStack,
    pub(crate) duration_secs: f64,
    pub(crate) output_rate: u32,
    pub(crate) output_channels: u16,
    /// Real decoded stream format for the `audio:format` event. None only if the
    /// source could not report codec params.
    pub(crate) resolved_format: Option<ResolvedCodecInfo>,
    /// Trigger for the sample-level crossfade fade-out.
    pub(crate) fadeout_trigger: Arc<AtomicBool>,
    /// Total samples for the fade-out (set before triggering).
    pub(crate) fadeout_samples: Arc<AtomicU64>,
}

/// Duration the built source will actually deliver.
///
/// The server hint is whole seconds — `sync/mapping.rs` rounds the API value
/// before it reaches the local index — so it sits up to half a second either
/// side of the real length. It is still the better number for a VBR MP3, whose
/// container duration is an estimate.
///
/// Encoder-gap trimming changes that for one class of stream: once the decoder
/// removes delay and padding, its own frame count *is* what comes out, and the
/// crossfade schedules its fade against exactly that value (`commands.rs`:
/// `remaining = duration_secs - position()`). Preferring the hint there hands
/// the scheduler a length the source will not reach.
///
/// Deliberately narrow: only the decoder-owned trim is covered. `build_source`'s
/// manual `iTunSMPB` trim shortens the stream too, but it has done so since the
/// gapless parser landed and its duration is not this change's to fix.
fn effective_source_duration(decoder: &SizedDecoder, duration_hint: f64) -> f64 {
    let decoded = decoder
        .total_duration()
        .map(|d| d.as_secs_f64())
        .filter(|d| *d > 0.0);
    if decoder.applies_builtin_gapless() {
        if let Some(decoded) = decoded {
            return decoded;
        }
    }
    if duration_hint > 1.0 {
        return duration_hint;
    }
    decoded.unwrap_or(duration_hint)
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
    playback_rate: PlaybackRateAtomics,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    // Channels the output device takes; 0 when that is not known yet.
    target_channels: u16,
    format_hint: Option<&str>,
    hi_res: bool,
) -> Result<BuiltSource, String> {
    let gapless = parse_gapless_info(&data);

    let decoder = SizedDecoder::new(data, format_hint, hi_res)?;
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();
    let resolved_format = Some(decoder.codec_info().clone());
    // Skip the manual trim when the decoder already applied the encoder gap
    // (MP3/Xing-LAME) — trimming both would cut real audio off the track.
    let manual_trim = !decoder.applies_builtin_gapless();
    // One exception, and it is not symmetrical: the decoder can own the front
    // gap while owning no end at all. LAME writes delay and padding independently
    // of Xing's optional `FRAMES` field, and without a frame count the demuxer has
    // no end timestamp to build a `trim_end` from — such a file would keep its
    // padding at exactly the boundary this fix exists to close. The manual end
    // trim stays available for it, while the delay stays with the decoder so the
    // front is not cut twice.
    let manual_end_trim_only = !manual_trim
        && !decoder.applies_builtin_end_trim()
        && gapless.total_valid_samples.is_some();

    let effective_dur = effective_source_duration(&decoder, duration_hint);

    // Apply encoder-delay trim and optional end-padding trim,
    // then resample to the canonical target rate if needed.
    let dyn_src: DynSource = if (manual_trim || manual_end_trim_only)
        && (gapless.delay_samples > 0 || gapless.total_valid_samples.is_some())
    {
        // `total_valid_samples` counts the real audio from `iTunSMPB`'s own delay,
        // which is not necessarily the delay the decoder removed — iTunes
        // re-tagging a LAME-encoded file leaves both, and they can disagree. Skip
        // only what is left of it, so the total lands on the same sample either
        // way. When the decoder cut more than `iTunSMPB` claims, the difference is
        // already gone and the total simply starts where the audio does.
        let delay_samples = if manual_trim {
            gapless.delay_samples
        } else {
            gapless.delay_samples.saturating_sub(decoder.builtin_gapless_delay_frames() as u64)
        };
        let delay_dur = Duration::from_secs_f64(
            delay_samples as f64 / sample_rate.get() as f64
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

    // Fold before everything downstream, so EQ, fades, the spectrum tap and the
    // sample counter all see the channels that will be played.
    let (dyn_src, output_channels) = fold_to_output_channels(dyn_src, channels, target_channels);

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let rate_src = PlaybackRateSource::new(dyn_src, playback_rate.clone());
    let rate_dyn = DynSource::new(rate_src);
    let eq_src = EqSource::new(rate_dyn, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    // Per-track visualizer tap: post-EQ/post-fade and pre-sink volume. During a
    // crossfade its exclusive lease follows the incoming track/metadata; rodio
    // mixes the two players later, so this is intentionally not a post-mix sum.
    let tapped = SpectrumTapSource::new(fade_out);
    let notifying = NotifyingSource::new(tapped, done_flag);
    let counting = CountingSource::new(notifying, sample_counter);
    let boosted = PriorityBoostSource::new(counting);

    Ok(BuiltSource {
        source: boosted,
        duration_secs: crate::playback_rate::effective_duration_secs(effective_dur, &playback_rate),
        output_rate,
        output_channels,
        resolved_format,
        fadeout_trigger,
        fadeout_samples,
    })
}

/// Mixes a multichannel source down to stereo when the device cannot take its
/// channels, and reports the channel count the rest of the pipeline will see.
///
/// Without this, rodio's mixer converts by keeping the first channels and
/// dropping the others, so a 5.1 track on a stereo device loses centre, LFE and
/// both surrounds outright (issue #1408).
///
/// `target_channels` of 0 means "unknown" — the device has not reported yet, and
/// passing the source through unchanged leaves the previous behaviour rather
/// than guessing a layout.
fn fold_to_output_channels(
    source: DynSource,
    channels: std::num::NonZeroU16,
    target_channels: u16,
) -> (DynSource, u16) {
    // Only the stereo fold exists. A device with more channels than two but
    // fewer than the source (a 4.0 output fed 5.1, say) keeps rodio's behaviour;
    // it needs its own layout mapping, not this one.
    if target_channels != 2 || channels.get() <= 2 {
        return (source, channels.get());
    }
    let folded = crate::channel_fold::FoldToStereo::new(source, channels.get() as usize);
    (DynSource::new(folded), 2)
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
    playback_rate: PlaybackRateAtomics,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    // Channels the output device takes; 0 when that is not known yet.
    target_channels: u16,
    count_gate: Option<Arc<AtomicBool>>,
) -> Result<BuiltSource, String> {
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();
    let resolved_format = Some(decoder.codec_info().clone());

    let effective_dur = effective_source_duration(&decoder, duration_hint);

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

    // Same reasoning as `build_source`: fold first, so everything after it works
    // on the channels that will be played.
    let (dyn_src, output_channels) = fold_to_output_channels(dyn_src, channels, target_channels);

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let rate_src = PlaybackRateSource::new(dyn_src, playback_rate.clone());
    let rate_dyn = DynSource::new(rate_src);
    let eq_src = EqSource::new(rate_dyn, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    // Same per-track/incoming-lease semantics as `build_source` above.
    let tapped = SpectrumTapSource::new(fade_out);
    let notifying = NotifyingSource::new(tapped, done_flag);
    let counting = match count_gate {
        Some(gate) => CountingSource::new_gated(notifying, sample_counter, gate),
        None => CountingSource::new(notifying, sample_counter),
    };
    let boosted = PriorityBoostSource::new(counting);

    Ok(BuiltSource {
        source: boosted,
        duration_secs: crate::playback_rate::effective_duration_secs(effective_dur, &playback_rate),
        output_rate,
        output_channels,
        resolved_format,
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

    /// `pub(super)` so `build_source_tests` can reuse it instead of keeping a
    /// second copy of the blob layout.
    pub(super) fn synth_itunsmpb_blob(delay_hex: &str, padding_hex: &str, total_hex: &str) -> Vec<u8> {
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

    pub(super) fn build_mono_pcm16_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
        build_pcm16_wav(samples, sample_rate, 1)
    }

    /// `samples` is interleaved when `num_channels > 1`.
    pub(super) fn build_pcm16_wav(samples: &[i16], sample_rate: u32, num_channels: u16) -> Vec<u8> {
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

    pub(super) fn synthetic_wav_bytes(secs: f32) -> Vec<u8> {
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

    fn build_mono_pcm16_aiff(
        samples: &[i16],
        form: &[u8; 4],
        sound_before_common: bool,
    ) -> Vec<u8> {
        let data_size = (samples.len() * 2) as u32;
        let mut common = Vec::with_capacity(if form == b"AIFC" { 24 } else { 18 });
        common.extend_from_slice(&1u16.to_be_bytes());
        common.extend_from_slice(&(samples.len() as u32).to_be_bytes());
        common.extend_from_slice(&16u16.to_be_bytes());
        common.extend_from_slice(&[0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
        if form == b"AIFC" {
            common.extend_from_slice(b"NONE");
            common.extend_from_slice(&[0, 0]);
        }

        let mut sound = Vec::with_capacity((8 + data_size) as usize);
        sound.extend_from_slice(&0u32.to_be_bytes());
        sound.extend_from_slice(&0u32.to_be_bytes());
        for sample in samples {
            sound.extend_from_slice(&sample.to_be_bytes());
        }

        let mut body = Vec::new();
        body.extend_from_slice(form);
        let mut append_chunk = |id: &[u8; 4], data: &[u8]| {
            body.extend_from_slice(id);
            body.extend_from_slice(&(data.len() as u32).to_be_bytes());
            body.extend_from_slice(data);
            if !data.len().is_multiple_of(2) {
                body.push(0);
            }
        };
        if form == b"AIFC" {
            append_chunk(b"FVER", &0xa280_5140u32.to_be_bytes());
        }
        if sound_before_common {
            append_chunk(b"SSND", &sound);
            append_chunk(b"COMM", &common);
        } else {
            append_chunk(b"COMM", &common);
            append_chunk(b"SSND", &sound);
        }

        let mut out = Vec::with_capacity(body.len() + 8);
        out.extend_from_slice(b"FORM");
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn sized_decoder_constructs_from_synthetic_wav() {
        let wav = synthetic_wav_bytes(0.5);
        let decoder = SizedDecoder::new(wav, Some("wav"), false).expect("WAV decode setup");
        assert_eq!(decoder.spec.rate(), 44_100);
        assert_eq!(decoder.spec.channels().count(), 1);
    }

    #[test]
    fn sized_decoder_returns_err_for_garbage_input() {
        let result = SizedDecoder::new(vec![0x00u8; 64], None, false);
        assert!(result.is_err());
    }

    #[test]
    fn an_empty_buffer_reports_a_whole_frame_so_the_channels_stay_paired() {
        // The span an empty buffer reports is handed to rodio's resampler, which
        // takes `channels` samples for its current frame and `channels` for the
        // next one (`conversions/sample_rate.rs`), and to the channel converter,
        // which counts a frame's samples from the start of every span. Reporting
        // half a frame is only harmless while that converter is pass-through.
        //
        // Measured, because the obvious failure does not happen: a partial frame
        // is *not* dropped on re-bootstrap — `SampleRateConverter::next` drains
        // `current_span` when it cannot interpolate — and no production call site
        // asks for a channel count other than the source's own, so nothing here
        // audibly breaks today. This test pins the frame alignment rather than
        // that pair of coincidences.
        //
        // The empty buffer itself is reached by seeking near the end:
        // `refine_position` hits EOF while refining and clears it.
        const LEFT: i16 = 12_000;
        const RIGHT: i16 = -12_000;
        let frames = 4_096;
        let mut interleaved = Vec::with_capacity(frames * 2);
        for _ in 0..frames {
            interleaved.push(LEFT);
            interleaved.push(RIGHT);
        }
        let wav = build_pcm16_wav(&interleaved, 44_100, 2);

        let mut decoder = SizedDecoder::new(wav, Some("wav"), false).expect("stereo WAV decode");
        assert_eq!(decoder.channels().get(), 2, "fixture must be stereo");

        // The state `refine_position` leaves behind at EOF.
        decoder.buffer.clear();
        decoder.current_frame_offset = 0;

        let span = decoder
            .current_span_len()
            .expect("an empty buffer must not report an infinite span");
        assert_eq!(
            span % decoder.channels().get() as usize,
            0,
            "a span that is not a whole number of frames shifts the interleave phase"
        );

        // 44.1 kHz source on a 48 kHz device: the rate converter is in the chain,
        // which is the only case where the span is consumed this way.
        let resampled = UniformSourceIterator::new(
            decoder,
            std::num::NonZeroU16::new(2).unwrap(),
            std::num::NonZeroU32::new(48_000).unwrap(),
        );
        let out: Vec<f32> = resampled.take(64).collect();
        assert!(!out.is_empty(), "resampled source must still produce audio");

        for (i, s) in out.iter().enumerate() {
            let expected_left = i % 2 == 0;
            assert_eq!(
                *s > 0.0,
                expected_left,
                "sample {i} landed on the wrong channel: the interleave phase shifted"
            );
        }
    }

    #[test]
    fn sized_decoder_uses_format_hint_when_provided() {
        let wav = synthetic_wav_bytes(0.3);
        let _decoder = SizedDecoder::new(wav, Some("wav"), true).expect("WAV decode with hi-res");
    }

    // ── new_streaming + ProbeSeekGate ────────────────────────────────────────

    fn seekable_source(bytes: Vec<u8>) -> Box<dyn MediaSource> {
        let len = bytes.len() as u64;
        Box::new(SizedCursorSource { inner: Cursor::new(bytes), len })
    }

    #[test]
    fn new_streaming_constructs_from_synthetic_wav() {
        let wav = synthetic_wav_bytes(0.5);
        let decoder =
            SizedDecoder::new_streaming(seekable_source(wav), Some("wav"), "test-stream", true, None)
                .expect("streaming WAV decode setup");
        assert_eq!(decoder.spec.rate(), 44_100);
        assert_eq!(decoder.spec.channels().count(), 1);
        // A finite, seekable source reports the duration it will actually deliver,
        // so consumers scheduling from it (crossfade) stay in step with the source.
        assert!(
            decoder.total_duration.is_some(),
            "a random-access source has a real frame count and must report it"
        );

        // An open-ended one does not: its frame count cannot be trusted.
        let wav = synthetic_wav_bytes(0.5);
        let live =
            SizedDecoder::new_streaming(seekable_source(wav), Some("wav"), "test-stream", false, None)
                .expect("streaming WAV decode setup");
        assert!(
            live.total_duration.is_none(),
            "radio and the non-seekable fallback must not claim a duration"
        );
    }

    #[test]
    fn new_streaming_decodes_synthetic_aiff() {
        let aiff = build_mono_pcm16_aiff(&[16_384; 64], b"AIFF", false);
        let mut decoder =
            SizedDecoder::new_streaming(seekable_source(aiff), Some("aiff"), "test-stream", true, None)
                .expect("streaming AIFF decode setup");
        assert_eq!(decoder.spec.rate(), 44_100);
        assert_eq!(decoder.spec.channels().count(), 1);
        let sample = decoder.next().expect("AIFF should yield decoded PCM");
        assert!((sample - 0.5).abs() < 0.01, "decoded sample was {sample}");
    }

    #[test]
    fn random_access_stream_decodes_aiff_with_sound_before_common() {
        let aiff = build_mono_pcm16_aiff(&[16_384; 64], b"AIFF", true);
        let mut decoder =
            SizedDecoder::new_streaming(seekable_source(aiff), Some("aif"), "hot-cache", true, None)
                .expect("seekable AIFF should allow chunks in either order");
        assert!(decoder.next().is_some());
    }

    #[test]
    fn hintless_sized_decoder_decodes_aiff_with_sound_before_common() {
        let aiff = build_mono_pcm16_aiff(&[16_384; 64], b"AIFF", true);
        let mut decoder = SizedDecoder::new(aiff, None, false)
            .expect("hintless in-memory AIFF should be sniffed before the seek gate");
        assert!(decoder.next().is_some());
    }

    #[test]
    fn misleading_hint_does_not_hide_seekability_for_sniffed_aiff() {
        let aiff = build_mono_pcm16_aiff(&[16_384; 64], b"AIFF", true);
        let mut decoder = SizedDecoder::new(aiff, Some("view"), false)
            .expect("AIFF magic should control the seek gate despite a misleading URL tail");
        assert!(decoder.next().is_some());
    }

    #[test]
    fn sized_decoder_decodes_uncompressed_aifc() {
        let aifc = build_mono_pcm16_aiff(&[16_384; 64], b"AIFC", false);
        let mut decoder =
            SizedDecoder::new(aifc, Some("aifc"), false).expect("AIFC decode setup");
        let sample = decoder.next().expect("AIFC should yield decoded PCM");
        assert!((sample - 0.5).abs() < 0.01, "decoded sample was {sample}");
    }

    #[test]
    fn new_streaming_returns_err_for_garbage_input() {
        let result = SizedDecoder::new_streaming(
            seekable_source(vec![0x00u8; 64]),
            None,
            "test-stream",
            true,
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn probe_seek_gate_toggles_seekability() {
        let wav = synthetic_wav_bytes(0.1);
        let len = wav.len() as u64;
        let flag = Arc::new(AtomicBool::new(false));
        let gate = ProbeSeekGate {
            inner: seekable_source(wav),
            seekable: flag.clone(),
        };
        // Hidden during probe …
        assert!(!gate.is_seekable());
        // … restored afterwards.
        flag.store(true, Ordering::Relaxed);
        assert!(gate.is_seekable());
        // byte_len always passes through to the inner source.
        assert_eq!(gate.byte_len(), Some(len));
    }

    #[test]
    fn probe_seek_gate_read_and_seek_pass_through() {
        let bytes = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let mut gate = ProbeSeekGate {
            inner: seekable_source(bytes),
            seekable: Arc::new(AtomicBool::new(true)),
        };
        let mut buf = [0u8; 4];
        let n = gate.read(&mut buf).expect("read");
        assert_eq!(n, 4);
        assert_eq!(&buf, &[1, 2, 3, 4]);
        let pos = gate.seek(std::io::SeekFrom::Start(6)).expect("seek");
        assert_eq!(pos, 6);
        let n = gate.read(&mut buf).expect("read after seek");
        assert_eq!(&buf[..n], &[7, 8]);
    }

    // ── log_codec_resolution ─────────────────────────────────────────────────

    #[test]
    fn log_codec_resolution_does_not_panic_for_valid_params() {
        let mut params = AudioCodecParameters::new();
        params.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_PCM_S16LE;
        params.sample_rate = Some(44_100);
        params.bits_per_sample = Some(16);
        params.channels = Some(symphonia::core::audio::Channels::Discrete(1));
        log_codec_resolution("test-tag", &params, Some("wav"));
    }

    #[test]
    fn log_codec_resolution_handles_unknown_codec_gracefully() {
        let params = AudioCodecParameters::new();
        log_codec_resolution("unknown", &params, None);
    }

    // ── resolve_codec_info / AudioFormatEvent ────────────────────────────────

    #[test]
    fn resolve_codec_info_reports_pcm_as_lossless() {
        let mut params = AudioCodecParameters::new();
        params.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_PCM_S16LE;
        params.sample_rate = Some(44_100);
        params.bits_per_sample = Some(16);
        params.channels = Some(symphonia::core::audio::Channels::Discrete(1));
        let info = resolve_codec_info(&params);
        assert!(info.codec_name.starts_with("pcm"));
        assert!(info.lossless);
        assert_eq!(info.sample_rate, Some(44_100));
        assert_eq!(info.bits_per_sample, Some(16));
        assert_eq!(info.channels, Some(1));
    }

    #[test]
    fn resolve_codec_info_reports_mp3_as_lossy() {
        let mut params = AudioCodecParameters::new();
        params.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_MP3;
        params.sample_rate = Some(44_100);
        let info = resolve_codec_info(&params);
        assert_eq!(info.codec_name, "mp3");
        assert!(!info.lossless);
    }

    #[test]
    fn audio_format_event_drops_bit_depth_for_lossy() {
        let lossy = ResolvedCodecInfo {
            codec_name: "mp3",
            sample_rate: Some(44_100),
            bits_per_sample: Some(16),
            channels: Some(2),
            lossless: false,
        };
        let ev = AudioFormatEvent::from_info(&lossy, AudioFormatIdentity {
            track_id: Some("t1".into()),
            server_id: Some("srv".into()),
            generation: Some(7),
            stream_cap_kbps: Some(128),
        });
        assert_eq!(ev.bits_per_sample, None);
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["codec"], "mp3");
        assert_eq!(json["sampleRate"], 44_100);
        assert_eq!(json["lossless"], false);
        assert!(json["bitsPerSample"].is_null());
        assert_eq!(json["trackId"], "t1");
        assert_eq!(json["serverId"], "srv");
        assert_eq!(json["generation"], 7);
        assert_eq!(json["streamCapKbps"], 128);
    }

    #[test]
    fn audio_format_event_keeps_bit_depth_for_lossless() {
        let lossless = ResolvedCodecInfo {
            codec_name: "flac",
            sample_rate: Some(96_000),
            bits_per_sample: Some(24),
            channels: Some(2),
            lossless: true,
        };
        let ev = AudioFormatEvent::from_info(&lossless, AudioFormatIdentity::default());
        assert_eq!(ev.bits_per_sample, Some(24));
    }
}

#[cfg(test)]
#[path = "decode_fixture_tests.rs"]
mod build_source_tests;

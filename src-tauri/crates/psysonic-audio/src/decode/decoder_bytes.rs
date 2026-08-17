use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    common::Limit,
    formats::probe::Hint,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    units::Timestamp,
};

use crate::codec::psysonic_codec_registry;

use super::decoder::{
    encoder_gap_reported, should_use_builtin_gapless, SizedDecoder, MAX_CONSECUTIVE_DECODE_ERRORS,
};
use super::format::{log_codec_resolution, resolve_codec_info};
use super::source_probe::{ProbeSeekGate, SizedCursorSource};

impl SizedDecoder {
    pub(crate) fn new(
        data: Vec<u8>,
        format_hint: Option<&str>,
        hi_res: bool,
    ) -> Result<Self, String> {
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
        let mss = MediaSourceStream::new(
            media,
            MediaSourceStreamOptions {
                buffer_len: buf_len,
            },
        );

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
                crate::app_eprintln!(
                    "[psysonic] no audio track found among {} tracks",
                    format.tracks().len()
                );
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
                Timestamp::try_from(frames)
                    .ok()
                    .and_then(|ts| base.calc_time(ts))
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
        let builtin_gapless_trims_end = builtin_gapless && track_num_frames.is_some_and(|n| n > 0);
        let builtin_gapless_delay = if builtin_gapless {
            track_delay.unwrap_or(0)
        } else {
            0
        };
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
                crate::app_eprintln!(
                    "[psysonic] skipping packet for track {} (want {})",
                    packet.track_id,
                    track_id
                );
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
                    crate::app_eprintln!(
                        "[psysonic] init: dropped corrupt frame #{decode_errors}: {msg}"
                    );
                    if decode_errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(
                            "too many consecutive decode errors during init — file may be corrupt"
                                .into(),
                        );
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
}

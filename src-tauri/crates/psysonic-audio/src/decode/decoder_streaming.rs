use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    formats::probe::Hint,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    units::Timestamp,
};

use crate::codec::try_make_radio_decoder;

use super::decoder::{
    encoder_gap_reported, should_use_builtin_gapless, SizedDecoder, MAX_CONSECUTIVE_DECODE_ERRORS,
    STREAM_PROBE_TIMEOUT,
};
use super::format::{log_codec_resolution, resolve_codec_info};
use super::source_probe::ProbeSeekGate;

impl SizedDecoder {
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
            Some(gate) => Box::new(ProbeSeekGate {
                inner: media,
                seekable: gate.clone(),
            }),
            None => media,
        };

        // Larger read-ahead buffer for the live streaming SPSC consumer — reduces
        // read() call frequency into the ring buffer, easing I/O spikes.
        let mss = MediaSourceStream::new(
            media,
            MediaSourceStreamOptions {
                buffer_len: 512 * 1024,
            },
        );
        let format_opts = FormatOptions::default();
        let meta_opts = MetadataOptions::default();

        crate::app_deprintln!(
            "[stream] {source_tag}: probe start (hint={}, stream_len={})",
            format_hint.unwrap_or("?"),
            stream_len
                .map(|n| n.to_string())
                .unwrap_or_else(|| "?".into()),
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

        let track = format
            .tracks()
            .iter()
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
                track
                    .time_base
                    .zip(track.num_frames)
                    .and_then(|(base, frames)| {
                        Timestamp::try_from(frames)
                            .ok()
                            .and_then(|ts| base.calc_time(ts))
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
        let builtin_gapless_trims_end = builtin_gapless && track_num_frames.is_some_and(|n| n > 0);
        let builtin_gapless_delay = if builtin_gapless {
            track_delay.unwrap_or(0)
        } else {
            0
        };
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
                Ok(None) => {
                    break Self::buffer_at_end_of_media(
                        decoder.last_decoded(),
                        source_tag,
                        superseded.as_ref(),
                        "stream ended",
                    )?
                }
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
            if packet.track_id != track_id {
                continue;
            }
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
                    crate::app_eprintln!(
                        "[psysonic] {source_tag} init: dropped corrupt frame #{errors}: {msg}"
                    );
                    if errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(format!("{source_tag}: too many consecutive decode errors"));
                    }
                }
                Err(e) => return Err(format!("{source_tag}: decode error: {e}")),
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

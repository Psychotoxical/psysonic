use std::time::Duration;

use rodio::Source;
use symphonia::core::{
    audio::{AudioSpec, GenericAudioBufferRef},
    codecs::audio::AudioDecoder,
    formats::{FormatReader, SeekMode, SeekTo},
    units::Time,
};

use super::format::ResolvedCodecInfo;

/// Max retries for IO/packet-read errors (fatal — network drop, truncated file).
const DECODE_MAX_RETRIES: usize = 3;
/// Max *consecutive* DecodeErrors before giving up on a file.
/// Non-fatal errors like "invalid main_data offset" are silently dropped up to
/// this limit so a handful of corrupt MP3 frames never aborts an otherwise
/// playable track (VLC-style frame dropping).
pub(super) const MAX_CONSECUTIVE_DECODE_ERRORS: usize = 100;
/// Wall-clock cap for the streaming `probe()` call. A ranged-HTTP source whose
/// download stalls (e.g. right after a server switch) can otherwise block the
/// probe — and therefore playback start — indefinitely. On timeout we abort with
/// an error so the player can recover/retry instead of hanging until a restart.
pub(super) const STREAM_PROBE_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) struct SizedDecoder {
    pub(super) decoder: Box<dyn AudioDecoder>,
    pub(super) current_frame_offset: usize,
    pub(super) format: Box<dyn FormatReader>,
    pub(super) total_duration: Option<Time>,
    /// Interleaved f32 samples of the currently decoded packet.
    pub(super) buffer: Vec<f32>,
    pub(super) spec: AudioSpec,
    /// Real decoded format (codec/rate/depth) for the now-playing UI badge.
    pub(super) codec_info: ResolvedCodecInfo,
    /// Whether Symphonia's own encoder-gap trimming is active for this stream.
    /// When true the decoder already removed encoder delay/padding, so
    /// `build_source` must not apply its manual `iTunSMPB` trim on top.
    pub(super) builtin_gapless: bool,
    /// Whether that trimming reaches the *end* of the stream. LAME writes its
    /// delay/padding extension independently of Xing's optional frame count, and
    /// without a count the demuxer has no end timestamp, so `PacketBuilder` never
    /// produces a `trim_end` — the decoder removes the front gap and leaves the
    /// padding. `build_source` keeps its manual end trim for that case.
    pub(super) builtin_gapless_trims_end: bool,
    /// The encoder delay the demuxer reported, in frames — what built-in gapless
    /// removed from the front. `build_source` needs it to place an `iTunSMPB`
    /// total, which counts from *its own* delay, against an already-trimmed
    /// stream. Zero whenever built-in gapless is off.
    pub(super) builtin_gapless_delay: u32,
    /// Counts consecutive DecodeErrors in the hot-path. Reset to 0 on every
    /// successfully decoded frame. Used to detect fully undecodable streams.
    pub(super) consecutive_decode_errors: usize,
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
pub(super) fn should_use_builtin_gapless(codec_name: &str) -> bool {
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
pub(super) fn encoder_gap_reported(
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
    pub(super) fn spec_and_buffer_at_eof(last: GenericAudioBufferRef<'_>) -> (AudioSpec, Vec<f32>) {
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
    pub(super) fn buffer_at_end_of_media(
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
    pub(super) fn make_buffer(decoded: &GenericAudioBufferRef<'_>) -> Vec<f32> {
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
            let candidate = match self
                .format
                .next_packet()
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
                let p = match self
                    .format
                    .next_packet()
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

#[cfg(test)]
#[path = "tests/decoder_unit.rs"]
mod tests;

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
                .seek(
                    SeekMode::Accurate,
                    SeekTo::Time {
                        time,
                        track_id: None,
                    },
                )
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

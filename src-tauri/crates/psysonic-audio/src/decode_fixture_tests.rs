//! Fixture-backed decoder tests.
//!
//! Split out of `decode.rs`: these are binary-fixture integration tests and were
//! pushing the decoder module well past the project's size trigger. Declared with
//! `#[path]` from `decode.rs`, so this stays a child module and keeps access to
//! the private decoder internals it exercises.

use super::*;

type EqGains = Arc<[AtomicU32; 10]>;
type SourceArgs = (
    EqGains,
    Arc<AtomicBool>,
    Arc<AtomicU32>,
    PlaybackRateAtomics,
    Arc<AtomicBool>,
    Arc<AtomicU64>,
);

fn default_source_args() -> SourceArgs {
    let eq_gains: Arc<[AtomicU32; 10]> =
        Arc::new(std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())));
    let eq_enabled = Arc::new(AtomicBool::new(false));
    let eq_pre_gain = Arc::new(AtomicU32::new(0f32.to_bits()));
    let playback_rate = PlaybackRateAtomics::new();
    let done_flag = Arc::new(AtomicBool::new(false));
    let sample_counter = Arc::new(AtomicU64::new(0));
    (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter)
}

#[test]
fn build_source_succeeds_for_synthetic_wav() {
    // Building a source installs a SpectrumTapSource over the process-global
    // spectrum ring and lease; hold the same lock the spectrum tests use.
    let _globals = crate::spectrum::tests::lock_globals();
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let wav = super::tests::synthetic_wav_bytes(0.4);
    let built = build_source(
        wav,
        0.4,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        0, // no device channel count in tests: leave the source as it is
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
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let result = build_source(
        vec![0u8; 32],
        0.0,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        0, // no device channel count in tests: leave the source as it is
        None,
        false,
    );
    assert!(result.is_err());
}

#[test]
fn build_streaming_source_succeeds_for_synthetic_wav() {
    // Building a source installs a SpectrumTapSource over the process-global
    // spectrum ring and lease; hold the same lock the spectrum tests use.
    let _globals = crate::spectrum::tests::lock_globals();
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let wav = super::tests::synthetic_wav_bytes(0.4);
    let decoder = SizedDecoder::new(wav, Some("wav"), false).unwrap();
    let built = build_streaming_source(
        decoder,
        0.4,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        0, // no device channel count in tests: leave the source as it is
        None,
    )
    .expect("build_streaming_source must succeed for a valid WAV decoder");
    assert_eq!(built.output_channels, 1);
    assert!(built.output_rate > 0);
}

#[test]
fn build_source_with_target_rate_resamples() {
    // Building a source installs a SpectrumTapSource over the process-global
    // spectrum ring and lease; hold the same lock the spectrum tests use.
    let _globals = crate::spectrum::tests::lock_globals();
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let wav = super::tests::synthetic_wav_bytes(0.3);
    let built = build_source(
        wav,
        0.3,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::from_millis(5),
        sample_counter,
        48_000,
        0, // no device channel count in tests: leave the source as it is
        Some("wav"),
        false,
    )
    .expect("resampled build_source must succeed");
    assert_eq!(built.output_rate, 48_000);
}

// ── Encoder-gap ownership per codec (issue #1373) ────────────────────────

#[test]
fn builtin_gapless_is_used_for_mp3() {
    assert!(should_use_builtin_gapless("mp3"));
}

#[test]
fn builtin_gapless_is_not_used_for_other_codecs() {
    // AAC/ALAC keep the manual iTunSMPB path; lossless codecs have no
    // encoder gap at all. Any of these turning true would double-trim.
    for codec in ["aac", "alac", "flac", "pcm_s16le", "vorbis", "opus", "?"] {
        assert!(
            !should_use_builtin_gapless(codec),
            "{codec} must keep the manual trim path"
        );
    }
}

/// A 440 Hz sine encoded with libmp3lame, carrying the Xing/LAME `Info`
/// header. Reference numbers and the regeneration recipe live in
/// `fixtures/README.md`.
const LAME_SINE_MP3: &[u8] = include_bytes!("../fixtures/lame_sine_22050.mp3");
/// Samples of the signal that was encoded — what a correct decode returns.
const LAME_SINE_TRIMMED_FRAMES: u64 = 22_050;
/// 21 MP3 packets x 1152 samples — what an untrimmed decode returns.
const LAME_SINE_RAW_FRAMES: u64 = 24_192;
/// Same signal encoded without a Xing header: symphonia reports no encoder
/// gap for it, which is what an iTunes-encoded MP3 looks like to the decoder.
const NO_XING_MP3: &[u8] = include_bytes!("../fixtures/no_xing_sine.mp3");
const NO_XING_RAW_FRAMES: u64 = 24_192;
/// 22.05 kHz (MPEG-2 Layer III, 576 samples per frame) — its first packet is
/// shorter than the encoder delay and is trimmed away entirely.
const MPEG2_SINE_MP3: &[u8] = include_bytes!("../fixtures/mpeg2_sine_22050.mp3");

/// Decode `data` through the production `build_source` path and return the
/// frame count, cross-checked against the production sample counter.
fn decoded_frames(data: Vec<u8>, format_hint: Option<&str>) -> u64 {
    decoded_frames_with_target(data, format_hint, 0)
}

/// As above, but with an explicit resampling target (0 = native rate). The
/// resampling branch wraps the source in rodio's `UniformSourceIterator`,
/// which is where a zero-length first span becomes silence.
fn decoded_frames_with_target(data: Vec<u8>, format_hint: Option<&str>, target_rate: u32) -> u64 {
    let (samples, channels) = decoded_samples_with_target(data, format_hint, target_rate);
    samples.len() as u64 / channels
}

/// The decoded samples plus the channel count — used where a test needs to
/// look at the waveform itself, not just how many samples came out.
fn decoded_samples_with_target(
    data: Vec<u8>,
    format_hint: Option<&str>,
    target_rate: u32,
) -> (Vec<f32>, u64) {
    // Draining a built source runs a `SpectrumTapSource` over the
    // process-global spectrum ring and lease. Hold the lock the spectrum
    // tests use so the two cannot interleave.
    let _globals = crate::spectrum::tests::lock_globals();
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let counter = Arc::clone(&sample_counter);
    let built = build_source(
        data,
        0.0,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        // No fade: it would not change the sample count but adds noise to the
        // thing under test.
        Duration::ZERO,
        sample_counter,
        target_rate,
        0, // no device channel count: leave the source as it is
        format_hint,
        false,
    )
    .expect("fixture must decode");

    let channels = built.output_channels as u64;
    let samples: Vec<f32> = built.source.collect();
    assert_eq!(
        samples.len() as u64,
        counter.load(Ordering::Relaxed),
        "drain count and production CountingSource must agree"
    );
    (samples, channels)
}

#[test]
fn mp3_encoder_delay_and_padding_are_trimmed() {
    // Regression for #1373. Before the fix this returned the raw frame count,
    // i.e. every track played ~48 ms of encoder delay and padding as audio —
    // the audible seam in a gapless chain.
    let (samples, channels) = decoded_samples_with_target(LAME_SINE_MP3.to_vec(), Some("mp3"), 0);
    let frames = samples.len() as u64 / channels;
    assert_ne!(
        frames, LAME_SINE_RAW_FRAMES,
        "encoder delay and padding are still played as audio (issue #1373)"
    );
    assert_eq!(frames, LAME_SINE_TRIMMED_FRAMES);

    // The count alone would also pass if the trim happened at the wrong end.
    // The fixture is a 440 Hz sine starting at phase 0, so a correctly trimmed
    // decode starts near zero and rises; a decode that kept the encoder delay
    // (or cut only from the back) starts somewhere else on the curve.
    let head: Vec<f32> = samples.iter().copied().take(6).collect();
    assert!(
        head[0].abs() < 0.05,
        "first sample should sit at the start of the sine, got {head:?}"
    );
    assert!(
        head[5] > head[0],
        "sine should be rising out of phase 0, got {head:?}"
    );
}

#[test]
fn mp3_with_itunsmpb_is_not_trimmed_twice() {
    // Some MP3s carry an iTunSMPB tag in addition to the Xing/LAME header.
    // Symphonia already trims those files, so the manual parser must stand
    // down — otherwise its delay would be cut off real audio a second time.
    let mut data = LAME_SINE_MP3.to_vec();
    data.extend_from_slice(&super::tests::synth_itunsmpb_blob("00000840", "00000000", "00000000"));

    // Guard the premise: the manual parser really does see the tag here.
    let info = parse_gapless_info(&data);
    assert_eq!(info.delay_samples, 0x840, "fixture must expose an iTunSMPB delay");

    assert_eq!(
        decoded_frames(data, Some("mp3")),
        LAME_SINE_TRIMMED_FRAMES,
        "decoder trim only — the manual iTunSMPB delay must not be applied on top"
    );
}

/// Same measurement through the streaming path (`SeekableMedia` / radio),
/// which is what a locally cached `psysonic-local://` file plays through.
fn decoded_frames_streaming(
    data: Vec<u8>,
    format_hint: Option<&str>,
    random_access: bool,
    target_rate: u32,
) -> u64 {
    // Same reason as `decoded_samples_with_target`: this drains a real source.
    let _globals = crate::spectrum::tests::lock_globals();
    let len = data.len() as u64;
    let media: Box<dyn MediaSource> =
        Box::new(SizedCursorSource { inner: Cursor::new(data), len });
    let decoder = SizedDecoder::new_streaming(media, format_hint, "test-stream", random_access, None)
        .expect("fixture must decode as a stream");

    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let counter = Arc::clone(&sample_counter);
    let built = build_streaming_source(
        decoder,
        0.0,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        target_rate,
        0, // no device channel count: leave the source as it is
        None,
    )
    .expect("streaming source must build");

    let channels = built.output_channels as u64;
    let mut drained: u64 = 0;
    for _ in built.source {
        drained += 1;
    }
    assert_eq!(
        drained,
        counter.load(Ordering::Relaxed),
        "drain count and production CountingSource must agree"
    );
    drained / channels
}

#[test]
fn cached_local_mp3_is_trimmed_on_the_streaming_path() {
    // A pinned/cached file plays as a seekable local source, not from bytes.
    // Without this the *predecessor* of a gapless boundary would still emit
    // its end padding — half the seam would survive the fix.
    assert_eq!(
        decoded_frames_streaming(LAME_SINE_MP3.to_vec(), Some("mp3"), true, 0),
        LAME_SINE_TRIMMED_FRAMES
    );
}

#[test]
fn progressive_mp3_stream_keeps_previous_behaviour() {
    // Radio and the legacy non-seekable fallback have no trustworthy frame count
    // up front, so they deliberately stay untrimmed. This models exactly those:
    // ranged HTTP is *not* in this set — `play_input.rs` passes
    // `random_access: true` for it, so a ranged read is trimmed like a local file.
    assert_eq!(
        decoded_frames_streaming(LAME_SINE_MP3.to_vec(), Some("mp3"), false, 0),
        LAME_SINE_RAW_FRAMES
    );
}

/// A source that serves `head` bytes and then stops, to model a range read dying
/// mid-stream rather than a stream ending cleanly.
///
/// `quiet_eof` picks how it stops: `false` is a hard transport error, `true` is
/// the `Ok(0)` that every on-demand reader returns once its generation moved —
/// the one the stream layer reaches on a track skip or a preview hover-away.
struct FailAfterSource {
    inner: Cursor<Vec<u8>>,
    head: u64,
    total: u64,
    quiet_eof: bool,
}

impl Read for FailAfterSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let pos = self.inner.position();
        if pos >= self.head {
            if self.quiet_eof {
                return Ok(0);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "range read failed",
            ));
        }
        // Hand out at most the bytes before the cut. Without this cap the very
        // first read satisfies the 512 KiB stream buffer from the whole fixture
        // and the failure never happens.
        let remaining = (self.head - pos) as usize;
        let take = buf.len().min(remaining);
        self.inner.read(&mut buf[..take])
    }
}

impl Seek for FailAfterSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for FailAfterSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.total)
    }
}

#[test]
fn a_failing_read_is_an_error_not_an_empty_track() {
    // With gapless trimming the first MPEG-2 packet decodes to zero frames, so
    // `last_decoded()` is still empty when the next read fails. Folding that into
    // EOF would hand the player a construction *success* holding no audio: it
    // would show a track that ends immediately instead of retrying. Only a clean
    // `Ok(None)` is end-of-media.
    let data = MPEG2_SINE_MP3.to_vec();
    let total = data.len() as u64;
    // Past the probe (a probe failure reports differently) but inside the
    // initialization loop, which is where the empty-buffer case lives.
    let head = (total / 16).max(1);
    let media: Box<dyn MediaSource> = Box::new(FailAfterSource {
        inner: Cursor::new(data),
        head,
        total,
        quiet_eof: false,
    });

    let err = match SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, None) {
        Ok(_) => panic!("a failing read must not construct a decoder"),
        Err(e) => e,
    };
    // Pinned to the initialization loop on purpose: a probe failure would prove
    // nothing about the arm under test, since the probe rejected truncated input
    // before this change too. If probe read-ahead ever shifts far enough to
    // swallow the cut-off, this fails loudly and the cut-off gets retuned —
    // preferable to an assertion that also passes on the old behaviour.
    assert!(
        err.contains("could not read audio data"),
        "the read failure must surface from initialization, got: {err}"
    );
}

#[test]
fn fully_trimmed_first_packet_streaming_resample_still_produces_audio() {
    // The streaming twin of `fully_trimmed_first_packet_still_produces_audio`.
    // Local files and ranged HTTP both build through `new_streaming`, and
    // hi-res blend / AutoDJ can ask for a non-native rate — so this is the
    // combination a real listener hits. Measured before the guard existed:
    // 0 frames at 48 kHz while the same fixture yielded 22050 frames at the
    // native rate, i.e. a completely silent track.
    let frames =
        decoded_frames_streaming(MPEG2_SINE_MP3.to_vec(), Some("mp3"), true, 48_000);
    assert!(
        frames > 40_000,
        "resampled 22.05 kHz MP3 must still produce audio on the streaming path, got {frames} frames"
    );
}

#[test]
fn mp3_without_encoder_gap_metadata_keeps_the_manual_trim() {
    // symphonia only reports delay/padding when it recognises the encoder in
    // the Xing extension; an iTunes-encoded MP3 (and this Xing-less fixture)
    // reports nothing while still carrying an `iTunSMPB` tag. Keying ownership
    // on the codec name alone would leave those files with no trim at all —
    // a regression of the very bug this branch fixes.
    let mut data = NO_XING_MP3.to_vec();
    data.extend_from_slice(&super::tests::synth_itunsmpb_blob(
        "00000840",
        "00000000",
        "00000000",
    ));
    assert_eq!(
        decoded_frames(data, Some("mp3")),
        NO_XING_RAW_FRAMES - 0x840,
        "manual iTunSMPB trim must still run when the decoder reports no gap"
    );
}

#[test]
fn fully_trimmed_first_packet_still_produces_audio() {
    // An MPEG-2/2.5 Layer III frame holds 576 samples, less than the ~1105
    // sample LAME delay, so the first packet is trimmed away completely. If the
    // decoder treats that as end-of-stream, the resampling path (hi-res blend,
    // AutoDJ) yields a silent track — this returned 0 frames before the fix.
    let frames = decoded_frames_with_target(MPEG2_SINE_MP3.to_vec(), Some("mp3"), 48_000);
    assert!(
        frames > 40_000,
        "resampled 22.05 kHz MP3 must still produce audio, got {frames} frames"
    );
}

/// Decode-throughput probe for the pre-PR runtime rule. Ignored by default;
/// run explicitly on both the base and the head build:
///
/// ```text
/// cargo test --workspace mp3_decode_throughput -- --ignored --nocapture
/// ```
///
/// Reports frames/second over repeated full decodes so the gapless trim can be
/// compared against the untrimmed base on the same machine and profile.
#[test]
#[ignore]
fn mp3_decode_throughput() {
    // Odd count so the median is a real sample rather than a pick between two.
    const RUNS: usize = 41;
    let mut elapsed_per_run = Vec::with_capacity(RUNS);
    let mut frames: Option<u64> = None;

    for _ in 0..RUNS {
        // Construction runs the probe, demuxer and codec init. That is startup
        // cost, not decode throughput, so it stays outside the timed region —
        // otherwise the number reported below is not what this change affects.
        let decoder =
            SizedDecoder::new(LAME_SINE_MP3.to_vec(), Some("mp3"), false).expect("decode");
        let t0 = std::time::Instant::now();
        let n = decoder.count() as u64;
        let dt = t0.elapsed().as_secs_f64();
        elapsed_per_run.push(dt);
        match frames {
            None => frames = Some(n),
            Some(prev) => assert_eq!(prev, n, "frame count must not vary between runs"),
        }
    }

    let frames = frames.expect("at least one run");
    elapsed_per_run.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = elapsed_per_run[RUNS / 2];
    let min = elapsed_per_run[0];
    let max = elapsed_per_run[RUNS - 1];
    let mean = elapsed_per_run.iter().sum::<f64>() / RUNS as f64;
    let var = elapsed_per_run
        .iter()
        .map(|d| (d - mean).powi(2))
        .sum::<f64>()
        / RUNS as f64;

    println!(
        "THROUGHPUT frames={frames} runs={RUNS} median_ms={:.3} min_ms={:.3} max_ms={:.3} stddev_ms={:.3} frames_per_sec={:.0}",
        median * 1e3,
        min * 1e3,
        max * 1e3,
        var.sqrt() * 1e3,
        frames as f64 / median
    );
}

#[test]
fn reported_duration_matches_the_frames_actually_delivered() {
    // Crossfade schedules the fade-out from the reported duration
    // (`commands.rs`: `remaining = duration_secs - position()`), so a source that
    // ends earlier than it claims gets its fade cut off mid-curve — a click
    // introduced by the very change that removes one. Whatever this decoder
    // reports has to match what it actually yields.
    let decoder = SizedDecoder::new(LAME_SINE_MP3.to_vec(), Some("mp3"), false).expect("decode");
    let reported = decoder
        .total_duration()
        .expect("fixture must report a duration");
    let rate = decoder.sample_rate().get() as f64;
    let channels = decoder.channels().get() as u64;
    let delivered = decoder.count() as u64 / channels;

    let reported_frames = (reported.as_secs_f64() * rate).round() as u64;
    assert_eq!(
        reported_frames, delivered,
        "reported duration is {reported_frames} frames but the source yields {delivered}"
    );
}

#[test]
fn a_superseded_read_ends_quietly_while_a_truncated_one_is_an_error() {
    // Both runs use identical bytes and an identical cut-off. The only variable
    // is whether the generation moved — which is the point: a reader that has
    // been superseded answers `Ok(0)`, exactly like a stream that ran out, so
    // the error kind alone can never tell a skip from a broken file.
    fn build(guard: Option<crate::stream::GenerationGuard>) -> Result<SizedDecoder, String> {
        let data = MPEG2_SINE_MP3.to_vec();
        let total = data.len() as u64;
        // Past the probe, inside the initialization loop — the fixture's first
        // packet is trimmed away entirely, so the buffer there is still empty.
        let head = (total / 16).max(1);
        let media: Box<dyn MediaSource> = Box::new(FailAfterSource {
            inner: Cursor::new(data),
            head,
            total,
            quiet_eof: true,
        });
        SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, guard)
    }

    // The generation moved: the user skipped or hovered away. Abandoned, not broken.
    let gen_arc = Arc::new(AtomicU64::new(7));
    let decoder = build(Some(crate::stream::GenerationGuard { gen: 6, gen_arc: gen_arc.clone() }))
        .expect("a superseded read must not be reported as a broken stream");
    assert!(decoder.buffer.is_empty(), "an abandoned build carries no audio");

    // Same bytes, same cut-off, generation unchanged: this stream is truncated.
    let err = match build(Some(crate::stream::GenerationGuard { gen: 7, gen_arc })) {
        Ok(_) => panic!("a truncated stream must reach the player's error path"),
        Err(e) => e,
    };
    assert!(
        err.contains("before any audio could be decoded"),
        "expected the end-of-media arm, got: {err}"
    );
    // A ranged start that dies before the first decodable packet is recoverable:
    // `is_stream_probe_failure_with_full_buffer_retry` (`source_build.rs`) waits
    // for the full download and retries from bytes — but it decides on the message
    // text, and only "end of stream" reaches it from here. Dropping the token turns
    // a retryable stream into a hard playback error.
    assert!(
        err.contains("end of stream"),
        "the message must keep the token the full-buffer retry matches on, got: {err}"
    );
}

#[test]
fn a_built_streaming_source_reports_what_it_delivers_not_the_server_hint() {
    // The test above proves the *decoder* reports the trimmed length. This one
    // covers the production decision on top of it: `build_streaming_source` is
    // free to discard that value in favour of the server hint, and every consumer
    // of `BuiltSource::duration_secs` — the crossfade scheduler among them — sees
    // only what the builder chose.
    //
    // The hint is 1.5 s against a 0.5 s fixture, which is further off than a real
    // one: the server duration is whole seconds (`sync/mapping.rs` rounds it), so
    // in production it misses by at most half a second. The builder only consults
    // the hint above 1.0 s, though, and the fixture is shorter than that — a
    // truthful hint would take the decoder's branch even without this change and
    // the assertion could not fail. Tracks that short were never affected.
    let _globals = crate::spectrum::tests::lock_globals();
    let data = LAME_SINE_MP3.to_vec();
    let len = data.len() as u64;
    let media: Box<dyn MediaSource> =
        Box::new(SizedCursorSource { inner: Cursor::new(data), len });
    let decoder = SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, None)
        .expect("fixture must decode as a seekable stream");
    assert!(
        decoder.applies_builtin_gapless(),
        "fixture must be the trimmed case, otherwise this asserts nothing"
    );
    let rate = decoder.sample_rate().get() as f64;

    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let built = build_streaming_source(
        decoder,
        1.5,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        0, // no device channel count in tests: leave the source as it is
        None,
    )
    .expect("build_streaming_source must succeed for the LAME fixture");

    let BuiltSource { source, duration_secs, output_channels, .. } = built;
    let reported_frames = (duration_secs * rate).round() as u64;
    let delivered_frames = source.count() as u64 / output_channels as u64;
    assert_eq!(
        reported_frames, delivered_frames,
        "built source claims {reported_frames} frames but yields {delivered_frames}"
    );
}

struct FailOnDemandSource {
    inner: Cursor<Vec<u8>>,
    len: u64,
    fail: Arc<AtomicBool>,
    /// Reads still granted after `fail` is armed. Lets a test place the failure
    /// after the demuxer's own seek reads instead of on top of them.
    grace: Arc<AtomicU64>,
}

impl Read for FailOnDemandSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.fail.load(Ordering::Relaxed) {
            if self.grace.load(Ordering::Relaxed) == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "read failed after the seek",
                ));
            }
            self.grace.fetch_sub(1, Ordering::Relaxed);
        }
        self.inner.read(buf)
    }
}

impl Seek for FailOnDemandSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for FailOnDemandSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.len) }
}

/// Seek once against a reader that starts failing after `grace_reads` further
/// reads, and report `(seek succeeded, buffer before, buffer after)`.
fn seek_with_read_failure_after(grace_reads: u64) -> (bool, usize, usize) {
    let data = LAME_SINE_MP3.to_vec();
    let len = data.len() as u64;
    let fail = Arc::new(AtomicBool::new(false));
    let media: Box<dyn MediaSource> = Box::new(FailOnDemandSource {
        inner: Cursor::new(data),
        len,
        fail: fail.clone(),
        grace: Arc::new(AtomicU64::new(grace_reads)),
    });
    let mut decoder = SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, None)
        .expect("fixture must decode as a seekable stream");
    let before = decoder.buffer.len();
    fail.store(true, Ordering::Relaxed);
    let ok = decoder.try_seek(Duration::from_millis(250)).is_ok();
    (ok, before, decoder.buffer.len())
}

#[test]
fn a_read_failure_before_the_demuxer_moves_stays_a_true_no_op() {
    // The failing half: the demuxer cannot complete its own seek reads, so
    // nothing moved and the previous position is still valid. The stale buffer
    // has to survive — clearing it here would silence audio that is still
    // correct, and the layers above keep their old counter on `Err`.
    let (ok, before, after) = seek_with_read_failure_after(0);
    assert!(!ok, "a seek that never moved the demuxer must report failure");
    assert_eq!(before, after, "a no-op seek must leave the decoded buffer alone");

    // The counter-check: granting a single read pulls the whole 4.6 KB fixture
    // into the MediaSourceStream buffer, so refinement reads nothing further and
    // cannot fail. Between "seek fails" and "everything succeeds" there is no
    // window — which is why a failure *after* the demuxer moved has no fixture
    // test, and is left alone here rather than fixed blind.
    let (ok, _, after) = seek_with_read_failure_after(1);
    assert!(ok, "one granted read must let the whole seek through");
    assert_eq!(after, 1152, "a landed seek installs a freshly decoded packet");
}

#[test]
fn packet_dur_carries_the_untrimmed_block_length() {
    // `refine_position` walks packets by `packet.dur` and then subtracts
    // `packet.trim_start` from what is left. That is only correct while `dur`
    // is the *untrimmed* block length.
    //
    // Symphonia 0.6 documents the opposite: `Packet::dur` is "the duration of
    // all valid frames … excludes any delay or padding", and `block_dur()` is
    // the pre-trim length. The locked 0.6.0 does not behave that way, and
    // `Cargo.toml` accepts any `0.6.x` — so pin the behaviour actually relied
    // on here. If a patch release starts honouring its own contract, this
    // fails loudly instead of every seek on a trimmed MP3 quietly landing in
    // the wrong place.
    let data = LAME_SINE_MP3.to_vec();
    let len = data.len() as u64;
    let media: Box<dyn MediaSource> =
        Box::new(SizedCursorSource { inner: Cursor::new(data), len });
    let mss = MediaSourceStream::new(media, MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .expect("fixture must probe");
    let packet = format
        .next_packet()
        .expect("packet read must succeed")
        .expect("fixture must yield a first packet");
    assert!(
        packet.trim_start.get() > 0,
        "fixture's first packet must carry the encoder delay, got {}",
        packet.trim_start.get()
    );
    assert_eq!(
        packet.dur.get(),
        1152,
        "dur must still be the full MPEG-1 Layer III block, not the trimmed remainder"
    );
}

#[test]
fn seeking_a_trimmed_mp3_lands_on_the_requested_frame() {
    // The seek refinement counts frames using the packet's untrimmed length.
    // With the decoder trimming the encoder gap off the first packet, seeking
    // to the start used to skip past the buffer and drop the rest of that
    // frame (47 of 22050 frames for this fixture).
    for (ms, expected) in [(0u64, LAME_SINE_TRIMMED_FRAMES), (250, LAME_SINE_TRIMMED_FRAMES / 2)] {
        let mut decoder =
            SizedDecoder::new(LAME_SINE_MP3.to_vec(), Some("mp3"), false).expect("decode");
        let channels = decoder.channels().get() as u64;
        decoder
            .try_seek(Duration::from_millis(ms))
            .expect("seek must succeed");
        let remaining = decoder.count() as u64 / channels;
        assert_eq!(remaining, expected, "seek to {ms} ms landed on the wrong frame");
    }
}

#[test]
fn seeking_resets_decoder_state_and_keeps_the_waveform_aligned() {
    // A remaining-frame count cannot see either of these. Symphonia requires a
    // decoder reset after a seek because the next packet is discontinuous; for
    // MP3 the carried-over state is the bit reservoir and the synthesis overlap.
    let full: Vec<f32> = SizedDecoder::new(LAME_SINE_MP3.to_vec(), Some("mp3"), false)
        .expect("decode")
        .collect();

    let mut seeked =
        SizedDecoder::new(LAME_SINE_MP3.to_vec(), Some("mp3"), false).expect("decode");
    seeked
        .try_seek(Duration::from_millis(250))
        .expect("seek must succeed");
    let tail: Vec<f32> = seeked.collect();
    assert_eq!(
        tail.len() as u64,
        LAME_SINE_TRIMMED_FRAMES / 2,
        "seek should leave exactly the second half of the fixture"
    );

    // (a) MP3 rebuilds its reservoir over the first frames after a jump, so this
    // window is silent by nature. Without the reset it carries residual energy
    // from before the seek instead (measured at peak 0.093 on this fixture).
    let warmup_peak = tail[..1024].iter().fold(0f32, |m, v| m.max(v.abs()));
    assert!(
        warmup_peak < 0.01,
        "decoder state from before the seek leaked into the first frames (peak {warmup_peak})"
    );

    // (b) Once decoding is up to speed the samples must be exactly the ones a
    // full decode produces at that position — proof that the seek landed on the
    // requested frame and not merely on the right *count* of frames.
    const SKIP_WARMUP: usize = 4096;
    const WINDOW: usize = 2048;
    let offset = LAME_SINE_TRIMMED_FRAMES as usize / 2 + SKIP_WARMUP;
    let seg = &tail[SKIP_WARMUP..SKIP_WARMUP + WINDOW];
    let expected = &full[offset..offset + WINDOW];
    let mean_abs_err: f32 =
        seg.iter().zip(expected).map(|(a, b)| (a - b).abs()).sum::<f32>() / WINDOW as f32;
    assert!(
        mean_abs_err < 1e-6,
        "post-seek waveform does not match a full decode at the same position (mean abs error {mean_abs_err})"
    );
}

#[test]
fn non_mp3_still_uses_the_manual_itunsmpb_trim() {
    // The counterpart to the test above: the fix must not silently disable
    // the manual path for the codecs it still owns.
    let plain = super::tests::synthetic_wav_bytes(0.5);
    let untrimmed = decoded_frames(plain.clone(), Some("wav"));

    let mut tagged = plain;
    tagged.extend_from_slice(&super::tests::synth_itunsmpb_blob("00000100", "00000000", "00000000"));
    let trimmed = decoded_frames(tagged, Some("wav"));

    assert_eq!(
        untrimmed - trimmed,
        0x100,
        "manual trim must still remove exactly the iTunSMPB delay for non-MP3"
    );
}

#[test]
fn an_mp3_without_a_header_frame_count_reports_no_duration() {
    // `try_seek` clamps any scrub within a millisecond of `total_duration` to the
    // end of the track, and the transport still writes back the position the user
    // asked for. Fed a bitrate estimate, that pair drifts apart permanently, so a
    // count symphonia guessed must not reach it.
    //
    // Every hint, not just the correct one. `ProbeSeekGate` is what stops symphonia
    // estimating, but it is chosen from the caller's hint before anything has
    // identified the container, and it deliberately keeps Ogg, AIFF and MP4
    // seekable through the probe. A server that labels an MP3 as one of those —
    // production prefers its hint over sniffing, and this constructor has no bytes
    // to sniff — lands on the exception while symphonia still decodes MP3.
    let _globals = crate::spectrum::tests::lock_globals();
    for hint in [Some("mp3"), Some("ogg"), Some("aiff"), Some("m4a")] {
        let len = NO_XING_MP3.len() as u64;
        let media: Box<dyn MediaSource> =
            Box::new(SizedCursorSource { inner: Cursor::new(NO_XING_MP3.to_vec()), len });
        let decoder = SizedDecoder::new_streaming(media, hint, "test-stream", true, None)
            .expect("fixture must decode as a stream whatever the hint claims");

        assert!(
            decoder.total_duration().is_none(),
            "an estimated frame count must not arm the seek clamp (hint {hint:?})"
        );

        // The bytes constructor needs no such filter, and this is why: it picks
        // its gate from sniffed bytes before the caller's hint, so a mislabelled
        // MP3 still gets the gate and never reaches the estimate. Asserted rather
        // than assumed, because the two constructors look interchangeable here.
        let decoder = SizedDecoder::new(NO_XING_MP3.to_vec(), hint, false)
            .expect("fixture must decode from bytes whatever the hint claims");
        assert!(
            decoder.total_duration().is_none(),
            "sniffing must keep the bytes path on the gate (hint {hint:?})"
        );
    }

    // The counterpart: a tagged MP3 still reports one, or the crossfade loses the
    // trimmed length this branch added it for.
    let len = LAME_SINE_MP3.len() as u64;
    let media: Box<dyn MediaSource> =
        Box::new(SizedCursorSource { inner: Cursor::new(LAME_SINE_MP3.to_vec()), len });
    let tagged = SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, None)
        .expect("fixture must decode as a stream");
    assert!(
        tagged.total_duration().is_some(),
        "a header-backed frame count must still be reported"
    );
}

/// The LAME fixture with only its Xing `FRAMES` field removed. The encoder
/// extension survives, so the demuxer still reports delay and padding — but
/// without a frame count it has no end timestamp, and `PacketBuilder` can then
/// never produce a `trim_end`. LAME writes the extension independently of that
/// optional field, so this is a real file shape, not a synthetic one.
fn lame_fixture_without_frame_count() -> Vec<u8> {
    let mut d = LAME_SINE_MP3.to_vec();
    let tag = d
        .windows(4)
        .position(|w| w == b"Info" || w == b"Xing")
        .expect("fixture must carry a Xing/Info tag");

    let flags = u32::from_be_bytes(d[tag + 4..tag + 8].try_into().unwrap());
    assert_eq!(flags & 1, 1, "fixture must have a FRAMES field to remove");
    d[tag + 4..tag + 8].copy_from_slice(&(flags & !1).to_be_bytes());

    // Symphonia parses these fields in order and skips the ones the flags clear,
    // so the four bytes have to go rather than be zeroed.
    d.drain(tag + 8..tag + 12);

    // Where the tag now ends: the fields symphonia still reads, then the 36-byte
    // LAME extension.
    let mut ext = tag + 8;
    if flags & 0x2 != 0 { ext += 4; }
    if flags & 0x4 != 0 { ext += 100; }
    if flags & 0x8 != 0 { ext += 4; }
    let tag_end = ext + 36;

    // The tag CRC no longer matches, and a stale one makes symphonia drop the
    // whole extension. Zero means "ignore" by its own rule.
    d[tag_end - 2..tag_end].copy_from_slice(&0u16.to_be_bytes());

    // Give the four bytes back inside the *same* MPEG frame — it is zero-padded
    // between the tag and the next frame header. Putting them anywhere later
    // would shift every following sync word and destroy an audio frame.
    let next_sync = d[tag_end..]
        .windows(2)
        .position(|w| w[0] == 0xFF && (w[1] & 0xE0) == 0xE0)
        .map(|p| tag_end + p)
        .expect("a second frame must follow the tag frame");
    d.splice(next_sync..next_sync, [0u8; 4]);
    d
}

/// Raw frames minus the LAME delay of 1105: what the decoder alone can remove
/// when the container gives it no end timestamp.
const LAME_SINE_FRONT_TRIMMED_FRAMES: u64 = 23_087;

#[test]
fn a_lame_file_without_a_xing_frame_count_keeps_its_end_trim() {
    // Owning the front gap does not mean owning both ends. Without Xing `FRAMES`
    // the demuxer has no end timestamp, so `PacketBuilder` never yields a
    // `trim_end` and the decoder leaves the padding in — at the very boundary
    // issue #1373 is about. The manual `iTunSMPB` trim has to stay available for
    // the end while the decoder keeps the front.
    let base = lame_fixture_without_frame_count();
    let decoder = SizedDecoder::new(base.clone(), Some("mp3"), false).expect("fixture decodes");
    assert!(
        decoder.applies_builtin_gapless(),
        "the LAME extension still reports a gap, so the decoder owns the front"
    );
    assert!(
        !decoder.applies_builtin_end_trim(),
        "without a frame count it cannot own the end"
    );

    assert_eq!(
        decoded_frames(base.clone(), Some("mp3")),
        LAME_SINE_FRONT_TRIMMED_FRAMES,
        "with nothing to describe the end, the delay trim must still happen"
    );

    let mut tagged = base;
    tagged.extend_from_slice(&super::tests::synth_itunsmpb_blob("00000451", "0000040D", "00005622"));
    assert_eq!(
        decoded_frames(tagged, Some("mp3")),
        LAME_SINE_TRIMMED_FRAMES,
        "an iTunSMPB total must still remove the end padding, and the delay must \
         not be cut a second time"
    );
}

#[test]
fn an_exact_frame_count_survives_an_unrecognised_encoder() {
    // symphonia fills delay and padding only when the Xing extension names
    // LAME, Lavf or Lavc; any other encoder gets `(0, 0)` while its `FRAMES`
    // field still carries an exact count. VBRI behaves the same way. Deciding
    // "estimated" from the absence of a gap would throw those counts away and
    // cost the crossfade the length it schedules from.
    let mut d = LAME_SINE_MP3.to_vec();
    let tag = d
        .windows(4)
        .position(|w| w == b"Info" || w == b"Xing")
        .expect("fixture must carry a Xing/Info tag");
    let flags = u32::from_be_bytes(d[tag + 4..tag + 8].try_into().unwrap());
    let mut ext = tag + 8;
    if flags & 0x1 != 0 { ext += 4; }
    if flags & 0x2 != 0 { ext += 4; }
    if flags & 0x4 != 0 { ext += 100; }
    if flags & 0x8 != 0 { ext += 4; }
    d[ext..ext + 4].copy_from_slice(b"GOGO");
    // Same length, so nothing else in the frame moves; zero the tag CRC, which
    // symphonia otherwise uses to reject the whole extension.
    d[ext + 34..ext + 36].copy_from_slice(&0u16.to_be_bytes());

    let len = d.len() as u64;
    let media: Box<dyn MediaSource> =
        Box::new(SizedCursorSource { inner: Cursor::new(d), len });
    let decoder = SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, None)
        .expect("fixture must still decode");

    assert!(
        !decoder.applies_builtin_gapless(),
        "an unrecognised encoder reports no gap, so the manual path keeps the trim"
    );
    assert!(
        decoder.total_duration().is_some(),
        "the Xing frame count is exact and must still be reported"
    );
}

#[test]
fn a_multichannel_source_is_folded_when_the_device_takes_stereo() {
    // Issue #1408: a 5.1 track on a stereo device lost centre, LFE and both
    // surrounds, because rodio's mixer converts channel counts by keeping the
    // first ones and discarding the rest. Built through the production path with
    // a device that takes two channels, every channel has to survive into the
    // mix — and the source has to report stereo, or the mixer would convert it
    // a second time.
    let _globals = crate::spectrum::tests::lock_globals();
    let frames = 512usize;
    let mut interleaved = Vec::with_capacity(frames * 6);
    for _ in 0..frames {
        // Silent front pair, content only in centre and surrounds: exactly the
        // material the old path threw away.
        interleaved.extend_from_slice(&[0, 0, 8_000, 0, 6_000, 6_000]);
    }
    let wav = super::tests::build_pcm16_wav(&interleaved, 44_100, 6);

    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let built = build_source(
        wav,
        0.0,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        2, // the device takes stereo
        Some("wav"),
        false,
    )
    .expect("a 5.1 WAV must build");

    assert_eq!(built.output_channels, 2, "the folded source must report stereo");

    let samples: Vec<f32> = built.source.take(64).collect();
    let loudest = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
    assert!(
        loudest > 0.01,
        "centre and surround content was dropped: peak {loudest}"
    );
    assert!(loudest <= 1.0 + f32::EPSILON, "the fold clipped at {loudest}");
}

#[test]
fn a_multichannel_source_is_left_alone_when_the_device_takes_its_channels() {
    // The counterpart: on a 5.1 output the source must stay 5.1. Folding
    // everything to stereo would fix the stereo case by breaking surround
    // playback for the people who have it.
    let _globals = crate::spectrum::tests::lock_globals();
    let interleaved: Vec<i16> = (0..512).flat_map(|_| [100, 200, 300, 400, 500, 600]).collect();
    let wav = super::tests::build_pcm16_wav(&interleaved, 44_100, 6);

    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let built = build_source(
        wav,
        0.0,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        6, // the device takes all six
        Some("wav"),
        false,
    )
    .expect("a 5.1 WAV must build");

    assert_eq!(built.output_channels, 6, "surround output must stay surround");
}

/// A 5.1 FLAC where every channel carries its own tone, so the output can be
/// asked which channels reached it. See `fixtures/README.md`.
const FIVE_ONE_FLAC: &[u8] = include_bytes!("../fixtures/five_one_sine.flac");

/// Energy at one frequency, via the Goertzel algorithm — cheaper than an FFT
/// and enough to answer "is this tone present".
fn tone_energy(samples: &[f32], freq: f32, rate: f32) -> f32 {
    let k = (0.5 + (samples.len() as f32 * freq) / rate).floor();
    let omega = 2.0 * std::f32::consts::PI * k / samples.len() as f32;
    let coeff = 2.0 * omega.cos();
    let (mut s_prev, mut s_prev2) = (0.0f32, 0.0f32);
    for &sample in samples {
        let s = sample + coeff * s_prev - s_prev2;
        s_prev2 = s_prev;
        s_prev = s;
    }
    (s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2).sqrt() / samples.len() as f32
}

#[test]
fn every_channel_of_a_real_five_one_flac_reaches_stereo_output() {
    // The format the issue was reported with, not a stand-in: a 5.1 FLAC decoded
    // through the production path onto a stereo device. Each channel carries a
    // different tone, so the output names what survived — before the fix only
    // 200 Hz and 400 Hz (the front pair) came through, and the centre, LFE and
    // surrounds were discarded by the mixer's channel conversion.
    let _globals = crate::spectrum::tests::lock_globals();
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let built = build_source(
        FIVE_ONE_FLAC.to_vec(),
        0.0,
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        Duration::ZERO,
        sample_counter,
        0,
        2, // stereo device
        Some("flac"),
        false,
    )
    .expect("the 5.1 fixture must build");

    assert_eq!(built.output_channels, 2);

    // De-interleave: the tones are per channel, and reading them mixed would
    // blur which side a surround landed on.
    let samples: Vec<f32> = built.source.collect();
    let left: Vec<f32> = samples.iter().step_by(2).copied().collect();
    let right: Vec<f32> = samples.iter().skip(1).step_by(2).copied().collect();
    assert!(left.len() > 4096, "not enough audio decoded: {}", left.len());

    let rate = 44_100.0;
    let floor = 0.001;
    for (name, freq, channel) in [
        ("front left  200 Hz", 200.0, &left),
        ("front right 400 Hz", 400.0, &right),
        ("centre      800 Hz", 800.0, &left),
        ("centre      800 Hz", 800.0, &right),
        ("LFE          60 Hz", 60.0, &left),
        ("surround L 1600 Hz", 1600.0, &left),
        ("surround R 3200 Hz", 3200.0, &right),
    ] {
        let energy = tone_energy(channel, freq, rate);
        assert!(energy > floor, "{name} missing from the fold: energy {energy}");
    }

    // And the sides stay sides: a surround must not appear on the wrong one.
    let sl_on_right = tone_energy(&right, 1600.0, rate);
    let sr_on_left = tone_energy(&left, 3200.0, rate);
    assert!(sl_on_right < floor, "left surround leaked right: {sl_on_right}");
    assert!(sr_on_left < floor, "right surround leaked left: {sr_on_left}");
}

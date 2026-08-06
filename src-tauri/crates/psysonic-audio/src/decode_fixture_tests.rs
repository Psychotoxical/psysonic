//! Fixture-backed decoder tests.
//!
//! Split out of `decode.rs`: these are binary-fixture integration tests and were
//! pushing the decoder module well past the project's size trigger. Declared with
//! `#[path]` from `decode.rs`, so this stays a child module and keeps access to
//! the private decoder internals it exercises.

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
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let wav = synthetic_wav_bytes_local(0.4);
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
        None,
        false,
    );
    assert!(result.is_err());
}

#[test]
fn build_streaming_source_succeeds_for_synthetic_wav() {
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let wav = synthetic_wav_bytes_local(0.4);
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
        None,
    )
    .expect("build_streaming_source must succeed for a valid WAV decoder");
    assert_eq!(built.output_channels, 1);
    assert!(built.output_rate > 0);
}

#[test]
fn build_source_with_target_rate_resamples() {
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) = default_source_args();
    let wav = synthetic_wav_bytes_local(0.3);
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
    let decoder = SizedDecoder::new_streaming(media, format_hint, "test-stream", random_access)
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
    // Radio and a mid-download ranged HTTP read have no trustworthy frame
    // count up front, so they deliberately stay untrimmed.
    assert_eq!(
        decoded_frames_streaming(LAME_SINE_MP3.to_vec(), Some("mp3"), false, 0),
        LAME_SINE_RAW_FRAMES
    );
}

/// A source that serves `head` bytes and then fails every further read, to model
/// a range read dying mid-stream rather than a stream ending cleanly.
struct FailAfterSource {
    inner: Cursor<Vec<u8>>,
    head: u64,
    total: u64,
}

impl Read for FailAfterSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let pos = self.inner.position();
        if pos >= self.head {
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
    });

    let err = match SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true) {
        Ok(_) => panic!("a failing read must not construct a decoder"),
        Err(e) => e,
    };
    assert!(
        err.contains("could not read audio data") || err.contains("ended before any audio"),
        "error should name the read failure, got: {err}"
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
    const RUNS: usize = 40;
    let mut samples_per_run = Vec::with_capacity(RUNS);
    let mut frames = 0u64;

    for _ in 0..RUNS {
        let t0 = std::time::Instant::now();
        let decoder =
            SizedDecoder::new(LAME_SINE_MP3.to_vec(), Some("mp3"), false).expect("decode");
        let n = decoder.count() as u64;
        let dt = t0.elapsed().as_secs_f64();
        frames = n;
        samples_per_run.push(dt);
    }

    samples_per_run.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = samples_per_run[RUNS / 2];
    let min = samples_per_run[0];
    let max = samples_per_run[RUNS - 1];
    let mean = samples_per_run.iter().sum::<f64>() / RUNS as f64;
    let var = samples_per_run
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
fn refined_offset_accounts_for_packets_dropped_by_a_retry() {
    // Straight-through: only the kept packet's own trim comes off.
    assert_eq!(SizedDecoder::refined_offset_frames(500, &[], 100), 400);

    // A retry moved to a later packet. The selection loop only breaks on a
    // packet longer than what is left to skip, so the discarded duration always
    // covers the remainder and the new packet is entered at its start.
    assert_eq!(SizedDecoder::refined_offset_frames(500, &[1152], 0), 0);

    // Using the failed packet's trim instead of the retried one's is the bug
    // this guards: with the discarded packet accounted for, a later trim cannot
    // push the offset back into a buffer that no longer contains those frames.
    assert_eq!(SizedDecoder::refined_offset_frames(500, &[300], 50), 150);

    // Two failures in a row.
    assert_eq!(SizedDecoder::refined_offset_frames(2000, &[576, 576], 0), 848);
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
    let plain = synthetic_wav_bytes_local(0.5);
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

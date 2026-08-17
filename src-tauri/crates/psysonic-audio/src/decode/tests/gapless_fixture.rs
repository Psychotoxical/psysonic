// ── Encoder-gap ownership per codec (issue #1373) ────────────────────────

use super::*;

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
    data.extend_from_slice(&synth_itunsmpb_blob("00000840", "00000000", "00000000"));

    // Guard the premise: the manual parser really does see the tag here.
    let info = parse_gapless_info(&data);
    assert_eq!(
        info.delay_samples, 0x840,
        "fixture must expose an iTunSMPB delay"
    );

    assert_eq!(
        decoded_frames(data, Some("mp3")),
        LAME_SINE_TRIMMED_FRAMES,
        "decoder trim only — the manual iTunSMPB delay must not be applied on top"
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
    data.extend_from_slice(&synth_itunsmpb_blob("00000840", "00000000", "00000000"));
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

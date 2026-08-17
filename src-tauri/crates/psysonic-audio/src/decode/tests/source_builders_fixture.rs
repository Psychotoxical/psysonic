use super::*;

#[test]
fn build_source_succeeds_for_synthetic_wav() {
    // Building a source installs a SpectrumTapSource over the process-global
    // spectrum ring and lease; hold the same lock the spectrum tests use.
    let _globals = crate::spectrum::tests::lock_globals();
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let wav = synthetic_wav_bytes(0.4);
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
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
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
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let wav = synthetic_wav_bytes(0.4);
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
    let (eq_gains, eq_enabled, eq_pre_gain, playback_rate, done_flag, sample_counter) =
        default_source_args();
    let wav = synthetic_wav_bytes(0.3);
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
    let wav = build_pcm16_wav(&interleaved, 44_100, 6);

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

    assert_eq!(
        built.output_channels, 2,
        "the folded source must report stereo"
    );

    let samples: Vec<f32> = built.source.take(64).collect();
    let loudest = samples.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
    assert!(
        loudest > 0.01,
        "centre and surround content was dropped: peak {loudest}"
    );
    assert!(
        loudest <= 1.0 + f32::EPSILON,
        "the fold clipped at {loudest}"
    );
}

#[test]
fn a_multichannel_source_is_left_alone_when_the_device_takes_its_channels() {
    // The counterpart: on a 5.1 output the source must stay 5.1. Folding
    // everything to stereo would fix the stereo case by breaking surround
    // playback for the people who have it.
    let _globals = crate::spectrum::tests::lock_globals();
    let interleaved: Vec<i16> = (0..512)
        .flat_map(|_| [100, 200, 300, 400, 500, 600])
        .collect();
    let wav = build_pcm16_wav(&interleaved, 44_100, 6);

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

    assert_eq!(
        built.output_channels, 6,
        "surround output must stay surround"
    );
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
    assert!(
        left.len() > 4096,
        "not enough audio decoded: {}",
        left.len()
    );

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
        assert!(
            energy > floor,
            "{name} missing from the fold: energy {energy}"
        );
    }

    // And the sides stay sides: a surround must not appear on the wrong one.
    let sl_on_right = tone_energy(&right, 1600.0, rate);
    let sr_on_left = tone_energy(&left, 3200.0, rate);
    assert!(
        sl_on_right < floor,
        "left surround leaked right: {sl_on_right}"
    );
    assert!(
        sr_on_left < floor,
        "right surround leaked left: {sr_on_left}"
    );
}

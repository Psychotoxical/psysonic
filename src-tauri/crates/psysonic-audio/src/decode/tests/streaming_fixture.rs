use super::*;

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
    let frames = decoded_frames_streaming(MPEG2_SINE_MP3.to_vec(), Some("mp3"), true, 48_000);
    assert!(
        frames > 40_000,
        "resampled 22.05 kHz MP3 must still produce audio on the streaming path, got {frames} frames"
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
    let decoder = build(Some(crate::stream::GenerationGuard {
        gen: 6,
        gen_arc: gen_arc.clone(),
    }))
    .expect("a superseded read must not be reported as a broken stream");
    assert!(
        decoder.buffer.is_empty(),
        "an abandoned build carries no audio"
    );

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
    let media: Box<dyn MediaSource> = Box::new(SizedCursorSource {
        inner: Cursor::new(data),
        len,
    });
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

    let BuiltSource {
        source,
        duration_secs,
        output_channels,
        ..
    } = built;
    let reported_frames = (duration_secs * rate).round() as u64;
    let delivered_frames = source.count() as u64 / output_channels as u64;
    assert_eq!(
        reported_frames, delivered_frames,
        "built source claims {reported_frames} frames but yields {delivered_frames}"
    );
}

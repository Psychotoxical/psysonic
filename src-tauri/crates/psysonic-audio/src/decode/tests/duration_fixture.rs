use super::*;

#[test]
fn non_mp3_still_uses_the_manual_itunsmpb_trim() {
    // The counterpart to the test above: the fix must not silently disable
    // the manual path for the codecs it still owns.
    let plain = synthetic_wav_bytes(0.5);
    let untrimmed = decoded_frames(plain.clone(), Some("wav"));

    let mut tagged = plain;
    tagged.extend_from_slice(&synth_itunsmpb_blob("00000100", "00000000", "00000000"));
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
        let media: Box<dyn MediaSource> = Box::new(SizedCursorSource {
            inner: Cursor::new(NO_XING_MP3.to_vec()),
            len,
        });
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
    let media: Box<dyn MediaSource> = Box::new(SizedCursorSource {
        inner: Cursor::new(LAME_SINE_MP3.to_vec()),
        len,
    });
    let tagged = SizedDecoder::new_streaming(media, Some("mp3"), "test-stream", true, None)
        .expect("fixture must decode as a stream");
    assert!(
        tagged.total_duration().is_some(),
        "a header-backed frame count must still be reported"
    );
}
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
    tagged.extend_from_slice(&synth_itunsmpb_blob("00000451", "0000040D", "00005622"));
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
    if flags & 0x1 != 0 {
        ext += 4;
    }
    if flags & 0x2 != 0 {
        ext += 4;
    }
    if flags & 0x4 != 0 {
        ext += 100;
    }
    if flags & 0x8 != 0 {
        ext += 4;
    }
    d[ext..ext + 4].copy_from_slice(b"GOGO");
    // Same length, so nothing else in the frame moves; zero the tag CRC, which
    // symphonia otherwise uses to reject the whole extension.
    d[ext + 34..ext + 36].copy_from_slice(&0u16.to_be_bytes());

    let len = d.len() as u64;
    let media: Box<dyn MediaSource> = Box::new(SizedCursorSource {
        inner: Cursor::new(d),
        len,
    });
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

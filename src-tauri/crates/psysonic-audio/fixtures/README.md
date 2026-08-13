# Audio test fixtures

Small, fully synthetic audio files for decoder regression tests. No third-party or
copyrighted material — each file is generated from a mathematical signal, so it can
live in the repository without licensing questions.

## `lame_sine_22050.mp3`

A 440 Hz sine, mono, 44.1 kHz, encoded with `libmp3lame` at 64 kbps. It carries the
`Info` (Xing/LAME) header that holds the encoder delay and end padding, which is what
makes it useful: it is the smallest file that can prove whether the player removes the
encoder gap (issue #1373).

| Property | Value |
|---|---|
| Source signal | 22050 samples (0.5 s @ 44.1 kHz, mono) |
| Raw MP3 frames | 21 packets x 1152 = 24192 samples |
| Correctly trimmed | 22050 samples (reference decode by ffmpeg) |
| Encoder overhang | 2142 samples, about 48.6 ms |

A decoder that reports **22050** samples applies the Xing/LAME trim; one that reports
**24192** plays the encoder delay and padding as audio.

## `no_xing_sine.mp3`

The same signal encoded **without** a Xing header. symphonia fills its `delay` /
`padding` fields only when the Xing extension names an encoder it knows (LAME, Lavf,
Lavc), so for this file it reports no encoder gap at all — which is exactly how an
iTunes-encoded MP3 looks to the decoder. Those files carry an `iTunSMPB` tag instead,
and the test uses this fixture to prove the manual parser stays in charge for them.

Raw frame count is the same 21 x 1152 = 24192; nothing trims it.

## `mpeg2_sine_22050.mp3`

440 Hz sine at **22.05 kHz** — MPEG-2 Layer III, where a frame holds 576 samples
instead of 1152. That is fewer than the encoder delay, so the first packet is trimmed
away *entirely*. It guards the case where an empty first buffer made the source report
a zero-length span and the resampling path played nothing at all.

## Regenerating

```bash
ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=44100:d=1:c=mono" -c:a pcm_s16le raw.wav
ffmpeg -i raw.wav -af "atrim=start_sample=0:end_sample=22050" -c:a pcm_s16le half.wav
ffmpeg -i half.wav -c:a libmp3lame -b:a 64k lame_sine_22050.mp3
ffmpeg -i half.wav -c:a libmp3lame -b:a 64k -write_xing 0 no_xing_sine.mp3

ffmpeg -f lavfi -i "aevalsrc='0.5*sin(2*PI*440*t)':s=22050:d=1:c=mono" -c:a pcm_s16le lo.wav
ffmpeg -i lo.wav -c:a libmp3lame -b:a 64k mpeg2_sine_22050.mp3
```

Cut with `start_sample`/`end_sample`, not with timestamps — a time-based cut does not
land on an exact sample boundary and the reference numbers above stop matching.

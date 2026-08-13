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

### `five_one_sine.flac`

A 5.1 FLAC where every channel carries a different tone, so a stereo downmix can
be asked which channels reached it:

| channel | tone |
|---|---|
| front left | 200 Hz |
| front right | 400 Hz |
| centre | 800 Hz |
| LFE | 60 Hz |
| back left | 1600 Hz |
| back right | 3200 Hz |

For issue #1408, where a 5.1 track played on a stereo device lost centre, LFE and
both surrounds: rodio's mixer converts channel counts by keeping the first ones
and discarding the rest, so only 200 Hz and 400 Hz used to survive.

**The channel map is explicit on purpose.** Without `map=`, `join` does not place
its inputs in the order they are listed — the first attempt at this fixture put
400 Hz on front-left and 200 Hz on centre, which reads as a bug in the downmix
rather than in the fixture. Verify per channel after regenerating.

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

```bash
ffmpeg -f lavfi -i "sine=frequency=200:duration=0.25:sample_rate=44100" \
       -f lavfi -i "sine=frequency=400:duration=0.25:sample_rate=44100" \
       -f lavfi -i "sine=frequency=800:duration=0.25:sample_rate=44100" \
       -f lavfi -i "sine=frequency=60:duration=0.25:sample_rate=44100" \
       -f lavfi -i "sine=frequency=1600:duration=0.25:sample_rate=44100" \
       -f lavfi -i "sine=frequency=3200:duration=0.25:sample_rate=44100" \
       -filter_complex "[0:a][1:a][2:a][3:a][4:a][5:a]join=inputs=6:channel_layout=5.1:\
map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-BL|5.0-BR[a]" \
       -map "[a]" -c:a flac -compression_level 8 -sample_fmt s16 five_one_sine.flac
```

Check each channel afterwards, rather than trusting the input order:

```bash
for i in 0 1 2 3 4 5; do
  ffmpeg -y -loglevel error -i five_one_sine.flac \
    -filter_complex "[0:a]pan=mono|c0=c$i" -c:a pcm_s16le "ch$i.wav"
done
```

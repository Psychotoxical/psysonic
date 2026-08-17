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
    (
        eq_gains,
        eq_enabled,
        eq_pre_gain,
        playback_rate,
        done_flag,
        sample_counter,
    )
}
/// A 440 Hz sine encoded with libmp3lame, carrying the Xing/LAME `Info`
/// header. Reference numbers and the regeneration recipe live in
/// `fixtures/README.md`.
const LAME_SINE_MP3: &[u8] = include_bytes!("../../../fixtures/lame_sine_22050.mp3");
/// Samples of the signal that was encoded — what a correct decode returns.
const LAME_SINE_TRIMMED_FRAMES: u64 = 22_050;
/// 21 MP3 packets x 1152 samples — what an untrimmed decode returns.
const LAME_SINE_RAW_FRAMES: u64 = 24_192;
/// Same signal encoded without a Xing header: symphonia reports no encoder
/// gap for it, which is what an iTunes-encoded MP3 looks like to the decoder.
const NO_XING_MP3: &[u8] = include_bytes!("../../../fixtures/no_xing_sine.mp3");
const NO_XING_RAW_FRAMES: u64 = 24_192;
/// 22.05 kHz (MPEG-2 Layer III, 576 samples per frame) — its first packet is
/// shorter than the encoder delay and is trimmed away entirely.
const MPEG2_SINE_MP3: &[u8] = include_bytes!("../../../fixtures/mpeg2_sine_22050.mp3");

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
    let media: Box<dyn MediaSource> = Box::new(SizedCursorSource {
        inner: Cursor::new(data),
        len,
    });
    let decoder =
        SizedDecoder::new_streaming(media, format_hint, "test-stream", random_access, None)
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
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
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
    if flags & 0x2 != 0 {
        ext += 4;
    }
    if flags & 0x4 != 0 {
        ext += 100;
    }
    if flags & 0x8 != 0 {
        ext += 4;
    }
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
/// A 5.1 FLAC where every channel carries its own tone, so the output can be
/// asked which channels reached it. See `fixtures/README.md`.
const FIVE_ONE_FLAC: &[u8] = include_bytes!("../../../fixtures/five_one_sine.flac");

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

#[path = "duration_fixture.rs"]
mod duration;
#[path = "gapless_fixture.rs"]
mod gapless;
#[path = "seeking_fixture.rs"]
mod seeking;
#[path = "source_builders_fixture.rs"]
mod source_builders;
#[path = "streaming_fixture.rs"]
mod streaming;

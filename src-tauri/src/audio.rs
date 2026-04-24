use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex, OnceLock, RwLock, TryLockError};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
#[cfg(unix)]
use libc;

use ringbuf::{HeapConsumer, HeapProducer, HeapRb};

use biquad::{Biquad, Coefficients, DirectForm2Transposed, ToHertz, Type as FilterType};
use rodio::{Sink, Source};
use rodio::source::UniformSourceIterator;
use serde::Serialize;
use symphonia::core::{
    audio::{AudioBufferRef, SampleBuffer, SignalSpec},
    codecs::{CodecRegistry, DecoderOptions, CODEC_TYPE_NULL},
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    io::{MediaSource, MediaSourceStream, MediaSourceStreamOptions},
    meta::MetadataOptions,
    probe::Hint,
    units::{self, Time},
};
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, State};

// ─── 10-Band Graphic Equalizer ────────────────────────────────────────────────

const EQ_BANDS_HZ: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
const EQ_Q: f32 = 1.41;
const EQ_CHECK_INTERVAL: usize = 1024;

struct EqSource<S: Source<Item = f32>> {
    inner: S,
    sample_rate: u32,
    channels: u16,
    gains: Arc<[AtomicU32; 10]>,
    enabled: Arc<AtomicBool>,
    pre_gain: Arc<AtomicU32>,
    filters: [[DirectForm2Transposed<f32>; 2]; 10],
    current_gains: [f32; 10],
    sample_counter: usize,
    channel_idx: usize,
}

impl<S: Source<Item = f32>> EqSource<S> {
    fn new(inner: S, gains: Arc<[AtomicU32; 10]>, enabled: Arc<AtomicBool>, pre_gain: Arc<AtomicU32>) -> Self {
        let sample_rate = inner.sample_rate();
        let channels = inner.channels();
        let filters = std::array::from_fn(|band| {
            let freq = EQ_BANDS_HZ[band].clamp(20.0, (sample_rate as f32 / 2.0) - 100.0);
            std::array::from_fn(|_| {
                let coeffs = Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(0.0),
                    (sample_rate as f32).hz(),
                    freq.hz(),
                    EQ_Q,
                ).unwrap_or_else(|_| Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(0.0),
                    (sample_rate as f32).hz(),
                    1000.0f32.hz(),
                    EQ_Q,
                ).unwrap());
                DirectForm2Transposed::<f32>::new(coeffs)
            })
        });
        Self {
            inner, sample_rate, channels, gains, enabled, pre_gain,
            filters,
            current_gains: [0.0; 10],
            sample_counter: 0,
            channel_idx: 0,
        }
    }

    fn refresh_if_needed(&mut self) {
        for band in 0..10 {
            let gain_db = f32::from_bits(self.gains[band].load(Ordering::Relaxed));
            if (gain_db - self.current_gains[band]).abs() > 0.01 {
                self.current_gains[band] = gain_db;
                let freq = EQ_BANDS_HZ[band].clamp(20.0, (self.sample_rate as f32 / 2.0) - 100.0);
                if let Ok(coeffs) = Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(gain_db),
                    (self.sample_rate as f32).hz(),
                    freq.hz(),
                    EQ_Q,
                ) {
                    for ch in 0..2 {
                        self.filters[band][ch].update_coefficients(coeffs);
                    }
                }
            }
        }
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;

        if self.sample_counter % EQ_CHECK_INTERVAL == 0 {
            self.refresh_if_needed();
        }
        self.sample_counter = self.sample_counter.wrapping_add(1);

        if !self.enabled.load(Ordering::Relaxed) {
            self.channel_idx = (self.channel_idx + 1) % self.channels as usize;
            return Some(sample);
        }

        let ch = self.channel_idx.min(1);
        self.channel_idx = (self.channel_idx + 1) % self.channels as usize;

        let pre_gain_db = f32::from_bits(self.pre_gain.load(Ordering::Relaxed));
        let pre_gain_factor = 10_f32.powf(pre_gain_db / 20.0);
        let mut s = sample * pre_gain_factor;
        for band in 0..10 {
            s = self.filters[band][ch].run(s);
        }
        Some(s.clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.channels }
    fn sample_rate(&self) -> u32 { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Reset biquad filter state to avoid glitches after seek.
        for band in 0..10 {
            let gain_db = f32::from_bits(self.gains[band].load(Ordering::Relaxed));
            self.current_gains[band] = gain_db;
            let freq = EQ_BANDS_HZ[band].clamp(20.0, (self.sample_rate as f32 / 2.0) - 100.0);
            if let Ok(coeffs) = Coefficients::<f32>::from_params(
                FilterType::PeakingEQ(gain_db),
                (self.sample_rate as f32).hz(),
                freq.hz(),
                EQ_Q,
            ) {
                for ch in 0..2 {
                    self.filters[band][ch] = DirectForm2Transposed::<f32>::new(coeffs);
                }
            }
        }
        self.channel_idx = 0;
        self.sample_counter = 0;
        self.inner.try_seek(pos)
    }
}

// ─── DynSource — type-erased Source wrapper ───────────────────────────────────
//
// Allows chaining differently-typed sources (with trimming applied) into a
// single concrete type accepted by EqSource<S: Source<Item=f32>>.

struct DynSource {
    inner: Box<dyn Source<Item = f32> + Send>,
    channels: u16,
    sample_rate: u32,
}

impl DynSource {
    fn new(src: impl Source<Item = f32> + Send + 'static) -> Self {
        let channels = src.channels();
        let sample_rate = src.sample_rate();
        Self { inner: Box::new(src), channels, sample_rate }
    }
}

impl Iterator for DynSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> { self.inner.next() }
}

impl Source for DynSource {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.channels }
    fn sample_rate(&self) -> u32 { self.sample_rate }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}

// ─── EqualPowerFadeIn — per-sample sin(t·π/2) fade-in envelope ───────────────
//
// Applied to every new track:
//   • Crossfade: fade_dur = crossfade_secs  → symmetric equal-power fade-in
//   • Hard cut:  fade_dur = 5 ms            → micro-fade eliminates DC-click
//   • Gapless:   fade_dur = 0               → unity gain (no modification)
//
// gain(t) = sin(t · π/2),  t ∈ [0, 1)
// At t = 0 gain = 0, at t = 1 gain = 1.
// Equal-power property: cos²+sin² = 1 → combined with cos fade-out on Track A
// the total perceived loudness stays constant across the crossfade.

struct EqualPowerFadeIn<S: Source<Item = f32>> {
    inner: S,
    sample_count: u64,
    fade_samples: u64,
}

impl<S: Source<Item = f32>> EqualPowerFadeIn<S> {
    fn new(inner: S, fade_dur: Duration) -> Self {
        let sample_rate = inner.sample_rate();
        let channels = inner.channels() as u64;
        let fade_samples = if fade_dur.is_zero() {
            0
        } else {
            (fade_dur.as_secs_f64() * sample_rate as f64 * channels as f64) as u64
        };
        Self { inner, sample_count: 0, fade_samples }
    }
}

impl<S: Source<Item = f32>> Iterator for EqualPowerFadeIn<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;
        let gain = if self.fade_samples == 0 || self.sample_count >= self.fade_samples {
            1.0
        } else {
            let t = self.sample_count as f32 / self.fade_samples as f32;
            (t * std::f32::consts::FRAC_PI_2).sin()
        };
        self.sample_count += 1;
        Some((sample * gain).clamp(-1.0, 1.0))
    }
}

impl<S: Source<Item = f32>> Source for EqualPowerFadeIn<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.inner.channels() }
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // For mid-track seeks: skip straight to unity gain so the new position
        // plays at full volume immediately — no audible fade-in glitch.
        // For seeks to the very start (< 100 ms): keep the micro-fade to
        // suppress any DC-offset click from the fresh decode.
        if pos.as_millis() < 100 {
            self.sample_count = 0;
        } else {
            self.sample_count = self.fade_samples;
        }
        self.inner.try_seek(pos)
    }
}

// ─── TriggeredFadeOut — sample-level cos(t·π/2) fade-out triggered externally ─
//
// Every track source is wrapped with this. It passes through at unity gain
// until `trigger` is set to true, at which point it reads `fade_total_samples`
// and applies a cos(t·π/2) envelope:
//   gain(t) = cos(t · π/2),  t ∈ [0, 1]
//   At t = 0 gain = 1, at t = 1 gain = 0.
// After the fade completes, returns None to exhaust the source.
//
// Combined with EqualPowerFadeIn (sin curve) on Track B, this gives a
// symmetric constant-power crossfade: sin²+cos² = 1.

struct TriggeredFadeOut<S: Source<Item = f32>> {
    inner: S,
    trigger: Arc<AtomicBool>,
    fade_total_samples: Arc<AtomicU64>,
    fade_progress: u64,
    fading: bool,
    cached_total: u64,
}

impl<S: Source<Item = f32>> TriggeredFadeOut<S> {
    fn new(inner: S, trigger: Arc<AtomicBool>, fade_total_samples: Arc<AtomicU64>) -> Self {
        Self {
            inner,
            trigger,
            fade_total_samples,
            fade_progress: 0,
            fading: false,
            cached_total: 0,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for TriggeredFadeOut<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        // Check trigger on first fade sample only (avoid atomic load per sample).
        if !self.fading && self.trigger.load(Ordering::Relaxed) {
            self.fading = true;
            self.cached_total = self.fade_total_samples.load(Ordering::Relaxed).max(1);
            self.fade_progress = 0;
        }

        if self.fading {
            if self.fade_progress >= self.cached_total {
                // Fade complete — exhaust the source.
                return None;
            }
            let sample = self.inner.next()?;
            let t = self.fade_progress as f32 / self.cached_total as f32;
            let gain = (t * std::f32::consts::FRAC_PI_2).cos();
            self.fade_progress += 1;
            Some((sample * gain).clamp(-1.0, 1.0))
        } else {
            self.inner.next()
        }
    }
}

impl<S: Source<Item = f32>> Source for TriggeredFadeOut<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.inner.channels() }
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // If we seek back during a fade, cancel the fade.
        if self.fading {
            self.fading = false;
            self.trigger.store(false, Ordering::Relaxed);
        }
        self.fade_progress = 0;
        self.inner.try_seek(pos)
    }
}

// ─── NotifyingSource — sets a flag when the inner iterator is exhausted ───────
//
// This is the key mechanism for gapless: the progress task polls `done` to know
// exactly when source N has finished inside the Sink, without relying on
// wall-clock estimation or the unreliable `Sink::empty()`.

struct NotifyingSource<S: Source<Item = f32>> {
    inner: S,
    done: Arc<AtomicBool>,
    signalled: bool,
}

impl<S: Source<Item = f32>> NotifyingSource<S> {
    fn new(inner: S, done: Arc<AtomicBool>) -> Self {
        Self { inner, done, signalled: false }
    }
}

impl<S: Source<Item = f32>> Iterator for NotifyingSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next();
        if sample.is_none() && !self.signalled {
            self.signalled = true;
            self.done.store(true, Ordering::SeqCst);
        }
        sample
    }
}

impl<S: Source<Item = f32>> Source for NotifyingSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.inner.channels() }
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // If we seek backwards the source is no longer exhausted.
        self.signalled = false;
        self.done.store(false, Ordering::SeqCst);
        self.inner.try_seek(pos)
    }
}

// ─── CountingSource — atomic sample counter for drift-free position tracking ─
//
// Wraps the outermost source and increments a shared AtomicU64 on every sample.
// The progress task reads this counter and divides by (sample_rate * channels)
// to get the exact playback position — no wall-clock drift.

struct CountingSource<S: Source<Item = f32>> {
    inner: S,
    counter: Arc<AtomicU64>,
}

impl<S: Source<Item = f32>> CountingSource<S> {
    fn new(inner: S, counter: Arc<AtomicU64>) -> Self {
        Self { inner, counter }
    }
}

impl<S: Source<Item = f32>> Iterator for CountingSource<S> {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next();
        if sample.is_some() {
            self.counter.fetch_add(1, Ordering::Relaxed);
        }
        sample
    }
}

impl<S: Source<Item = f32>> Source for CountingSource<S> {
    fn current_frame_len(&self) -> Option<usize> { self.inner.current_frame_len() }
    fn channels(&self) -> u16 { self.inner.channels() }
    fn sample_rate(&self) -> u32 { self.inner.sample_rate() }
    fn total_duration(&self) -> Option<Duration> { self.inner.total_duration() }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        // Reset counter only after confirming the inner seek succeeded.
        // If we reset first and the seek fails, the counter ends up at the
        // new position while the decoder is still at the old one — causing
        // a permanent desync between displayed time and actual audio.
        let result = self.inner.try_seek(pos);
        if result.is_ok() {
            let samples = (pos.as_secs_f64() * self.inner.sample_rate() as f64
                * self.inner.channels() as f64) as u64;
            self.counter.store(samples, Ordering::Relaxed);
        }
        result
    }
}

// ─── Internet Radio v2 — Lock-Free SPSC + ICY Metadata + Hybrid Pause ────────
//
//  HTTP task (tokio)
//    └─[IcyInterceptor]─► HeapProducer<u8>
//                              │  (4 MB HeapRb, lock-free)
//                         HeapConsumer<u8>
//                              │
//                       AudioStreamReader (Read + Seek + MediaSource)
//                              │
//                       SizedDecoder (symphonia)
//                              │
//                           rodio Sink
//
// Pause modes:
//   Logical pause  — sink.pause(); download task keeps filling (time-shift).
//   Hard pause     — buffer ≥ RADIO_HARD_PAUSE_THRESH full + paused ≥ 5 s
//                    → TCP disconnect, is_hard_paused = true.
//   Resume (warm)  — sink.play(); buffer drains seamlessly.
//   Resume (cold)  — new HeapRb + new GET; consumer swapped in AudioStreamReader.
//
// New Tauri event: "radio:metadata" → String  (ICY StreamTitle)

/// 256 KB on the heap — ≈16 s at 128 kbps, ≈6 s at 320 kbps.
/// Small enough that stale audio drains within a few seconds on reconnect;
/// large enough to absorb brief network hiccups without stuttering.
const RADIO_BUF_CAPACITY: usize = 256 * 1024;
/// Minimum ring buffer for on-demand track streaming starts.
const TRACK_STREAM_MIN_BUF_CAPACITY: usize = 1024 * 1024;
/// Cap ring buffer growth when content-length is known.
const TRACK_STREAM_MAX_BUF_CAPACITY: usize = 32 * 1024 * 1024;
/// Max bytes kept in memory to promote a completed streamed track for fast replay/seek recovery.
const TRACK_STREAM_PROMOTE_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Consecutive body-stream failures tolerated for track streaming before abort.
const TRACK_STREAM_MAX_RECONNECTS: u32 = 3;
/// Seconds at stall threshold while paused before hard-disconnect.
const RADIO_HARD_PAUSE_SECS: u64 = 5;
/// AudioStreamReader timeout: if no audio bytes arrive for this long → EOF.
const RADIO_READ_TIMEOUT_SECS: u64 = 15;
/// Sleep interval when ring buffer is empty (prevents CPU spin).
const RADIO_YIELD_MS: u64 = 2;

// ── ICY Metadata State Machine ────────────────────────────────────────────────
//
// Shoutcast/Icecast embed metadata every `metaint` audio bytes:
//
//   ┌──────────────────────┬───┬─────────────┐
//   │  audio × metaint     │ N │ meta × N×16 │  (repeating)
//   └──────────────────────┴───┴─────────────┘
//
// N = 0 → no metadata this block.  Metadata bytes are stripped so only
// pure audio reaches the ring buffer and Symphonia never sees text bytes.

enum IcyState {
    /// Forwarding audio bytes; `remaining` counts down to the next boundary.
    ReadingAudio { remaining: usize },
    /// Next byte is the metadata length multiplier N.
    ReadingLengthByte,
    /// Accumulating N×16 metadata bytes.
    ReadingMetadata { remaining: usize, buf: Vec<u8> },
}

struct IcyInterceptor {
    state: IcyState,
    metaint: usize,
}

impl IcyInterceptor {
    fn new(metaint: usize) -> Self {
        Self { metaint, state: IcyState::ReadingAudio { remaining: metaint } }
    }

    /// Feed a raw HTTP chunk.
    /// Appends only audio bytes to `audio_out`.
    /// Returns `Some(IcyMeta)` when a StreamTitle is extracted.
    fn process(&mut self, input: &[u8], audio_out: &mut Vec<u8>) -> Option<IcyMeta> {
        let mut extracted: Option<IcyMeta> = None;
        let mut i = 0;
        while i < input.len() {
            match &mut self.state {
                IcyState::ReadingAudio { remaining } => {
                    let n = (input.len() - i).min(*remaining);
                    audio_out.extend_from_slice(&input[i..i + n]);
                    i += n;
                    *remaining -= n;
                    if *remaining == 0 {
                        self.state = IcyState::ReadingLengthByte;
                    }
                }
                IcyState::ReadingLengthByte => {
                    let len_n = input[i] as usize;
                    i += 1;
                    self.state = if len_n == 0 {
                        IcyState::ReadingAudio { remaining: self.metaint }
                    } else {
                        IcyState::ReadingMetadata {
                            remaining: len_n * 16,
                            buf: Vec::with_capacity(len_n * 16),
                        }
                    };
                }
                IcyState::ReadingMetadata { remaining, buf } => {
                    let n = (input.len() - i).min(*remaining);
                    buf.extend_from_slice(&input[i..i + n]);
                    i += n;
                    *remaining -= n;
                    if *remaining == 0 {
                        let bytes = std::mem::take(buf);
                        extracted = parse_icy_meta(&bytes);
                        self.state = IcyState::ReadingAudio { remaining: self.metaint };
                    }
                }
            }
        }
        extracted
    }
}

/// ICY metadata parsed from a raw metadata block.
#[derive(serde::Serialize, Clone)]
pub(crate) struct IcyMeta {
    pub title: String,
    /// `true` when `StreamUrl='0'` — indicates a CDN-injected ad/promo.
    pub is_ad: bool,
}

/// Extract `StreamTitle` and `StreamUrl` from a raw ICY metadata block.
/// Tolerates null padding and non-UTF-8 bytes (lossy conversion).
fn parse_icy_meta(raw: &[u8]) -> Option<IcyMeta> {
    let s = String::from_utf8_lossy(raw);
    let s = s.trim_end_matches('\0');

    const TITLE_TAG: &str = "StreamTitle='";
    let title_start = s.find(TITLE_TAG)? + TITLE_TAG.len();
    let title_rest = &s[title_start..];
    // find (not rfind) — rfind would skip past StreamUrl and corrupt the title
    let title_end = title_rest.find("';")?;
    let title = title_rest[..title_end].trim().to_string();
    if title.is_empty() {
        return None;
    }

    const URL_TAG: &str = "StreamUrl='";
    let stream_url = s.find(URL_TAG).map(|pos| {
        let rest = &s[pos + URL_TAG.len()..];
        let end = rest.find("';").unwrap_or(rest.len());
        rest[..end].trim().to_string()
    }).unwrap_or_default();

    Some(IcyMeta { title, is_ad: stream_url == "0" })
}

// ── AudioStreamReader — SPSC consumer → std::io::Read ────────────────────────
//
// Bridges HeapConsumer<u8> (non-blocking) into the synchronous Read interface
// that Symphonia requires.  Designed to run inside tokio::task::spawn_blocking.
//
// Empty buffer:  sleeps RADIO_YIELD_MS ms, retries. Never busy-spins.
// Timeout:       after RADIO_READ_TIMEOUT_SECS with no data → TimedOut.
// Generation:    if gen_arc != self.gen → Ok(0) (EOF; new track started).
// Reconnect:     audio_resume sends a fresh HeapConsumer via new_cons_rx.
//                On the next read() we drain the channel (keep latest) and swap.

struct AudioStreamReader {
    cons: HeapConsumer<u8>,
    /// Delivers fresh consumers on hard-pause reconnect (unbounded; drain to latest).
    /// Wrapped in Mutex so AudioStreamReader is Sync (required by symphonia::MediaSource).
    /// No real contention: only the audio thread ever calls read().
    new_cons_rx: Mutex<std::sync::mpsc::Receiver<HeapConsumer<u8>>>,
    deadline: std::time::Instant,
    gen_arc: Arc<AtomicU64>,
    gen: u64,
    /// Diagnostic tag for logs ("radio" or "track-stream").
    source_tag: &'static str,
    /// Optional completion marker: when true and the ring buffer is empty,
    /// return EOF immediately (used by one-shot track streaming).
    eof_when_empty: Option<Arc<AtomicBool>>,
    /// Monotonic byte offset for SeekFrom::Current(0) "tell" (Symphonia probe).
    pos: u64,
}

impl Read for AudioStreamReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // EOF guard: new track started.
        if self.gen_arc.load(Ordering::SeqCst) != self.gen {
            return Ok(0);
        }
        // Drain reconnect channel; keep only the most recently delivered consumer
        // so a double-tap of resume doesn't leave stale data in place.
        let mut newest: Option<HeapConsumer<u8>> = None;
        while let Ok(c) = self.new_cons_rx.lock().unwrap().try_recv() {
            newest = Some(c);
        }
        if let Some(c) = newest {
            self.cons = c;
            self.deadline =
                std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS);
        }
        loop {
            if self.gen_arc.load(Ordering::SeqCst) != self.gen {
                return Ok(0);
            }
            let available = self.cons.len();
            if available > 0 {
                let n = buf.len().min(available);
                let read = self.cons.pop_slice(&mut buf[..n]);
                self.pos += read as u64;
                // Reset deadline: data arrived, so connection is alive.
                self.deadline =
                    std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS);
                return Ok(read);
            }
            if self
                .eof_when_empty
                .as_ref()
                .is_some_and(|done| done.load(Ordering::SeqCst))
            {
                return Ok(0);
            }
            if std::time::Instant::now() >= self.deadline {
                crate::app_eprintln!(
                    "[{}] AudioStreamReader: {}s without data → EOF",
                    self.source_tag,
                    RADIO_READ_TIMEOUT_SECS
                );
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("{}: no data received", self.source_tag),
                ));
            }
            std::thread::sleep(Duration::from_millis(RADIO_YIELD_MS));
        }
    }
}

impl Seek for AudioStreamReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        match pos {
            SeekFrom::Current(0) => Ok(self.pos),
            _ => Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                format!("{} stream is not seekable", self.source_tag),
            )),
        }
    }
}

impl MediaSource for AudioStreamReader {
    fn is_seekable(&self) -> bool { false }
    fn byte_len(&self) -> Option<u64> { None }
}

// ── RangedHttpSource — seekable HTTP-backed MediaSource ──────────────────────
//
// Pre-allocates a Vec<u8> of total track size. A background task fills it
// linearly from offset 0 via streaming HTTP. Read blocks (with timeout) until
// requested bytes are downloaded; Seek only updates the cursor.
//
// Reports is_seekable=true so Symphonia performs time-based seeks via the
// format reader. Backward seeks: instant (data in buffer). Forward seeks
// beyond downloaded_to: Read blocks until the linear download catches up.
//
// Requires server to have responded with both Content-Length and
// `Accept-Ranges: bytes` so reconnects can resume via HTTP Range.

struct RangedHttpSource {
    /// Pre-allocated buffer of total size. Filled linearly from offset 0.
    buf: Arc<Mutex<Vec<u8>>>,
    /// Bytes contiguously downloaded from offset 0.
    downloaded_to: Arc<AtomicUsize>,
    total_size: u64,
    pos: u64,
    /// Set when the download task terminates (success or hard error).
    done: Arc<AtomicBool>,
    gen_arc: Arc<AtomicU64>,
    gen: u64,
}

impl Read for RangedHttpSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.gen_arc.load(Ordering::SeqCst) != self.gen {
            return Ok(0);
        }
        if self.pos >= self.total_size {
            return Ok(0);
        }
        let max_read = ((self.total_size - self.pos) as usize).min(buf.len());
        if max_read == 0 {
            return Ok(0);
        }
        let target_end = self.pos + max_read as u64;

        let deadline = Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS);
        loop {
            if self.gen_arc.load(Ordering::SeqCst) != self.gen {
                return Ok(0);
            }
            let dl = self.downloaded_to.load(Ordering::SeqCst) as u64;
            if dl >= target_end {
                break;
            }
            // Download finished but our cursor is past downloaded_to (e.g. seek
            // beyond a partial download that aborted). Return what we have.
            if self.done.load(Ordering::SeqCst) {
                if dl > self.pos {
                    let avail = (dl - self.pos) as usize;
                    let src = self.buf.lock().unwrap();
                    let start = self.pos as usize;
                    buf[..avail].copy_from_slice(&src[start..start + avail]);
                    drop(src);
                    self.pos += avail as u64;
                    return Ok(avail);
                }
                return Ok(0);
            }
            if Instant::now() >= deadline {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "ranged-http: no data within timeout",
                ));
            }
            std::thread::sleep(Duration::from_millis(RADIO_YIELD_MS));
        }

        let src = self.buf.lock().unwrap();
        let start = self.pos as usize;
        let end = start + max_read;
        buf[..max_read].copy_from_slice(&src[start..end]);
        drop(src);
        self.pos += max_read as u64;
        Ok(max_read)
    }
}

impl Seek for RangedHttpSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new_pos: i64 = match pos {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::Current(p) => self.pos as i64 + p,
            SeekFrom::End(p) => self.total_size as i64 + p,
        };
        if new_pos < 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "ranged-http: seek before start",
            ));
        }
        self.pos = (new_pos as u64).min(self.total_size);
        Ok(self.pos)
    }
}

impl MediaSource for RangedHttpSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.total_size) }
}

// ── LocalFileSource — seekable file-backed MediaSource ───────────────────────
//
// Wraps `std::fs::File` so the decoder reads on-demand from disk instead of
// pre-loading the whole file into a Vec. Used for `psysonic-local://` URLs
// (offline library + hot playback cache hits) — gives instant track-start
// because Symphonia only needs to read ~64 KB during probe before playback
// can begin, vs the previous behaviour of `tokio::fs::read` which blocked
// until the entire file (often 100+ MB for hi-res FLAC) was in RAM.

struct LocalFileSource {
    file: std::fs::File,
    len: u64,
}

impl Read for LocalFileSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buf)
    }
}

impl Seek for LocalFileSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.file.seek(pos)
    }
}

impl MediaSource for LocalFileSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.len) }
}

// ── Pause / Reconnect Coordination ───────────────────────────────────────────

pub(crate) struct RadioSharedFlags {
    /// Set by audio_pause; cleared by audio_resume.
    is_paused: AtomicBool,
    /// Set by download task on hard disconnect; cleared on resume-reconnect.
    is_hard_paused: AtomicBool,
    /// Delivers a fresh HeapConsumer<u8> to AudioStreamReader on reconnect.
    new_cons_tx: Mutex<std::sync::mpsc::Sender<HeapConsumer<u8>>>,
}

/// Live state for the current radio session, stored in AudioEngine.
/// Dropping this struct aborts the HTTP download task immediately.
pub(crate) struct RadioLiveState {
    pub url: String,
    pub gen: u64,
    pub task: tokio::task::JoinHandle<()>,
    pub flags: Arc<RadioSharedFlags>,
}

impl Drop for RadioLiveState {
    fn drop(&mut self) { self.task.abort(); }
}

// ── HE-AAC / FDK-AAC Fallback ────────────────────────────────────────────────
//
// Symphonia 0.5.x: AAC-LC only.  HE-AAC (AAC+) and HE-AACv2 lack SBR/PS →
// streams play at half speed with muffled audio.
//
// With Cargo feature "fdk-aac": FdkAacDecoder is tried first for CODEC_TYPE_AAC.
// Enable in Cargo.toml:
//   symphonia-adapter-fdk-aac = { version = "0.1", optional = true }
//   [features]
//   fdk-aac = ["dep:symphonia-adapter-fdk-aac"]

/// Symphonia’s default codec set for our enabled features, plus Opus via libopus.
fn psysonic_codec_registry() -> &'static CodecRegistry {
    static REGISTRY: OnceLock<CodecRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut registry);
        registry.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        registry
    })
}

fn try_make_radio_decoder(
    params: &symphonia::core::codecs::CodecParameters,
    opts: &DecoderOptions,
) -> Result<Box<dyn symphonia::core::codecs::Decoder>, symphonia::core::errors::Error> {
    psysonic_codec_registry().make(params, opts)
}

// ── Async HTTP Download Task ──────────────────────────────────────────────────
//
// Lifecycle:
//   'outer loop — reconnect on TCP drop (up to MAX_RECONNECTS)
//   'inner loop — read HTTP chunks → ICY interceptor → push audio to ring buffer
//
// Hard-pause detection: if push_slice() returns 0 (buffer full) AND sink is
// paused AND that condition persists for RADIO_HARD_PAUSE_SECS → disconnect.
// Sets is_hard_paused = true so audio_resume knows it must reconnect.

async fn radio_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    mut initial_response: Option<reqwest::Response>,
    http_client: reqwest::Client,
    url: String,
    mut prod: HeapProducer<u8>,
    flags: Arc<RadioSharedFlags>,
    app: AppHandle,
) {
    let mut bytes_total: u64 = 0;
    // Counts consecutive failures (reset on each successful chunk).
    // laut.fm and similar CDNs force-reconnect every ~700 KB; this is normal.
    let mut reconnect_count: u32 = 0;
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    let mut audio_scratch: Vec<u8> = Vec::with_capacity(65_536);

    'outer: loop {
        if gen_arc.load(Ordering::SeqCst) != gen { return; }

        // ── Obtain response (initial or reconnect) ────────────────────────────
        let response = match initial_response.take() {
            Some(r) => r,
            None => {
                if reconnect_count >= MAX_CONSECUTIVE_FAILURES {
                    crate::app_eprintln!("[radio] {MAX_CONSECUTIVE_FAILURES} consecutive failures — giving up");
                    break 'outer;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
                if gen_arc.load(Ordering::SeqCst) != gen { return; }
                match http_client
                    .get(&url)
                    .header("Icy-MetaData", "1")
                    .send()
                    .await
                {
                    Ok(r) if r.status().is_success() => {
                        crate::app_eprintln!("[radio] reconnected ({bytes_total} B so far)");
                        r
                    }
                    Ok(r) => {
                        crate::app_eprintln!("[radio] reconnect: HTTP {} — giving up", r.status());
                        break 'outer;
                    }
                    Err(e) => {
                        crate::app_eprintln!("[radio] reconnect error: {e} — giving up");
                        break 'outer;
                    }
                }
            }
        };

        // Parse ICY metaint from each response (consistent across reconnects).
        let metaint: Option<usize> = response
            .headers()
            .get("icy-metaint")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok());
        let mut icy = metaint.map(IcyInterceptor::new);

        let mut byte_stream = response.bytes_stream();
        // Stall timer: tracks how long push_slice() returns 0 while paused.
        let mut stall_since: Option<std::time::Instant> = None;

        'inner: loop {
            if gen_arc.load(Ordering::SeqCst) != gen { return; }

            // ── Back-pressure + hard-pause detection ──────────────────────────
            if prod.is_full() {
                if flags.is_paused.load(Ordering::Relaxed) {
                    let since = stall_since.get_or_insert(std::time::Instant::now());
                    if since.elapsed() >= Duration::from_secs(RADIO_HARD_PAUSE_SECS) {
                        let fill_pct = ((1.0
                            - prod.free_len() as f32 / RADIO_BUF_CAPACITY as f32)
                            * 100.0) as u32;
                        crate::app_eprintln!(
                            "[radio] hard pause: {fill_pct}% full, \
                             paused >{RADIO_HARD_PAUSE_SECS}s → disconnecting"
                        );
                        flags.is_hard_paused.store(true, Ordering::Release);
                        return; // Drop HeapProducer → TCP connection released.
                    }
                } else {
                    stall_since = None;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue 'inner;
            }
            stall_since = None;

            // ── Read HTTP chunk ───────────────────────────────────────────────
            match byte_stream.next().await {
                Some(Ok(chunk)) => {
                    bytes_total += chunk.len() as u64;
                    // Successful data → reset consecutive-failure counter.
                    reconnect_count = 0;
                    audio_scratch.clear();

                    if let Some(ref mut interceptor) = icy {
                        if let Some(meta) = interceptor.process(&chunk, &mut audio_scratch) {
                            let label = if meta.is_ad { "[Ad]" } else { "" };
                            crate::app_eprintln!("[radio] ICY StreamTitle: {}{}", label, meta.title);
                            let _ = app.emit("radio:metadata", &meta);
                        }
                    } else {
                        audio_scratch.extend_from_slice(&chunk);
                    }

                    // Push with per-chunk back-pressure: yield 5 ms if full mid-chunk.
                    let mut offset = 0;
                    while offset < audio_scratch.len() {
                        if gen_arc.load(Ordering::SeqCst) != gen { return; }
                        let pushed = prod.push_slice(&audio_scratch[offset..]);
                        if pushed == 0 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        } else {
                            offset += pushed;
                        }
                    }
                }
                Some(Err(e)) => {
                    reconnect_count += 1;
                    crate::app_eprintln!("[radio] stream error: {e} → reconnecting (consecutive #{reconnect_count})");
                    break 'inner;
                }
                None => {
                    reconnect_count += 1;
                    crate::app_eprintln!("[radio] stream ended cleanly → reconnecting (consecutive #{reconnect_count})");
                    break 'inner;
                }
            }
        } // 'inner

        // Do NOT swap the ring buffer here.  The remaining bytes in the buffer
        // are still valid audio and will drain naturally during reconnect.
        // Clearing it would cause an immediate underrun/glitch.
        // The buffer is kept small (RADIO_BUF_CAPACITY) so stale audio drains
        // within a few seconds rather than minutes.
    } // 'outer

    crate::app_eprintln!("[radio] download task done ({bytes_total} B total)");
}

/// One-shot HTTP downloader for track streaming starts.
///
/// Pushes response chunks into an SPSC ring buffer consumed by `AudioStreamReader`.
/// Terminates when:
/// - generation changes (track superseded),
/// - response stream ends, or
/// - response emits an error.
async fn track_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_client: reqwest::Client,
    url: String,
    initial_response: reqwest::Response,
    mut prod: HeapProducer<u8>,
    done: Arc<AtomicBool>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
) {
    let mut downloaded: u64 = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let mut capture: Vec<u8> = Vec::new();
    let mut capture_over_limit = false;
    'outer: loop {
        let response = if let Some(r) = next_response.take() {
            r
        } else {
            let mut req = http_client.get(&url);
            if downloaded > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            }
            match req.send().await {
                Ok(r) => r,
                Err(err) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] streaming reconnect failed after {} attempts: {}",
                            reconnects, err
                        );
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    reconnects += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue 'outer;
                }
            }
        };
        if downloaded > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            crate::app_eprintln!(
                "[audio] streaming reconnect returned {}, expected 206 for range resume",
                response.status()
            );
            done.store(true, Ordering::SeqCst);
            return;
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] streaming HTTP {}", response.status());
            done.store(true, Ordering::SeqCst);
            return;
        }

        let mut byte_stream = response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            if gen_arc.load(Ordering::SeqCst) != gen {
                done.store(true, Ordering::SeqCst);
                return;
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] streaming download error after {} reconnects: {}",
                            reconnects, e
                        );
                        done.store(true, Ordering::SeqCst);
                        return;
                    }
                    reconnects += 1;
                    crate::app_eprintln!(
                        "[audio] streaming download error (attempt {}/{}): {} — reconnecting",
                        reconnects,
                        TRACK_STREAM_MAX_RECONNECTS,
                        e
                    );
                    next_response = None;
                    continue 'outer;
                }
            };
            reconnects = 0;
            let mut offset = 0;
            while offset < chunk.len() {
                if gen_arc.load(Ordering::SeqCst) != gen {
                    done.store(true, Ordering::SeqCst);
                    return;
                }
                let pushed = prod.push_slice(&chunk[offset..]);
                if pushed == 0 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                } else {
                    if !capture_over_limit {
                        if capture.len().saturating_add(pushed) <= TRACK_STREAM_PROMOTE_MAX_BYTES {
                            let from = offset;
                            let to = offset + pushed;
                            capture.extend_from_slice(&chunk[from..to]);
                        } else {
                            capture.clear();
                            capture_over_limit = true;
                        }
                    }
                    offset += pushed;
                    downloaded += pushed as u64;
                }
            }
        }
        if !capture_over_limit && !capture.is_empty() {
            *promote_cache_slot.lock().unwrap() = Some(PreloadedTrack {
                url: url.clone(),
                data: capture,
            });
        }
        done.store(true, Ordering::SeqCst);
        return;
    }
}

/// Linear downloader for `RangedHttpSource`: fills the pre-allocated buffer
/// from offset 0 to total_size. Reconnects via HTTP Range from the current
/// `downloaded` offset on transient errors. On completion (full track) the
/// data is promoted to `stream_completed_cache` for fast replay.
async fn ranged_download_task(
    gen: u64,
    gen_arc: Arc<AtomicU64>,
    http_client: reqwest::Client,
    url: String,
    initial_response: reqwest::Response,
    buf: Arc<Mutex<Vec<u8>>>,
    downloaded_to: Arc<AtomicUsize>,
    done: Arc<AtomicBool>,
    promote_cache_slot: Arc<Mutex<Option<PreloadedTrack>>>,
) {
    let total_size = buf.lock().unwrap().len();
    let mut downloaded: usize = 0;
    let mut reconnects: u32 = 0;
    let mut next_response: Option<reqwest::Response> = Some(initial_response);
    let dl_started = Instant::now();
    let mut next_progress_mb: usize = 1;

    'outer: loop {
        let response = if let Some(r) = next_response.take() {
            r
        } else {
            let mut req = http_client.get(&url);
            if downloaded > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
            }
            match req.send().await {
                Ok(r) => r,
                Err(err) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] ranged reconnect failed after {} attempts: {}",
                            reconnects, err
                        );
                        break 'outer;
                    }
                    reconnects += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue 'outer;
                }
            }
        };
        if downloaded > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            crate::app_eprintln!(
                "[audio] ranged reconnect returned {}, expected 206",
                response.status()
            );
            break 'outer;
        }
        if downloaded == 0 && !response.status().is_success() {
            crate::app_eprintln!("[audio] ranged HTTP {}", response.status());
            break 'outer;
        }

        let mut byte_stream = response.bytes_stream();
        while let Some(chunk) = byte_stream.next().await {
            if gen_arc.load(Ordering::SeqCst) != gen {
                done.store(true, Ordering::SeqCst);
                return;
            }
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if reconnects >= TRACK_STREAM_MAX_RECONNECTS {
                        crate::app_eprintln!(
                            "[audio] ranged dl error after {} reconnects: {}",
                            reconnects, e
                        );
                        break 'outer;
                    }
                    reconnects += 1;
                    crate::app_eprintln!(
                        "[audio] ranged dl error (attempt {}/{}): {} — reconnecting",
                        reconnects, TRACK_STREAM_MAX_RECONNECTS, e
                    );
                    next_response = None;
                    continue 'outer;
                }
            };
            reconnects = 0;
            let writable = total_size.saturating_sub(downloaded);
            if writable == 0 {
                break;
            }
            let n = chunk.len().min(writable);
            {
                let mut b = buf.lock().unwrap();
                b[downloaded..downloaded + n].copy_from_slice(&chunk[..n]);
            }
            downloaded += n;
            downloaded_to.store(downloaded, Ordering::SeqCst);
            let mb = downloaded / (1024 * 1024);
            if mb >= next_progress_mb {
                let pct = (downloaded as f64 / total_size as f64 * 100.0) as u32;
                crate::app_deprintln!(
                    "[stream] dl progress: {} MB / {} MB ({}%)",
                    mb,
                    total_size / (1024 * 1024),
                    pct
                );
                next_progress_mb = mb + 1;
            }
            if downloaded >= total_size {
                break;
            }
        }
        // Stream ended cleanly (or hit total_size).
        break 'outer;
    }

    done.store(true, Ordering::SeqCst);

    crate::app_deprintln!(
        "[stream] dl done: {} / {} bytes in {:.2}s ({} reconnects)",
        downloaded,
        total_size,
        dl_started.elapsed().as_secs_f64(),
        reconnects
    );

    if downloaded == total_size && total_size > 0 && total_size <= TRACK_STREAM_PROMOTE_MAX_BYTES {
        let data = buf.lock().unwrap().clone();
        *promote_cache_slot.lock().unwrap() = Some(PreloadedTrack { url, data });
        crate::app_deprintln!("[stream] promoted to stream_completed_cache for replay");
    }
}

fn content_type_to_hint(ct: &str) -> Option<String> {
    let ct = ct.to_ascii_lowercase();
    if ct.contains("mpeg") || ct.contains("mp3") { Some("mp3".into()) }
    else if ct.contains("aac") || ct.contains("aacp") { Some("aac".into()) }
    else if ct.contains("ogg") { Some("ogg".into()) }
    else if ct.contains("flac") { Some("flac".into()) }
    else if ct.contains("wav") || ct.contains("wave") { Some("wav".into()) }
    else if ct.contains("opus") { Some("opus".into()) }
    else { None }
}

// ─── SizedCursorSource — correct byte_len for seekable in-memory sources ──────
//
// rodio's internal ReadSeekSource wraps Cursor<Vec<u8>> but hardcodes
// byte_len() → None.  This tells symphonia "stream length unknown", which
// prevents the FLAC demuxer from seeking (it validates seek offsets against
// the total stream length from byte_len).  MP3 is unaffected because its
// demuxer uses Xing/LAME headers instead.
//
// This wrapper provides the actual byte length, fixing seek for all formats.

struct SizedCursorSource {
    inner: Cursor<Vec<u8>>,
    len: u64,
}

impl Read for SizedCursorSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Seek for SizedCursorSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl MediaSource for SizedCursorSource {
    fn is_seekable(&self) -> bool { true }
    fn byte_len(&self) -> Option<u64> { Some(self.len) }
}

// ─── SizedDecoder — symphonia decoder with correct byte_len ───────────────────
//
// Replaces rodio::Decoder::new() which wraps the source in ReadSeekSource
// (byte_len = None).  This constructs the symphonia pipeline directly,
// providing the correct byte_len via SizedCursorSource.
//
// Implements Iterator<Item = i16> + Source — identical interface to
// rodio::Decoder, so the rest of the source chain is unchanged.

/// Debug logging: codec parameters in human-readable form to verify whether
/// playback is genuinely lossless.
fn log_codec_resolution(
    tag: &str,
    params: &symphonia::core::codecs::CodecParameters,
    container_hint: Option<&str>,
) {
    let codec_name = symphonia::default::get_codecs()
        .get_codec(params.codec)
        .map(|d| d.short_name)
        .unwrap_or("?");
    let rate = params.sample_rate.map(|r| format!("{} Hz", r)).unwrap_or_else(|| "? Hz".into());
    let bits = params.bits_per_sample
        .or(params.bits_per_coded_sample)
        .map(|b| format!("{}-bit", b))
        .unwrap_or_else(|| "?-bit".into());
    let ch = params.channels
        .map(|c| format!("{}ch", c.count()))
        .unwrap_or_else(|| "?ch".into());
    let lossless = codec_name.starts_with("pcm")
        || matches!(
            codec_name,
            "flac" | "alac" | "wavpack" | "monkeys-audio" | "tta" | "shorten"
        );
    let kind = if lossless { "LOSSLESS" } else { "lossy" };
    crate::app_deprintln!(
        "[stream] {tag}: codec={codec_name} ({kind}) {bits} {rate} {ch} container={}",
        container_hint.unwrap_or("?")
    );
}

/// Max retries for IO/packet-read errors (fatal — network drop, truncated file).
const DECODE_MAX_RETRIES: usize = 3;
/// Max *consecutive* DecodeErrors before giving up on a file.
/// Non-fatal errors like "invalid main_data offset" are silently dropped up to
/// this limit so a handful of corrupt MP3 frames never aborts an otherwise
/// playable track (VLC-style frame dropping).
const MAX_CONSECUTIVE_DECODE_ERRORS: usize = 100;

struct SizedDecoder {
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    current_frame_offset: usize,
    format: Box<dyn FormatReader>,
    total_duration: Option<Time>,
    buffer: SampleBuffer<i16>,
    spec: SignalSpec,
    /// Counts consecutive DecodeErrors in the hot-path. Reset to 0 on every
    /// successfully decoded frame. Used to detect fully undecodable streams.
    consecutive_decode_errors: usize,
}

impl SizedDecoder {
    fn new(data: Vec<u8>, format_hint: Option<&str>, hi_res: bool) -> Result<Self, String> {
        let data_len = data.len() as u64;
        let source = SizedCursorSource {
            inner: Cursor::new(data),
            len: data_len,
        };
        // Hi-Res: 4 MB read-ahead so Symphonia demuxes fewer Read calls for
        // high-bitrate files (88.2 kHz/24-bit FLAC ≈ 1800 kbps).
        // Standard: 512 KB is plenty for MP3/AAC — larger buffers waste allocation
        // and compete with the playback thread at track start.
        let buf_len = if hi_res { 4 * 1024 * 1024 } else { 512 * 1024 };
        let mss = MediaSourceStream::new(
            Box::new(source) as Box<dyn MediaSource>,
            MediaSourceStreamOptions { buffer_len: buf_len },
        );

        let mut hint = Hint::new();
        if let Some(ext) = format_hint {
            hint.with_extension(ext);
        }
        let format_opts = FormatOptions {
            // Disable gapless parsing — Symphonia 0.5.5 crashes on `edts` atoms
            // present in older iTunes-purchased M4A files.
            enable_gapless: false,
            ..Default::default()
        };

        let meta_opts = symphonia::core::meta::MetadataOptions {
            // Cap embedded cover art at 8 MiB so oversized MJPEG images in
            // iTunes M4A files don't choke the parser.
            limit_visual_bytes: symphonia::core::meta::Limit::Maximum(8 * 1024 * 1024),
            ..Default::default()
        };

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &meta_opts)
            .map_err(|e| {
                let hint_str = format_hint.unwrap_or("unknown");
                // Always print the raw Symphonia error to the terminal for diagnosis.
                crate::app_eprintln!("[psysonic] probe failed (hint={hint_str}): {e}");
                if e.to_string().to_lowercase().contains("unsupported") {
                    format!("unsupported format: .{hint_str} files cannot be played (no demuxer)")
                } else {
                    format!("could not open audio stream (.{hint_str}): {e}")
                }
            })?;

        let track = probed.format
            .tracks()
            .iter()
            // Explicitly select only audio tracks: must have a valid codec and a
            // sample_rate. This skips MJPEG cover-art streams that iTunes M4A
            // files embed as a secondary video track.
            .find(|t| {
                t.codec_params.codec != CODEC_TYPE_NULL
                    && t.codec_params.sample_rate.is_some()
            })
            .ok_or_else(|| {
                crate::app_eprintln!("[psysonic] no audio track found among {} tracks", probed.format.tracks().len());
                "no playable audio track found in file".to_string()
            })?;

        let track_id = track.id;
        let total_duration = track.codec_params.time_base
            .zip(track.codec_params.n_frames)
            .map(|(base, frames)| base.calc_time(frames));

        log_codec_resolution("bytes", &track.codec_params, format_hint);

        let mut decoder = psysonic_codec_registry()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| {
                crate::app_eprintln!("[psysonic] codec init failed: {e}");
                if e.to_string().to_lowercase().contains("unsupported") {
                    "unsupported codec: no decoder available for this audio format".to_string()
                } else {
                    format!("failed to initialise audio decoder: {e}")
                }
            })?;

        let mut format = probed.format;

        // Decode the first packet to initialise spec + buffer.
        // DecodeErrors (e.g. "invalid main_data offset") are non-fatal: drop the
        // frame and try the next packet up to MAX_CONSECUTIVE_DECODE_ERRORS times.
        let mut decode_errors: usize = 0;
        let decoded = loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(symphonia::core::errors::Error::IoError(_)) => {
                    break decoder.last_decoded();
                }
                Err(e) => {
                    crate::app_eprintln!("[psysonic] next_packet error: {e}");
                    return Err(format!("could not read audio data: {e}"));
                }
            };
            if packet.track_id() != track_id {
                crate::app_eprintln!("[psysonic] skipping packet for track {} (want {})", packet.track_id(), track_id);
                continue;
            }
            match decoder.decode(&packet) {
                Ok(decoded) => break decoded,
                Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                    decode_errors += 1;
                    crate::app_eprintln!("[psysonic] init: dropped corrupt frame #{decode_errors}: {msg}");
                    if decode_errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err("too many consecutive decode errors during init — file may be corrupt".into());
                    }
                }
                Err(e) => {
                    crate::app_eprintln!("[psysonic] fatal decode error: {e}");
                    return Err(format!("audio decode error: {e}"));
                }
            }
        };

        let spec = decoded.spec().to_owned();
        let buffer = Self::make_buffer(decoded, &spec);

        Ok(SizedDecoder {
            decoder,
            current_frame_offset: 0,
            format,
            total_duration,
            buffer,
            spec,
            consecutive_decode_errors: 0,
        })
    }

    /// Build a decoder from any `MediaSource` (e.g. track-stream or radio).
    /// Uses `enable_gapless: false` — live streams are not seekable; gapless
    /// trimming requires seeking to read the LAME/iTunSMPB end-padding info.
    fn new_streaming(
        media: Box<dyn MediaSource>,
        format_hint: Option<&str>,
        source_tag: &str,
    ) -> Result<Self, String> {
        // Larger read-ahead buffer for the live streaming SPSC consumer — reduces
        // read() call frequency into the ring buffer, easing I/O spikes.
        let mss = MediaSourceStream::new(media, MediaSourceStreamOptions { buffer_len: 512 * 1024 });
        let mut hint = Hint::new();
        if let Some(ext) = format_hint { hint.with_extension(ext); }
        let format_opts = FormatOptions { enable_gapless: false, ..Default::default() };
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &format_opts, &MetadataOptions::default())
            .map_err(|e| format!("{source_tag}: format probe failed: {e}"))?;

        let track = probed.format.tracks().iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| format!("{source_tag}: no audio track found"))?;
        let track_id = track.id;
        log_codec_resolution(source_tag, &track.codec_params, format_hint);
        // Live streams have no known total frame count → total_duration = None.
        let total_duration = None;
        let mut decoder = try_make_radio_decoder(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("{source_tag}: codec init failed: {e}"))?;
        let mut format = probed.format;

        let mut errors = 0usize;
        let decoded = loop {
            let packet = match format.next_packet() {
                Ok(p) => p,
                Err(_) => break decoder.last_decoded(),
            };
            if packet.track_id() != track_id { continue; }
            match decoder.decode(&packet) {
                Ok(d) => break d,
                Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                    errors += 1;
                    crate::app_eprintln!("[psysonic] {source_tag} init: dropped corrupt frame #{errors}: {msg}");
                    if errors >= MAX_CONSECUTIVE_DECODE_ERRORS {
                        return Err(format!("{source_tag}: too many consecutive decode errors"));
                    }
                }
                Err(e) => return Err(format!("{source_tag}: decode error: {e}")),
            }
        };
        let spec = decoded.spec().to_owned();
        let buffer = Self::make_buffer(decoded, &spec);
        Ok(SizedDecoder { decoder, current_frame_offset: 0, format, total_duration, buffer, spec, consecutive_decode_errors: 0 })
    }

    #[inline]
    fn make_buffer(decoded: AudioBufferRef, spec: &SignalSpec) -> SampleBuffer<i16> {
        let duration = units::Duration::from(decoded.capacity() as u64);
        let mut buffer = SampleBuffer::<i16>::new(duration, *spec);
        buffer.copy_interleaved_ref(decoded);
        buffer
    }

    /// Refine position after a coarse seek — decode packets until we reach the
    /// exact requested timestamp.
    fn refine_position(
        &mut self,
        seek_res: symphonia::core::formats::SeekedTo,
    ) -> Result<(), String> {
        let mut samples_to_pass = seek_res.required_ts - seek_res.actual_ts;
        let packet = loop {
            let candidate = self.format.next_packet()
                .map_err(|e| format!("refine seek: {e}"))?;
            if candidate.dur() > samples_to_pass {
                break candidate;
            }
            samples_to_pass -= candidate.dur();
        };

        let mut decoded = self.decoder.decode(&packet);
        for _ in 0..DECODE_MAX_RETRIES {
            if decoded.is_err() {
                let p = self.format.next_packet()
                    .map_err(|e| format!("refine retry: {e}"))?;
                decoded = self.decoder.decode(&p);
            }
        }

        let decoded = decoded.map_err(|e| format!("refine decode: {e}"))?;
        decoded.spec().clone_into(&mut self.spec);
        self.buffer = Self::make_buffer(decoded, &self.spec);
        self.current_frame_offset = samples_to_pass as usize * self.spec.channels.count();
        Ok(())
    }
}

impl Iterator for SizedDecoder {
    type Item = i16;

    #[inline]
    fn next(&mut self) -> Option<i16> {
        if self.current_frame_offset >= self.buffer.len() {
            // Loop until a decodable packet is found or the stream ends.
            // DecodeErrors (e.g. MP3 "invalid main_data offset") are non-fatal:
            // drop the frame and advance to the next packet. IO errors and a
            // clean end-of-stream both terminate the iterator normally.
            loop {
                let packet = self.format.next_packet().ok()?;
                match self.decoder.decode(&packet) {
                    Ok(decoded) => {
                        self.consecutive_decode_errors = 0;
                        decoded.spec().clone_into(&mut self.spec);
                        self.buffer = Self::make_buffer(decoded, &self.spec);
                        self.current_frame_offset = 0;
                        break;
                    }
                    Err(symphonia::core::errors::Error::DecodeError(ref msg)) => {
                        #[cfg(not(debug_assertions))]
                        let _ = msg;
                        self.consecutive_decode_errors += 1;
                        // Log sparingly: first drop, then every 10th to avoid spam.
                        if self.consecutive_decode_errors == 1
                            || self.consecutive_decode_errors % 10 == 0
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

        let sample = *self.buffer.samples().get(self.current_frame_offset)?;
        self.current_frame_offset += 1;
        Some(sample)
    }
}

impl Source for SizedDecoder {
    #[inline]
    fn current_frame_len(&self) -> Option<usize> {
        Some(self.buffer.samples().len())
    }

    #[inline]
    fn channels(&self) -> u16 {
        self.spec.channels.count() as u16
    }

    #[inline]
    fn sample_rate(&self) -> u32 {
        self.spec.rate
    }

    #[inline]
    fn total_duration(&self) -> Option<Duration> {
        self.total_duration.map(|Time { seconds, frac }| {
            Duration::new(seconds, (frac * 1_000_000_000.0) as u32)
        })
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let seek_beyond_end = self
            .total_duration()
            .is_some_and(|dur| dur.saturating_sub(pos).as_millis() < 1);

        let time: Time = if seek_beyond_end {
            let t = self.total_duration.unwrap_or(pos.as_secs_f64().into());
            // Step back a tiny bit — some demuxers can't seek to the exact end.
            let mut secs = t.seconds;
            let mut frac = t.frac - 0.0001;
            if frac < 0.0 {
                secs = secs.saturating_sub(1);
                frac = 1.0 - frac;
            }
            Time { seconds: secs, frac }
        } else {
            pos.as_secs_f64().into()
        };

        let to_skip = self.current_frame_offset % self.channels() as usize;

        let seek_res = self
            .format
            .seek(SeekMode::Accurate, SeekTo::Time { time, track_id: None })
            .map_err(|e| rodio::source::SeekError::Other(
                Box::new(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
            ))?;

        self.refine_position(seek_res)
            .map_err(|e| rodio::source::SeekError::Other(
                Box::new(std::io::Error::new(std::io::ErrorKind::Other, e))
            ))?;

        self.current_frame_offset += to_skip;
        Ok(())
    }
}

// ─── Encoder-gap trimming (iTunSMPB) ─────────────────────────────────────────
//
// MP3/AAC encoders prepend an "encoder delay" (typically 576–2112 silent
// samples for LAME) and append end-padding to fill the final frame.
// iTunes embeds the exact counts in an ID3v2 COMM frame with description
// "iTunSMPB". Format: " 00000000 DELAY PADDING TOTAL ..."  (space-separated hex)
//
// Parsing strategy: scan raw bytes for the ASCII marker, then extract the
// first whitespace-separated hex tokens after it.

struct GaplessInfo {
    delay_samples: u64,
    total_valid_samples: Option<u64>,
}

impl Default for GaplessInfo {
    fn default() -> Self {
        Self { delay_samples: 0, total_valid_samples: None }
    }
}

fn find_subsequence(data: &[u8], needle: &[u8]) -> Option<usize> {
    data.windows(needle.len()).position(|w| w == needle)
}

fn parse_gapless_info(data: &[u8]) -> GaplessInfo {
    let pos = match find_subsequence(data, b"iTunSMPB") {
        Some(p) => p,
        None => return GaplessInfo::default(),
    };

    // In M4A/iTunes files the key is followed by a binary 'data' atom header
    // (16 bytes: size[4] + "data"[4] + type_flags[4] + locale[4]) before the
    // actual value string. Search for the " 00000000 " sentinel that every
    // iTunSMPB value starts with to locate the true start of the text.
    let search_end = data.len().min(pos + 8 + 128);
    let search_window = &data[pos + 8..search_end];
    let value_start = find_subsequence(search_window, b" 00000000 ")
        .map(|off| pos + 8 + off)
        .unwrap_or(pos + 8);

    let tail = &data[value_start..data.len().min(value_start + 256)];
    let text: String = tail.iter()
        .map(|&b| b as char)
        .filter(|c| c.is_ascii_hexdigit() || *c == ' ')
        .collect();

    let parts: Vec<&str> = text.split_whitespace().collect();
    // parts[0] = "00000000", parts[1] = delay, parts[2] = padding, parts[3] = total
    if parts.len() < 3 {
        return GaplessInfo::default();
    }
    let delay = u64::from_str_radix(parts.get(1).unwrap_or(&"0"), 16).unwrap_or(0);
    let padding = u64::from_str_radix(parts.get(2).unwrap_or(&"0"), 16).unwrap_or(0);
    let total_raw = parts.get(3).and_then(|s| u64::from_str_radix(s, 16).ok());

    let total_valid = total_raw.map(|t| t).filter(|&t| t > 0).or_else(|| {
        // Derive from delay + padding if total not available:
        // Not possible without knowing total encoded samples, so just use None.
        let _ = padding;
        None
    });

    GaplessInfo { delay_samples: delay, total_valid_samples: total_valid }
}

/// Result of build_source: the fully-wrapped source plus metadata and control Arcs.
struct BuiltSource {
    source: CountingSource<NotifyingSource<TriggeredFadeOut<EqualPowerFadeIn<EqSource<DynSource>>>>>,
    duration_secs: f64,
    output_rate: u32,
    output_channels: u16,
    /// Trigger for the sample-level crossfade fade-out.
    fadeout_trigger: Arc<AtomicBool>,
    /// Total samples for the fade-out (set before triggering).
    fadeout_samples: Arc<AtomicU64>,
}

/// Build a fully-prepared playback source:
///   decode → trim → resample → EQ → fade-in → triggered-fade-out → notify → count
///
/// `fade_in_dur`:
///   • `Duration::ZERO`          — unity gain; used for gapless chain (no click)
///   • `Duration::from_millis(5)` — micro-fade; used for hard cuts (anti-click)
///   • `Duration::from_secs_f32(cf)` — full equal-power fade-in for crossfade
///
/// `sample_counter`: atomic counter incremented per sample for drift-free position.
/// `target_rate`: canonical output sample rate for resampling (0 = no resampling).
/// `format_hint`: optional file extension (e.g. "flac", "mp3") to help symphonia probe.
fn build_source(
    data: Vec<u8>,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    eq_pre_gain: Arc<AtomicU32>,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    format_hint: Option<&str>,
    hi_res: bool,
) -> Result<BuiltSource, String> {
    let gapless = parse_gapless_info(&data);

    let decoder = SizedDecoder::new(data, format_hint, hi_res)?;
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();

    // Determine effective duration.
    // Prefer hint from Subsonic API (reliable) over decoder (unreliable for VBR MP3).
    let effective_dur = if duration_hint > 1.0 {
        duration_hint
    } else {
        decoder.total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(duration_hint)
    };

    // Apply encoder-delay trim and optional end-padding trim,
    // then resample to the canonical target rate if needed.
    let dyn_src: DynSource = if gapless.delay_samples > 0 || gapless.total_valid_samples.is_some() {
        let delay_dur = Duration::from_secs_f64(
            gapless.delay_samples as f64 / sample_rate as f64
        );
        let base = decoder.convert_samples::<f32>().skip_duration(delay_dur);

        if let Some(total) = gapless.total_valid_samples {
            let valid_dur = Duration::from_secs_f64(total as f64 / sample_rate as f64);
            let trimmed = base.take_duration(valid_dur);
            if target_rate > 0 && sample_rate != target_rate {
                DynSource::new(UniformSourceIterator::new(trimmed, channels, target_rate))
            } else {
                DynSource::new(trimmed)
            }
        } else {
            if target_rate > 0 && sample_rate != target_rate {
                DynSource::new(UniformSourceIterator::new(base, channels, target_rate))
            } else {
                DynSource::new(base)
            }
        }
    } else {
        let converted = decoder.convert_samples::<f32>();
        if target_rate > 0 && sample_rate != target_rate {
            DynSource::new(UniformSourceIterator::new(converted, channels, target_rate))
        } else {
            DynSource::new(converted)
        }
    };

    let output_rate = if target_rate > 0 && sample_rate != target_rate { target_rate } else { sample_rate };

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let eq_src = EqSource::new(dyn_src, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag);
    let counting = CountingSource::new(notifying, sample_counter);

    Ok(BuiltSource {
        source: counting,
        duration_secs: effective_dur,
        output_rate,
        output_channels: channels,
        fadeout_trigger,
        fadeout_samples,
    })
}

/// Streaming variant of `build_source`: uses a live `SizedDecoder` source
/// (non-seekable) and skips iTunSMPB parsing, but preserves the same EQ/fade/
/// counting wrappers and output metadata.
fn build_streaming_source(
    decoder: SizedDecoder,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    eq_pre_gain: Arc<AtomicU32>,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
) -> Result<BuiltSource, String> {
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();

    // For streaming starts prefer server-provided duration when available.
    let effective_dur = if duration_hint > 1.0 {
        duration_hint
    } else {
        decoder
            .total_duration()
            .map(|d| d.as_secs_f64())
            .unwrap_or(duration_hint)
    };

    let converted = decoder.convert_samples::<f32>();
    let dyn_src: DynSource = if target_rate > 0 && sample_rate != target_rate {
        DynSource::new(UniformSourceIterator::new(converted, channels, target_rate))
    } else {
        DynSource::new(converted)
    };

    let output_rate = if target_rate > 0 && sample_rate != target_rate {
        target_rate
    } else {
        sample_rate
    };

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let eq_src = EqSource::new(dyn_src, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag);
    let counting = CountingSource::new(notifying, sample_counter);

    Ok(BuiltSource {
        source: counting,
        duration_secs: effective_dur,
        output_rate,
        output_channels: channels,
        fadeout_trigger,
        fadeout_samples,
    })
}

// ─── Engine state ─────────────────────────────────────────────────────────────

pub(crate) struct PreloadedTrack {
    pub(crate) url: String,
    pub(crate) data: Vec<u8>,
}

/// Info about the track that has been appended (chained) to the current Sink
/// but whose source has not yet started playing (gapless mode only).
pub(crate) struct ChainedInfo {
    /// The URL that was chained — used by audio_play to detect a pre-chain hit.
    url: String,
    /// Raw file bytes (shared with the chained decoder). Lets manual skip reuse
    /// them instead of re-downloading after dropping the Sink queue.
    raw_bytes: Arc<Vec<u8>>,
    duration_secs: f64,
    replay_gain_linear: f32,
    base_volume: f32,
    /// Set by NotifyingSource when this chained track's source is exhausted.
    source_done: Arc<AtomicBool>,
    /// Atomic sample counter for this chained source (swapped into
    /// samples_played on transition).
    sample_counter: Arc<AtomicU64>,
}

pub struct AudioEngine {
    pub stream_handle: Arc<std::sync::Mutex<rodio::OutputStreamHandle>>,
    /// Sample rate the output stream was last opened at (updated on every re-open).
    pub stream_sample_rate: Arc<AtomicU32>,
    /// The rate the device was opened at on cold start — used to restore the
    /// stream when Hi-Res is toggled off while a hi-res rate is active.
    pub device_default_rate: u32,
    /// Sends `(desired_rate, is_hi_res, device_name, reply_tx)` to the audio-stream
    /// thread to re-open the output device. `device_name = None` → system default.
    pub stream_reopen_tx: std::sync::mpsc::SyncSender<(u32, bool, Option<String>, std::sync::mpsc::SyncSender<rodio::OutputStreamHandle>)>,
    /// User-selected output device name (None = follow system default).
    pub selected_device: Arc<Mutex<Option<String>>>,
    pub current: Arc<Mutex<AudioCurrent>>,
    /// Monotonically incremented on each audio_play (non-chain) / audio_stop call.
    pub generation: Arc<AtomicU64>,
    pub http_client: Arc<RwLock<reqwest::Client>>,
    pub eq_gains: Arc<[AtomicU32; 10]>,
    pub eq_enabled: Arc<AtomicBool>,
    pub eq_pre_gain: Arc<AtomicU32>,
    pub(crate) preloaded: Arc<Mutex<Option<PreloadedTrack>>>,
    /// Last fully downloaded manual-stream track bytes (same playback identity),
    /// used to recover seek/replay without waiting for network again.
    pub(crate) stream_completed_cache: Arc<Mutex<Option<PreloadedTrack>>>,
    /// True when the currently playing source supports seeking (in-memory bytes
    /// or `RangedHttpSource`); false for the legacy non-seekable streaming
    /// fallback (`AudioStreamReader`). `audio_seek` rejects with a "not
    /// seekable" error when false so the frontend restart-fallback can engage.
    pub(crate) current_is_seekable: Arc<AtomicBool>,
    pub crossfade_enabled: Arc<AtomicBool>,
    pub crossfade_secs: Arc<AtomicU32>,
    pub fading_out_sink: Arc<Mutex<Option<Arc<Sink>>>>,
    /// When true, audio_play chains sources to the existing Sink instead of
    /// creating a new one, achieving sample-accurate gapless transitions.
    pub gapless_enabled: Arc<AtomicBool>,
    /// Info about the next-up chained track (gapless mode).
    /// The progress task reads this when `current_source_done` fires.
    pub(crate) chained_info: Arc<Mutex<Option<ChainedInfo>>>,
    /// Atomic sample counter — incremented by CountingSource in the audio thread.
    /// Progress task reads this for drift-free position tracking.
    pub samples_played: Arc<AtomicU64>,
    /// Sample rate of the currently playing source (for samples → seconds).
    pub current_sample_rate: Arc<AtomicU32>,
    /// Channel count of the currently playing source.
    pub current_channels: Arc<AtomicU32>,
    /// Instant (as nanos since UNIX epoch via Instant hack) of the last gapless
    /// auto-advance. Commands arriving within 500 ms are rejected as ghost commands.
    pub gapless_switch_at: Arc<AtomicU64>,
    /// Active radio session state.  None for regular (non-radio) tracks.
    /// Dropping the value aborts the HTTP download task via RadioLiveState::Drop.
    pub(crate) radio_state: Mutex<Option<RadioLiveState>>,
}

pub struct AudioCurrent {
    pub sink: Option<Arc<Sink>>,
    pub duration_secs: f64,
    pub seek_offset: f64,
    pub play_started: Option<Instant>,
    pub paused_at: Option<f64>,
    pub replay_gain_linear: f32,
    pub base_volume: f32,
    /// Crossfade: trigger for sample-level fade-out of the current source.
    pub fadeout_trigger: Option<Arc<AtomicBool>>,
    /// Crossfade: total fade samples (set before triggering).
    pub fadeout_samples: Option<Arc<AtomicU64>>,
}

impl AudioCurrent {
    pub fn position(&self) -> f64 {
        if let Some(p) = self.paused_at {
            return p;
        }
        if let Some(t) = self.play_started {
            let elapsed = t.elapsed().as_secs_f64();
            (self.seek_offset + elapsed).min(self.duration_secs.max(0.001))
        } else {
            self.seek_offset
        }
    }
}

/// Open an output device at `desired_rate` Hz (0 = device default).
///
/// `device_name`: exact name from `audio_list_devices`. `None` → system default.
/// Falls back to the system default if the named device is not found.
///
/// Resolution order:
///   1. Exact rate match in the device's supported config ranges.
///   2. Highest available rate (for hardware that doesn't support the source rate).
///   3. Device default.
///   4. System default (last resort).
///
/// Returns `(OutputStream, OutputStreamHandle, actual_sample_rate)`.
fn open_stream_for_device_and_rate(device_name: Option<&str>, desired_rate: u32) -> (rodio::OutputStream, rodio::OutputStreamHandle, u32) {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};

    // Suppress ALSA stderr noise while enumerating devices on Unix.
    #[cfg(unix)]
    let _guard = unsafe {
        struct StderrGuard(i32);
        impl Drop for StderrGuard {
            fn drop(&mut self) { unsafe { libc::dup2(self.0, 2); libc::close(self.0); } }
        }
        let saved = libc::dup(2);
        let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_WRONLY);
        libc::dup2(devnull, 2);
        libc::close(devnull);
        StderrGuard(saved)
    };

    let host = rodio::cpal::default_host();

    // Resolve the target device: explicit name first, then (on Linux) prefer
    // a "pipewire" or "pulse" ALSA alias before falling back to cpal's system
    // default. On PipeWire-based distros the raw ALSA `default` alias can
    // route to a null sink at app-start (issue #234 on Debian 13): the stream
    // opens cleanly, progress ticks run, no audio reaches the user. The
    // named-alias path goes through pipewire-alsa's real sink and just works.
    // On systems where neither alias exists (pure ALSA, macOS, Windows),
    // `find_by_name` returns None and we drop through to `default_output_device`
    // unchanged — no regression.
    let find_by_name = |name: &str| -> Option<_> {
        host.output_devices().ok()?.find(|d| d.name().ok().as_deref() == Some(name))
    };

    let device = device_name
        .and_then(find_by_name)
        .or_else(|| {
            #[cfg(target_os = "linux")]
            { find_by_name("pipewire").or_else(|| find_by_name("pulse")) }
            #[cfg(not(target_os = "linux"))]
            { None }
        })
        .or_else(|| host.default_output_device());

    if let Some(device) = device {
        if desired_rate > 0 {
            if let Ok(supported) = device.supported_output_configs() {
                let configs: Vec<_> = supported.collect();

                // 1. Exact rate match — prefer more channels (stereo > mono).
                let exact = configs.iter()
                    .filter(|c| {
                        c.min_sample_rate().0 <= desired_rate
                            && desired_rate <= c.max_sample_rate().0
                    })
                    .max_by_key(|c| c.channels());

                if let Some(cfg) = exact {
                    let config = cfg.clone()
                        .with_sample_rate(rodio::cpal::SampleRate(desired_rate));
                    if let Ok((stream, handle)) =
                        rodio::OutputStream::try_from_device_config(&device, config)
                    {
                        crate::app_eprintln!("[psysonic] audio stream opened at {} Hz (exact)", desired_rate);
                        return (stream, handle, desired_rate);
                    }
                }

                // 2. No exact match — use the highest supported rate.
                let best = configs.iter()
                    .max_by_key(|c| c.max_sample_rate().0);

                if let Some(cfg) = best {
                    let rate = cfg.max_sample_rate().0;
                    let config = cfg.clone()
                        .with_sample_rate(rodio::cpal::SampleRate(rate));
                    if let Ok((stream, handle)) =
                        rodio::OutputStream::try_from_device_config(&device, config)
                    {
                        crate::app_eprintln!(
                            "[psysonic] audio stream opened at {} Hz (highest, wanted {})",
                            rate, desired_rate
                        );
                        return (stream, handle, rate);
                    }
                }
            }
        }

        // 3. Device default.
        if let Ok((stream, handle)) = rodio::OutputStream::try_from_device(&device) {
            let rate = device
                .default_output_config()
                .map(|c| c.sample_rate().0)
                .unwrap_or(44100);
            crate::app_eprintln!("[psysonic] audio stream opened at {} Hz (device default)", rate);
            return (stream, handle, rate);
        }
    }

    // 4. Last resort: system default.
    crate::app_eprintln!("[psysonic] audio stream falling back to system default");
    let (stream, handle) = rodio::OutputStream::try_default()
        .expect("cannot open any audio output device");
    let rate = rodio::cpal::default_host()
        .default_output_device()
        .and_then(|d| d.default_output_config().ok())
        .map(|c| c.sample_rate().0)
        .unwrap_or(44100);
    (stream, handle, rate)
}

pub fn create_engine() -> (AudioEngine, std::thread::JoinHandle<()>) {
    // macOS: request a smaller CoreAudio buffer to reduce output latency.
    #[cfg(target_os = "macos")]
    {
        if std::env::var("COREAUDIO_BUFFER_SIZE").is_err() {
            std::env::set_var("COREAUDIO_BUFFER_SIZE", "512");
        }
    }

    // Channels: main thread ←→ audio-stream thread.
    //   init_tx/rx : (OutputStreamHandle, actual_rate) sent once at startup.
    //   reopen_tx/rx: (desired_rate, reply_tx) — triggers a stream re-open.
    let (init_tx, init_rx) =
        std::sync::mpsc::sync_channel::<(rodio::OutputStreamHandle, u32)>(0);
    let (reopen_tx, reopen_rx) =
        std::sync::mpsc::sync_channel::<(u32, bool, Option<String>, std::sync::mpsc::SyncSender<rodio::OutputStreamHandle>)>(4);

    let thread = std::thread::Builder::new()
        .name("psysonic-audio-stream".into())
        .spawn(move || {
            // Set PipeWire / PulseAudio latency hints before the first open.
            #[cfg(target_os = "linux")]
            {
                if std::env::var("PIPEWIRE_LATENCY").is_err() {
                    std::env::set_var("PIPEWIRE_LATENCY", "4096/48000");
                }
                if std::env::var("PULSE_LATENCY_MSEC").is_err() {
                    std::env::set_var("PULSE_LATENCY_MSEC", "85");
                }
            }

            // Thread priority is kept at default during standard-mode playback.
            // It is escalated to Max only when a Hi-Res stream reopen is requested,
            // to prevent PipeWire underruns at high quantum sizes (8192 frames).
            let (mut _stream, handle, rate) = open_stream_for_device_and_rate(None, 0);
            init_tx.send((handle, rate)).ok();

            // Keep the stream alive and handle sample-rate / device-switch requests.
            while let Ok((desired_rate, is_hi_res, device_name, reply_tx)) = reopen_rx.recv() {
                // Escalate to Max for Hi-Res reopens (large PipeWire quanta need
                // real-time scheduling to avoid underruns). No escalation for
                // standard mode — the thread blocks on recv() between reopens so
                // elevated priority would only waste scheduler budget.
                if is_hi_res {
                    thread_priority::set_current_thread_priority(
                        thread_priority::ThreadPriority::Max
                    ).ok();
                }

                drop(_stream); // close old stream before opening new one

                // Scale the PipeWire quantum with the sample rate so wall-clock
                // latency stays roughly constant (≈93 ms) at all rates.
                // 8192 frames at 88200 Hz ≈ 92.9 ms (same as 4096 at 48000 Hz).
                #[cfg(target_os = "linux")]
                {
                    let frames: u32 = if desired_rate > 48_000 { 8192 } else { 4096 };
                    std::env::set_var("PIPEWIRE_LATENCY", format!("{frames}/{desired_rate}"));
                    // Keep PULSE_LATENCY_MSEC in sync so PulseAudio-based setups
                    // get the same wall-clock quantum as PipeWire.
                    let latency_ms = (frames as f64 / desired_rate as f64 * 1000.0).round() as u64;
                    std::env::set_var("PULSE_LATENCY_MSEC", latency_ms.to_string());
                }

                let (new_stream, new_handle, _actual) = open_stream_for_device_and_rate(device_name.as_deref(), desired_rate);
                _stream = new_stream;
                reply_tx.send(new_handle).ok();
            }
        })
        .expect("spawn audio stream thread");

    let (initial_handle, initial_rate) = init_rx.recv().expect("audio stream handle");

    let engine = AudioEngine {
        stream_handle: Arc::new(std::sync::Mutex::new(initial_handle)),
        stream_sample_rate: Arc::new(AtomicU32::new(initial_rate)),
        device_default_rate: initial_rate,
        stream_reopen_tx: reopen_tx,
        selected_device: Arc::new(Mutex::new(None)),
        current: Arc::new(Mutex::new(AudioCurrent {
            sink: None,
            duration_secs: 0.0,
            seek_offset: 0.0,
            play_started: None,
            paused_at: None,
            replay_gain_linear: 1.0,
            base_volume: 0.8,
            fadeout_trigger: None,
            fadeout_samples: None,
        })),
        generation: Arc::new(AtomicU64::new(0)),
        http_client: Arc::new(RwLock::new(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .use_rustls_tls()
                .user_agent(crate::subsonic_wire_user_agent())
                .build()
                .unwrap_or_default(),
        )),
        eq_gains: Arc::new(std::array::from_fn(|_| AtomicU32::new(0f32.to_bits()))),
        eq_enabled: Arc::new(AtomicBool::new(false)),
        eq_pre_gain: Arc::new(AtomicU32::new(0f32.to_bits())),
        preloaded: Arc::new(Mutex::new(None)),
        stream_completed_cache: Arc::new(Mutex::new(None)),
        current_is_seekable: Arc::new(AtomicBool::new(true)),
        crossfade_enabled: Arc::new(AtomicBool::new(false)),
        crossfade_secs: Arc::new(AtomicU32::new(3.0f32.to_bits())),
        fading_out_sink: Arc::new(Mutex::new(None)),
        gapless_enabled: Arc::new(AtomicBool::new(false)),
        chained_info: Arc::new(Mutex::new(None)),
        samples_played: Arc::new(AtomicU64::new(0)),
        current_sample_rate: Arc::new(AtomicU32::new(0)),
        current_channels: Arc::new(AtomicU32::new(2)),
        gapless_switch_at: Arc::new(AtomicU64::new(0)),
        radio_state: Mutex::new(None),
    };

    (engine, thread)
}

fn audio_http_client(state: &AudioEngine) -> reqwest::Client {
    state
        .http_client
        .read()
        .map(|c| c.clone())
        .unwrap_or_default()
}

pub fn refresh_http_user_agent(state: &AudioEngine, ua: &str) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .use_rustls_tls()
        .user_agent(ua)
        .build()
        .unwrap_or_default();
    if let Ok(mut slot) = state.http_client.write() {
        *slot = client;
    }
}

// ─── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
    pub current_time: f64,
    pub duration: f64,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Subsonic `buildStreamUrl()` uses a fresh random salt on every call, so two
/// URLs for the same track differ in `t`/`s` query params. Compare a stable key.
fn playback_identity(url: &str) -> Option<String> {
    if let Some(path) = url.strip_prefix("psysonic-local://") {
        return Some(format!("local:{path}"));
    }
    if !url.contains("stream.view") {
        return None;
    }
    let q = url.split('?').nth(1)?;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("id=") {
            let v = v.split('&').next().unwrap_or(v);
            return Some(format!("stream:{v}"));
        }
    }
    None
}

fn same_playback_target(a_url: &str, b_url: &str) -> bool {
    match (playback_identity(a_url), playback_identity(b_url)) {
        (Some(a), Some(b)) => a == b,
        _ => a_url == b_url,
    }
}

/// Take (consume) completed manual-stream bytes if they correspond to `url`.
pub(crate) fn take_stream_completed_for_url(state: &AudioEngine, url: &str) -> Option<Vec<u8>> {
    let mut guard = state.stream_completed_cache.lock().unwrap();
    if guard
        .as_ref()
        .is_some_and(|p| same_playback_target(&p.url, url))
    {
        return guard.take().map(|p| p.data);
    }
    None
}

/// Fetch track bytes from the preload cache or via HTTP.
async fn fetch_data(
    url: &str,
    state: &AudioEngine,
    gen: u64,
    app: &AppHandle,
) -> Result<Option<Vec<u8>>, String> {
    // Check completed streamed-track cache first (manual streaming fallback cache).
    let streamed_cached = {
        let mut streamed = state.stream_completed_cache.lock().unwrap();
        if streamed.as_ref().is_some_and(|p| same_playback_target(&p.url, url)) {
            streamed.take().map(|p| p.data)
        } else {
            None
        }
    };
    if let Some(data) = streamed_cached {
        return Ok(Some(data));
    }

    // Check preload cache next.
    let cached = {
        let mut preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, url)) {
            preloaded.take().map(|p| p.data)
        } else {
            None
        }
    };

    if let Some(data) = cached {
        return Ok(Some(data));
    }

    // Offline cache — local file written by download_track_offline.
    if let Some(path) = url.strip_prefix("psysonic-local://") {
        let data = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        return Ok(Some(data));
    }

    let response = audio_http_client(&state).get(url).send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let ct = response.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    let server_hdr = response.headers()
        .get("server")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    // Strip auth params from URL before logging.
    let safe_url = url.split('?').next().unwrap_or(url);
    crate::app_deprintln!(
        "[audio] fetch {} → {} | content-type: {} | server: {}",
        safe_url, status, ct, server_hdr
    );
    if !response.status().is_success() {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded
        }
        let status = response.status().as_u16();
        let msg = format!("HTTP {status}");
        app.emit("audio:error", &msg).ok();
        return Err(msg);
    }
    // Stream the body, checking gen between chunks so a rapid manual skip can
    // abort a superseded download mid-flight and free bandwidth for the new one.
    let hint = response.content_length().unwrap_or(0) as usize;
    let mut stream = response.bytes_stream();
    let mut data = Vec::with_capacity(hint);
    while let Some(chunk) = stream.next().await {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded — abort
        }
        data.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
    }
    Ok(Some(data))
}

/// -1 dB headroom applied at full scale to prevent inter-sample clipping.
/// Modern masters are often at 0 dBFS; the EQ biquad chain and resampler
/// can produce inter-sample peaks slightly above ±1.0 → audible distortion.
/// 10^(-1/20) ≈ 0.891 — inaudible volume difference, eliminates clipping.
const MASTER_HEADROOM: f32 = 0.891_254;

fn compute_gain(
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    volume: f32,
) -> (f32, f32) {
    let gain_linear = replay_gain_db
        .map(|db| 10f32.powf((db + pre_gain_db) / 20.0))
        .unwrap_or_else(|| 10f32.powf(fallback_db / 20.0));
    let peak = replay_gain_peak.unwrap_or(1.0).max(0.001);
    let gain_linear = gain_linear.min(1.0 / peak);
    let effective = (volume.clamp(0.0, 1.0) * gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
    (gain_linear, effective)
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn audio_play(
    url: String,
    volume: f32,
    duration_hint: f64,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    manual: bool, // true = user-initiated skip → bypass crossfade, start immediately
    hi_res_enabled: bool, // false = safe 44.1 kHz mode; true = native rate (alpha)
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let gapless = state.gapless_enabled.load(Ordering::Relaxed);

    // ── Ghost-command guard ───────────────────────────────────────────────────
    // After a gapless auto-advance, the frontend may fire a stale playTrack()
    // call via IPC. If we're within 500 ms of the last gapless switch AND the
    // requested URL matches the already-playing chained track, reject it.
    {
        let switch_ms = state.gapless_switch_at.load(Ordering::SeqCst);
        if switch_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now_ms.saturating_sub(switch_ms) < 500 {
                // Within the guard window — suppress this ghost command.
                return Ok(());
            }
        }
    }

    // ── Gapless pre-chain hit ─────────────────────────────────────────────────
    // audio_chain_preload already appended this URL to the Sink 30 s in
    // advance. The source is live in the queue — just return and let the
    // progress task handle the state transition when the previous source ends.
    //
    // Never for manual skips: the UI already jumped to this track in JS, but
    // the current source is still playing until the chain drains. User-initiated
    // play must clear the chain and start this URL immediately (standard path).
    if gapless && !manual {
        let already_chained = state.chained_info.lock().unwrap()
            .as_ref()
            .map(|c| same_playback_target(&c.url, &url))
            .unwrap_or(false);
        if already_chained {
            return Ok(());
        }
    }

    // ── Standard (new-sink) path ─────────────────────────────────────────────
    // Used for: manual skip, gapless OFF, first play, or gapless when the
    // proactive chain was not set up in time.

    // Bump generation first so the old progress task stops before we peel
    // chained_info (avoids a race where it sees current_done + empty chain).
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Manual skip onto the gapless-pre-chained track: reuse raw bytes (no HTTP;
    // preload cache was already consumed when the chain was built). Otherwise
    // clear any stale chain metadata.
    let reuse_chained_bytes: Option<Vec<u8>> = if gapless && manual {
        let mut ci = state.chained_info.lock().unwrap();
        if ci.as_ref().is_some_and(|c| same_playback_target(&c.url, &url)) {
            ci.take().map(|info| {
                Arc::try_unwrap(info.raw_bytes).unwrap_or_else(|a| (*a).clone())
            })
        } else {
            *ci = None;
            None
        }
    } else {
        *state.chained_info.lock().unwrap() = None;
        None
    };

    // Stop fading-out sink from previous crossfade.
    if let Some(old) = state.fading_out_sink.lock().unwrap().take() {
        old.stop();
    }

    // Extract format hint from URL for better symphonia probing. Strip the
    // query string first so Subsonic-style URLs (`stream.view?...&v=1.16.1&...`)
    // don't latch onto random query-param substrings; only accept short
    // alphanumeric tails that look like an actual audio extension.
    let format_hint = url
        .split('?').next()
        .and_then(|path| path.rsplit('.').next())
        .filter(|ext| {
            (1..=5).contains(&ext.len())
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "mp3" | "flac" | "ogg" | "oga" | "opus" | "m4a" | "mp4"
                    | "aac" | "wav" | "wave" | "ape" | "wv" | "webm" | "mka"
                )
        })
        .map(|s| s.to_lowercase());

    enum PlayInput {
        Bytes(Vec<u8>),
        /// Seekable on-demand source — `RangedHttpSource` for HTTP streams,
        /// `LocalFileSource` for `psysonic-local://` files. Goes through
        /// `build_streaming_source` (no iTunSMPB scan, since we don't have the
        /// bytes in memory; chained-track gapless trim still applies via the
        /// re-played `Bytes` path on the next start).
        SeekableMedia {
            reader: Box<dyn MediaSource>,
            format_hint: Option<String>,
            tag: &'static str,
        },
        Streaming {
            reader: AudioStreamReader,
            format_hint: Option<String>,
        },
    }

    // Data source selection:
    // 1) Reused chained bytes (manual skip onto pre-chained track)
    // 2) `psysonic-local://` (offline / hot cache hit) → LocalFileSource (instant)
    // 3) Manual uncached remote start:
    //    a) Server supports Range + Content-Length → seekable RangedHttpSource
    //    b) Server does not → legacy non-seekable AudioStreamReader fallback
    // 4) Preloaded/streamed-cache hit → in-memory bytes via fetch_data
    let play_input = if let Some(d) = reuse_chained_bytes {
        PlayInput::Bytes(d)
    } else {
        let stream_cache_hit = {
            let streamed = state.stream_completed_cache.lock().unwrap();
            streamed
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, &url))
        };
        let preloaded_hit = {
            let preloaded = state.preloaded.lock().unwrap();
            preloaded
                .as_ref()
                .is_some_and(|p| same_playback_target(&p.url, &url))
        };
        let is_local = url.starts_with("psysonic-local://");

        if is_local && !stream_cache_hit && !preloaded_hit {
            let path = url.strip_prefix("psysonic-local://").unwrap();
            let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let local_hint = std::path::Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase());
            crate::app_deprintln!(
                "[stream] LocalFileSource selected — size={} KB, hint={:?}",
                len / 1024,
                local_hint
            );
            let reader = LocalFileSource { file, len };
            PlayInput::SeekableMedia {
                reader: Box::new(reader),
                format_hint: local_hint,
                tag: "local-file",
            }
        } else if manual && !stream_cache_hit && !preloaded_hit && !is_local {
            let response = audio_http_client(&state).get(&url).send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                if state.generation.load(Ordering::SeqCst) != gen {
                    return Ok(()); // superseded
                }
                let status = response.status().as_u16();
                let msg = format!("HTTP {status}");
                app.emit("audio:error", &msg).ok();
                return Err(msg);
            }

            let stream_hint = content_type_to_hint(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or(""),
            ).or_else(|| format_hint.clone());

            let supports_range = response.headers()
                .get(reqwest::header::ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.to_ascii_lowercase().contains("bytes"));
            let total_size = response.content_length();

            if let (true, Some(total)) = (supports_range, total_size) {
                let total_usize = total as usize;
                crate::app_deprintln!(
                    "[stream] RangedHttpSource selected — total={} KB, hint={:?}",
                    total_usize / 1024,
                    stream_hint
                );
                let buf = Arc::new(Mutex::new(vec![0u8; total_usize]));
                let downloaded_to = Arc::new(AtomicUsize::new(0));
                let done = Arc::new(AtomicBool::new(false));
                tokio::spawn(ranged_download_task(
                    gen,
                    state.generation.clone(),
                    audio_http_client(&state),
                    url.clone(),
                    response,
                    buf.clone(),
                    downloaded_to.clone(),
                    done.clone(),
                    state.stream_completed_cache.clone(),
                ));
                let reader = RangedHttpSource {
                    buf,
                    downloaded_to,
                    total_size: total,
                    pos: 0,
                    done,
                    gen_arc: state.generation.clone(),
                    gen,
                };
                PlayInput::SeekableMedia {
                    reader: Box::new(reader),
                    format_hint: stream_hint,
                    tag: "ranged-stream",
                }
            } else {
                crate::app_deprintln!(
                    "[stream] legacy AudioStreamReader (non-seekable) — accept-ranges={}, content-length={:?}",
                    supports_range, total_size
                );
                let buffer_cap = total_size
                    .map(|n| n as usize)
                    .unwrap_or(TRACK_STREAM_MIN_BUF_CAPACITY)
                    .clamp(TRACK_STREAM_MIN_BUF_CAPACITY, TRACK_STREAM_MAX_BUF_CAPACITY);
                let rb = HeapRb::<u8>::new(buffer_cap);
                let (prod, cons) = rb.split();
                let done = Arc::new(AtomicBool::new(false));
                tokio::spawn(track_download_task(
                    gen,
                    state.generation.clone(),
                    audio_http_client(&state),
                    url.clone(),
                    response,
                    prod,
                    done.clone(),
                    state.stream_completed_cache.clone(),
                ));

                let (_new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapConsumer<u8>>();
                let reader = AudioStreamReader {
                    cons,
                    new_cons_rx: Mutex::new(new_cons_rx),
                    deadline: std::time::Instant::now()
                        + Duration::from_secs(RADIO_READ_TIMEOUT_SECS),
                    gen_arc: state.generation.clone(),
                    gen,
                    source_tag: "track-stream",
                    eof_when_empty: Some(done),
                    pos: 0,
                };
                PlayInput::Streaming {
                    reader,
                    format_hint: stream_hint,
                }
            }
        } else {
            let data = fetch_data(&url, &state, gen, &app).await?;
            let data = match data {
                Some(d) => d,
                None => return Ok(()), // superseded while downloading
            };
            PlayInput::Bytes(data)
        }
    };

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let (gain_linear, effective_volume) = compute_gain(replay_gain_db, replay_gain_peak, pre_gain_db, fallback_db, volume);

    // Manual skips (user-initiated) bypass crossfade — the track should start immediately.
    let crossfade_enabled = state.crossfade_enabled.load(Ordering::Relaxed) && !manual;
    let crossfade_secs_val = f32::from_bits(state.crossfade_secs.load(Ordering::Relaxed)).clamp(0.5, 12.0);

    // Measure how much audio Track A actually has left right now.
    // By the time audio_play is called, near_end_ticks (2×500ms) + IPC latency
    // have consumed ~500–800ms from Track A's tail — so its true remaining time
    // is always less than crossfade_secs_val.  Using the measured remaining time
    // for BOTH fade-out (Track A) and fade-in (Track B) keeps them in sync and
    // guarantees Track A reaches 0 exactly when its source exhausts.
    let actual_fade_secs: f32 = if crossfade_enabled {
        let cur = state.current.lock().unwrap();
        let remaining = (cur.duration_secs - cur.position()) as f32;
        remaining.clamp(0.1, crossfade_secs_val)
    } else {
        0.0
    };

    // Fade-in duration for Track B:
    //   crossfade → equal-power sin(t·π/2) over actual remaining time of Track A
    //   hard cut  → 5 ms micro-fade to suppress DC-offset click
    let fade_in_dur = if crossfade_enabled {
        Duration::from_secs_f32(actual_fade_secs)
    } else {
        Duration::from_millis(5)
    };

    // Build source: decode → trim → resample → EQ → fade-in → fade-out → notify → count.
    let done_flag = Arc::new(AtomicBool::new(false));
    // Reset sample counter for the new track.
    state.samples_played.store(0, Ordering::Relaxed);
    // Always 0 — no application-level resampling. Rodio handles conversion to
    // the output device rate internally; we let every track play at its native rate.
    let target_rate: u32 = 0;
    let mut new_is_seekable = true;
    let built = match play_input {
        PlayInput::Bytes(data) => build_source(
            data,
            duration_hint,
            state.eq_gains.clone(),
            state.eq_enabled.clone(),
            state.eq_pre_gain.clone(),
            done_flag.clone(),
            fade_in_dur,
            state.samples_played.clone(),
            target_rate,
            format_hint.as_deref(),
            hi_res_enabled,
        ),
        PlayInput::SeekableMedia { reader, format_hint, tag } => {
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(reader, format_hint.as_deref(), tag)
            })
            .await
            .map_err(|e| e.to_string())??;

            build_streaming_source(
                decoder,
                duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                done_flag.clone(),
                fade_in_dur,
                state.samples_played.clone(),
                target_rate,
            )
        }
        PlayInput::Streaming { reader, format_hint } => {
            new_is_seekable = false;
            let decoder = tokio::task::spawn_blocking(move || {
                SizedDecoder::new_streaming(Box::new(reader), format_hint.as_deref(), "track-stream")
            })
            .await
            .map_err(|e| e.to_string())??;

            build_streaming_source(
                decoder,
                duration_hint,
                state.eq_gains.clone(),
                state.eq_enabled.clone(),
                state.eq_pre_gain.clone(),
                done_flag.clone(),
                fade_in_dur,
                state.samples_played.clone(),
                target_rate,
            )
        }
    }.map_err(|e| { app.emit("audio:error", &e).ok(); e })?;
    state.current_is_seekable.store(new_is_seekable, Ordering::SeqCst);
    let source = built.source;
    let duration_secs = built.duration_secs;
    let output_rate = built.output_rate;
    let output_channels = built.output_channels;

    // Store the actual output rate/channels for position calculation.
    state.current_sample_rate.store(output_rate, Ordering::Relaxed);
    state.current_channels.store(output_channels as u32, Ordering::Relaxed);

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    // ── Stream rate management ────────────────────────────────────────────────
    // Hi-Res ON:  open device at file's native rate (bit-perfect, no resampler).
    // Hi-Res OFF: if the stream was previously opened at a hi-res rate (e.g. the
    //             toggle was just turned off mid-session), restore the device
    //             default rate so playback is no longer at 88.2/96 kHz etc.
    //             If already at the device default — skip entirely (no IPC, no
    //             PipeWire reconfigure, no scheduler cost).
    {
        let current_stream_rate = state.stream_sample_rate.load(Ordering::Relaxed);
        let target_rate = if hi_res_enabled {
            output_rate   // native file rate
        } else {
            state.device_default_rate  // restore device default
        };
        let needs_switch = target_rate > 0 && target_rate != current_stream_rate;
        if needs_switch {
            let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);
            let dev = state.selected_device.lock().unwrap().clone();
            if state.stream_reopen_tx.send((target_rate, hi_res_enabled, dev, reply_tx)).is_ok() {
                match reply_rx.recv_timeout(std::time::Duration::from_secs(5)) {
                    Ok(new_handle) => {
                        *state.stream_handle.lock().unwrap() = new_handle;
                        state.stream_sample_rate.store(target_rate, Ordering::Relaxed);
                        // Give PipeWire time to reconfigure at the new rate before
                        // we open a Sink — only needed for large hi-res quanta.
                        if hi_res_enabled && target_rate > 48_000 {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                        }
                    }
                    Err(_) => {
                        crate::app_eprintln!("[psysonic] stream rate switch timed out, keeping {current_stream_rate} Hz");
                    }
                }
            }
        }

        // Re-check gen: a rapid skip during the settle sleep would have bumped it.
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(());
        }
    }

    let sink = Arc::new(Sink::try_new(&*state.stream_handle.lock().unwrap()).map_err(|e| e.to_string())?);
    sink.set_volume(effective_volume);

    // ── Sink pre-fill for hi-res tracks ──────────────────────────────────────
    // At sample rates > 48 kHz the hardware quantum is larger and the first
    // period demands more decoded frames than at 44.1/48 kHz.
    // Strategy: pause the sink before appending so rodio's internal mixer
    // decodes into its ring buffer ahead of the hardware. After a short delay
    // we resume — the buffer is already full and the hardware gets its frames
    // without an underrun on the very first period.
    // Standard mode: no pre-fill needed — default 44.1/48 kHz quantum is small.
    let needs_prefill = hi_res_enabled && output_rate > 48_000;
    if needs_prefill {
        sink.pause();
    }

    // Gapless OFF: prepend a short silence so tracks are clearly separated.
    // Only when this is an auto-advance (near end), not on manual skip.
    if !gapless {
        let cur_pos = {
            let cur = state.current.lock().unwrap();
            cur.position()
        };
        let cur_dur = {
            let cur = state.current.lock().unwrap();
            cur.duration_secs
        };
        let is_auto_advance = cur_dur > 3.0 && cur_pos >= cur_dur - 3.0;
        if is_auto_advance {
            let silence = rodio::source::Zero::<f32>::new(
                source.channels(),
                source.sample_rate(),
            ).take_duration(Duration::from_millis(500));
            sink.append(silence);
        }
    }

    sink.append(source);

    if needs_prefill {
        // 500 ms lets rodio decode several seconds of hi-res audio into its
        // internal buffer while the sink is paused. The hardware sees no gap
        // because the output is held — it only starts draining after sink.play().
        // 500 ms gives ~5 quanta of headroom at 8192-frame/88200 Hz quantum size,
        // absorbing scheduler jitter and PipeWire graph wake-up latency.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(()); // skipped during pre-fill — abort silently
        }
        sink.play();
    }

    // Atomically swap sinks — extract old sink + its fade-out trigger.
    let (old_sink, old_fadeout_trigger, old_fadeout_samples) = {
        let mut cur = state.current.lock().unwrap();
        let old = cur.sink.take();
        let old_fo_trigger = cur.fadeout_trigger.take();
        let old_fo_samples = cur.fadeout_samples.take();
        cur.sink = Some(sink);
        cur.duration_secs = duration_secs;
        cur.seek_offset = 0.0;
        cur.play_started = Some(Instant::now());
        cur.paused_at = None;
        cur.replay_gain_linear = gain_linear;
        cur.base_volume = volume.clamp(0.0, 1.0);
        cur.fadeout_trigger = Some(built.fadeout_trigger);
        cur.fadeout_samples = Some(built.fadeout_samples);
        (old, old_fo_trigger, old_fo_samples)
    };

    // Handle old sink: symmetric crossfade or immediate stop.
    if crossfade_enabled {
        if let Some(old) = old_sink {
            // Trigger sample-level fade-out on Track A via TriggeredFadeOut.
            // Calculate total fade samples from the measured actual_fade_secs.
            let rate = state.current_sample_rate.load(Ordering::Relaxed);
            let ch = state.current_channels.load(Ordering::Relaxed);
            let fade_total = (actual_fade_secs as f64 * rate as f64 * ch as f64) as u64;

            if let (Some(trigger), Some(samples)) = (old_fadeout_trigger, old_fadeout_samples) {
                samples.store(fade_total.max(1), Ordering::SeqCst);
                trigger.store(true, Ordering::SeqCst);
            }

            // Keep old sink alive until the fade completes + small margin,
            // then drop it. No volume stepping needed — the fade-out runs
            // at sample level inside the audio thread.
            *state.fading_out_sink.lock().unwrap() = Some(old);
            let fo_arc = state.fading_out_sink.clone();
            let cleanup_dur = Duration::from_secs_f32(actual_fade_secs + 0.5);
            tokio::spawn(async move {
                tokio::time::sleep(cleanup_dur).await;
                if let Some(s) = fo_arc.lock().unwrap().take() {
                    s.stop();
                }
            });
        }
    } else if let Some(old) = old_sink {
        old.stop();
    }

    app.emit("audio:playing", duration_secs).ok();

    // ── Progress + ended detection ────────────────────────────────────────────
    spawn_progress_task(
        gen,
        state.generation.clone(),
        state.current.clone(),
        state.chained_info.clone(),
        state.crossfade_enabled.clone(),
        state.crossfade_secs.clone(),
        done_flag,
        app,
        state.samples_played.clone(),
        state.current_sample_rate.clone(),
        state.current_channels.clone(),
        state.gapless_switch_at.clone(),
    );

    Ok(())
}

/// Proactively appends the next track to the current Sink ~30 s before the
/// current track ends. Called from JS at the same trigger point as preload.
///
/// Because this runs well before the track boundary, the IPC round-trip is
/// irrelevant — by the time the current track actually ends, the next source
/// is already live in the Sink queue and rodio transitions at sample accuracy.
///
/// audio_play() checks chained_info.url on arrival: if it matches, it returns
/// immediately without touching the Sink (pure no-op on the audio path).
#[tauri::command]
pub async fn audio_chain_preload(
    url: String,
    volume: f32,
    duration_hint: f64,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    hi_res_enabled: bool,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    // Idempotent: already chained this track → nothing to do.
    {
        let chained = state.chained_info.lock().unwrap();
        if chained.as_ref().is_some_and(|c| same_playback_target(&c.url, &url)) {
            return Ok(());
        }
    }

    // Gapless must be enabled and a sink must exist.
    if !state.gapless_enabled.load(Ordering::Relaxed) {
        return Ok(());
    }

    let snapshot_gen = state.generation.load(Ordering::SeqCst);

    // Fetch bytes — use preload cache if available, otherwise HTTP.
    let data: Vec<u8> = {
        let cached = {
            let mut preloaded = state.preloaded.lock().unwrap();
            if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, &url)) {
                preloaded.take().map(|p| p.data)
            } else {
                None
            }
        };
        if let Some(d) = cached {
            d
        } else {
            if let Some(path) = url.strip_prefix("psysonic-local://") {
                tokio::fs::read(path).await.map_err(|e| e.to_string())?
            } else {
                let resp = audio_http_client(&state).get(&url).send().await
                    .map_err(|e| e.to_string())?;
                if !resp.status().is_success() {
                    return Ok(()); // silently fail — audio_play will retry
                }
                let hint = resp.content_length().unwrap_or(0) as usize;
                let mut stream = resp.bytes_stream();
                let mut buf = Vec::with_capacity(hint);
                while let Some(chunk) = stream.next().await {
                    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
                        return Ok(()); // superseded by manual skip — abort download
                    }
                    buf.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
                }
                buf
            }
        }
    };

    // Bail if the user skipped to a different track while we were downloading.
    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
        return Ok(());
    }

    let raw_bytes = Arc::new(data);

    // Only `gain_linear` is needed — `effective_volume` is intentionally NOT
    // applied to the Sink here. `audio_chain_preload` runs ~30 s before the
    // current track ends, and `Sink::set_volume` affects the WHOLE Sink (incl.
    // the still-playing current source). Volume for the chained track is
    // applied at the gapless transition in `spawn_progress_task`, not here.
    let (gain_linear, _effective_volume) = compute_gain(replay_gain_db, replay_gain_peak, pre_gain_db, fallback_db, volume);

    let done_next = Arc::new(AtomicBool::new(false));
    // Use a dedicated counter for the chained source — it will be swapped into
    // samples_played when the chained track becomes active.
    let chain_counter = Arc::new(AtomicU64::new(0));
    // Always 0 — no application-level resampling (same as audio_play).
    let target_rate: u32 = 0;
    let format_hint = url.rsplit('.').next()
        .and_then(|ext| ext.split('?').next())
        .map(|s| s.to_lowercase());
    let built = build_source(
        (*raw_bytes).clone(),
        duration_hint,
        state.eq_gains.clone(),
        state.eq_enabled.clone(),
        state.eq_pre_gain.clone(),
        done_next.clone(),
        Duration::ZERO, // gapless: no fade-in — sample-accurate boundary, no click
        chain_counter.clone(),
        target_rate,
        format_hint.as_deref(),
        hi_res_enabled,
    ).map_err(|e| e.to_string())?;
    let source = built.source;
    let duration_secs = built.duration_secs;

    // Final gen check — reject if a manual skip happened during decode.
    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
        return Ok(());
    }

    // In hi-res mode: if the next track's native rate differs from the current
    // output stream, we cannot chain gaplessly — audio_play will do a hard cut
    // with a stream re-open. Store raw bytes to avoid re-downloading.
    // In safe mode (44.1 kHz locked): the stream rate is always 44100, so the
    // chain proceeds and rodio resamples internally — no bail needed.
    let next_rate = if hi_res_enabled { built.output_rate } else { 44_100 };
    let stream_rate = state.stream_sample_rate.load(Ordering::Relaxed);
    if hi_res_enabled && stream_rate > 0 && next_rate != stream_rate {
        crate::app_eprintln!(
            "[psysonic] gapless chain skipped: next track rate {} Hz ≠ stream {} Hz",
            next_rate, stream_rate
        );
        *state.preloaded.lock().unwrap() = Some(PreloadedTrack {
            url,
            data: Arc::try_unwrap(raw_bytes).unwrap_or_else(|a| (*a).clone()),
        });
        return Ok(());
    }

    // Append to the existing Sink. The audio hardware stream never stalls.
    // Note: `set_volume` is deliberately NOT called here (see comment above).
    {
        let cur = state.current.lock().unwrap();
        match &cur.sink {
            Some(sink) => {
                sink.append(source);
            }
            None => return Ok(()), // playback stopped — bail
        }
    }

    *state.chained_info.lock().unwrap() = Some(ChainedInfo {
        url,
        raw_bytes,
        duration_secs,
        replay_gain_linear: gain_linear,
        base_volume: volume.clamp(0.0, 1.0),
        source_done: done_next,
        sample_counter: chain_counter,
    });

    Ok(())
}

/// Spawns the per-generation progress + ended-detection task.
///
/// The task owns a local `done: Arc<AtomicBool>` reference that starts as
/// the current track's done flag. When the progress task detects that the
/// done flag is set AND `chained_info` has data, it swaps `done` to the
/// chained source's flag and transitions state — all without creating a new
/// task or changing the generation counter.
///
/// Key changes from the previous implementation:
///   • 100 ms tick (was 500 ms) — halves worst-case event latency
///   • Position from atomic sample counter (no wall-clock drift)
///   • Immediate `audio:track_switched` event at decoder boundary
///   • `audio:ended` only fires when no chained successor exists
fn spawn_progress_task(
    gen: u64,
    gen_counter: Arc<AtomicU64>,
    current_arc: Arc<Mutex<AudioCurrent>>,
    chained_arc: Arc<Mutex<Option<ChainedInfo>>>,
    crossfade_enabled_arc: Arc<AtomicBool>,
    crossfade_secs_arc: Arc<AtomicU32>,
    initial_done: Arc<AtomicBool>,
    app: AppHandle,
    samples_played: Arc<AtomicU64>,
    sample_rate_arc: Arc<AtomicU32>,
    channels_arc: Arc<AtomicU32>,
    gapless_switch_at: Arc<AtomicU64>,
) {
    tokio::spawn(async move {
        let mut near_end_ticks: u32 = 0;
        // Local done-flag reference; swapped on gapless transition.
        let mut current_done = initial_done;
        // Local sample counter; swapped to chained source's counter on transition.
        let mut samples_played = samples_played;

        loop {
            // 100 ms tick keeps near-end detection timely for crossfade/gapless
            // handoff while frontend still interpolates smoothly via rAF.
            tokio::time::sleep(Duration::from_millis(100)).await;

            if gen_counter.load(Ordering::SeqCst) != gen {
                break;
            }

            // ── Gapless transition detection ─────────────────────────────────
            // If the current source is exhausted AND we have a chained track
            // ready, transition seamlessly: swap tracking state, emit
            // audio:track_switched for the new track, and continue the loop.
            if current_done.load(Ordering::SeqCst) {
                // Radio (dur == 0): stream exhausted / connection dropped → stop.
                let cur_dur = current_arc.lock().unwrap().duration_secs;
                if cur_dur <= 0.0 {
                    crate::app_eprintln!("[radio] current_done fired → emitting audio:ended (dur=0)");
                    gen_counter.fetch_add(1, Ordering::SeqCst);
                    app.emit("audio:ended", ()).ok();
                    break;
                }

                let chained = chained_arc.lock().unwrap().take();
                if let Some(info) = chained {
                    // Swap to the chained source's done flag.
                    current_done = info.source_done;

                    // Swap to the chained source's sample counter.
                    // The chained CountingSource increments its own Arc,
                    // so we must rebind our local reference to it —
                    // a one-time value copy would go stale immediately.
                    samples_played = info.sample_counter;

                    // Update tracking state and apply the chained track's
                    // effective volume. Deferred from `audio_chain_preload`
                    // (which runs ~30 s before the current track ends) to
                    // avoid changing loudness of the still-playing current
                    // track. `Sink::set_volume` affects the whole Sink, so it
                    // must only be called at the boundary, not at preload.
                    {
                        let mut cur = current_arc.lock().unwrap();
                        cur.replay_gain_linear = info.replay_gain_linear;
                        cur.base_volume = info.base_volume;
                        cur.duration_secs = info.duration_secs;
                        cur.seek_offset = 0.0;
                        cur.play_started = Some(Instant::now());
                        if let Some(sink) = &cur.sink {
                            let effective = (cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0);
                            sink.set_volume(effective);
                        }
                    }

                    // Record the gapless switch timestamp for ghost-command guard.
                    let switch_ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    gapless_switch_at.store(switch_ts, Ordering::SeqCst);

                    // Emit the new track_switched event — this is immediate,
                    // not delayed by 500 ms like the old audio:playing was.
                    app.emit("audio:track_switched", info.duration_secs).ok();
                    near_end_ticks = 0;
                    continue;
                }
                // Current source exhausted but no chain queued — the Sink is
                // likely draining; audio:ended will fire on the next tick via
                // the near-end logic below.
            }

            // ── Position from atomic sample counter ──────────────────────────
            let rate = sample_rate_arc.load(Ordering::Relaxed) as f64;
            let ch = channels_arc.load(Ordering::Relaxed) as f64;
            let samples = samples_played.load(Ordering::Relaxed) as f64;
            let divisor = (rate * ch).max(1.0);

            let dur = {
                let cur = current_arc.lock().unwrap();
                cur.duration_secs
            };
            let is_paused = {
                let cur = current_arc.lock().unwrap();
                cur.paused_at.is_some()
            };

            let pos = if is_paused {
                let cur = current_arc.lock().unwrap();
                cur.paused_at.unwrap_or(0.0)
            } else {
                (samples / divisor).min(dur.max(0.001))
            };

            app.emit("audio:progress", ProgressPayload { current_time: pos, duration: dur }).ok();

            if is_paused {
                continue;
            }

            let cf_enabled = crossfade_enabled_arc.load(Ordering::Relaxed);
            let cf_secs = f32::from_bits(crossfade_secs_arc.load(Ordering::Relaxed)).clamp(0.5, 12.0) as f64;
            let end_threshold = if cf_enabled { cf_secs.max(1.0) } else { 1.0 };

            if dur > end_threshold && pos >= dur - end_threshold {
                near_end_ticks += 1;
                // At 100 ms ticks, 10 ticks ≈ 1 s — equivalent to the old 2×500ms.
                if near_end_ticks >= 10 {
                    // If a gapless chain is pending, the source hasn't
                    // exhausted yet — duration_hint (integer seconds from
                    // Subsonic) is shorter than the actual audio content.
                    // Don't emit audio:ended; let the gapless transition
                    // handle it when current_done fires.
                    let has_chain = chained_arc.lock().unwrap().is_some();
                    if has_chain {
                        continue;
                    }
                    gen_counter.fetch_add(1, Ordering::SeqCst);
                    app.emit("audio:ended", ()).ok();
                    break;
                }
            } else {
                near_end_ticks = 0;
            }
        }
    });
}

#[tauri::command]
pub fn audio_pause(state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if !sink.is_paused() {
            let pos = cur.position();
            sink.pause();
            cur.paused_at    = Some(pos);
            cur.play_started = None;
        }
    }
    // Notify the download task so it can start measuring the hard-pause stall timer.
    if let Some(rs) = state.radio_state.lock().unwrap().as_ref() {
        rs.flags.is_paused.store(true, Ordering::Release);
    }
}

/// Resume playback.
///
/// **Warm resume** (`is_hard_paused = false`): download task is still running,
/// buffer has buffered audio.  `sink.play()` suffices.
///
/// **Cold resume** (`is_hard_paused = true`): TCP was dropped.  A fresh 4 MB
/// ring buffer is created, its consumer is sent to `AudioStreamReader` (which
/// swaps it in on the next `read()`), and a new download task is spawned.
#[tauri::command]
pub async fn audio_resume(state: State<'_, AudioEngine>, app: AppHandle) -> Result<(), String> {
    // Detect radio hard-disconnect.
    let reconnect_info = {
        let guard = state.radio_state.lock().unwrap();
        guard
            .as_ref()
            .filter(|rs| rs.flags.is_hard_paused.load(Ordering::Acquire))
            .map(|rs| (rs.url.clone(), rs.gen, rs.flags.clone()))
    };

    if let Some((url, gen, flags)) = reconnect_info {
        let rb = HeapRb::<u8>::new(RADIO_BUF_CAPACITY);
        let (new_prod, new_cons) = rb.split();

        // Send new consumer to AudioStreamReader (non-blocking; unbounded channel).
        let ok = flags.new_cons_tx.lock().unwrap().send(new_cons).is_ok();

        if ok {
            let new_task = tokio::spawn(radio_download_task(
                gen,
                state.generation.clone(),
                None, // task performs its own fresh GET
                audio_http_client(&state),
                url,
                new_prod,
                flags.clone(),
                app,
            ));
            if let Some(rs) = state.radio_state.lock().unwrap().as_mut() {
                let old = std::mem::replace(&mut rs.task, new_task);
                old.abort(); // ensure any lingering old task is gone
                rs.flags.is_hard_paused.store(false, Ordering::Release);
                rs.flags.is_paused.store(false, Ordering::Release);
            }
        } else {
            crate::app_eprintln!("[radio] resume: AudioStreamReader gone — skipping reconnect");
        }
    }

    // Resume the rodio Sink (works for both warm and cold resume).
    {
        let mut cur = state.current.lock().unwrap();
        if let Some(sink) = &cur.sink {
            if sink.is_paused() {
                let pos = cur.paused_at.unwrap_or(cur.seek_offset);
                sink.play();
                cur.seek_offset  = pos;
                cur.play_started = Some(Instant::now());
                cur.paused_at    = None;
            }
        }
    }
    if let Some(rs) = state.radio_state.lock().unwrap().as_ref() {
        rs.flags.is_paused.store(false, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn audio_stop(state: State<'_, AudioEngine>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.chained_info.lock().unwrap() = None;
    *state.stream_completed_cache.lock().unwrap() = None;
    // Drop RadioLiveState → triggers Drop → task.abort() → TCP released.
    drop(state.radio_state.lock().unwrap().take());
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() { sink.stop(); }
    cur.duration_secs = 0.0;
    cur.seek_offset   = 0.0;
    cur.play_started  = None;
    cur.paused_at     = None;
}

#[tauri::command]
pub fn audio_seek(seconds: f64, state: State<'_, AudioEngine>) -> Result<(), String> {
    const AUDIO_SEEK_TIMEOUT_MS: u64 = 700;
    const AUDIO_SEEK_LOCK_TIMEOUT_MS: u64 = 40;
    // Ghost-command guard: reject seeks within 500 ms of a gapless auto-advance.
    {
        let switch_ms = state.gapless_switch_at.load(Ordering::SeqCst);
        if switch_ms > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            if now_ms.saturating_sub(switch_ms) < 500 {
                return Ok(());
            }
        }
    }

    // Reject seek up-front for non-seekable streaming sources so the frontend's
    // restart-fallback engages instead of rolling the dice on the format reader
    // (which can consume the ring buffer to EOF for forward seeks → next song).
    if !state.current_is_seekable.load(Ordering::SeqCst) {
        crate::app_deprintln!("[seek] rejected → not-seekable source (legacy stream)");
        return Err("source is not seekable".into());
    }
    crate::app_deprintln!("[seek] target={:.2}s", seconds);

    let lock_current_with_timeout = |timeout_ms: u64| {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            match state.current.try_lock() {
                Ok(guard) => break Ok(guard),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        break Err("audio seek busy".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(TryLockError::Poisoned(_)) => {
                    break Err("audio state lock poisoned".to_string());
                }
            }
        }
    };

    // Seeking back invalidates any pending gapless chain.
    let cur_pos = {
        let cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
        cur.position()
    };
    if seconds < cur_pos - 1.0 {
        *state.chained_info.lock().unwrap() = None;
    }

    let seek_seconds = seconds.max(0.0);
    let seek_duration = Duration::from_secs_f64(seek_seconds);
    let seek_generation = state.generation.load(Ordering::SeqCst);
    let sink = {
        let cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
        match cur.sink.as_ref() {
            Some(sink) => Arc::clone(sink),
            None => return Ok(()),
        }
    };

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = sink.try_seek(seek_duration).map_err(|e| e.to_string());
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_millis(AUDIO_SEEK_TIMEOUT_MS)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            return Err("audio seek timeout".into());
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            return Err("audio seek worker disconnected".into());
        }
    }

    // If playback switched while seek was in flight, skip timestamp updates.
    if state.generation.load(Ordering::SeqCst) != seek_generation {
        return Ok(());
    }

    let mut cur = lock_current_with_timeout(AUDIO_SEEK_LOCK_TIMEOUT_MS)?;
    if cur.sink.is_none() { return Ok(()); }

    if cur.paused_at.is_some() {
        cur.paused_at = Some(seek_seconds);
    } else {
        cur.seek_offset = seek_seconds;
        cur.play_started = Some(Instant::now());
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(volume: f32, state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        sink.set_volume((cur.base_volume * cur.replay_gain_linear * MASTER_HEADROOM).clamp(0.0, 1.0));
    }
}

#[tauri::command]
pub fn audio_update_replay_gain(
    volume: f32,
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    pre_gain_db: f32,
    fallback_db: f32,
    state: State<'_, AudioEngine>,
) {
    let (gain_linear, effective) = compute_gain(replay_gain_db, replay_gain_peak, pre_gain_db, fallback_db, volume);
    let mut cur = state.current.lock().unwrap();
    cur.replay_gain_linear = gain_linear;
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        sink.set_volume(effective);
    }
}

/// Proxy: fetches https://autoeq.app/entries via Rust to bypass WebView CORS restrictions.
#[tauri::command]
pub async fn autoeq_entries(state: State<'_, AudioEngine>) -> Result<String, String> {
    audio_http_client(&state)
        .get("https://autoeq.app/entries")
        .send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())
}

/// Fetches the AutoEQ FixedBandEQ profile for a specific headphone from GitHub raw content.
///
/// Directory layout in the AutoEQ repo:
///   results/{source}/{form}/{name}/{name} FixedBandEQ.txt           (most sources)
///   results/{source}/{rig} {form}/{name}/{name} FixedBandEQ.txt     (crinacle — rig-prefixed dir)
///
/// We try the rig-prefixed path first (when rig is present), then fall back to form-only.
#[tauri::command]
pub async fn autoeq_fetch_profile(
    name: String,
    source: String,
    rig: Option<String>,
    form: String,
    state: State<'_, AudioEngine>,
) -> Result<String, String> {
    let base = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results";
    let filename = format!("{} FixedBandEQ.txt", name);

    let candidates: Vec<String> = if let Some(ref r) = rig {
        vec![
            format!("{}/{}/{} {}/{}/{}", base, source, r, form, name, filename),
            format!("{}/{}/{}/{}/{}", base, source, form, name, filename),
        ]
    } else {
        vec![format!("{}/{}/{}/{}/{}", base, source, form, name, filename)]
    };

    for url in &candidates {
        let resp = audio_http_client(&state).get(url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return resp.text().await.map_err(|e| e.to_string());
        }
    }

    Err(format!("FixedBandEQ profile not found for '{}'", name))
}

#[tauri::command]
pub fn audio_set_eq(gains: [f32; 10], enabled: bool, pre_gain: f32, state: State<'_, AudioEngine>) {
    state.eq_enabled.store(enabled, Ordering::Relaxed);
    state.eq_pre_gain.store(pre_gain.clamp(-30.0, 6.0).to_bits(), Ordering::Relaxed);
    for (i, &gain) in gains.iter().enumerate() {
        state.eq_gains[i].store(gain.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn audio_preload(
    url: String,
    duration_hint: f64,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    {
        let preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().is_some_and(|p| same_playback_target(&p.url, &url)) {
            let _ = app.emit("audio:preload-ready", url.clone());
            return Ok(());
        }
    }
    // Throttle: wait 8 s before starting the background download so it does not
    // compete with the decode + sink-feed work of the just-started current track.
    // If the user skips during the wait the generation counter changes and we abort.
    let gen_snapshot = state.generation.load(Ordering::Relaxed);
    tokio::time::sleep(Duration::from_secs(8)).await;
    if state.generation.load(Ordering::Relaxed) != gen_snapshot {
        return Ok(());
    }
    let data: Vec<u8> = if let Some(path) = url.strip_prefix("psysonic-local://") {
        tokio::fs::read(path).await.map_err(|e| e.to_string())?
    } else {
        let response = audio_http_client(&state).get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Ok(());
        }
        response.bytes().await.map_err(|e| e.to_string())?.into()
    };
    let _ = duration_hint; // kept in API for compatibility
    let url_for_emit = url.clone();
    *state.preloaded.lock().unwrap() = Some(PreloadedTrack { url, data });
    let _ = app.emit("audio:preload-ready", url_for_emit);
    Ok(())
}

/// Play a live internet radio stream.
///
/// Sends `Icy-MetaData: 1` to request inline ICY metadata.
/// Emits `audio:playing` with `duration = 0.0` (sentinel for live stream)
/// and `radio:metadata` whenever the StreamTitle changes.
#[tauri::command]
pub async fn audio_play_radio(
    url: String,
    volume: f32,
    app: AppHandle,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Abort any previous radio task before stopping the sink.
    drop(state.radio_state.lock().unwrap().take());

    *state.chained_info.lock().unwrap() = None;
    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.sink.take() { old.stop(); }
    }
    if let Some(old) = state.fading_out_sink.lock().unwrap().take() { old.stop(); }

    // ── Open initial HTTP connection ──────────────────────────────────────────
    let response = audio_http_client(&state)
        .get(&url)
        .header("Icy-MetaData", "1")
        .send()
        .await
        .map_err(|e| {
            let m = format!("radio: connection failed: {e}");
            app.emit("audio:error", &m).ok();
            m
        })?;

    if !response.status().is_success() {
        let m = format!("radio: HTTP {}", response.status());
        app.emit("audio:error", &m).ok();
        return Err(m);
    }

    let fmt_hint = content_type_to_hint(
        response.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );

    // ── Build 4 MB lock-free SPSC ring buffer ─────────────────────────────────
    let rb = HeapRb::<u8>::new(RADIO_BUF_CAPACITY);
    let (prod, cons) = rb.split();

    let (new_cons_tx, new_cons_rx) = std::sync::mpsc::channel::<HeapConsumer<u8>>();
    let flags = Arc::new(RadioSharedFlags {
        is_paused:      AtomicBool::new(false),
        is_hard_paused: AtomicBool::new(false),
        new_cons_tx:    Mutex::new(new_cons_tx),
    });

    // ── Spawn download task ───────────────────────────────────────────────────
    let task = tokio::spawn(radio_download_task(
        gen,
        state.generation.clone(),
        Some(response),
        audio_http_client(&state),
        url.clone(),
        prod,
        flags.clone(),
        app.clone(),
    ));

    *state.radio_state.lock().unwrap() = Some(RadioLiveState {
        url:  url.clone(),
        gen,
        task,
        flags: flags.clone(),
    });

    // ── Build Symphonia decoder in a blocking thread ──────────────────────────
    let reader = AudioStreamReader {
        cons,
        new_cons_rx: Mutex::new(new_cons_rx),
        deadline: std::time::Instant::now() + Duration::from_secs(RADIO_READ_TIMEOUT_SECS),
        gen_arc:  state.generation.clone(),
        gen,
        source_tag: "radio",
        eof_when_empty: None,
        pos: 0,
    };

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let hint_clone = fmt_hint.clone();
    let decoder = tokio::task::spawn_blocking(move || {
        SizedDecoder::new_streaming(Box::new(reader), hint_clone.as_deref(), "radio")
    })
    .await
    .map_err(|e| e.to_string())??;

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let sample_rate     = decoder.sample_rate();
    let channels        = decoder.channels();
    let done_flag       = Arc::new(AtomicBool::new(false));
    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));
    state.samples_played.store(0, Ordering::Relaxed);

    // Radio: no gapless trim, no ReplayGain, 5 ms fade-in to suppress click.
    let dyn_src   = DynSource::new(decoder.convert_samples::<f32>());
    let eq_src    = EqSource::new(dyn_src, state.eq_gains.clone(),
                                  state.eq_enabled.clone(), state.eq_pre_gain.clone());
    let fade_in   = EqualPowerFadeIn::new(eq_src, Duration::from_millis(5));
    let fade_out  = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    let notifying = NotifyingSource::new(fade_out, done_flag.clone());
    let counting  = CountingSource::new(notifying, state.samples_played.clone());

    if state.generation.load(Ordering::SeqCst) != gen { return Ok(()); }

    let sink = Arc::new(Sink::try_new(&*state.stream_handle.lock().unwrap()).map_err(|e| e.to_string())?);
    sink.set_volume((volume.clamp(0.0, 1.0) * MASTER_HEADROOM).clamp(0.0, 1.0));
    sink.append(counting);

    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.sink.take() { old.stop(); }
        cur.sink              = Some(sink);
        cur.duration_secs     = 0.0; // sentinel: live stream
        cur.seek_offset       = 0.0;
        cur.play_started      = Some(Instant::now());
        cur.paused_at         = None;
        cur.replay_gain_linear = 1.0;
        cur.base_volume       = volume.clamp(0.0, 1.0);
        cur.fadeout_trigger   = Some(fadeout_trigger);
        cur.fadeout_samples   = Some(fadeout_samples);
    }

    state.current_sample_rate.store(sample_rate, Ordering::Relaxed);
    state.current_channels.store(channels as u32, Ordering::Relaxed);

    app.emit("audio:playing", 0.0f64).ok();

    spawn_progress_task(
        gen,
        state.generation.clone(),
        state.current.clone(),
        state.chained_info.clone(),
        state.crossfade_enabled.clone(),
        state.crossfade_secs.clone(),
        done_flag,
        app,
        state.samples_played.clone(),
        state.current_sample_rate.clone(),
        state.current_channels.clone(),
        state.gapless_switch_at.clone(),
    );

    Ok(())
}

/// ALSA probes noisy plugins during device queries — suppress stderr on Unix.
#[cfg(unix)]
fn with_suppressed_alsa_stderr<R>(f: impl FnOnce() -> R) -> R {
    struct StderrGuard(i32);
    impl Drop for StderrGuard {
        fn drop(&mut self) {
            unsafe { libc::dup2(self.0, 2); libc::close(self.0); }
        }
    }
    let _guard = unsafe {
        let saved = libc::dup(2);
        let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_WRONLY);
        libc::dup2(devnull, 2);
        libc::close(devnull);
        StderrGuard(saved)
    };
    f()
}

#[cfg(not(unix))]
#[inline]
fn with_suppressed_alsa_stderr<R>(f: impl FnOnce() -> R) -> R {
    f()
}

fn enumerate_output_device_names() -> Vec<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.output_devices()
            .map(|iter| iter.filter_map(|d| d.name().ok()).collect())
            .unwrap_or_default()
    })
}

/// Linux ALSA-style cpal names: same physical sink can appear with different suffixes;
/// busy devices are sometimes omitted from `output_devices()` while playback works.
#[cfg(target_os = "linux")]
fn linux_alsa_sink_fingerprint(name: &str) -> Option<(String, String, u32)> {
    const IFACES: &[&str] = &[
        "hdmi", "hw", "plughw", "sysdefault", "iec958", "front", "dmix", "surround40",
        "surround51", "surround71",
    ];
    let colon = name.find(':')?;
    let iface = name[..colon].to_ascii_lowercase();
    if !IFACES.iter().any(|&i| i == iface.as_str()) {
        return None;
    }
    let card = name.split("CARD=").nth(1)?.split(',').next()?.to_string();
    let dev = name
        .split("DEV=")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Some((iface, card, dev))
}

#[cfg(not(target_os = "linux"))]
#[inline]
fn linux_alsa_sink_fingerprint(_name: &str) -> Option<(String, String, u32)> {
    None
}

fn output_devices_logically_same(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (
        linux_alsa_sink_fingerprint(a),
        linux_alsa_sink_fingerprint(b),
    ) {
        (Some(fa), Some(fb)) => fa == fb,
        _ => false,
    }
}

/// True if `pinned` is the same sink as some entry (exact or Linux ALSA logical match).
fn output_enumeration_includes_pinned(available: &[String], pinned: &str) -> bool {
    available
        .iter()
        .any(|d| output_devices_logically_same(d, pinned))
}

/// If the pinned id is missing from cpal's list but another listed id is the same
/// physical sink (e.g. suffix drift), rewrite `selected_device` to the listed form.
#[tauri::command]
pub fn audio_canonicalize_selected_device(state: State<'_, AudioEngine>) -> Option<String> {
    let pinned = state.selected_device.lock().unwrap().clone()?;
    if pinned.is_empty() {
        return None;
    }
    let list = enumerate_output_device_names();
    if list.iter().any(|d| d == &pinned) {
        return None;
    }
    let canon = list
        .iter()
        .find(|d| output_devices_logically_same(d, &pinned))?
        .clone();
    *state.selected_device.lock().unwrap() = Some(canon.clone());
    Some(canon)
}

/// Same device list as [`audio_list_devices`] without the Tauri `State` wrapper (CLI / single-instance).
pub fn audio_list_devices_for_engine(engine: &AudioEngine) -> Vec<String> {
    let mut list = enumerate_output_device_names();
    if let Some(ref name) = *engine.selected_device.lock().unwrap() {
        if !name.is_empty() && !output_enumeration_includes_pinned(&list, name) {
            list.push(name.clone());
        }
    }
    list
}

/// Returns the names of all available audio output devices on the current host.
/// On Linux, ALSA probes unavailable backends (JACK, OSS, dmix) and prints errors to
/// stderr. We suppress fd 2 for the duration of enumeration to keep the terminal clean.
///
/// The user-pinned device name is appended when cpal omits it (e.g. HDMI busy while
/// streaming) so the Settings dropdown still matches `audioOutputDevice`.
#[tauri::command]
pub fn audio_list_devices(state: State<'_, AudioEngine>) -> Vec<String> {
    audio_list_devices_for_engine(&state)
}

/// Device id string for the host default output (matches an entry from `audio_list_devices` when present).
#[tauri::command]
pub fn audio_default_output_device_name() -> Option<String> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    with_suppressed_alsa_stderr(|| {
        let host = rodio::cpal::default_host();
        host.default_output_device().and_then(|d| d.name().ok())
    })
}

/// Switch the audio output device. `device_name = null` → follow system default.
/// Reopens the stream immediately; frontend must restart playback via audio:device-changed.
#[tauri::command]
pub async fn audio_set_device(
    device_name: Option<String>,
    state: State<'_, AudioEngine>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    *state.selected_device.lock().unwrap() = device_name.clone();

    let rate = state.stream_sample_rate.load(Ordering::Relaxed);
    let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);
    state.stream_reopen_tx
        .send((rate, false, device_name, reply_tx))
        .map_err(|e| e.to_string())?;

    let new_handle = tauri::async_runtime::spawn_blocking(move || {
        reply_rx.recv_timeout(Duration::from_secs(5)).ok()
    }).await.unwrap_or(None).ok_or("device open timed out")?;

    *state.stream_handle.lock().unwrap() = new_handle;

    // Drop active sinks — they were bound to the old stream.
    if let Some(s) = state.current.lock().unwrap().sink.take() { s.stop(); }
    if let Some(s) = state.fading_out_sink.lock().unwrap().take() { s.stop(); }

    app.emit("audio:device-changed", ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn audio_set_crossfade(enabled: bool, secs: f32, state: State<'_, AudioEngine>) {
    state.crossfade_enabled.store(enabled, Ordering::Relaxed);
    state.crossfade_secs.store(secs.clamp(0.1, 12.0).to_bits(), Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_set_gapless(enabled: bool, state: State<'_, AudioEngine>) {
    state.gapless_enabled.store(enabled, Ordering::Relaxed);
}

// ─── Device-change watcher ────────────────────────────────────────────────────
//
// Polls every 3 s for two conditions:
//   1. System default device changed (Bluetooth, USB DAC plug/unplug) while no
//      device is pinned → reopen on new default, emit audio:device-changed.
//   2. (macOS / Windows only) User-pinned device disappeared from cpal's list →
//      fall back to system default, clear selected_device, emit audio:device-reset.
//      Linux: case 2 is disabled — ALSA/cpal often omit the active sink from
//      enumeration while streaming, which caused false resets to system default.


pub fn start_device_watcher(engine: &AudioEngine, app: tauri::AppHandle) {
    let reopen_tx       = engine.stream_reopen_tx.clone();
    let stream_handle   = engine.stream_handle.clone();
    let stream_rate     = engine.stream_sample_rate.clone();
    let current         = engine.current.clone();
    let fading_out      = engine.fading_out_sink.clone();
    let selected_device = engine.selected_device.clone();

    tauri::async_runtime::spawn(async move {
        let mut last_default: Option<String> = tauri::async_runtime::spawn_blocking(|| {
            use rodio::cpal::traits::{DeviceTrait, HostTrait};
            rodio::cpal::default_host()
                .default_output_device()
                .and_then(|d| d.name().ok())
        }).await.unwrap_or(None);

        // macOS/Windows: consecutive polls where a pinned device is absent from cpal's list.
        #[cfg(not(target_os = "linux"))]
        let mut pinned_miss_count: u32 = 0;

        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            // Enumerate all available output devices and the current default.
            // Suppress stderr on Unix to avoid ALSA probing noise (JACK, OSS, dmix).
            let (current_default, available) = tauri::async_runtime::spawn_blocking(|| {
                use rodio::cpal::traits::{DeviceTrait, HostTrait};
                #[cfg(unix)]
                let _guard = unsafe {
                    struct StderrGuard(i32);
                    impl Drop for StderrGuard {
                        fn drop(&mut self) { unsafe { libc::dup2(self.0, 2); libc::close(self.0); } }
                    }
                    let saved = libc::dup(2);
                    let devnull = libc::open(b"/dev/null\0".as_ptr() as *const libc::c_char, libc::O_WRONLY);
                    libc::dup2(devnull, 2);
                    libc::close(devnull);
                    StderrGuard(saved)
                };
                let host = rodio::cpal::default_host();
                let default = host.default_output_device().and_then(|d| d.name().ok());
                let available: Vec<String> = host
                    .output_devices()
                    .map(|iter| iter.filter_map(|d| d.name().ok()).collect())
                    .unwrap_or_default();
                (default, available)
            }).await.unwrap_or((None, vec![]));

            // Empty list almost always means a transient enumeration failure, not
            // that every output device vanished. Treating it as "pinned missing"
            // caused false audio:device-reset (UI jumped back to system default)
            // when switching to external USB / class-compliant interfaces.
            if available.is_empty() {
                continue;
            }

            let pinned = selected_device.lock().unwrap().clone();

            #[cfg(target_os = "linux")]
            if pinned.is_some() {
                // Do not infer "unplugged" from `output_devices()` when a device is pinned.
                // ALSA/cpal often omit the active HDMI/USB sink from enumeration for the
                // whole session — any miss counter eventually tripped audio:device-reset.
                // Clearing the pin is left to the user (Settings → System Default) or
                // to a future explicit error signal from the output stream.
                continue;
            }

            // ── Case 2 (non-Linux): pinned device disappeared from enumeration ─
            #[cfg(not(target_os = "linux"))]
            if let Some(ref dev_name) = pinned {
                if !output_enumeration_includes_pinned(&available, dev_name) {
                    pinned_miss_count += 1;
                    if pinned_miss_count < 3 {
                        continue;
                    }
                    crate::app_eprintln!("[psysonic] device-watcher: pinned device '{dev_name}' disconnected, falling back to system default");
                    pinned_miss_count = 0;
                    *selected_device.lock().unwrap() = None;

                    tokio::time::sleep(Duration::from_millis(500)).await;

                    let rate = stream_rate.load(Ordering::Relaxed);
                    let reopen_tx2 = reopen_tx.clone();
                    let new_handle = tauri::async_runtime::spawn_blocking(move || {
                        let (reply_tx, reply_rx) =
                            std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);
                        if reopen_tx2.send((rate, false, None, reply_tx)).is_err() {
                            return None;
                        }
                        reply_rx.recv_timeout(Duration::from_secs(5)).ok()
                    }).await.unwrap_or(None);

                    if let Some(handle) = new_handle {
                        *stream_handle.lock().unwrap() = handle;
                        if let Some(s) = current.lock().unwrap().sink.take() { s.stop(); }
                        if let Some(s) = fading_out.lock().unwrap().take()   { s.stop(); }
                        app.emit("audio:device-reset", ()).ok();
                    }

                    last_default = current_default;
                } else {
                    pinned_miss_count = 0;
                }
                continue;
            }

            // ── Case 1: no pinned device, system default changed ──────────────
            if current_default == last_default {
                continue;
            }

            last_default = current_default.clone();

            let Some(_new_name) = current_default else { continue };

            // Debounce: give the OS time to finish configuring the new device.
            tokio::time::sleep(Duration::from_millis(500)).await;

            let rate = stream_rate.load(Ordering::Relaxed);
            let reopen_tx2 = reopen_tx.clone();
            let new_handle = tauri::async_runtime::spawn_blocking(move || {
                let (reply_tx, reply_rx) =
                    std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);
                if reopen_tx2.send((rate, false, None, reply_tx)).is_err() {
                    return None;
                }
                reply_rx.recv_timeout(Duration::from_secs(5)).ok()
            }).await.unwrap_or(None);

            let Some(handle) = new_handle else {
                crate::app_eprintln!("[psysonic] device-watcher: stream reopen timed out");
                continue;
            };

            *stream_handle.lock().unwrap() = handle;
            if let Some(s) = current.lock().unwrap().sink.take() { s.stop(); }
            if let Some(s) = fading_out.lock().unwrap().take()   { s.stop(); }
            app.emit("audio:device-changed", ()).ok();
        }
    });
}

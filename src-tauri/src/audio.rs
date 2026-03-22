use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use biquad::{Biquad, Coefficients, DirectForm2Transposed, ToHertz, Type as FilterType};
use rodio::{Decoder, Sink, Source};
use rodio::source::UniformSourceIterator;
use serde::Serialize;
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
    filters: [[DirectForm2Transposed<f32>; 2]; 10],
    current_gains: [f32; 10],
    sample_counter: usize,
    channel_idx: usize,
}

impl<S: Source<Item = f32>> EqSource<S> {
    fn new(inner: S, gains: Arc<[AtomicU32; 10]>, enabled: Arc<AtomicBool>) -> Self {
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
            inner, sample_rate, channels, gains, enabled,
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

        let mut s = sample;
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
        // Restart the fade envelope after seeking (avoids a mid-song click if
        // the user seeks to the very beginning while a fade was in progress).
        self.sample_count = 0;
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
        // Reset counter to the sought position in samples.
        let samples = (pos.as_secs_f64() * self.inner.sample_rate() as f64
            * self.inner.channels() as f64) as u64;
        self.counter.store(samples, Ordering::Relaxed);
        self.inner.try_seek(pos)
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

    // Collect printable ASCII bytes after the tag (skip nulls / control chars)
    let tail = &data[pos + 8..data.len().min(pos + 8 + 256)];
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
fn build_source(
    data: Vec<u8>,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
) -> Result<BuiltSource, String> {
    let gapless = parse_gapless_info(&data);

    let cursor = Cursor::new(data);
    let decoder = Decoder::new(cursor).map_err(|e| e.to_string())?;
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

    let eq_src = EqSource::new(dyn_src, eq_gains, eq_enabled);
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
    url: String,
    data: Vec<u8>,
}

/// Info about the track that has been appended (chained) to the current Sink
/// but whose source has not yet started playing (gapless mode only).
pub(crate) struct ChainedInfo {
    /// The URL that was chained — used by audio_play to detect a pre-chain hit.
    url: String,
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
    pub stream_handle: Arc<rodio::OutputStreamHandle>,
    pub current: Arc<Mutex<AudioCurrent>>,
    /// Monotonically incremented on each audio_play (non-chain) / audio_stop call.
    pub generation: Arc<AtomicU64>,
    pub http_client: reqwest::Client,
    pub eq_gains: Arc<[AtomicU32; 10]>,
    pub eq_enabled: Arc<AtomicBool>,
    pub preloaded: Arc<Mutex<Option<PreloadedTrack>>>,
    pub crossfade_enabled: Arc<AtomicBool>,
    pub crossfade_secs: Arc<AtomicU32>,
    pub fading_out_sink: Arc<Mutex<Option<Sink>>>,
    /// When true, audio_play chains sources to the existing Sink instead of
    /// creating a new one, achieving sample-accurate gapless transitions.
    pub gapless_enabled: Arc<AtomicBool>,
    /// Info about the next-up chained track (gapless mode).
    /// The progress task reads this when `current_source_done` fires.
    pub chained_info: Arc<Mutex<Option<ChainedInfo>>>,
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
}

pub struct AudioCurrent {
    pub sink: Option<Sink>,
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

pub fn create_engine() -> (AudioEngine, std::thread::JoinHandle<()>) {
    let (tx, rx) = std::sync::mpsc::sync_channel::<rodio::OutputStreamHandle>(0);

    // Request a larger audio buffer from PipeWire/PulseAudio to reduce ALSA underruns.
    // Only set if the user hasn't already configured these themselves.
    // PIPEWIRE_LATENCY: 4096 frames / 48000 Hz ≈ 85 ms — enough to absorb scheduler jitter.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("PIPEWIRE_LATENCY").is_err() {
            std::env::set_var("PIPEWIRE_LATENCY", "4096/48000");
        }
        if std::env::var("PULSE_LATENCY_MSEC").is_err() {
            std::env::set_var("PULSE_LATENCY_MSEC", "85");
        }
    }

    // macOS: request a smaller CoreAudio buffer to reduce output latency.
    // Smaller buffers = lower latency between decoded samples and DAC output,
    // which tightens the gap between actual audio and UI event delivery.
    #[cfg(target_os = "macos")]
    {
        if std::env::var("COREAUDIO_BUFFER_SIZE").is_err() {
            std::env::set_var("COREAUDIO_BUFFER_SIZE", "512");
        }
    }

    let thread = std::thread::Builder::new()
        .name("psysonic-audio-stream".into())
        .spawn(move || match rodio::OutputStream::try_default() {
            Ok((_stream, handle)) => {
                tx.send(handle).ok();
                loop { std::thread::park(); }
            }
            Err(e) => { eprintln!("[psysonic] audio output error: {e}"); }
        })
        .expect("spawn audio stream thread");

    let stream_handle = rx.recv().expect("audio stream handle");

    let engine = AudioEngine {
        stream_handle: Arc::new(stream_handle),
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
        http_client: reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default(),
        eq_gains: Arc::new(std::array::from_fn(|_| AtomicU32::new(0f32.to_bits()))),
        eq_enabled: Arc::new(AtomicBool::new(false)),
        preloaded: Arc::new(Mutex::new(None)),
        crossfade_enabled: Arc::new(AtomicBool::new(false)),
        crossfade_secs: Arc::new(AtomicU32::new(3.0f32.to_bits())),
        fading_out_sink: Arc::new(Mutex::new(None)),
        gapless_enabled: Arc::new(AtomicBool::new(false)),
        chained_info: Arc::new(Mutex::new(None)),
        samples_played: Arc::new(AtomicU64::new(0)),
        current_sample_rate: Arc::new(AtomicU32::new(44100)),
        current_channels: Arc::new(AtomicU32::new(2)),
        gapless_switch_at: Arc::new(AtomicU64::new(0)),
    };

    (engine, thread)
}

// ─── Event payloads ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
    pub current_time: f64,
    pub duration: f64,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Fetch track bytes from the preload cache or via HTTP.
async fn fetch_data(
    url: &str,
    state: &AudioEngine,
    gen: u64,
    app: &AppHandle,
) -> Result<Option<Vec<u8>>, String> {
    // Check preload cache first.
    let cached = {
        let mut preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().map(|p| p.url == url).unwrap_or(false) {
            preloaded.take().map(|p| p.data)
        } else {
            None
        }
    };

    if let Some(data) = cached {
        return Ok(Some(data));
    }

    let response = state.http_client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded
        }
        let status = response.status().as_u16();
        let msg = format!("HTTP {status}");
        app.emit("audio:error", &msg).ok();
        return Err(msg);
    }
    let data: Vec<u8> = response.bytes().await.map_err(|e| e.to_string())?.into();
    Ok(Some(data))
}

fn compute_gain(
    replay_gain_db: Option<f32>,
    replay_gain_peak: Option<f32>,
    volume: f32,
) -> (f32, f32) {
    let gain_linear = replay_gain_db
        .map(|db| 10f32.powf(db / 20.0))
        .unwrap_or(1.0);
    let peak = replay_gain_peak.unwrap_or(1.0).max(0.001);
    let gain_linear = gain_linear.min(1.0 / peak);
    let effective = (volume.clamp(0.0, 1.0) * gain_linear).clamp(0.0, 1.0);
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
    if gapless {
        let already_chained = state.chained_info.lock().unwrap()
            .as_ref()
            .map(|c| c.url == url)
            .unwrap_or(false);
        if already_chained {
            return Ok(());
        }
    }

    // ── Standard (new-sink) path ─────────────────────────────────────────────
    // Used for: manual skip, gapless OFF, first play, or gapless when the
    // proactive chain was not set up in time.

    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Cancel any pending chain (manual skip while gapless chain was set up).
    *state.chained_info.lock().unwrap() = None;

    // Stop fading-out sink from previous crossfade.
    if let Some(old) = state.fading_out_sink.lock().unwrap().take() {
        old.stop();
    }

    // Fetch bytes (may use preload cache).
    let data = match fetch_data(&url, &state, gen, &app).await? {
        Some(d) => d,
        None => return Ok(()), // superseded while downloading
    };

    if state.generation.load(Ordering::SeqCst) != gen {
        return Ok(());
    }

    let (gain_linear, effective_volume) = compute_gain(replay_gain_db, replay_gain_peak, volume);

    let crossfade_enabled = state.crossfade_enabled.load(Ordering::Relaxed);
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
    let target_rate = state.current_sample_rate.load(Ordering::Relaxed);
    let built = build_source(
        data,
        duration_hint,
        state.eq_gains.clone(),
        state.eq_enabled.clone(),
        done_flag.clone(),
        fade_in_dur,
        state.samples_played.clone(),
        target_rate,
    ).map_err(|e| { app.emit("audio:error", &e).ok(); e })?;
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

    let sink = Sink::try_new(&*state.stream_handle).map_err(|e| e.to_string())?;
    sink.set_volume(effective_volume);

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
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    // Idempotent: already chained this URL → nothing to do.
    {
        let chained = state.chained_info.lock().unwrap();
        if chained.as_ref().map(|c| c.url == url).unwrap_or(false) {
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
            if preloaded.as_ref().map(|p| p.url == url).unwrap_or(false) {
                preloaded.take().map(|p| p.data)
            } else {
                None
            }
        };
        if let Some(d) = cached {
            d
        } else {
            let resp = state.http_client.get(&url).send().await
                .map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                return Ok(()); // silently fail — audio_play will retry
            }
            resp.bytes().await.map_err(|e| e.to_string())?.into()
        }
    };

    // Bail if the user skipped to a different track while we were downloading.
    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
        return Ok(());
    }

    let (gain_linear, effective_volume) = compute_gain(replay_gain_db, replay_gain_peak, volume);

    let done_next = Arc::new(AtomicBool::new(false));
    // Use a dedicated counter for the chained source — it will be swapped into
    // samples_played when the chained track becomes active.
    let chain_counter = Arc::new(AtomicU64::new(0));
    let target_rate = state.current_sample_rate.load(Ordering::Relaxed);
    let built = build_source(
        data,
        duration_hint,
        state.eq_gains.clone(),
        state.eq_enabled.clone(),
        done_next.clone(),
        Duration::ZERO, // gapless: no fade-in — sample-accurate boundary, no click
        chain_counter.clone(),
        target_rate,
    ).map_err(|e| e.to_string())?;
    let source = built.source;
    let duration_secs = built.duration_secs;

    // Final gen check — reject if a manual skip happened during decode.
    if state.generation.load(Ordering::SeqCst) != snapshot_gen {
        return Ok(());
    }

    // Append to the existing Sink. The audio hardware stream never stalls.
    {
        let cur = state.current.lock().unwrap();
        match &cur.sink {
            Some(sink) => {
                sink.set_volume(effective_volume);
                sink.append(source);
            }
            None => return Ok(()), // playback stopped — bail
        }
    }

    *state.chained_info.lock().unwrap() = Some(ChainedInfo {
        url,
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

        loop {
            // 100 ms tick — tight enough for responsive UI, low enough CPU cost.
            tokio::time::sleep(Duration::from_millis(100)).await;

            if gen_counter.load(Ordering::SeqCst) != gen {
                break;
            }

            // ── Gapless transition detection ─────────────────────────────────
            // If the current source is exhausted AND we have a chained track
            // ready, transition seamlessly: swap tracking state, emit
            // audio:track_switched for the new track, and continue the loop.
            if current_done.load(Ordering::SeqCst) {
                let chained = chained_arc.lock().unwrap().take();
                if let Some(info) = chained {
                    // Swap to the chained source's done flag.
                    current_done = info.source_done;

                    // Swap the sample counter: the chained source's counter
                    // is already being incremented by CountingSource. Copy its
                    // current value into the shared samples_played so the
                    // progress calculation stays accurate.
                    let chained_samples = info.sample_counter.load(Ordering::Relaxed);
                    samples_played.store(chained_samples, Ordering::Relaxed);

                    // Update tracking state.
                    {
                        let mut cur = current_arc.lock().unwrap();
                        cur.replay_gain_linear = info.replay_gain_linear;
                        cur.base_volume = info.base_volume;
                        cur.duration_secs = info.duration_secs;
                        cur.seek_offset = 0.0;
                        cur.play_started = Some(Instant::now());
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
            cur.paused_at = Some(pos);
            cur.play_started = None;
        }
    }
}

#[tauri::command]
pub fn audio_resume(state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        if sink.is_paused() {
            let pos = cur.paused_at.unwrap_or(cur.seek_offset);
            sink.play();
            cur.seek_offset = pos;
            cur.play_started = Some(Instant::now());
            cur.paused_at = None;
        }
    }
}

#[tauri::command]
pub fn audio_stop(state: State<'_, AudioEngine>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.chained_info.lock().unwrap() = None;
    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() {
        sink.stop();
    }
    cur.duration_secs = 0.0;
    cur.seek_offset = 0.0;
    cur.play_started = None;
    cur.paused_at = None;
}

#[tauri::command]
pub fn audio_seek(seconds: f64, state: State<'_, AudioEngine>) -> Result<(), String> {
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

    // Seeking far back invalidates any pending gapless chain.
    let cur_pos = {
        let cur = state.current.lock().unwrap();
        cur.position()
    };
    if seconds < cur_pos - 1.0 {
        *state.chained_info.lock().unwrap() = None;
    }

    let mut cur = state.current.lock().unwrap();
    if let Some(sink) = &cur.sink {
        sink.try_seek(Duration::from_secs_f64(seconds.max(0.0)))
            .map_err(|e: rodio::source::SeekError| e.to_string())?;
        if cur.paused_at.is_some() {
            cur.paused_at = Some(seconds);
        } else {
            cur.seek_offset = seconds;
            cur.play_started = Some(Instant::now());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn audio_set_volume(volume: f32, state: State<'_, AudioEngine>) {
    let mut cur = state.current.lock().unwrap();
    cur.base_volume = volume.clamp(0.0, 1.0);
    if let Some(sink) = &cur.sink {
        sink.set_volume((cur.base_volume * cur.replay_gain_linear).clamp(0.0, 1.0));
    }
}

#[tauri::command]
pub fn audio_set_eq(gains: [f32; 10], enabled: bool, state: State<'_, AudioEngine>) {
    state.eq_enabled.store(enabled, Ordering::Relaxed);
    for (i, &gain) in gains.iter().enumerate() {
        state.eq_gains[i].store(gain.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn audio_preload(
    url: String,
    duration_hint: f64,
    state: State<'_, AudioEngine>,
) -> Result<(), String> {
    {
        let preloaded = state.preloaded.lock().unwrap();
        if preloaded.as_ref().map(|p| p.url == url).unwrap_or(false) {
            return Ok(());
        }
    }
    let response = state.http_client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(());
    }
    let data: Vec<u8> = response.bytes().await.map_err(|e| e.to_string())?.into();
    let _ = duration_hint; // kept in API for compatibility
    *state.preloaded.lock().unwrap() = Some(PreloadedTrack { url, data });
    Ok(())
}

#[tauri::command]
pub fn audio_set_crossfade(enabled: bool, secs: f32, state: State<'_, AudioEngine>) {
    state.crossfade_enabled.store(enabled, Ordering::Relaxed);
    state.crossfade_secs.store(secs.clamp(0.5, 12.0).to_bits(), Ordering::Relaxed);
}

#[tauri::command]
pub fn audio_set_gapless(enabled: bool, state: State<'_, AudioEngine>) {
    state.gapless_enabled.store(enabled, Ordering::Relaxed);
}

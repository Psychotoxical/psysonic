use std::sync::{
    atomic::{AtomicU32, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use rodio::Source;

use super::*;

/// The ring and lease are process-global (they are reached from the audio
/// callback, where threading an `Arc` through twelve constructor arguments
/// would be worse). Tests that touch them must not interleave.
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Take the shared lock without propagating poisoning: a single failing test
/// would otherwise cascade into every other test that touches the globals,
/// burying the actual failure.
///
/// `pub(crate)` because tests outside this module drain a full production
/// source (see `decode.rs`), which runs a `SpectrumTapSource` over these same
/// globals and could otherwise steal the lease mid-test.
pub(crate) fn lock_globals() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) struct Silence {
    pub(super) remaining: usize,
    pub(super) channels: u16,
    pub(super) rate: u32,
}

impl Iterator for Silence {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        Some(0.25)
    }
}

impl Source for Silence {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> rodio::ChannelCount {
        rodio::ChannelCount::new(self.channels).unwrap()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        rodio::SampleRate::new(self.rate).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

/// Interleaved stereo whose channels differ: +0.5 left, −0.5 right.
pub(super) struct Alternating {
    pub(super) remaining: usize,
    pub(super) channels: u16,
    pub(super) rate: u32,
    pub(super) next_left: bool,
}

impl Iterator for Alternating {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.remaining == 0 {
            return None;
        }
        self.remaining -= 1;
        let v = if self.next_left { 0.5 } else { -0.5 };
        self.next_left = !self.next_left;
        Some(v)
    }
}

impl Source for Alternating {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> rodio::ChannelCount {
        rodio::ChannelCount::new(self.channels).unwrap()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        rodio::SampleRate::new(self.rate).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

pub(super) struct Samples {
    inner: std::vec::IntoIter<f32>,
    channels: u16,
    rate: Arc<AtomicU32>,
    rate_reads: Arc<AtomicUsize>,
}

impl Iterator for Samples {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next()
    }
}

impl Source for Samples {
    fn current_span_len(&self) -> Option<usize> {
        Some(self.inner.len())
    }
    fn channels(&self) -> rodio::ChannelCount {
        rodio::ChannelCount::new(self.channels).unwrap()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.rate_reads.fetch_add(1, Ordering::Relaxed);
        rodio::SampleRate::new(self.rate.load(Ordering::Relaxed)).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

pub(super) fn samples_source(
    samples: Vec<f32>,
    channels: u16,
    rate: u32,
) -> (Samples, Arc<AtomicU32>) {
    let (source, rate, _) = counted_samples_source(samples, channels, rate);
    (source, rate)
}

pub(super) fn counted_samples_source(
    samples: Vec<f32>,
    channels: u16,
    rate: u32,
) -> (Samples, Arc<AtomicU32>, Arc<AtomicUsize>) {
    let rate = Arc::new(AtomicU32::new(rate));
    let rate_reads = Arc::new(AtomicUsize::new(0));
    (
        Samples {
            inner: samples.into_iter(),
            channels,
            rate: Arc::clone(&rate),
            rate_reads: Arc::clone(&rate_reads),
        },
        rate,
        rate_reads,
    )
}

/// Encoded length of `bytes` bytes of base64, including padding.
pub(super) fn base64_len(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

pub(super) fn tone(freq: f32, rate: f32, len: usize) -> Vec<f32> {
    (0..len)
        .map(|i| (std::f32::consts::TAU * freq * i as f32 / rate).sin())
        .collect()
}

pub(super) fn reset_globals() {
    ACTIVE.store(false, Ordering::Relaxed);
    FPS.store(DEFAULT_FPS, Ordering::Relaxed);
    RESPONSIVENESS.store(DEFAULT_RESPONSIVENESS.to_bits(), Ordering::Relaxed);
    GENERATION.store(0, Ordering::Relaxed);
    WRITE_POS.store(0, Ordering::Relaxed);
    LEASE.store(0, Ordering::Relaxed);
    SOURCE_RATE.store(0, Ordering::Relaxed);
}

/// Minimal base64 decoder, test-only — mirrors what the frontend does with
/// `atob`, and keeps these assertions independent of the encoder's internals.
pub(super) fn decode_b64(s: &str) -> Vec<u8> {
    let idx = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => 0,
        }
    };
    let bytes: Vec<u8> = s.bytes().collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let n = (idx(chunk[0]) << 18)
            | (idx(chunk[1]) << 12)
            | (idx(*chunk.get(2).unwrap_or(&b'A')) << 6)
            | idx(*chunk.get(3).unwrap_or(&b'A'));
        out.push((n >> 16) as u8);
        if chunk.get(2).is_some_and(|c| *c != b'=') {
            out.push((n >> 8) as u8);
        }
        if chunk.get(3).is_some_and(|c| *c != b'=') {
            out.push(n as u8);
        }
    }
    out
}

//! Global playback speed / pitch strategies (varispeed, speed-corrected, preserve pitch).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use rodio::source::SeekError;
use rodio::{ChannelCount, SampleRate, Source};

use crate::preserve_worker::PreserveOffload;

pub const STRATEGY_VARISPEED: u32 = 0;
pub const STRATEGY_PRESERVE_PITCH: u32 = 1;
pub const STRATEGY_SPEED_CORRECTED: u32 = 2;

pub(crate) const PRESERVE_MAKEUP_GAIN: f32 = 1.35;

#[derive(Clone)]
pub struct PlaybackRateAtomics {
    pub enabled: Arc<AtomicBool>,
    pub strategy: Arc<AtomicU32>,
    pub speed: Arc<AtomicU32>,
    pub pitch_semitones: Arc<AtomicU32>,
}

impl Default for PlaybackRateAtomics {
    fn default() -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(false)),
            strategy: Arc::new(AtomicU32::new(STRATEGY_SPEED_CORRECTED)),
            speed: Arc::new(AtomicU32::new(1.0f32.to_bits())),
            pitch_semitones: Arc::new(AtomicU32::new(0.0f32.to_bits())),
        }
    }
}

impl PlaybackRateAtomics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_speed(&self) -> f32 {
        f32::from_bits(self.speed.load(Ordering::Relaxed)).clamp(0.5, 2.0)
    }

    pub fn load_pitch(&self) -> f32 {
        f32::from_bits(self.pitch_semitones.load(Ordering::Relaxed)).clamp(-12.0, 12.0)
    }

    pub fn load_strategy(&self) -> u32 {
        match self.strategy.load(Ordering::Relaxed) {
            STRATEGY_PRESERVE_PITCH => STRATEGY_PRESERVE_PITCH,
            STRATEGY_SPEED_CORRECTED => STRATEGY_SPEED_CORRECTED,
            _ => STRATEGY_VARISPEED,
        }
    }
}

pub fn uses_preserve_dsp(strategy: u32) -> bool {
    strategy == STRATEGY_PRESERVE_PITCH || strategy == STRATEGY_SPEED_CORRECTED
}

pub fn effective_pitch(atomics: &PlaybackRateAtomics) -> f32 {
    if atomics.load_strategy() == STRATEGY_PRESERVE_PITCH {
        atomics.load_pitch()
    } else {
        0.0
    }
}

pub fn is_effect_active(atomics: &PlaybackRateAtomics) -> bool {
    if !atomics.enabled.load(Ordering::Relaxed) {
        return false;
    }
    let speed = atomics.load_speed();
    match atomics.load_strategy() {
        STRATEGY_PRESERVE_PITCH => {
            (speed - 1.0).abs() > 0.001 || atomics.load_pitch().abs() > 0.001
        }
        _ => (speed - 1.0).abs() > 0.001,
    }
}

/// True when preserve-pitch DSP (background worker) should run for this track.
pub(crate) fn preserve_pitch_will_run(atomics: &PlaybackRateAtomics) -> bool {
    atomics.enabled.load(Ordering::Relaxed)
        && uses_preserve_dsp(atomics.load_strategy())
        && is_effect_active(atomics)
}

/// Content timeline length for seek bar / duration labels (always the full track).
pub fn effective_duration_secs(base_secs: f64, _atomics: &PlaybackRateAtomics) -> f64 {
    base_secs
}

/// Map counter-derived seconds to timeline position for UI / near-end checks.
pub fn effective_position_secs(raw_secs: f64, atomics: &PlaybackRateAtomics) -> f64 {
    if !is_effect_active(atomics) {
        return raw_secs;
    }
    if atomics.load_strategy() == STRATEGY_VARISPEED {
        return raw_secs;
    }
    // Preserve DSP outputs at the base sample rate; scale to content timeline.
    raw_secs * atomics.load_speed() as f64
}

/// Sample-counter position mapped to the content timeline (seek bar / labels).
pub(crate) fn content_position_from_samples(
    samples: u64,
    sample_rate_hz: u32,
    channels: u32,
    atomics: &PlaybackRateAtomics,
) -> f64 {
    let divisor = (sample_rate_hz as f64 * channels as f64).max(1.0);
    effective_position_secs(samples as f64 / divisor, atomics)
}

/// Counter value that matches `content_position_from_samples` after a content-timeline seek.
pub(crate) fn raw_counter_samples_for_content_position(
    content_secs: f64,
    sample_rate_hz: u32,
    channels: u32,
    atomics: &PlaybackRateAtomics,
) -> u64 {
    let divisor = (sample_rate_hz as f64 * channels as f64).max(1.0);
    let raw_secs = if is_effect_active(atomics) && atomics.load_strategy() != STRATEGY_VARISPEED {
        content_secs / atomics.load_speed().max(0.001) as f64
    } else {
        content_secs
    };
    (raw_secs * divisor).round() as u64
}

pub(crate) fn preserve_out_samples(speed: f32) -> usize {
    (128.0f32 / speed.clamp(0.5, 2.0)).round() as usize
}

pub struct PlaybackRateSource<S: Source<Item = f32> + Send + 'static> {
    inner: Option<S>,
    base_sample_rate: SampleRate,
    base_channels: ChannelCount,
    atomics: PlaybackRateAtomics,
    offload: Option<PreserveOffload>,
    handback_rx: Option<mpsc::Receiver<S>>,
    handback_requested: bool,
}

impl<S: Source<Item = f32> + Send + 'static> PlaybackRateSource<S> {
    pub fn new(inner: S, atomics: PlaybackRateAtomics) -> Self {
        let base_sample_rate = inner.sample_rate();
        let base_channels = inner.channels();
        Self {
            inner: Some(inner),
            base_sample_rate,
            base_channels,
            atomics,
            offload: None,
            handback_rx: None,
            handback_requested: false,
        }
    }

    fn poll_handback(&mut self) {
        let Some(rx) = &self.handback_rx else {
            return;
        };
        if let Ok(inner) = rx.try_recv() {
            self.inner = Some(inner);
            self.handback_rx = None;
            self.handback_requested = false;
            if let Some(offload) = self.offload.take() {
                offload.join();
            }
        }
    }

    fn request_handback_if_needed(&mut self) {
        if self.inner.is_some() || self.handback_requested {
            return;
        }
        if let Some(offload) = &self.offload {
            offload.request_handback();
            self.handback_requested = true;
        }
    }

    fn ensure_offload(&mut self) {
        if self.offload.is_some() {
            return;
        }
        if let Some(inner) = self.inner.take() {
            let (handback_tx, handback_rx) = mpsc::sync_channel(1);
            self.handback_rx = Some(handback_rx);
            self.offload = Some(PreserveOffload::spawn(
                inner,
                self.atomics.clone(),
                self.base_sample_rate.get(),
                self.base_channels.get(),
                handback_tx,
            ));
        }
    }

    fn base_sample_rate(&self) -> SampleRate {
        self.inner
            .as_ref()
            .map(Source::sample_rate)
            .unwrap_or(self.base_sample_rate)
    }

    fn try_recover_inner_from_offload(&mut self) {
        if self.inner.is_some() || self.offload.is_none() {
            return;
        }
        self.request_handback_if_needed();
        self.poll_handback();
    }

    fn next_from_inner_or_pad(&mut self) -> Option<f32> {
        self.try_recover_inner_from_offload();
        if let Some(inner) = self.inner.as_mut() {
            return inner.next();
        }
        if self
            .offload
            .as_ref()
            .is_some_and(|offload| !offload.is_done())
        {
            return Some(0.0);
        }
        None
    }
}

impl<S: Source<Item = f32> + Send + 'static> Iterator for PlaybackRateSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if !is_effect_active(&self.atomics) {
            if let Some(offload) = self.offload.as_mut() {
                if let Some(s) = offload.pop() {
                    return Some(s);
                }
            }
            return self.next_from_inner_or_pad();
        }

        if uses_preserve_dsp(self.atomics.load_strategy()) {
            self.ensure_offload();
            if let Some(s) = self.offload.as_mut().and_then(|o| o.pop()) {
                return Some(s);
            }
            if self
                .offload
                .as_ref()
                .is_some_and(|offload| !offload.is_done())
            {
                return Some(0.0);
            }
            return None;
        }

        // Varispeed: decoder must stay in `inner` (never in the preserve worker).
        if self.offload.is_some() {
            self.try_recover_inner_from_offload();
        }
        self.next_from_inner_or_pad()
    }
}

impl<S: Source<Item = f32> + Send + 'static> Source for PlaybackRateSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.as_ref()?.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.base_channels
    }

    fn sample_rate(&self) -> SampleRate {
        if is_effect_active(&self.atomics) && self.atomics.load_strategy() == STRATEGY_VARISPEED {
            let factor = self.atomics.load_speed().max(0.001);
            SampleRate::new((self.base_sample_rate().get() as f32 * factor).max(1.0) as u32)
                .unwrap_or(self.base_sample_rate)
        } else {
            self.base_sample_rate()
        }
    }

    fn total_duration(&self) -> Option<Duration> {
        self.inner.as_ref()?.total_duration()
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        // UI / transport always pass content-timeline seconds (0..full track).
        if let Some(inner) = self.inner.as_mut() {
            inner.try_seek(pos)?;
        }
        if let Some(offload) = self.offload.as_mut() {
            offload.request_seek(pos);
            offload.drain();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

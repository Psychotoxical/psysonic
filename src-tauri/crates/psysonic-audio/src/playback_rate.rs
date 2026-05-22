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

pub fn effective_duration_secs(base_secs: f64, atomics: &PlaybackRateAtomics) -> f64 {
    if !is_effect_active(atomics) {
        return base_secs;
    }
    let speed = atomics.load_speed() as f64;
    if speed <= 0.0 {
        return base_secs;
    }
    base_secs / speed
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
}

impl<S: Source<Item = f32> + Send + 'static> Iterator for PlaybackRateSource<S> {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if !is_effect_active(&self.atomics) {
            if let Some(offload) = self.offload.as_mut() {
                if let Some(s) = offload.pop() {
                    return Some(s);
                }
                if !offload.is_done() {
                    self.request_handback_if_needed();
                    self.poll_handback();
                    if let Some(inner) = self.inner.as_mut() {
                        return inner.next();
                    }
                }
            } else if let Some(inner) = self.inner.as_mut() {
                return inner.next();
            }
            return None;
        }

        if uses_preserve_dsp(self.atomics.load_strategy()) {
            self.ensure_offload();
            if let Some(offload) = self.offload.as_mut() {
                if let Some(s) = offload.pop() {
                    return Some(s);
                }
                if offload.is_done() {
                    return None;
                }
                // Ring starved while worker catches up — pad one frame rather than
                // ending the source (Iterator::None would stop the track).
                return Some(0.0);
            }
            return None;
        }

        self.inner.as_mut()?.next()
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
        let base = self.inner.as_ref()?.total_duration()?;
        Some(if is_effect_active(&self.atomics) {
            base.div_f32(self.atomics.load_speed().max(0.001))
        } else {
            base
        })
    }

    fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
        if is_effect_active(&self.atomics) && self.atomics.load_strategy() == STRATEGY_VARISPEED {
            let factor = self.atomics.load_speed().max(0.001);
            if let Some(inner) = self.inner.as_mut() {
                inner.try_seek(pos.mul_f32(factor))?;
            }
        } else if let Some(inner) = self.inner.as_mut() {
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
mod tests {
    use super::*;
    use pitch_shift::{Shifter, TOTAL_F32};

    #[test]
    fn passthrough_when_disabled() {
        let a = PlaybackRateAtomics::new();
        assert!(!is_effect_active(&a));
    }

    #[test]
    fn passthrough_at_unity() {
        let a = PlaybackRateAtomics::new();
        a.enabled.store(true, Ordering::Relaxed);
        assert!(!is_effect_active(&a));
    }

    #[test]
    fn active_when_speed_not_one() {
        let a = PlaybackRateAtomics::new();
        a.enabled.store(true, Ordering::Relaxed);
        a.speed.store(1.5f32.to_bits(), Ordering::Relaxed);
        assert!(is_effect_active(&a));
    }

    #[test]
    fn effective_duration_scales() {
        let a = PlaybackRateAtomics::new();
        a.enabled.store(true, Ordering::Relaxed);
        a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
        assert!((effective_duration_secs(100.0, &a) - 50.0).abs() < 0.001);
    }

    #[test]
    fn preserve_out_samples_clamped() {
        assert_eq!(preserve_out_samples(2.0), 64);
        assert_eq!(preserve_out_samples(0.5), 256);
    }

    struct FixedRateSource {
        rate: u32,
        remaining: usize,
    }

    impl Iterator for FixedRateSource {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.remaining == 0 {
                return None;
            }
            self.remaining -= 1;
            Some(0.0)
        }
    }

    impl Source for FixedRateSource {
        fn current_span_len(&self) -> Option<usize> {
            Some(self.remaining)
        }
        fn channels(&self) -> ChannelCount {
            std::num::NonZero::new(1).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            SampleRate::new(self.rate).unwrap()
        }
        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs(1))
        }
    }

    #[test]
    fn speed_corrected_uses_preserve_dsp_path() {
        let atomics = PlaybackRateAtomics::new();
        atomics.enabled.store(true, Ordering::Relaxed);
        atomics
            .strategy
            .store(STRATEGY_SPEED_CORRECTED, Ordering::Relaxed);
        atomics.speed.store(1.5f32.to_bits(), Ordering::Relaxed);
        assert!(uses_preserve_dsp(atomics.load_strategy()));
        assert!(is_effect_active(&atomics));
        assert_eq!(effective_pitch(&atomics), 0.0);
    }

    #[test]
    fn preserve_pitch_respects_manual_pitch() {
        let atomics = PlaybackRateAtomics::new();
        atomics.enabled.store(true, Ordering::Relaxed);
        atomics
            .strategy
            .store(STRATEGY_PRESERVE_PITCH, Ordering::Relaxed);
        atomics.pitch_semitones.store(3.0f32.to_bits(), Ordering::Relaxed);
        assert!(is_effect_active(&atomics));
        assert_eq!(effective_pitch(&atomics), 3.0);
    }

    #[test]
    fn varispeed_scales_reported_sample_rate() {
        let atomics = PlaybackRateAtomics::new();
        atomics.enabled.store(true, Ordering::Relaxed);
        atomics
            .strategy
            .store(STRATEGY_VARISPEED, Ordering::Relaxed);
        atomics.speed.store(1.5f32.to_bits(), Ordering::Relaxed);
        let src = PlaybackRateSource::new(
            FixedRateSource {
                rate: 44_100,
                remaining: 1,
            },
            atomics,
        );
        assert_eq!(src.sample_rate().get(), 66_150);
    }

    #[test]
    fn varispeed_propagates_through_dyn_source() {
        use crate::sources::DynSource;

        let atomics = PlaybackRateAtomics::new();
        atomics.enabled.store(true, Ordering::Relaxed);
        atomics
            .strategy
            .store(STRATEGY_VARISPEED, Ordering::Relaxed);
        atomics.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
        let rate_src = PlaybackRateSource::new(
            FixedRateSource {
                rate: 48_000,
                remaining: 1,
            },
            atomics,
        );
        let dyn_src = DynSource::new(rate_src);
        assert_eq!(dyn_src.sample_rate().get(), 96_000);
    }

    fn rms_f32(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn preserve_pitch_makeup_keeps_level_reasonable() {
        let sr = 44_100f32;
        let mut input = [0.0f32; 128];
        for (i, s) in input.iter_mut().enumerate() {
            *s = (i as f32 * 0.12).sin() * 0.75;
        }
        let in_rms = rms_f32(&input);
        let mut shifter: Shifter<Box<[f32; TOTAL_F32]>> =
            Shifter::new(Box::new([0.0; TOTAL_F32]));
        for _ in 0..24 {
            shifter.shift(&input, 4.0, 128, sr);
        }
        let dry = shifter.shift(&input, 4.0, 128, sr);
        let boosted: Vec<f32> = dry
            .iter()
            .map(|&s| (s * PRESERVE_MAKEUP_GAIN).clamp(-1.0, 1.0))
            .collect();
        let out_rms = rms_f32(&boosted);
        assert!(out_rms > in_rms * 0.8, "out_rms={out_rms} in_rms={in_rms}");
        assert!(out_rms < in_rms * 1.25, "out_rms={out_rms} in_rms={in_rms}");
    }
}

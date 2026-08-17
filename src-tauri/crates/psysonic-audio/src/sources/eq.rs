use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use biquad::{Biquad, Coefficients, DirectForm2Transposed, ToHertz, Type as FilterType};
use rodio::Source;

const EQ_BANDS_HZ: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
const EQ_Q: f32 = 1.41;
const EQ_CHECK_INTERVAL: usize = 1024;

pub(crate) struct EqSource<S: Source<Item = f32>> {
    inner: S,
    channels: rodio::ChannelCount,
    gains: Arc<[AtomicU32; 10]>,
    enabled: Arc<AtomicBool>,
    pre_gain: Arc<AtomicU32>,
    filters: [[DirectForm2Transposed<f32>; 2]; 10],
    current_gains: [f32; 10],
    sample_counter: usize,
    channel_idx: usize,
}

impl<S: Source<Item = f32>> EqSource<S> {
    pub(crate) fn new(
        inner: S,
        gains: Arc<[AtomicU32; 10]>,
        enabled: Arc<AtomicBool>,
        pre_gain: Arc<AtomicU32>,
    ) -> Self {
        let sample_rate = inner.sample_rate();
        let channels = inner.channels();
        let filters = std::array::from_fn(|band| {
            let freq = EQ_BANDS_HZ[band].clamp(20.0, (sample_rate.get() as f32 / 2.0) - 100.0);
            std::array::from_fn(|_| {
                let coeffs = Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(0.0),
                    (sample_rate.get() as f32).hz(),
                    freq.hz(),
                    EQ_Q,
                )
                .unwrap_or_else(|_| {
                    Coefficients::<f32>::from_params(
                        FilterType::PeakingEQ(0.0),
                        (sample_rate.get() as f32).hz(),
                        1000.0f32.hz(),
                        EQ_Q,
                    )
                    .unwrap()
                });
                DirectForm2Transposed::<f32>::new(coeffs)
            })
        });
        Self {
            inner,
            channels,
            gains,
            enabled,
            pre_gain,
            filters,
            current_gains: [0.0; 10],
            sample_counter: 0,
            channel_idx: 0,
        }
    }

    #[allow(clippy::needless_range_loop)]
    fn refresh_if_needed(&mut self) {
        let sample_rate = self.inner.sample_rate();
        for band in 0..10 {
            let gain_db = f32::from_bits(self.gains[band].load(Ordering::Relaxed));
            if (gain_db - self.current_gains[band]).abs() > 0.01 {
                self.current_gains[band] = gain_db;
                let freq = EQ_BANDS_HZ[band].clamp(20.0, (sample_rate.get() as f32 / 2.0) - 100.0);
                if let Ok(coeffs) = Coefficients::<f32>::from_params(
                    FilterType::PeakingEQ(gain_db),
                    (sample_rate.get() as f32).hz(),
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

        if self.sample_counter.is_multiple_of(EQ_CHECK_INTERVAL) {
            self.refresh_if_needed();
        }
        self.sample_counter = self.sample_counter.wrapping_add(1);

        if !self.enabled.load(Ordering::Relaxed) {
            self.channel_idx = (self.channel_idx + 1) % self.channels.get() as usize;
            return Some(sample);
        }

        let ch = self.channel_idx.min(1);
        self.channel_idx = (self.channel_idx + 1) % self.channels.get() as usize;

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
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> rodio::ChannelCount {
        self.channels
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        self.inner.total_duration()
    }

    #[allow(clippy::needless_range_loop)]
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        let sample_rate = self.inner.sample_rate();
        // Reset biquad filter state to avoid glitches after seek.
        for band in 0..10 {
            let gain_db = f32::from_bits(self.gains[band].load(Ordering::Relaxed));
            self.current_gains[band] = gain_db;
            let freq = EQ_BANDS_HZ[band].clamp(20.0, (sample_rate.get() as f32 / 2.0) - 100.0);
            if let Ok(coeffs) = Coefficients::<f32>::from_params(
                FilterType::PeakingEQ(gain_db),
                (sample_rate.get() as f32).hz(),
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

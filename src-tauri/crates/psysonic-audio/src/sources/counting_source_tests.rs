use super::*;
use rodio::Source;
use std::time::Duration;

struct TwoSamples(u8);
impl Iterator for TwoSamples {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        match self.0 {
            0 => {
                self.0 = 1;
                Some(0.1)
            }
            1 => {
                self.0 = 2;
                Some(0.2)
            }
            _ => None,
        }
    }
}
impl Source for TwoSamples {
    fn current_span_len(&self) -> Option<usize> {
        Some(1)
    }
    fn channels(&self) -> rodio::ChannelCount {
        std::num::NonZero::new(1).unwrap()
    }
    fn sample_rate(&self) -> rodio::SampleRate {
        std::num::NonZero::new(44_100).unwrap()
    }
    fn total_duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f32(2.0 / 44_100.0))
    }
}

#[test]
fn gated_counter_skips_samples_until_gate_is_set() {
    let counter = Arc::new(AtomicU64::new(0));
    let gate = Arc::new(AtomicBool::new(false));
    let mut src = CountingSource::new_gated(TwoSamples(0), counter.clone(), gate.clone());
    assert_eq!(src.next(), Some(0.1));
    assert_eq!(src.next(), Some(0.2));
    assert_eq!(counter.load(Ordering::Relaxed), 0);
    gate.store(true, Ordering::SeqCst);
    let mut src2 = CountingSource::new_gated(TwoSamples(0), counter.clone(), gate);
    assert_eq!(src2.next(), Some(0.1));
    assert_eq!(counter.load(Ordering::Relaxed), 1);
}

#[test]
fn cancelled_source_exhausts_without_reading_more_successor_samples() {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut src = CancellableSource::new(TwoSamples(0), cancel.clone());
    assert_eq!(src.next(), Some(0.1));
    cancel.store(true, Ordering::Release);
    assert_eq!(src.next(), None);
    assert_eq!(src.current_span_len(), Some(0));
}

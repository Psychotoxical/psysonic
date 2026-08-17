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
fn effective_duration_is_content_timeline() {
    let a = PlaybackRateAtomics::new();
    a.enabled.store(true, Ordering::Relaxed);
    a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    for strat in [
        STRATEGY_VARISPEED,
        STRATEGY_SPEED_CORRECTED,
        STRATEGY_PRESERVE_PITCH,
    ] {
        a.strategy.store(strat, Ordering::Relaxed);
        assert!(
            (effective_duration_secs(200.0, &a) - 200.0).abs() < 0.001,
            "strategy {strat}"
        );
    }
}

#[test]
fn effective_position_varispeed_uses_counter() {
    let a = PlaybackRateAtomics::new();
    a.enabled.store(true, Ordering::Relaxed);
    a.strategy.store(STRATEGY_VARISPEED, Ordering::Relaxed);
    a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    assert!((effective_position_secs(20.0, &a) - 20.0).abs() < 0.001);
}

#[test]
fn effective_position_preserve_scales_with_speed() {
    let a = PlaybackRateAtomics::new();
    a.enabled.store(true, Ordering::Relaxed);
    a.strategy
        .store(STRATEGY_SPEED_CORRECTED, Ordering::Relaxed);
    a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    assert!((effective_position_secs(10.0, &a) - 20.0).abs() < 0.001);
}

#[test]
fn effective_position_inactive_is_raw() {
    let a = PlaybackRateAtomics::new();
    assert!((effective_position_secs(15.0, &a) - 15.0).abs() < 0.001);
}

#[test]
fn raw_counter_samples_roundtrip_content_timeline() {
    let a = PlaybackRateAtomics::new();
    a.enabled.store(true, Ordering::Relaxed);
    a.strategy
        .store(STRATEGY_SPEED_CORRECTED, Ordering::Relaxed);
    a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    let samples = raw_counter_samples_for_content_position(120.0, 44_100, 2, &a);
    let back = content_position_from_samples(samples, 44_100, 2, &a);
    assert!((back - 120.0).abs() < 0.05, "roundtrip at 2x preserve");
}

#[test]
fn raw_counter_samples_roundtrip_varispeed() {
    let a = PlaybackRateAtomics::new();
    a.enabled.store(true, Ordering::Relaxed);
    a.strategy.store(STRATEGY_VARISPEED, Ordering::Relaxed);
    a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);
    let samples = raw_counter_samples_for_content_position(90.0, 44_100, 2, &a);
    let back = content_position_from_samples(samples, 44_100, 2, &a);
    assert!((back - 90.0).abs() < 0.05, "roundtrip at 2x varispeed");
}

#[test]
fn varispeed_seek_uses_content_timeline() {
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
    use std::sync::Arc;

    struct SeekSpy {
        rate: SampleRate,
        last_seek_secs: Arc<AtomicU64>,
        remaining: usize,
    }

    impl Iterator for SeekSpy {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.remaining == 0 {
                return None;
            }
            self.remaining -= 1;
            Some(0.0)
        }
    }

    impl Source for SeekSpy {
        fn current_span_len(&self) -> Option<usize> {
            Some(self.remaining)
        }
        fn channels(&self) -> ChannelCount {
            ChannelCount::new(1).unwrap()
        }
        fn sample_rate(&self) -> SampleRate {
            self.rate
        }
        fn total_duration(&self) -> Option<Duration> {
            Some(Duration::from_secs(200))
        }
        fn try_seek(&mut self, pos: Duration) -> Result<(), SeekError> {
            self.last_seek_secs
                .store(pos.as_secs_f64().to_bits(), AtomicOrdering::Relaxed);
            Ok(())
        }
    }

    let last = Arc::new(AtomicU64::new(f64::NAN.to_bits()));
    let spy = SeekSpy {
        rate: SampleRate::new(44_100).unwrap(),
        last_seek_secs: last.clone(),
        remaining: 44_100,
    };

    let a = PlaybackRateAtomics::new();
    a.enabled.store(true, Ordering::Relaxed);
    a.strategy.store(STRATEGY_VARISPEED, Ordering::Relaxed);
    a.speed.store(2.0f32.to_bits(), Ordering::Relaxed);

    let mut src = PlaybackRateSource::new(spy, a);
    src.try_seek(Duration::from_secs(120)).unwrap();
    let got = f64::from_bits(last.load(AtomicOrdering::Relaxed));
    assert!(
        (got - 120.0).abs() < 0.001,
        "varispeed seek must not scale content position, got {got}"
    );
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
    atomics
        .pitch_semitones
        .store(3.0f32.to_bits(), Ordering::Relaxed);
    assert!(is_effect_active(&atomics));
    assert_eq!(effective_pitch(&atomics), 3.0);
}

#[test]
fn strategy_switch_preserve_to_varispeed_does_not_end_early() {
    let atomics = PlaybackRateAtomics::new();
    atomics.enabled.store(true, Ordering::Relaxed);
    atomics
        .strategy
        .store(STRATEGY_SPEED_CORRECTED, Ordering::Relaxed);
    atomics.speed.store(1.5f32.to_bits(), Ordering::Relaxed);

    let mut src = PlaybackRateSource::new(
        FixedRateSource {
            rate: 44_100,
            remaining: 50_000,
        },
        atomics.clone(),
    );
    for _ in 0..5_000 {
        assert!(src.next().is_some());
    }

    atomics
        .strategy
        .store(STRATEGY_VARISPEED, Ordering::Relaxed);

    let mut got = 0usize;
    for _ in 0..2_000 {
        if src.next().is_some() {
            got += 1;
        } else {
            break;
        }
    }
    assert!(
        got > 100,
        "varispeed should continue after preserve strategy switch, got {got} samples"
    );
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
    let mut shifter: Shifter<Box<[f32; TOTAL_F32]>> = Shifter::new(Box::new([0.0; TOTAL_F32]));
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

#[test]
fn live_speed_change_represerves_content_position() {
    let atomics = PlaybackRateAtomics::new();
    atomics.enabled.store(true, Ordering::Relaxed);
    atomics
        .strategy
        .store(STRATEGY_SPEED_CORRECTED, Ordering::Relaxed);
    atomics.speed.store(1.5f32.to_bits(), Ordering::Relaxed);

    let samples = raw_counter_samples_for_content_position(30.0, 44_100, 2, &atomics);
    let content = content_position_from_samples(samples, 44_100, 2, &atomics);
    assert!((content - 30.0).abs() < 0.05);

    atomics.speed.store(1.8f32.to_bits(), Ordering::Relaxed);
    let restamped = raw_counter_samples_for_content_position(content, 44_100, 2, &atomics);
    let after = content_position_from_samples(restamped, 44_100, 2, &atomics);
    assert!((after - 30.0).abs() < 0.05);
}

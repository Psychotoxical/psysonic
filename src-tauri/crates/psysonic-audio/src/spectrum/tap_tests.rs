use std::sync::atomic::Ordering;

use rodio::Source;

use super::tests::{counted_samples_source, lock_globals, reset_globals, samples_source, Silence};
use super::*;
use crate::spectrum_dsp::FFT_SIZE;

#[test]
fn tap_is_transparent_to_the_audio_it_passes() {
    let _guard = lock_globals();
    reset_globals();
    let mut tap = SpectrumTapSource::new(Silence {
        remaining: 8,
        channels: 2,
        rate: 44_100,
    });
    let out: Vec<f32> = (&mut tap).collect();
    assert_eq!(out, vec![0.25; 8], "tap must not alter the signal");
}

#[test]
fn tap_preserves_source_metadata() {
    let _guard = lock_globals();
    reset_globals();
    let tap = SpectrumTapSource::new(Silence {
        remaining: 4,
        channels: 2,
        rate: 96_000,
    });
    assert_eq!(tap.channels().get(), 2);
    assert_eq!(tap.sample_rate().get(), 96_000);
}

#[test]
fn tap_writes_nothing_while_inactive() {
    let _guard = lock_globals();
    reset_globals();
    let mut tap = SpectrumTapSource::new(Silence {
        remaining: 64,
        channels: 2,
        rate: 44_100,
    });
    let _: Vec<f32> = (&mut tap).collect();
    assert_eq!(
        WRITE_POS.load(Ordering::Acquire),
        0,
        "inactive tap must stay silent"
    );
}

#[test]
fn inactive_and_losing_taps_only_track_interleaved_position() {
    let _guard = lock_globals();
    reset_globals();

    let (source, _, rate_reads) = counted_samples_source(vec![0.5, -0.5, 0.25, -0.25], 2, 48_000);
    let mut inactive = SpectrumTapSource::new(source);
    inactive.next();
    assert_eq!(inactive.channel_idx, 1);
    assert!(!inactive.capture_frame);
    assert_eq!(inactive.left, 0.0);
    assert_eq!(inactive.right, 0.0);
    assert_eq!(rate_reads.load(Ordering::Relaxed), 0);

    ACTIVE.store(true, Ordering::Relaxed);
    let (old_source, _, old_rate_reads) =
        counted_samples_source(vec![0.4, -0.4, 0.3, -0.3], 2, 48_000);
    let mut old = SpectrumTapSource::new(old_source);
    old.next();
    old.next();

    let (new_source, _) = samples_source(vec![0.2, -0.2], 2, 48_000);
    let mut new = SpectrumTapSource::new(new_source);
    new.next();
    new.next();

    let reads_before_loss = old_rate_reads.load(Ordering::Relaxed);
    old.next();
    assert_eq!(old.channel_idx, 1);
    assert!(old.lease_lost);
    assert!(!old.capture_frame);
    assert_eq!(old.left, 0.0);
    assert_eq!(old.right, 0.0);
    assert_eq!(old_rate_reads.load(Ordering::Relaxed), reads_before_loss);
    ACTIVE.store(false, Ordering::Relaxed);
}

#[test]
fn tap_writes_one_folded_frame_per_channel_group() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);
    let mut tap = SpectrumTapSource::new(Silence {
        remaining: 64,
        channels: 2,
        rate: 44_100,
    });
    let _: Vec<f32> = (&mut tap).collect();
    ACTIVE.store(false, Ordering::Relaxed);
    assert_eq!(
        WRITE_POS.load(Ordering::Acquire),
        32,
        "64 stereo samples = 32 audio frames"
    );
}

#[test]
fn tap_records_the_leaseholders_sample_rate() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);
    let mut tap = SpectrumTapSource::new(Silence {
        remaining: 8,
        channels: 2,
        rate: 88_200,
    });
    let _: Vec<f32> = (&mut tap).collect();
    ACTIVE.store(false, Ordering::Relaxed);
    assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 88_200);
}

#[test]
fn tap_refreshes_a_dynamic_source_rate_at_frame_boundaries() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);
    let (source, rate) = samples_source(vec![0.25; 6], 2, 44_100);
    let mut tap = SpectrumTapSource::new(source);

    tap.next();
    tap.next();
    assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 44_100);
    rate.store(88_200, Ordering::Relaxed);
    tap.next();
    tap.next();
    assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 88_200);
    rate.store(22_050, Ordering::Relaxed);
    tap.next();
    tap.next();
    assert_eq!(SOURCE_RATE.load(Ordering::Relaxed), 22_050);
    ACTIVE.store(false, Ordering::Relaxed);
}

#[test]
fn crossfade_capture_follows_the_incoming_metadata_source_not_the_post_mix() {
    let _guard = lock_globals();
    reset_globals();
    ACTIVE.store(true, Ordering::Relaxed);

    // Outgoing track starts first and claims the ring.
    let (old_source, _) = samples_source(vec![0.75; 64], 1, 44_100);
    let mut old = SpectrumTapSource::new(old_source);
    old.next();
    assert_eq!(WRITE_POS.load(Ordering::Acquire), 1);

    // Crossfade begins: the incoming source produces its first complete
    // frame and takes over when the UI switches metadata.
    let (new_source, _) = samples_source(vec![0.25; 64], 1, 48_000);
    let mut new = SpectrumTapSource::new(new_source);
    new.next();
    assert_eq!(
        SOURCE_RATE.load(Ordering::Relaxed),
        48_000,
        "lease should follow the newest source"
    );

    // From here the outgoing source must not interleave into the ring.
    let before = WRITE_POS.load(Ordering::Acquire);
    for _ in 0..10 {
        old.next();
    }
    assert_eq!(
        WRITE_POS.load(Ordering::Acquire),
        before,
        "old source kept writing after handoff"
    );

    for _ in 0..10 {
        new.next();
    }
    assert_eq!(WRITE_POS.load(Ordering::Acquire), before + 10);

    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    snapshot(&mut left, &mut right);
    assert!((left[0] - 0.75).abs() < f32::EPSILON);
    assert!((right[0] - 0.75).abs() < f32::EPSILON);
    assert!(
        left[1..12]
            .iter()
            .chain(&right[1..12])
            .all(|sample| (*sample - 0.25).abs() < f32::EPSILON),
        "the outgoing source must not be summed into incoming-track capture"
    );
    ACTIVE.store(false, Ordering::Relaxed);
}

#[test]
fn snapshot_returns_the_most_recent_window_oldest_first() {
    let _guard = lock_globals();
    reset_globals();
    for i in 0..(FFT_SIZE + 100) {
        push_frame(i as f32, -(i as f32));
    }
    let mut left = vec![0.0f32; FFT_SIZE];
    let mut right = vec![0.0f32; FFT_SIZE];
    let pos = snapshot(&mut left, &mut right);
    assert_eq!(pos, (FFT_SIZE + 100) as u64);
    assert_eq!(left[0], 100.0);
    assert_eq!(left[FFT_SIZE - 1], (FFT_SIZE + 99) as f32);
    // Channels must stay separate all the way through the ring.
    assert_eq!(right[0], -100.0);
    assert_eq!(right[FFT_SIZE - 1], -((FFT_SIZE + 99) as f32));
}

#[test]
fn snapshot_zero_fills_before_any_audio_has_played() {
    let _guard = lock_globals();
    reset_globals();
    let mut left = vec![9.0f32; FFT_SIZE];
    let mut right = vec![9.0f32; FFT_SIZE];
    let pos = snapshot(&mut left, &mut right);
    assert_eq!(pos, 0);
    assert!(left.iter().all(|v| *v == 0.0));
    assert!(right.iter().all(|v| *v == 0.0));
}

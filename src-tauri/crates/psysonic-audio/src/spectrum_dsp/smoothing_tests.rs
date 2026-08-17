use super::*;

#[test]
fn responsiveness_shortens_every_timing_as_it_rises() {
    let smooth = SmoothingProfile::from_responsiveness(0.0);
    let snappy = SmoothingProfile::from_responsiveness(1.0);
    assert!(snappy.attack_tau < smooth.attack_tau);
    assert!(snappy.decay_tau < smooth.decay_tau);
    assert!(snappy.peak_hold < smooth.peak_hold);
    assert!(
        snappy.peak_fall > smooth.peak_fall,
        "caps must fall faster, not slower"
    );
}

#[test]
fn responsiveness_is_clamped_and_nan_safe() {
    assert_eq!(
        SmoothingProfile::from_responsiveness(-5.0),
        SmoothingProfile::from_responsiveness(0.0)
    );
    assert_eq!(
        SmoothingProfile::from_responsiveness(9.0),
        SmoothingProfile::from_responsiveness(1.0)
    );
    assert_eq!(
        SmoothingProfile::from_responsiveness(f32::NAN),
        SmoothingProfile::default()
    );
}

#[test]
fn every_profile_keeps_positive_time_constants() {
    for step in 0..=10 {
        let p = SmoothingProfile::from_responsiveness(step as f32 / 10.0);
        assert!(p.attack_tau > 0.0 && p.decay_tau > 0.0, "{p:?}");
        assert!(p.peak_hold >= 0.0 && p.peak_fall > 0.0, "{p:?}");
    }
}

#[test]
fn a_snappier_profile_falls_faster_from_the_same_state() {
    fn fall_after(responsiveness: f32) -> f32 {
        let mut s = Smoother::new(SmoothingProfile::from_responsiveness(responsiveness));
        for _ in 0..200 {
            s.step(&vec![1.0; BAND_COUNT], 0.016);
        }
        for _ in 0..6 {
            s.step(&vec![0.0; BAND_COUNT], 0.016);
        }
        s.levels()[0]
    }
    assert!(
        fall_after(1.0) < fall_after(0.0),
        "snappy must decay faster than smooth"
    );
}

#[test]
fn retuning_keeps_the_current_envelope() {
    let mut s = Smoother::new(SmoothingProfile::from_responsiveness(0.0));
    for _ in 0..200 {
        s.step(&vec![1.0; BAND_COUNT], 0.016);
    }
    let before = s.levels()[0];
    s.set_profile(SmoothingProfile::from_responsiveness(1.0));
    // Changing the setting mid-track must shift the motion, not blank the bars.
    assert_eq!(s.levels()[0], before);
    assert_eq!(s.profile(), SmoothingProfile::from_responsiveness(1.0));
}

#[test]
fn default_profile_decays_quicker_than_a_third_of_a_second() {
    // Guards the responsiveness complaint that prompted this control: at the
    // default the bars must be most of the way down within ~200 ms.
    let mut s = Smoother::new(SmoothingProfile::default());
    for _ in 0..200 {
        s.step(&vec![1.0; BAND_COUNT], 0.016);
    }
    for _ in 0..12 {
        s.step(&vec![0.0; BAND_COUNT], 0.016);
    }
    assert!(
        s.levels()[0] < 0.2,
        "level after ~190 ms was {}",
        s.levels()[0]
    );
}

#[test]
fn smoother_starts_settled() {
    assert!(Smoother::new(SmoothingProfile::default()).is_settled());
}

#[test]
fn smoother_attacks_faster_than_it_decays() {
    let target = vec![1.0; BAND_COUNT];
    let mut up = Smoother::new(SmoothingProfile::default());
    up.step(&target, 0.016);
    let risen = up.levels()[0];

    let mut down = Smoother::new(SmoothingProfile::default());
    for _ in 0..200 {
        down.step(&target, 0.016);
    }
    let before = down.levels()[0];
    down.step(&vec![0.0; BAND_COUNT], 0.016);
    let fallen = before - down.levels()[0];

    assert!(
        risen > fallen,
        "attack {risen} should outpace decay {fallen}"
    );
}

#[test]
fn smoother_converges_to_its_target() {
    let target = vec![0.75; BAND_COUNT];
    let mut s = Smoother::new(SmoothingProfile::default());
    for _ in 0..500 {
        s.step(&target, 0.016);
    }
    assert!(
        (s.levels()[0] - 0.75).abs() < 0.01,
        "level {}",
        s.levels()[0]
    );
}

#[test]
fn smoother_settles_after_the_signal_stops() {
    let mut s = Smoother::new(SmoothingProfile::default());
    for _ in 0..100 {
        s.step(&vec![1.0; BAND_COUNT], 0.016);
    }
    assert!(!s.is_settled());
    for _ in 0..600 {
        s.step(&vec![0.0; BAND_COUNT], 0.016);
    }
    assert!(s.is_settled(), "levels {:?}", &s.levels()[..4]);
}

#[test]
fn peak_cap_holds_then_falls_and_never_drops_below_the_level() {
    let mut s = Smoother::new(SmoothingProfile::default());
    for _ in 0..300 {
        s.step(&vec![1.0; BAND_COUNT], 0.016);
    }
    let peak_at_top = s.peaks()[0];
    assert!(peak_at_top > 0.9);

    // Immediately after the signal cuts, the cap is still held.
    s.step(&vec![0.0; BAND_COUNT], 0.016);
    assert!(s.peaks()[0] > 0.9, "cap should hang before falling");

    // Well past the hold window it has fallen, but never under the bar.
    for _ in 0..40 {
        s.step(&vec![0.0; BAND_COUNT], 0.016);
    }
    assert!(s.peaks()[0] < peak_at_top, "cap should fall after the hold");
    assert!(
        s.peaks()[0] >= s.levels()[0] - 1e-6,
        "cap fell below its bar"
    );
}

#[test]
fn smoother_motion_is_frame_rate_independent() {
    let target = vec![1.0; BAND_COUNT];
    let mut fast = Smoother::new(SmoothingProfile::default());
    for _ in 0..60 {
        fast.step(&target, 1.0 / 60.0);
    }
    let mut slow = Smoother::new(SmoothingProfile::default());
    for _ in 0..15 {
        slow.step(&target, 1.0 / 15.0);
    }
    // One second of rise either way should land in the same place.
    assert!(
        (fast.levels()[0] - slow.levels()[0]).abs() < 0.02,
        "60fps {} vs 15fps {}",
        fast.levels()[0],
        slow.levels()[0]
    );
}

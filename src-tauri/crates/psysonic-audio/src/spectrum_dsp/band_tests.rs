use super::test_support::windowed_spectrum;
use super::*;

#[test]
fn silence_maps_to_zero_level() {
    assert_eq!(magnitude_to_level(0.0, 0.0), 0.0);
}

#[test]
fn full_scale_maps_to_one() {
    assert!((magnitude_to_level(1.0, 0.0) - 1.0).abs() < 1e-6);
}

#[test]
fn floor_db_maps_to_zero() {
    let mag = 10f32.powf(FLOOR_DB / 20.0);
    assert!(magnitude_to_level(mag, 0.0).abs() < 1e-5);
}

#[test]
fn level_mapping_is_monotonic() {
    let mut prev = -1.0;
    for step in 0..50 {
        let mag = 10f32.powf((FLOOR_DB + step as f32 * 1.5) / 20.0);
        let level = magnitude_to_level(mag, 0.0);
        assert!(level >= prev, "level fell at step {step}");
        prev = level;
    }
}

#[test]
fn tilt_lifts_a_band_by_the_requested_db() {
    let mag = 10f32.powf(-40.0 / 20.0);
    let flat = magnitude_to_level(mag, 0.0);
    let tilted = magnitude_to_level(mag, 12.0);
    let delta_db = (tilted - flat) * -FLOOR_DB;
    assert!((delta_db - 12.0).abs() < 0.01, "tilt delta {delta_db} dB");
}

#[test]
fn band_layout_produces_the_expected_count() {
    assert_eq!(band_layout(48_000).len(), BAND_COUNT);
}

#[test]
fn band_layout_never_reads_dc_or_exceeds_nyquist() {
    for rate in [22_050u32, 44_100, 48_000, 96_000, 192_000] {
        let layout = band_layout(rate);
        for band in &layout {
            assert!(band.lo >= 1, "rate {rate} band reads DC");
            assert!(
                band.hi < FFT_SIZE / 2,
                "rate {rate} band exceeds Nyquist bins"
            );
            assert!(band.lo <= band.hi, "rate {rate} band inverted");
        }
    }
}

#[test]
fn band_layout_is_ascending_and_non_degenerate() {
    for rate in [44_100, 48_000, 96_000, 192_000] {
        let layout = band_layout(rate);
        // Quantised bands may share bins, but neither edge may move
        // backwards and the full layout must still span a useful range.
        for pair in layout.windows(2) {
            assert!(
                pair[1].lo >= pair[0].lo,
                "rate {rate} lo moved backwards: {pair:?}"
            );
            assert!(
                pair[1].hi >= pair[0].hi,
                "rate {rate} hi moved backwards: {pair:?}"
            );
        }
        assert!(layout[BAND_COUNT - 1].hi > layout[0].hi * 4);
    }
}

#[test]
fn unresolved_low_bands_share_real_bins_instead_of_being_displaced() {
    // Band 18 is centred near 70 Hz. A 2,048-point FFT cannot resolve every
    // neighbouring log band there, particularly at high sample rates, so
    // this band must stay on the nearest physical bin rather than being
    // forced to bin 19 merely to make the display bands unique.
    let band_index = 18usize;
    let ratio = (BAND_MAX_HZ / BAND_MIN_HZ).ln() / BAND_COUNT as f32;
    let centre = BAND_MIN_HZ * (ratio * (band_index as f32 + 0.5)).exp();

    for rate in [44_100u32, 48_000, 96_000, 192_000] {
        let layout = band_layout(rate);
        let nearest = ((centre / (rate as f32 / FFT_SIZE as f32)).round() as usize)
            .clamp(1, FFT_SIZE / 2 - 1);
        let band = layout[band_index];
        assert!(
            band.lo <= nearest && nearest <= band.hi,
            "rate {rate}: nominal {centre:.2} Hz band mapped to {band:?}, nearest bin is {nearest}"
        );
        assert!(
            layout[..32].windows(2).any(|pair| pair[0].lo == pair[1].lo),
            "rate {rate}: unresolved bass bands were incorrectly forced unique"
        );
    }
}

#[test]
fn narrow_bass_bands_interpolate_instead_of_plateauing() {
    // At 48 kHz, bands 5..=14 all collapse onto FFT bin 2. Reading that
    // bin verbatim renders them as one flat lockstep plateau — the
    // "squared" left edge. Interpolating at each band's centre frequency
    // must keep neighbouring bars visually distinct.
    let sample_rate = 48_000u32;
    let layout = band_layout(sample_rate);
    let plateau = &layout[5..=14];
    assert!(
        plateau
            .iter()
            .all(|b| b.lo == b.hi && b.lo == plateau[0].lo),
        "test premise broken: bands 5..=14 no longer share one bin: {plateau:?}"
    );

    let mags = windowed_spectrum(60.0, sample_rate as f32, 1.0);
    let mut bands = vec![0.0; BAND_COUNT];
    bands_from_magnitudes(&mags, &layout, &mut bands);
    let distinct = bands[5..=14]
        .windows(2)
        .filter(|pair| (pair[0] - pair[1]).abs() > 1e-6)
        .count();
    assert!(
        distinct >= 5,
        "bands sharing a bin still move in lockstep: {:?}",
        &bands[5..=14]
    );
}

#[test]
fn wide_single_bin_band_keeps_its_peak() {
    let sample_rate = 48_000u32;
    let layout = band_layout(sample_rate);
    let band_index = 57usize;
    let band = layout[band_index];
    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let ratio = (BAND_MAX_HZ / BAND_MIN_HZ).ln() / BAND_COUNT as f32;
    let f_lo = BAND_MIN_HZ * (ratio * band_index as f32).exp();
    let f_hi = BAND_MIN_HZ * (ratio * (band_index + 1) as f32).exp();

    assert!(
        f_hi - f_lo >= bin_hz,
        "test band is no longer at least one bin wide"
    );
    assert_eq!(
        band.lo, band.hi,
        "test band no longer contains exactly one bin"
    );

    let mut mags = vec![0.0; FFT_SIZE / 2];
    mags[band.lo] = 0.1;
    let mut bands = vec![0.0; BAND_COUNT];
    bands_from_magnitudes(&mags, &layout, &mut bands);

    let expected = magnitude_to_level(0.1, band.tilt_db);
    assert!(
        (bands[band_index] - expected).abs() < 1e-6,
        "wide one-bin band blended away from its owned peak: {} vs {expected}",
        bands[band_index]
    );
}

#[test]
fn hi_res_bands_below_bin_one_do_not_plateau() {
    for sample_rate in [96_000u32, 192_000] {
        let layout = band_layout(sample_rate);
        let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
        let ratio = (BAND_MAX_HZ / BAND_MIN_HZ).ln() / BAND_COUNT as f32;
        let below_first_bin = (0..BAND_COUNT)
            .take_while(|band| {
                let centre = BAND_MIN_HZ * (ratio * (*band as f32 + 0.5)).exp();
                centre < bin_hz
            })
            .count();
        assert!(
            below_first_bin > 1,
            "test rate has no sub-bin low-end group"
        );

        let mut mags = vec![0.0; FFT_SIZE / 2];
        mags[0] = 0.2;
        mags[1] = 0.8;
        let mut bands = vec![0.0; BAND_COUNT];
        bands_from_magnitudes(&mags, &layout, &mut bands);

        assert!(
            bands[..below_first_bin]
                .windows(2)
                .all(|pair| (pair[0] - pair[1]).abs() > 1e-6),
            "rate {sample_rate}: bands below bin one still plateau: {:?}",
            &bands[..below_first_bin]
        );
    }
}

#[test]
fn band_layout_survives_absurd_sample_rates() {
    for rate in [0u32, 1, 8_000] {
        let layout = band_layout(rate);
        assert_eq!(layout.len(), BAND_COUNT);
        assert!(layout.iter().all(|b| b.lo >= 1 && b.hi < FFT_SIZE / 2));
    }
}

#[test]
fn tilt_stays_near_the_true_pink_slope() {
    // Over-tilting pushes the treble bands into the ceiling, which flattens
    // the whole spectrum into a uniform wall of near-full-height bars —
    // exactly the "everything looks the same height" failure mode.
    let layout = band_layout(48_000);
    let top = layout[BAND_COUNT - 1].tilt_db;
    assert!(top <= 20.0, "top-band tilt {top} dB is too aggressive");
    assert!(
        top >= 10.0,
        "top-band tilt {top} dB is too weak to lift the treble"
    );
}

#[test]
fn a_realistic_pink_spectrum_keeps_visible_contrast() {
    // Pink noise (−3 dB/octave) is the reference "flat-looking" input. Real
    // music departs from it, and those departures are what the eye reads —
    // so bands must not all pin to the top for a pink-ish input.
    let layout = band_layout(48_000);
    let mut levels = Vec::new();
    for band in &layout {
        let centre_bin = (band.lo + band.hi) as f32 / 2.0;
        let freq = centre_bin * (48_000.0 / FFT_SIZE as f32);
        // −3 dB per octave above 200 Hz, starting at −18 dBFS.
        let db = -18.0 - 3.0 * (freq / 200.0).log2();
        levels.push(magnitude_to_level(10f32.powf(db / 20.0), band.tilt_db));
    }
    let max = levels.iter().copied().fold(0.0f32, f32::max);
    assert!(
        max < 0.98,
        "pink input pinned a band at the ceiling ({max})"
    );
    assert!(max > 0.3, "pink input barely registered ({max})");
}

#[test]
fn tilt_rises_with_frequency() {
    let layout = band_layout(48_000);
    assert!(layout[BAND_COUNT - 1].tilt_db > layout[0].tilt_db);
    assert!(layout.iter().all(|b| b.tilt_db <= TILT_MAX_DB));
}

#[test]
fn representative_tones_keep_their_log_positions_across_sample_rates() {
    // These expected positions come directly from the documented
    // 28 Hz..16 kHz logarithmic display axis, not from the generated bin
    // layout. The former forced-unique mapping put 1 kHz around band 41 at
    // 48 kHz and around band 10 at 192 kHz instead of near band 72.
    for sample_rate in [44_100u32, 48_000, 96_000, 192_000] {
        let layout = band_layout(sample_rate);
        for (freq, expected) in [(1_000.0, 72usize), (8_000.0, 114usize)] {
            let mags = windowed_spectrum(freq, sample_rate as f32, 1.0);
            let mut bands = vec![0.0; BAND_COUNT];
            bands_from_magnitudes(&mags, &layout, &mut bands);
            let (loudest, _) = bands
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .unwrap();
            assert!(
                loudest.abs_diff(expected) <= 4,
                "rate {sample_rate}, tone {freq} Hz: band {loudest}, expected near {expected}"
            );
        }
    }
}

#[test]
fn silence_produces_all_zero_bands() {
    let layout = band_layout(48_000);
    let mags = vec![0.0; FFT_SIZE / 2];
    let mut bands = vec![0.0; BAND_COUNT];
    bands_from_magnitudes(&mags, &layout, &mut bands);
    assert!(bands.iter().all(|v| *v == 0.0));
}

//! Folding a multichannel frame down to stereo.
//!
//! rodio converts every source to the mixer's channel count, and for more
//! channels than the device wants it keeps the first few and discards the rest
//! (`ChannelCountConverter`). On a 5.1 track played through a stereo device that
//! silences centre, LFE and both surrounds — measured: of six channels only
//! front-left and front-right arrive. Whatever a mix puts in those channels is
//! simply gone, which is what issue #1408 reports.
//!
//! The gains live here rather than in the source wrapper because the spectrum
//! tap already folds the same layouts for the waveform and analyser display.
//! Sharing them keeps what is shown and what is heard on one model.

/// Per-channel gain into the left and right output of an interleaved frame.
///
/// Conventional linear fold for the layouts reachable through rodio's
/// channel-count-only API — there is no channel map, so position is inferred
/// from index and count, the same assumption the decoders make:
/// left and right pass through, centre is -3 dB into both, LFE is -6 dB into
/// both, and each surround pair is -3 dB into its own side.
#[inline]
pub(crate) fn fold_gains(channel_idx: usize, channels: usize) -> (f32, f32) {
    const MINUS_3_DB: f32 = std::f32::consts::FRAC_1_SQRT_2;
    const MINUS_6_DB: f32 = 0.5;

    match channel_idx {
        0 => (1.0, 0.0),
        1 => (0.0, 1.0),
        // Quad: no centre, so channels 2 and 3 are the surround pair.
        2 if channels == 4 => (MINUS_3_DB, 0.0),
        3 if channels == 4 => (0.0, MINUS_3_DB),
        2 => (MINUS_3_DB, MINUS_3_DB),
        // 5.0: centre, then a surround pair, and no LFE in between.
        3 if channels == 5 => (MINUS_3_DB, 0.0),
        4 if channels == 5 => (0.0, MINUS_3_DB),
        3 => (MINUS_6_DB, MINUS_6_DB),
        // 6.1 breaks the pairing: its order is FL FR FC LFE **RC** SL SR, so the
        // rear centre sits at index 4 where every other layout has a left
        // surround, and the side pair follows one slot late. Read as pairs, the
        // rear centre would be panned hard left and the side channels swapped.
        // Order from symphonia's own FLAC channel map.
        4 if channels == 7 => (MINUS_3_DB, MINUS_3_DB),
        5 if channels == 7 => (MINUS_3_DB, 0.0),
        6 if channels == 7 => (0.0, MINUS_3_DB),
        // Everything past the LFE comes in pairs: left, right, left, right.
        // Holds for 5.1 (RL RR) and 7.1 (RL RR SL SR).
        channel => {
            if (channel - 4) % 2 == 0 {
                (MINUS_3_DB, 0.0)
            } else {
                (0.0, MINUS_3_DB)
            }
        }
    }
}

/// How much to attenuate a fold so it lands at a sensible level.
///
/// Summing channels can exceed full scale where discarding them never could, so
/// some attenuation is needed. The question is how much, and the answer decides
/// how loud a 5.1 track plays next to the stereo tracks around it in a queue.
///
/// Scaled by the *power* sum, not the amplitude sum. Amplitudes only add up
/// fully when every channel carries the same signal at full scale, which real
/// material does not do; unrelated channels add in power. For 5.1 that is
/// `sqrt(1 + 0.5 + 0.25 + 0.5)` = 1.5, about -3.5 dB — close to what other
/// players do. The amplitude worst case would be 2.914, nearly -9.3 dB, and a
/// 5.1 track would sound conspicuously quiet for a case that does not occur.
///
/// Correlated content can still exceed full scale, which is what the clamp in
/// `FoldToStereo` is for.
#[inline]
pub(crate) fn fold_normalisation(channels: usize) -> f32 {
    let mut left_power = 0.0f32;
    let mut right_power = 0.0f32;
    for idx in 0..channels {
        let (l, r) = fold_gains(idx, channels);
        left_power += l * l;
        right_power += r * r;
    }
    let loudest = left_power.max(right_power).sqrt();
    if loudest > 1.0 {
        1.0 / loudest
    } else {
        1.0
    }
}

/// Folds an interleaved multichannel source down to stereo.
///
/// Sits after resampling so everything downstream — EQ, fades, the spectrum tap,
/// the sample counter — works on the two channels that will actually be played,
/// and so the sample count the position is derived from matches the output.
pub(crate) struct FoldToStereo<S> {
    inner: S,
    channels: usize,
    scale: f32,
    /// The right sample of the frame just folded, handed out on the next call.
    pending_right: Option<f32>,
}

impl<S> FoldToStereo<S> {
    pub(crate) fn new(inner: S, channels: usize) -> Self {
        Self { inner, channels, scale: fold_normalisation(channels), pending_right: None }
    }
}

impl<S> Iterator for FoldToStereo<S>
where
    S: Iterator<Item = f32>,
{
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if let Some(right) = self.pending_right.take() {
            return Some(right);
        }
        let mut left = 0.0f32;
        let mut right = 0.0f32;
        for idx in 0..self.channels {
            // A frame that ends mid-way cannot be folded: the remaining channels
            // would be read as silence and skew the mix. Dropping that partial
            // frame costs a fraction of a millisecond at the very end.
            let sample = self.inner.next()?;
            let (left_gain, right_gain) = fold_gains(idx, self.channels);
            left += sample * left_gain;
            right += sample * right_gain;
        }
        // Power scaling leaves headroom for ordinary material but not for a mix
        // whose channels carry the same signal; clamp rather than wrap.
        self.pending_right = Some((right * self.scale).clamp(-1.0, 1.0));
        Some((left * self.scale).clamp(-1.0, 1.0))
    }
}

impl<S> rodio::Source for FoldToStereo<S>
where
    S: rodio::Source<Item = f32>,
{
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        // Reported in samples, so it shrinks with the channel count.
        //
        // `Some(0)` has to survive: rodio defines `is_exhausted()` as exactly
        // `current_span_len() == Some(0)`, and its queue relies on that to look
        // ahead to the next source's channel count and rate. Rounding an ended
        // span up to a non-zero value leaves the queue reporting the finished
        // source's shape at a gapless boundary.
        self.inner.current_span_len().map(|len| {
            let owed = usize::from(self.pending_right.is_some());
            if len == 0 {
                // Genuinely finished — only the owed sample can still come out.
                return owed;
            }
            // Whole output frames — a span ending mid-frame is what makes rodio's
            // converters start on the wrong channel — plus the sample still owed
            // from the frame already folded.
            //
            // At least one frame while the inner span is non-empty: a span that
            // is not a whole number of input frames (a duration-derived one, as
            // `TakeDuration` produces) would otherwise truncate to zero and read
            // as exhausted while `next()` can still assemble a frame across the
            // boundary.
            (len / self.channels).max(1) * 2 + owed
        })
    }

    #[inline]
    fn channels(&self) -> rodio::ChannelCount {
        std::num::NonZeroU16::new(2).unwrap_or(std::num::NonZeroU16::MIN)
    }

    #[inline]
    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }

    #[inline]
    fn total_duration(&self) -> Option<std::time::Duration> {
        self.inner.total_duration()
    }

    #[inline]
    fn try_seek(&mut self, pos: std::time::Duration) -> Result<(), rodio::source::SeekError> {
        // The owed right sample is *not* dropped. Removing one sample shifts the
        // interleave parity by one, and nothing downstream resynchronises: every
        // left sample would land in the device's right slot for the rest of the
        // track. Seeks arrive from `periodic_access` on an odd stride, so they
        // land mid-frame about half the time.
        //
        // So it is kept either way: the consumer has just been handed a left
        // sample and is owed the matching right one. It carries a single sample
        // of the old position — 23 microseconds — and then the next frame starts
        // cleanly at the new one. Swapped channels for a whole track is the worse
        // trade by a wide margin.
        self.inner.try_seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUS_3_DB: f32 = std::f32::consts::FRAC_1_SQRT_2;

    #[test]
    fn stereo_passes_through_untouched() {
        assert_eq!(fold_gains(0, 2), (1.0, 0.0));
        assert_eq!(fold_gains(1, 2), (0.0, 1.0));
        assert_eq!(fold_normalisation(2), 1.0);
    }

    #[test]
    fn five_point_one_routes_every_channel_somewhere() {
        // The defect this exists for: centre, LFE and both surrounds were
        // dropped outright. Every one of them has to reach an output.
        for idx in 0..6 {
            let (l, r) = fold_gains(idx, 6);
            assert!(l > 0.0 || r > 0.0, "channel {idx} of 5.1 goes nowhere");
        }
        assert_eq!(fold_gains(2, 6), (MINUS_3_DB, MINUS_3_DB), "centre feeds both");
        assert_eq!(fold_gains(3, 6), (0.5, 0.5), "LFE feeds both, quieter");
        assert_eq!(fold_gains(4, 6), (MINUS_3_DB, 0.0), "left surround stays left");
        assert_eq!(fold_gains(5, 6), (0.0, MINUS_3_DB), "right surround stays right");
    }

    #[test]
    fn quad_and_five_zero_place_their_surrounds_correctly() {
        // Without a centre (quad) or without an LFE (5.0) the indices shift, and
        // reading them as 5.1 would put a surround into the wrong side.
        assert_eq!(fold_gains(2, 4), (MINUS_3_DB, 0.0));
        assert_eq!(fold_gains(3, 4), (0.0, MINUS_3_DB));
        assert_eq!(fold_gains(3, 5), (MINUS_3_DB, 0.0));
        assert_eq!(fold_gains(4, 5), (0.0, MINUS_3_DB));
    }

    #[test]
    fn normalisation_follows_the_power_sum() {
        // Scaling by the amplitude worst case would put 5.1 at about -9.3 dB and
        // make it audibly quieter than the stereo tracks around it. Power summing
        // assumes channels are not carrying identical signals, which is what real
        // material looks like, and lands near -3.5 dB.
        let mut power = 0.0f32;
        for idx in 0..6 {
            power += fold_gains(idx, 6).0.powi(2);
        }
        let expected = 1.0 / power.sqrt();
        assert!((fold_normalisation(6) - expected).abs() < 1e-6);

        let db = 20.0 * fold_normalisation(6).log10();
        assert!(db > -4.5 && db < -3.0, "5.1 fold attenuates {db} dB");
    }

    /// Interleaved source where each channel carries its own constant, so the
    /// output names the channels it was built from.
    #[derive(Clone)]
    struct Labelled {
        pos: usize,
        channels: usize,
        frames: usize,
    }

    impl Iterator for Labelled {
        type Item = f32;
        fn next(&mut self) -> Option<f32> {
            if self.pos >= self.frames * self.channels {
                return None;
            }
            let channel = self.pos % self.channels;
            self.pos += 1;
            // Scaled to a realistic level: at 1.0 per channel the fold would run
            // into its clamp and every assertion below would read 1.0.
            Some((channel as f32 + 1.0) * 0.1)
        }
    }

    impl rodio::Source for Labelled {
        fn current_span_len(&self) -> Option<usize> {
            Some(self.frames * self.channels)
        }
        fn channels(&self) -> rodio::ChannelCount {
            std::num::NonZeroU16::new(self.channels as u16).unwrap()
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            std::num::NonZeroU32::new(44_100).unwrap()
        }
        fn total_duration(&self) -> Option<std::time::Duration> {
            None
        }
    }

    #[test]
    fn every_channel_of_a_five_one_frame_reaches_the_output() {
        // Issue #1408: a 5.1 track lost centre, LFE and both surrounds on a
        // stereo device because rodio keeps the first two channels and discards
        // the rest. Each contribution has to be present in the sum.
        let source = Labelled { pos: 0, channels: 6, frames: 4 };
        let folded: Vec<f32> = FoldToStereo::new(source, 6).take(2).collect();

        let scale = fold_normalisation(6);
        let expected_left = (0.1 + 0.3 * MINUS_3_DB + 0.4 * 0.5 + 0.5 * MINUS_3_DB) * scale;
        let expected_right = (0.2 + 0.3 * MINUS_3_DB + 0.4 * 0.5 + 0.6 * MINUS_3_DB) * scale;

        assert!((folded[0] - expected_left).abs() < 1e-6, "left was {}", folded[0]);
        assert!((folded[1] - expected_right).abs() < 1e-6, "right was {}", folded[1]);

        // The failure mode being fixed: output that contains only channels 1
        // and 2 — that is what discarding looks like.
        assert!(
            (folded[0] - 0.1).abs() > 1e-6 && (folded[1] - 0.2).abs() > 1e-6,
            "output still looks like the bare front pair"
        );
    }

    #[test]
    fn an_exhausted_inner_span_stays_exhausted() {
        // rodio defines `is_exhausted()` as exactly `current_span_len() == Some(0)`
        // and its queue uses that to look ahead at the next source's channel count
        // and rate. Rounding an ended span up to a non-zero value leaves the queue
        // describing the finished source at a gapless boundary.
        use rodio::Source as _;
        let source = Labelled { pos: 0, channels: 6, frames: 0 };
        let folded = FoldToStereo::new(source, 6);
        assert_eq!(folded.current_span_len(), Some(0));
        assert!(folded.is_exhausted());
    }

    #[test]
    fn a_pending_right_sample_is_counted_in_the_span() {
        // Half a frame is owed after every odd call, and a span that forgets it
        // under-reports by one — the same off-by-one that puts rodio's converters
        // on the wrong channel.
        use rodio::Source as _;
        let source = Labelled { pos: 0, channels: 6, frames: 4 };
        let mut folded = FoldToStereo::new(source, 6);
        assert_eq!(folded.current_span_len(), Some(8));
        let _left = folded.next().expect("a left sample");
        assert_eq!(
            folded.current_span_len(),
            Some(9),
            "the span still measures four frames — it reports a size, not a \
             remainder — plus the one sample owed, which is what puts the stream \
             back on a frame boundary"
        );
    }

    #[test]
    fn seeking_keeps_the_owed_right_sample_so_the_channels_do_not_swap() {
        // Dropping it removes one sample from an interleaved stream, and nothing
        // downstream resynchronises: left would land in the device's right slot
        // for the rest of the track. Seeks arrive on an odd stride, so they hit
        // mid-frame about half the time.
        use rodio::Source as _;
        let source = Labelled { pos: 0, channels: 6, frames: 8 };
        let mut folded = FoldToStereo::new(source, 6);

        let first_left = folded.next().expect("a left sample");
        assert!(folded.pending_right.is_some(), "a right sample is now owed");

        // `Labelled` has no seek support, which is the interesting case: a refused
        // seek must not consume it either.
        let _ = folded.try_seek(std::time::Duration::from_millis(10));
        assert!(
            folded.pending_right.is_some(),
            "the owed right sample must survive a seek attempt"
        );

        let right = folded.next().expect("the owed right sample");
        assert!(right != first_left, "left and right must stay distinguishable");
    }

    #[test]
    fn six_one_places_its_rear_centre_and_side_pair_correctly() {
        // 6.1 is the one layout that does not continue the pairs: FL FR FC LFE
        // RC SL SR. The rear centre is index 4 — where 5.1 and 7.1 have a left
        // surround — and reading it as a pair puts the rear centre in the left
        // speaker and swaps the sides. Indices per symphonia's FLAC channel map.
        assert_eq!(fold_gains(4, 7), (MINUS_3_DB, MINUS_3_DB), "rear centre feeds both");
        assert_eq!(fold_gains(5, 7), (MINUS_3_DB, 0.0), "side left stays left");
        assert_eq!(fold_gains(6, 7), (0.0, MINUS_3_DB), "side right stays right");
    }

    #[test]
    fn the_layouts_that_do_continue_the_pairs_are_unaffected() {
        // 5.1: RL RR after the LFE. 7.1: RL RR SL SR. Both alternate, and the
        // 6.1 exception must not disturb them.
        assert_eq!(fold_gains(4, 6), (MINUS_3_DB, 0.0));
        assert_eq!(fold_gains(5, 6), (0.0, MINUS_3_DB));
        for (idx, expected) in [
            (4, (MINUS_3_DB, 0.0)),
            (5, (0.0, MINUS_3_DB)),
            (6, (MINUS_3_DB, 0.0)),
            (7, (0.0, MINUS_3_DB)),
        ] {
            assert_eq!(fold_gains(idx, 8), expected, "7.1 index {idx}");
        }
    }

    #[test]
    fn the_folded_source_reports_stereo_and_whole_frames() {
        use rodio::Source as _;
        let source = Labelled { pos: 0, channels: 6, frames: 4 };
        let folded = FoldToStereo::new(source, 6);
        assert_eq!(folded.channels().get(), 2);
        let span = folded.current_span_len().expect("a finite span");
        assert_eq!(span, 8, "4 frames of stereo");
        assert_eq!(span % 2, 0, "a span must not end mid-frame");
    }

    #[test]
    fn folding_a_five_one_frame_stays_within_full_scale() {
        // Worst case: every channel at full scale at once.
        struct AllOnes(usize);
        impl Iterator for AllOnes {
            type Item = f32;
            fn next(&mut self) -> Option<f32> {
                self.0 = self.0.saturating_sub(1);
                if self.0 == 0 { None } else { Some(1.0) }
            }
        }
        impl rodio::Source for AllOnes {
            fn current_span_len(&self) -> Option<usize> { None }
            fn channels(&self) -> rodio::ChannelCount { std::num::NonZeroU16::new(6).unwrap() }
            fn sample_rate(&self) -> rodio::SampleRate { std::num::NonZeroU32::new(44_100).unwrap() }
            fn total_duration(&self) -> Option<std::time::Duration> { None }
        }

        let folded: Vec<f32> = FoldToStereo::new(AllOnes(64), 6).take(8).collect();
        for sample in folded {
            assert!(sample.abs() <= 1.0 + f32::EPSILON, "fold clipped at {sample}");
        }
    }

    #[test]
    fn stereo_is_not_quietened_by_normalisation() {
        // The common case must sound exactly as before — a fix for multichannel
        // playback that lowers every stereo track would be a poor trade.
        assert_eq!(fold_normalisation(2), 1.0);
        assert_eq!(fold_normalisation(1), 1.0);
    }
}

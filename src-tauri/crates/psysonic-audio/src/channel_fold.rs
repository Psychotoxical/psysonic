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
        // Everything past the LFE alternates side by side.
        channel => {
            if (channel - 4) % 2 == 0 {
                (MINUS_3_DB, 0.0)
            } else {
                (0.0, MINUS_3_DB)
            }
        }
    }
}

/// The loudest a fold can get, used to keep it from clipping.
///
/// Summing channels can exceed full scale where the discard never could: 5.1
/// with identical content everywhere reaches roughly 2.2× on each side. Scaling
/// by the layout's own worst case keeps the result inside range and, more
/// importantly, keeps it *predictable* — a track does not change loudness
/// depending on how much its surrounds happen to correlate.
#[inline]
pub(crate) fn fold_normalisation(channels: usize) -> f32 {
    let mut left = 0.0f32;
    let mut right = 0.0f32;
    for idx in 0..channels {
        let (l, r) = fold_gains(idx, channels);
        left += l;
        right += r;
    }
    let loudest = left.max(right);
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
        self.pending_right = Some(right * self.scale);
        Some(left * self.scale)
    }
}

impl<S> rodio::Source for FoldToStereo<S>
where
    S: rodio::Source<Item = f32>,
{
    #[inline]
    fn current_span_len(&self) -> Option<usize> {
        // Reported in samples, so it shrinks with the channel count. Rounded down
        // to whole output frames: half a frame here is what makes rodio's
        // converters start on the wrong channel.
        self.inner.current_span_len().map(|len| {
            let frames = len / self.channels;
            (frames * 2).max(if self.pending_right.is_some() { 1 } else { 2 })
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
        // The half-frame in flight belongs to the old position.
        self.pending_right = None;
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
    fn normalisation_keeps_a_full_scale_fold_in_range() {
        for channels in [2usize, 4, 5, 6, 8] {
            let scale = fold_normalisation(channels);
            let mut left = 0.0f32;
            for idx in 0..channels {
                left += fold_gains(idx, channels).0;
            }
            assert!(
                left * scale <= 1.0 + f32::EPSILON,
                "{channels} channels at full scale reach {} after scaling",
                left * scale
            );
        }
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
            Some(channel as f32 + 1.0)
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
        let expected_left = (1.0 + 3.0 * MINUS_3_DB + 4.0 * 0.5 + 5.0 * MINUS_3_DB) * scale;
        let expected_right = (2.0 + 3.0 * MINUS_3_DB + 4.0 * 0.5 + 6.0 * MINUS_3_DB) * scale;

        assert!((folded[0] - expected_left).abs() < 1e-6, "left was {}", folded[0]);
        assert!((folded[1] - expected_right).abs() < 1e-6, "right was {}", folded[1]);

        // The failure mode being fixed: output that contains only channels 1
        // and 2 — that is what discarding looks like.
        assert!(
            (folded[0] - 1.0).abs() > 1e-6 && (folded[1] - 2.0).abs() > 1e-6,
            "output still looks like the bare front pair"
        );
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

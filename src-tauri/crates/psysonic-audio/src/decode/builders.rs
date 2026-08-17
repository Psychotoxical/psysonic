use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64};
use std::sync::Arc;
use std::time::Duration;

use rodio::source::UniformSourceIterator;
use rodio::Source;

use crate::playback_rate::{PlaybackRateAtomics, PlaybackRateSource};
use crate::sources::*;
use crate::spectrum::SpectrumTapSource;

use super::decoder::SizedDecoder;
use super::format::ResolvedCodecInfo;
use super::gapless::parse_gapless_info;

pub(crate) type BuiltSourceStack = PriorityBoostSource<
    CountingSource<
        NotifyingSource<SpectrumTapSource<TriggeredFadeOut<EqualPowerFadeIn<EqSource<DynSource>>>>>,
    >,
>;

/// Result of build_source: the fully-wrapped source plus metadata and control Arcs.
pub(crate) struct BuiltSource {
    pub(crate) source: BuiltSourceStack,
    pub(crate) duration_secs: f64,
    pub(crate) output_rate: u32,
    pub(crate) output_channels: u16,
    /// Real decoded stream format for the `audio:format` event. None only if the
    /// source could not report codec params.
    pub(crate) resolved_format: Option<ResolvedCodecInfo>,
    /// Trigger for the sample-level crossfade fade-out.
    pub(crate) fadeout_trigger: Arc<AtomicBool>,
    /// Total samples for the fade-out (set before triggering).
    pub(crate) fadeout_samples: Arc<AtomicU64>,
}

/// Duration the built source will actually deliver.
///
/// The server hint is whole seconds — `sync/mapping.rs` rounds the API value
/// before it reaches the local index — so it sits up to half a second either
/// side of the real length. It is still the better number for a VBR MP3, whose
/// container duration is an estimate.
///
/// Encoder-gap trimming changes that for one class of stream: once the decoder
/// removes delay and padding, its own frame count *is* what comes out, and the
/// crossfade schedules its fade against exactly that value (`commands.rs`:
/// `remaining = duration_secs - position()`). Preferring the hint there hands
/// the scheduler a length the source will not reach.
///
/// Deliberately narrow: only the decoder-owned trim is covered. `build_source`'s
/// manual `iTunSMPB` trim shortens the stream too, but it has done so since the
/// gapless parser landed and its duration is not this change's to fix.
fn effective_source_duration(decoder: &SizedDecoder, duration_hint: f64) -> f64 {
    let decoded = decoder
        .total_duration()
        .map(|d| d.as_secs_f64())
        .filter(|d| *d > 0.0);
    if decoder.applies_builtin_gapless() {
        if let Some(decoded) = decoded {
            return decoded;
        }
    }
    if duration_hint > 1.0 {
        return duration_hint;
    }
    decoded.unwrap_or(duration_hint)
}

/// Build a fully-prepared playback source:
///   decode → trim → resample → EQ → fade-in → triggered-fade-out → notify → count
///
/// `fade_in_dur`:
///   • `Duration::ZERO`          — unity gain; used for gapless chain (no click)
///   • `Duration::from_millis(5)` — micro-fade; used for hard cuts (anti-click)
///   • `Duration::from_secs_f32(cf)` — full equal-power fade-in for crossfade
///
/// `sample_counter`: atomic counter incremented per sample for drift-free position.
/// `target_rate`: canonical output sample rate for resampling (0 = no resampling).
/// `format_hint`: optional file extension (e.g. "flac", "mp3") to help symphonia probe.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_source(
    data: Vec<u8>,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    eq_pre_gain: Arc<AtomicU32>,
    playback_rate: PlaybackRateAtomics,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    // Channels the output device takes; 0 when that is not known yet.
    target_channels: u16,
    format_hint: Option<&str>,
    hi_res: bool,
) -> Result<BuiltSource, String> {
    let gapless = parse_gapless_info(&data);

    let decoder = SizedDecoder::new(data, format_hint, hi_res)?;
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();
    let resolved_format = Some(decoder.codec_info().clone());
    // Skip the manual trim when the decoder already applied the encoder gap
    // (MP3/Xing-LAME) — trimming both would cut real audio off the track.
    let manual_trim = !decoder.applies_builtin_gapless();
    // One exception, and it is not symmetrical: the decoder can own the front
    // gap while owning no end at all. LAME writes delay and padding independently
    // of Xing's optional `FRAMES` field, and without a frame count the demuxer has
    // no end timestamp to build a `trim_end` from — such a file would keep its
    // padding at exactly the boundary this fix exists to close. The manual end
    // trim stays available for it, while the delay stays with the decoder so the
    // front is not cut twice.
    let manual_end_trim_only = !manual_trim
        && !decoder.applies_builtin_end_trim()
        && gapless.total_valid_samples.is_some();

    let effective_dur = effective_source_duration(&decoder, duration_hint);

    // Apply encoder-delay trim and optional end-padding trim,
    // then resample to the canonical target rate if needed.
    let dyn_src: DynSource = if (manual_trim || manual_end_trim_only)
        && (gapless.delay_samples > 0 || gapless.total_valid_samples.is_some())
    {
        // `total_valid_samples` counts the real audio from `iTunSMPB`'s own delay,
        // which is not necessarily the delay the decoder removed — iTunes
        // re-tagging a LAME-encoded file leaves both, and they can disagree. Skip
        // only what is left of it, so the total lands on the same sample either
        // way. When the decoder cut more than `iTunSMPB` claims, the difference is
        // already gone and the total simply starts where the audio does.
        let delay_samples = if manual_trim {
            gapless.delay_samples
        } else {
            gapless
                .delay_samples
                .saturating_sub(decoder.builtin_gapless_delay_frames() as u64)
        };
        let delay_dur = Duration::from_secs_f64(delay_samples as f64 / sample_rate.get() as f64);
        let base = decoder.skip_duration(delay_dur);

        if let Some(total) = gapless.total_valid_samples {
            let valid_dur = Duration::from_secs_f64(total as f64 / sample_rate.get() as f64);
            let trimmed = base.take_duration(valid_dur);
            if target_rate > 0 && sample_rate.get() != target_rate {
                DynSource::new(UniformSourceIterator::new(
                    trimmed,
                    channels,
                    std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
                ))
            } else {
                DynSource::new(trimmed)
            }
        } else if target_rate > 0 && sample_rate.get() != target_rate {
            DynSource::new(UniformSourceIterator::new(
                base,
                channels,
                std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
            ))
        } else {
            DynSource::new(base)
        }
    } else {
        let converted = decoder;
        if target_rate > 0 && sample_rate.get() != target_rate {
            DynSource::new(UniformSourceIterator::new(
                converted,
                channels,
                std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
            ))
        } else {
            DynSource::new(converted)
        }
    };

    let output_rate = if target_rate > 0 && sample_rate.get() != target_rate {
        target_rate
    } else {
        sample_rate.get()
    };

    // Fold before everything downstream, so EQ, fades, the spectrum tap and the
    // sample counter all see the channels that will be played.
    let (dyn_src, output_channels) = fold_to_output_channels(dyn_src, channels, target_channels);

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let rate_src = PlaybackRateSource::new(dyn_src, playback_rate.clone());
    let rate_dyn = DynSource::new(rate_src);
    let eq_src = EqSource::new(rate_dyn, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    // Per-track visualizer tap: post-EQ/post-fade and pre-sink volume. During a
    // crossfade its exclusive lease follows the incoming track/metadata; rodio
    // mixes the two players later, so this is intentionally not a post-mix sum.
    let tapped = SpectrumTapSource::new(fade_out);
    let notifying = NotifyingSource::new(tapped, done_flag);
    let counting = CountingSource::new(notifying, sample_counter);
    let boosted = PriorityBoostSource::new(counting);

    Ok(BuiltSource {
        source: boosted,
        duration_secs: crate::playback_rate::effective_duration_secs(effective_dur, &playback_rate),
        output_rate,
        output_channels,
        resolved_format,
        fadeout_trigger,
        fadeout_samples,
    })
}

/// Mixes a multichannel source down to stereo when the device cannot take its
/// channels, and reports the channel count the rest of the pipeline will see.
///
/// Without this, rodio's mixer converts by keeping the first channels and
/// dropping the others, so a 5.1 track on a stereo device loses centre, LFE and
/// both surrounds outright (issue #1408).
///
/// `target_channels` of 0 means "unknown" — the device has not reported yet, and
/// passing the source through unchanged leaves the previous behaviour rather
/// than guessing a layout.
fn fold_to_output_channels(
    source: DynSource,
    channels: std::num::NonZeroU16,
    target_channels: u16,
) -> (DynSource, u16) {
    // Only the stereo fold exists. A device with more channels than two but
    // fewer than the source (a 4.0 output fed 5.1, say) keeps rodio's behaviour;
    // it needs its own layout mapping, not this one.
    if target_channels != 2 || channels.get() <= 2 {
        return (source, channels.get());
    }
    let folded = crate::channel_fold::FoldToStereo::new(source, channels.get() as usize);
    (DynSource::new(folded), 2)
}

/// Streaming variant of `build_source`: uses a live `SizedDecoder` source
/// (non-seekable) and skips iTunSMPB parsing, but preserves the same EQ/fade/
/// counting wrappers and output metadata.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_streaming_source(
    decoder: SizedDecoder,
    duration_hint: f64,
    eq_gains: Arc<[AtomicU32; 10]>,
    eq_enabled: Arc<AtomicBool>,
    eq_pre_gain: Arc<AtomicU32>,
    playback_rate: PlaybackRateAtomics,
    done_flag: Arc<AtomicBool>,
    fade_in_dur: Duration,
    sample_counter: Arc<AtomicU64>,
    target_rate: u32,
    // Channels the output device takes; 0 when that is not known yet.
    target_channels: u16,
    count_gate: Option<Arc<AtomicBool>>,
) -> Result<BuiltSource, String> {
    let sample_rate = decoder.sample_rate();
    let channels = decoder.channels();
    let resolved_format = Some(decoder.codec_info().clone());

    let effective_dur = effective_source_duration(&decoder, duration_hint);

    let converted = decoder;
    let dyn_src: DynSource = if target_rate > 0 && sample_rate.get() != target_rate {
        DynSource::new(UniformSourceIterator::new(
            converted,
            channels,
            std::num::NonZeroU32::new(target_rate).unwrap_or(std::num::NonZeroU32::MIN),
        ))
    } else {
        DynSource::new(converted)
    };

    let output_rate = if target_rate > 0 && sample_rate.get() != target_rate {
        target_rate
    } else {
        sample_rate.get()
    };

    // Same reasoning as `build_source`: fold first, so everything after it works
    // on the channels that will be played.
    let (dyn_src, output_channels) = fold_to_output_channels(dyn_src, channels, target_channels);

    let fadeout_trigger = Arc::new(AtomicBool::new(false));
    let fadeout_samples = Arc::new(AtomicU64::new(0));

    let rate_src = PlaybackRateSource::new(dyn_src, playback_rate.clone());
    let rate_dyn = DynSource::new(rate_src);
    let eq_src = EqSource::new(rate_dyn, eq_gains, eq_enabled, eq_pre_gain);
    let fade_in = EqualPowerFadeIn::new(eq_src, fade_in_dur);
    let fade_out = TriggeredFadeOut::new(fade_in, fadeout_trigger.clone(), fadeout_samples.clone());
    // Same per-track/incoming-lease semantics as `build_source` above.
    let tapped = SpectrumTapSource::new(fade_out);
    let notifying = NotifyingSource::new(tapped, done_flag);
    let counting = match count_gate {
        Some(gate) => CountingSource::new_gated(notifying, sample_counter, gate),
        None => CountingSource::new(notifying, sample_counter),
    };
    let boosted = PriorityBoostSource::new(counting);

    Ok(BuiltSource {
        source: boosted,
        duration_secs: crate::playback_rate::effective_duration_secs(effective_dur, &playback_rate),
        output_rate,
        output_channels,
        resolved_format,
        fadeout_trigger,
        fadeout_samples,
    })
}

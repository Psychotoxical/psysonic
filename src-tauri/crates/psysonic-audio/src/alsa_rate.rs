//! Linux ALSA sample-rate negotiation guard for CPAL/Rodio output streams.

use alsa::pcm::{Access, Format, HwParams, PCM};
use alsa::{Direction, ValueOr};
use rodio::cpal::traits::DeviceTrait;
use rodio::cpal::{Device, SampleFormat, SupportedStreamConfig};

fn alsa_format_candidates(format: SampleFormat) -> Option<(Format, Option<Format>)> {
    Some(match format {
        SampleFormat::I8 => (Format::S8, None),
        SampleFormat::U8 => (Format::U8, None),
        #[cfg(target_endian = "little")]
        SampleFormat::I16 => (Format::S16LE, Some(Format::S16BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::I16 => (Format::S16BE, Some(Format::S16LE)),
        #[cfg(target_endian = "little")]
        SampleFormat::I24 => (Format::S24LE, Some(Format::S24BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::I24 => (Format::S24BE, Some(Format::S24LE)),
        #[cfg(target_endian = "little")]
        SampleFormat::I32 => (Format::S32LE, Some(Format::S32BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::I32 => (Format::S32BE, Some(Format::S32LE)),
        #[cfg(target_endian = "little")]
        SampleFormat::U16 => (Format::U16LE, Some(Format::U16BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::U16 => (Format::U16BE, Some(Format::U16LE)),
        #[cfg(target_endian = "little")]
        SampleFormat::U24 => (Format::U24LE, Some(Format::U24BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::U24 => (Format::U24BE, Some(Format::U24LE)),
        #[cfg(target_endian = "little")]
        SampleFormat::U32 => (Format::U32LE, Some(Format::U32BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::U32 => (Format::U32BE, Some(Format::U32LE)),
        #[cfg(target_endian = "little")]
        SampleFormat::F32 => (Format::FloatLE, Some(Format::FloatBE)),
        #[cfg(target_endian = "big")]
        SampleFormat::F32 => (Format::FloatBE, Some(Format::FloatLE)),
        #[cfg(target_endian = "little")]
        SampleFormat::F64 => (Format::Float64LE, Some(Format::Float64BE)),
        #[cfg(target_endian = "big")]
        SampleFormat::F64 => (Format::Float64BE, Some(Format::Float64LE)),
        _ => return None,
    })
}

fn alsa_format(params: &HwParams<'_>, format: SampleFormat) -> Option<Format> {
    let (native, opposite) = alsa_format_candidates(format)?;
    if params.test_format(native).is_ok() {
        Some(native)
    } else {
        opposite.filter(|candidate| params.test_format(*candidate).is_ok())
    }
}

/// Mirror CPAL's ALSA format/rate/channel constraints and return the rate ALSA
/// actually selects. CPAL 0.17 uses `ValueOr::Nearest` but retains the requested
/// rate in its callback configuration, which changes playback speed when ALSA
/// silently chooses another rate.
pub(super) fn negotiated_output_rate(
    device: &Device,
    config: &SupportedStreamConfig,
) -> Option<u32> {
    let pcm_id = device.description().ok()?.driver()?.to_string();
    let pcm = PCM::new(&pcm_id, Direction::Playback, true).ok()?;
    let params = HwParams::any(&pcm).ok()?;
    params.set_access(Access::RWInterleaved).ok()?;
    params
        .set_format(alsa_format(&params, config.sample_format())?)
        .ok()?;
    params
        .set_rate(config.sample_rate(), ValueOr::Nearest)
        .ok()?;
    params.set_channels(config.channels() as u32).ok()?;
    params.get_rate().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_formats_used_by_cpal_alsa_output() {
        for format in [
            SampleFormat::I8,
            SampleFormat::I16,
            SampleFormat::I24,
            SampleFormat::I32,
            SampleFormat::U8,
            SampleFormat::U16,
            SampleFormat::U24,
            SampleFormat::U32,
            SampleFormat::F32,
            SampleFormat::F64,
        ] {
            assert!(
                alsa_format_candidates(format).is_some(),
                "missing mapping for {format}"
            );
        }
    }
}

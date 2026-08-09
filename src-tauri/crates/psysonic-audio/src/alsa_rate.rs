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
) -> Result<u32, String> {
    let description = device
        .description()
        .map_err(|error| format!("failed to describe ALSA output device: {error}"))?;
    let pcm_id = description
        .driver()
        .ok_or_else(|| "ALSA output device has no PCM identifier".to_string())?
        .to_string();
    let pcm = PCM::new(&pcm_id, Direction::Playback, true)
        .map_err(|error| format!("failed to open ALSA PCM '{pcm_id}': {error}"))?;
    let params = HwParams::any(&pcm)
        .map_err(|error| format!("failed to query ALSA hardware parameters: {error}"))?;
    params
        .set_access(Access::RWInterleaved)
        .map_err(|error| format!("failed to select ALSA interleaved access: {error}"))?;
    params
        .set_format(
            alsa_format(&params, config.sample_format())
                .ok_or_else(|| format!("ALSA does not support {} output", config.sample_format()))?,
        )
        .map_err(|error| format!("failed to select ALSA sample format: {error}"))?;
    params
        .set_rate(config.sample_rate(), ValueOr::Nearest)
        .map_err(|error| format!("failed to negotiate ALSA sample rate: {error}"))?;
    params
        .set_channels(config.channels() as u32)
        .map_err(|error| format!("failed to select ALSA channel count: {error}"))?;
    params
        .get_rate()
        .map_err(|error| format!("failed to read negotiated ALSA sample rate: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_formats_used_by_cpal_alsa_output() {
        let mut expected = vec![
            (SampleFormat::I8, (Format::S8, None)),
            (SampleFormat::U8, (Format::U8, None)),
        ];
        #[cfg(target_endian = "little")]
        expected.extend([
            (SampleFormat::I16, (Format::S16LE, Some(Format::S16BE))),
            (SampleFormat::I24, (Format::S24LE, Some(Format::S24BE))),
            (SampleFormat::I32, (Format::S32LE, Some(Format::S32BE))),
            (SampleFormat::U16, (Format::U16LE, Some(Format::U16BE))),
            (SampleFormat::U24, (Format::U24LE, Some(Format::U24BE))),
            (SampleFormat::U32, (Format::U32LE, Some(Format::U32BE))),
            (SampleFormat::F32, (Format::FloatLE, Some(Format::FloatBE))),
            (SampleFormat::F64, (Format::Float64LE, Some(Format::Float64BE))),
        ]);
        #[cfg(target_endian = "big")]
        expected.extend([
            (SampleFormat::I16, (Format::S16BE, Some(Format::S16LE))),
            (SampleFormat::I24, (Format::S24BE, Some(Format::S24LE))),
            (SampleFormat::I32, (Format::S32BE, Some(Format::S32LE))),
            (SampleFormat::U16, (Format::U16BE, Some(Format::U16LE))),
            (SampleFormat::U24, (Format::U24BE, Some(Format::U24LE))),
            (SampleFormat::U32, (Format::U32BE, Some(Format::U32LE))),
            (SampleFormat::F32, (Format::FloatBE, Some(Format::FloatLE))),
            (SampleFormat::F64, (Format::Float64BE, Some(Format::Float64LE))),
        ]);

        for (format, mapping) in expected {
            assert_eq!(alsa_format_candidates(format), Some(mapping), "{format}");
        }
    }
}

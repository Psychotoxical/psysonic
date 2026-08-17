use std::io::Cursor;

use symphonia::core::io::MediaSource;

use super::source_probe::SizedCursorSource;

/// Shared binary builders for decoder unit and fixture tests.
pub(super) fn synth_itunsmpb_blob(delay_hex: &str, padding_hex: &str, total_hex: &str) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"random preamble bytes ");
    v.extend_from_slice(b"iTunSMPB");
    v.extend_from_slice(&[0u8; 16]);
    v.push(b' ');
    v.extend_from_slice(b"00000000");
    v.push(b' ');
    v.extend_from_slice(delay_hex.as_bytes());
    v.push(b' ');
    v.extend_from_slice(padding_hex.as_bytes());
    v.push(b' ');
    v.extend_from_slice(total_hex.as_bytes());
    v.push(b' ');
    v
}
pub(super) fn build_mono_pcm16_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    build_pcm16_wav(samples, sample_rate, 1)
}

/// `samples` is interleaved when `num_channels > 1`.
pub(super) fn build_pcm16_wav(samples: &[i16], sample_rate: u32, num_channels: u16) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let byte_rate = sample_rate * (bits_per_sample as u32 / 8) * num_channels as u32;
    let block_align = num_channels * (bits_per_sample / 8);
    let data_size = (samples.len() * 2) as u32;
    let riff_size = 36 + data_size;

    let mut out = Vec::with_capacity(44 + data_size as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&num_channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_size.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

pub(super) fn synthetic_wav_bytes(secs: f32) -> Vec<u8> {
    let sample_rate = 44_100u32;
    let n = (sample_rate as f32 * secs) as usize;
    let amp: f32 = 0.5 * i16::MAX as f32;
    let samples: Vec<i16> = (0..n)
        .map(|i| {
            let t = i as f32 / sample_rate as f32;
            ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * amp) as i16
        })
        .collect();
    build_mono_pcm16_wav(&samples, sample_rate)
}

pub(super) fn seekable_source(bytes: Vec<u8>) -> Box<dyn MediaSource> {
    let len = bytes.len() as u64;
    Box::new(SizedCursorSource {
        inner: Cursor::new(bytes),
        len,
    })
}

pub(super) fn build_mono_pcm16_aiff(
    samples: &[i16],
    form: &[u8; 4],
    sound_before_common: bool,
) -> Vec<u8> {
    let data_size = (samples.len() * 2) as u32;
    let mut common = Vec::with_capacity(if form == b"AIFC" { 24 } else { 18 });
    common.extend_from_slice(&1u16.to_be_bytes());
    common.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    common.extend_from_slice(&16u16.to_be_bytes());
    common.extend_from_slice(&[0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
    if form == b"AIFC" {
        common.extend_from_slice(b"NONE");
        common.extend_from_slice(&[0, 0]);
    }

    let mut sound = Vec::with_capacity((8 + data_size) as usize);
    sound.extend_from_slice(&0u32.to_be_bytes());
    sound.extend_from_slice(&0u32.to_be_bytes());
    for sample in samples {
        sound.extend_from_slice(&sample.to_be_bytes());
    }

    let mut body = Vec::new();
    body.extend_from_slice(form);
    let mut append_chunk = |id: &[u8; 4], data: &[u8]| {
        body.extend_from_slice(id);
        body.extend_from_slice(&(data.len() as u32).to_be_bytes());
        body.extend_from_slice(data);
        if !data.len().is_multiple_of(2) {
            body.push(0);
        }
    };
    if form == b"AIFC" {
        append_chunk(b"FVER", &0xa280_5140u32.to_be_bytes());
    }
    if sound_before_common {
        append_chunk(b"SSND", &sound);
        append_chunk(b"COMM", &common);
    } else {
        append_chunk(b"COMM", &common);
        append_chunk(b"SSND", &sound);
    }

    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"FORM");
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

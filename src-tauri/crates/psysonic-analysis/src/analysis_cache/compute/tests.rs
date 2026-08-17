mod decoder;
mod planning;
mod waveform;

/// Build a mono signed-16-bit-PCM WAV from a sample buffer at `sample_rate`.
/// Produces a buffer ready to be probed by Symphonia's WAV format reader.
fn build_mono_pcm16_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let num_channels: u16 = 1;
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

fn build_mono_pcm16_aiff(samples: &[i16]) -> Vec<u8> {
    let data_size = (samples.len() * 2) as u32;
    let form_size = 4 + (8 + 18) + (8 + 8 + data_size);
    let mut out = Vec::with_capacity((form_size + 8) as usize);
    out.extend_from_slice(b"FORM");
    out.extend_from_slice(&form_size.to_be_bytes());
    out.extend_from_slice(b"AIFFCOMM");
    out.extend_from_slice(&18u32.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    out.extend_from_slice(&16u16.to_be_bytes());
    out.extend_from_slice(&[0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
    out.extend_from_slice(b"SSND");
    out.extend_from_slice(&(8 + data_size).to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_be_bytes());
    }
    out
}

/// Generate a 440 Hz sine wave at -6 dBFS as a Vec<i16>.
fn sine_440_at_minus_6db(sample_rate: u32, secs: f32) -> Vec<i16> {
    let n = (sample_rate as f32 * secs) as usize;
    let amplitude: f32 = 0.5 * i16::MAX as f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / sample_rate as f32;
            let v = (2.0 * std::f32::consts::PI * 440.0 * t).sin() * amplitude;
            v as i16
        })
        .collect()
}

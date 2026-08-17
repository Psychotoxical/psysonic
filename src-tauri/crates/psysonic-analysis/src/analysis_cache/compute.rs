//! Stable facade for analysis-cache computation and decoding.

mod decoder;
mod planning;
mod waveform;

pub use decoder::{
    analysis_pcm_window, audio_duration_from_bytes, decode_mono_pcm_limited,
    decode_mono_pcm_window, PcmAnalysisWindow,
};
pub(crate) use planning::seed_transcoded_bytes_execute;
pub use planning::{
    md5_first_16kb, seed_from_bytes_execute, seed_from_bytes_into_cache, SeedFromBytesOutcome,
};
pub use waveform::recommended_gain_for_target;

#[cfg(test)]
mod tests;

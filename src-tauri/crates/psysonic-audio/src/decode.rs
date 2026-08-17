//! Symphonia decoding, gapless trim, and playback source construction.

mod builders;
mod decoder;
mod decoder_bytes;
mod decoder_streaming;
mod format;
mod gapless;
mod source_probe;

#[cfg(test)]
mod test_support;

#[allow(unused_imports)]
pub(crate) use builders::{build_source, build_streaming_source, BuiltSource, BuiltSourceStack};
pub(crate) use decoder::SizedDecoder;
pub(crate) use format::{AudioFormatEvent, AudioFormatIdentity, ResolvedCodecInfo};

#[cfg(test)]
#[path = "decode_fixture_tests.rs"]
mod build_source_tests;

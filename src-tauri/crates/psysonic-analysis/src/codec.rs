//! Symphonia codec registry — mirrors `psysonic-audio::codec` (Opus via libopus).
use std::sync::OnceLock;

use symphonia::core::codecs::audio::{AudioCodecParameters, AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::registry::CodecRegistry;

pub(crate) fn psysonic_codec_registry() -> &'static CodecRegistry {
    static REGISTRY: OnceLock<CodecRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut registry);
        registry.register_audio_decoder::<symphonia_adapter_libopus::OpusDecoder>();
        registry
    })
}

pub(crate) fn make_decoder(
    params: &AudioCodecParameters,
    opts: &AudioDecoderOptions,
) -> Result<Box<dyn AudioDecoder>, symphonia::core::errors::Error> {
    psysonic_codec_registry().make_audio_decoder(params, opts)
}

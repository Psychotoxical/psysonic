//! Symphonia codec registry (incl. Opus) and radio decoder factory.
use std::sync::OnceLock;

use symphonia::core::codecs::{CodecRegistry, DecoderOptions};

pub(crate) fn psysonic_codec_registry() -> &'static CodecRegistry {
    static REGISTRY: OnceLock<CodecRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = CodecRegistry::new();
        symphonia::default::register_enabled_codecs(&mut registry);
        registry.register_all::<symphonia_adapter_libopus::OpusDecoder>();
        registry
    })
}

pub(crate) fn try_make_radio_decoder(
    params: &symphonia::core::codecs::CodecParameters,
    opts: &DecoderOptions,
) -> Result<Box<dyn symphonia::core::codecs::Decoder>, symphonia::core::errors::Error> {
    psysonic_codec_registry().make(params, opts)
}

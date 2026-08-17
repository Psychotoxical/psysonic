use symphonia::core::codecs::audio::AudioCodecParameters;

use crate::codec::psysonic_codec_registry;

/// Resolved audio format of a decoded stream — the real codec/rate/depth the
/// engine is playing, which can differ from the server's stored file metadata
/// when the server transcodes on the fly.
#[derive(Clone, Debug)]
pub(crate) struct ResolvedCodecInfo {
    /// Symphonia codec short name, e.g. `mp3`, `flac`, `aac`, `pcm_s16le`.
    pub(crate) codec_name: &'static str,
    pub(crate) sample_rate: Option<u32>,
    pub(crate) bits_per_sample: Option<u32>,
    pub(crate) channels: Option<u16>,
    pub(crate) lossless: bool,
}

#[cfg(test)]
#[path = "tests/format_unit.rs"]
mod tests;

/// Extract the human/UI-facing format from symphonia codec parameters.
pub(crate) fn resolve_codec_info(params: &AudioCodecParameters) -> ResolvedCodecInfo {
    // Resolve the codec name from the SAME registry the engine decodes with
    // (`psysonic_codec_registry`), not `symphonia::default::get_codecs()`. The
    // app registry adds decoders the stock one lacks (e.g. the libopus adapter);
    // using the stock registry would render those as "?" even though playback
    // works — which is exactly what a server Opus transcode would show.
    let codec_name = psysonic_codec_registry()
        .get_audio_decoder(params.codec)
        .map(|d| d.codec.info.short_name)
        .unwrap_or("?");
    let lossless = codec_name.starts_with("pcm")
        || matches!(
            codec_name,
            "flac" | "alac" | "wavpack" | "monkeys-audio" | "tta" | "shorten"
        );
    ResolvedCodecInfo {
        codec_name,
        sample_rate: params.sample_rate,
        bits_per_sample: params.bits_per_sample.or(params.bits_per_coded_sample),
        channels: params.channels.as_ref().map(|c| c.count() as u16),
        lossless,
    }
}

/// `audio:format` event payload — the actually-decoded stream format, sent to
/// the frontend so now-playing badges can show real transmitted quality.
/// Hand-serialized (not tauri-specta) to match the `audio:*` event convention.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioFormatEvent {
    /// Track this format was resolved for — lets the frontend drop the event if
    /// the user has since skipped. `None` on legacy/identity-less emits.
    pub(crate) track_id: Option<String>,
    /// Playback server index key — disambiguates duplicate ids across servers.
    pub(crate) server_id: Option<String>,
    /// Playback generation the stream belongs to (stale-event rejection).
    pub(crate) generation: Option<u64>,
    /// `maxBitRate` cap (kbps) the stream URL was opened with — latched per
    /// stream, so a mid-playback settings change never relabels the current one.
    pub(crate) stream_cap_kbps: Option<u32>,
    pub(crate) codec: String,
    pub(crate) sample_rate: Option<u32>,
    pub(crate) bits_per_sample: Option<u32>,
    pub(crate) channels: Option<u16>,
    pub(crate) lossless: bool,
}

/// Identity a resolved-format event is stamped with (who/which stream).
#[derive(Clone, Default)]
pub(crate) struct AudioFormatIdentity {
    pub(crate) track_id: Option<String>,
    pub(crate) server_id: Option<String>,
    pub(crate) generation: Option<u64>,
    pub(crate) stream_cap_kbps: Option<u32>,
}

impl AudioFormatEvent {
    pub(crate) fn from_info(info: &ResolvedCodecInfo, id: AudioFormatIdentity) -> Self {
        Self {
            track_id: id.track_id,
            server_id: id.server_id,
            generation: id.generation,
            stream_cap_kbps: id.stream_cap_kbps,
            codec: info.codec_name.to_string(),
            // Bit depth is only meaningful for lossless output.
            bits_per_sample: if info.lossless {
                info.bits_per_sample
            } else {
                None
            },
            sample_rate: info.sample_rate,
            channels: info.channels,
            lossless: info.lossless,
        }
    }
}

/// Debug logging: codec parameters in human-readable form to verify whether
/// playback is genuinely lossless.
pub(crate) fn log_codec_resolution(
    tag: &str,
    params: &AudioCodecParameters,
    container_hint: Option<&str>,
) {
    let info = resolve_codec_info(params);
    let rate = info
        .sample_rate
        .map(|r| format!("{} Hz", r))
        .unwrap_or_else(|| "? Hz".into());
    let bits = info
        .bits_per_sample
        .map(|b| format!("{}-bit", b))
        .unwrap_or_else(|| "?-bit".into());
    let ch = info
        .channels
        .map(|c| format!("{}ch", c))
        .unwrap_or_else(|| "?ch".into());
    let kind = if info.lossless { "LOSSLESS" } else { "lossy" };
    crate::app_deprintln!(
        "[stream] {tag}: codec={} ({kind}) {bits} {rate} {ch} container={}",
        info.codec_name,
        container_hint.unwrap_or("?")
    );
}

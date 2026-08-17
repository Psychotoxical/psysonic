use symphonia::core::codecs::audio::AudioCodecParameters;

use super::*;

// ── log_codec_resolution ─────────────────────────────────────────────────

#[test]
fn log_codec_resolution_does_not_panic_for_valid_params() {
    let mut params = AudioCodecParameters::new();
    params.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_PCM_S16LE;
    params.sample_rate = Some(44_100);
    params.bits_per_sample = Some(16);
    params.channels = Some(symphonia::core::audio::Channels::Discrete(1));
    log_codec_resolution("test-tag", &params, Some("wav"));
}

#[test]
fn log_codec_resolution_handles_unknown_codec_gracefully() {
    let params = AudioCodecParameters::new();
    log_codec_resolution("unknown", &params, None);
}

// ── resolve_codec_info / AudioFormatEvent ────────────────────────────────

#[test]
fn resolve_codec_info_reports_pcm_as_lossless() {
    let mut params = AudioCodecParameters::new();
    params.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_PCM_S16LE;
    params.sample_rate = Some(44_100);
    params.bits_per_sample = Some(16);
    params.channels = Some(symphonia::core::audio::Channels::Discrete(1));
    let info = resolve_codec_info(&params);
    assert!(info.codec_name.starts_with("pcm"));
    assert!(info.lossless);
    assert_eq!(info.sample_rate, Some(44_100));
    assert_eq!(info.bits_per_sample, Some(16));
    assert_eq!(info.channels, Some(1));
}

#[test]
fn resolve_codec_info_reports_mp3_as_lossy() {
    let mut params = AudioCodecParameters::new();
    params.codec = symphonia::core::codecs::audio::well_known::CODEC_ID_MP3;
    params.sample_rate = Some(44_100);
    let info = resolve_codec_info(&params);
    assert_eq!(info.codec_name, "mp3");
    assert!(!info.lossless);
}

#[test]
fn audio_format_event_drops_bit_depth_for_lossy() {
    let lossy = ResolvedCodecInfo {
        codec_name: "mp3",
        sample_rate: Some(44_100),
        bits_per_sample: Some(16),
        channels: Some(2),
        lossless: false,
    };
    let ev = AudioFormatEvent::from_info(
        &lossy,
        AudioFormatIdentity {
            track_id: Some("t1".into()),
            server_id: Some("srv".into()),
            generation: Some(7),
            stream_cap_kbps: Some(128),
        },
    );
    assert_eq!(ev.bits_per_sample, None);
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["codec"], "mp3");
    assert_eq!(json["sampleRate"], 44_100);
    assert_eq!(json["lossless"], false);
    assert!(json["bitsPerSample"].is_null());
    assert_eq!(json["trackId"], "t1");
    assert_eq!(json["serverId"], "srv");
    assert_eq!(json["generation"], 7);
    assert_eq!(json["streamCapKbps"], 128);
}

#[test]
fn audio_format_event_keeps_bit_depth_for_lossless() {
    let lossless = ResolvedCodecInfo {
        codec_name: "flac",
        sample_rate: Some(96_000),
        bits_per_sample: Some(24),
        channels: Some(2),
        lossless: true,
    };
    let ev = AudioFormatEvent::from_info(&lossless, AudioFormatIdentity::default());
    assert_eq!(ev.bits_per_sample, Some(24));
}

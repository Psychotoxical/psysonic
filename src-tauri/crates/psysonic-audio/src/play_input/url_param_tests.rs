use super::{ranged_analysis_seed_hold_allowed, url_format_hint, url_stream_cap_kbps};

#[test]
fn ranged_analysis_hold_covers_disk_spill_sizes() {
    assert!(ranged_analysis_seed_hold_allowed(
        super::super::stream::TRACK_STREAM_PROMOTE_MAX_BYTES + 1
    ));
    assert!(ranged_analysis_seed_hold_allowed(
        super::super::stream::LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES
    ));
    assert!(!ranged_analysis_seed_hold_allowed(
        super::super::stream::LOCAL_FILE_PLAYBACK_SEED_MAX_BYTES + 1
    ));
}

#[test]
fn extracts_aiff_format_hint_from_url_path() {
    assert_eq!(
        url_format_hint("https://s.example/music/track.AIFF?token=x"),
        Some("aiff".into()),
    );
}

#[test]
fn parses_max_bit_rate_from_stream_url() {
    let url = "https://s.example/rest/stream.view?id=t1&u=a&maxBitRate=128&f=json";
    assert_eq!(url_stream_cap_kbps(url), Some(128));
}

#[test]
fn absent_or_zero_cap_is_none() {
    assert_eq!(
        url_stream_cap_kbps("https://s.example/rest/stream.view?id=t1&u=a"),
        None
    );
    assert_eq!(
        url_stream_cap_kbps("https://s.example/rest/stream.view?id=t1&maxBitRate=0"),
        None
    );
    assert_eq!(
        url_stream_cap_kbps("psysonic-local:///library/t1.flac"),
        None
    );
}

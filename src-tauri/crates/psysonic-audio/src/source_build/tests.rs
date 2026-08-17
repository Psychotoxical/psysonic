use std::path::PathBuf;

use super::{
    fallback_analysis_dispatch, is_stream_probe_failure_with_full_buffer_retry,
    FallbackAnalysisDispatch, PublishedFallbackLocation,
};

#[test]
fn published_fallback_spill_routes_analysis_from_the_file() {
    let path = PathBuf::from("fallback-spill.flac");
    match fallback_analysis_dispatch(PublishedFallbackLocation::Spill {
        path,
        analysis_file: None,
    }) {
        FallbackAnalysisDispatch::File(_) => {}
        FallbackAnalysisDispatch::Bytes => panic!("spill analysis must use the file path"),
    }
}

#[test]
fn in_memory_fallback_keeps_byte_analysis() {
    assert!(matches!(
        fallback_analysis_dispatch(PublishedFallbackLocation::Memory),
        FallbackAnalysisDispatch::Bytes
    ));
}

#[test]
fn stale_reused_spill_keeps_the_shared_cache_path() {
    let path = PathBuf::from("shared-spill.flac");
    assert!(!super::stale_fallback_spill_should_unlink(
        &path,
        Some(&path)
    ));
    assert!(super::stale_fallback_spill_should_unlink(&path, None));
}

#[test]
fn retries_ranged_probe_timeouts_from_full_buffer() {
    assert!(is_stream_probe_failure_with_full_buffer_retry(
        "ranged-stream: format probe timed out after 20s",
        Some("aiff"),
    ));
}

#[test]
fn retries_legacy_aiff_probe_failures_from_full_buffer() {
    assert!(is_stream_probe_failure_with_full_buffer_retry(
        "track-stream: format probe failed: malformed stream: aiff: missing common element",
        None,
    ));
    assert!(is_stream_probe_failure_with_full_buffer_retry(
        "track-stream: format probe timed out after 20s",
        Some("aif"),
    ));
}

#[test]
fn does_not_retry_unrelated_legacy_stream_failures() {
    assert!(!is_stream_probe_failure_with_full_buffer_retry(
        "track-stream: format probe failed: unsupported format",
        Some("mp3"),
    ));
}

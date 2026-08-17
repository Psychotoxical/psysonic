use super::super::*;

#[test]
fn header_validation_requires_206_zero_start_and_exact_window() {
    // Full window on a large file.
    assert_eq!(
        expected_prefix_len(206, Some("bytes 0-16383/9999999")),
        Some(16384)
    );
    // The strict 206 parser still rejects 200; the HTTP probe handles a
    // verified raw 200 separately with a hard 16 KiB read cap.
    assert_eq!(
        expected_prefix_len(200, Some("bytes 0-16383/9999999")),
        None
    );
    // Range not starting at zero.
    assert_eq!(
        expected_prefix_len(206, Some("bytes 100-16483/9999999")),
        None
    );
    // Truncated prefix of a large file — wrong fingerprint window.
    assert_eq!(expected_prefix_len(206, Some("bytes 0-999/9999999")), None);
    // Range end past the advertised total (inconsistent).
    assert_eq!(expected_prefix_len(206, Some("bytes 0-16383/512")), None);
    // Unknown total ('*') is unverifiable.
    assert_eq!(expected_prefix_len(206, Some("bytes 0-16383/*")), None);
    // Missing header entirely.
    assert_eq!(expected_prefix_len(206, None), None);
}

#[test]
fn permanent_http_status_classification_excludes_retryable_responses() {
    assert!(BoundedStreamFetchError::HttpStatus(404).is_permanent_http());
    assert!(!BoundedStreamFetchError::HttpStatus(401).is_permanent_http());
    assert!(!BoundedStreamFetchError::HttpStatus(403).is_permanent_http());
    assert!(!BoundedStreamFetchError::HttpStatus(408).is_permanent_http());
    assert!(!BoundedStreamFetchError::HttpStatus(429).is_permanent_http());
    assert!(!BoundedStreamFetchError::HttpStatus(503).is_permanent_http());
}

#[test]
fn subsonic_missing_source_error_preserves_code_and_reason() {
    let body = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /music/a.flac: no such file or directory"}}}"#;
    let error = parse_subsonic_stream_error(body).unwrap();

    assert_eq!(error.code, 0);
    assert_eq!(
        error.message,
        "open /music/a.flac: no such file or directory"
    );
    assert!(error.is_source_unavailable());
    assert_eq!(error.diagnostic_reason(), "no_such_file_or_directory");
}

#[test]
fn short_files_use_their_full_size_and_bodies_must_match_exactly() {
    // File smaller than the probe window: exact "0-(size-1)/size" accepted.
    assert_eq!(expected_prefix_len(206, Some("bytes 0-511/512")), Some(512));
    assert!(validate_prefix_body(&vec![0x11u8; 512], 512));
    // Truncated or padded bodies are rejected even with valid headers.
    assert!(!validate_prefix_body(&vec![0x11u8; 500], 512));
    assert!(!validate_prefix_body(&vec![0x11u8; 513], 512));
    // Subsonic error envelopes served with a misleading 206.
    let err = br#"{"subsonic-response":{"status":"failed"}}"#.to_vec();
    assert!(!validate_prefix_body(&err, err.len()));
    let xml = br#"<?xml version="1.0"?><subsonic-response status="failed"/>"#.to_vec();
    assert!(!validate_prefix_body(&xml, xml.len()));
}

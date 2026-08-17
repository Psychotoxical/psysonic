use super::super::*;

#[test]
fn promotion_gate_requires_prefix_equality_with_the_trusted_fingerprint() {
    let original = vec![7u8; 20 * 1024];
    let trusted = crate::analysis_cache::md5_first_16kb(&original);
    assert!(bytes_match_trusted(&original, &trusted));
    // Transcoded bytes (different content) never match the original.
    let transcoded = vec![9u8; 20 * 1024];
    assert!(!bytes_match_trusted(&transcoded, &trusted));
    assert!(!bytes_match_trusted(&[], &trusted));
}

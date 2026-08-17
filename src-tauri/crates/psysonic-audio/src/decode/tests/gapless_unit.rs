use super::*;
use crate::decode::test_support::synth_itunsmpb_blob;

// ── find_subsequence ─────────────────────────────────────────────────────

#[test]
fn find_subsequence_locates_needle_at_start() {
    assert_eq!(find_subsequence(b"abcdef", b"abc"), Some(0));
}

#[test]
fn find_subsequence_locates_needle_in_middle() {
    assert_eq!(find_subsequence(b"abcdef", b"cd"), Some(2));
}

#[test]
fn find_subsequence_returns_none_when_absent() {
    assert!(find_subsequence(b"abcdef", b"xyz").is_none());
}

#[test]
fn find_subsequence_returns_none_for_needle_longer_than_haystack() {
    assert!(find_subsequence(b"ab", b"abcd").is_none());
}

#[test]
fn find_subsequence_finds_first_occurrence_of_repeated_pattern() {
    assert_eq!(find_subsequence(b"abab", b"ab"), Some(0));
}

// ── parse_gapless_info ───────────────────────────────────────────────────

#[test]
fn parse_gapless_returns_default_when_itunsmpb_absent() {
    let info = parse_gapless_info(b"no marker here");
    assert_eq!(info.delay_samples, 0);
    assert!(info.total_valid_samples.is_none());
}

#[test]
fn parse_gapless_extracts_delay_from_itunsmpb_blob() {
    let blob = synth_itunsmpb_blob("00000840", "00000000", "00ABCDEF");
    let info = parse_gapless_info(&blob);
    assert_eq!(info.delay_samples, 0x840, "delay decoded as hex");
    assert_eq!(info.total_valid_samples, Some(0x00AB_CDEF));
}

#[test]
fn parse_gapless_returns_none_total_when_total_field_is_zero() {
    let blob = synth_itunsmpb_blob("00000840", "00000000", "00000000");
    let info = parse_gapless_info(&blob);
    assert_eq!(info.delay_samples, 0x840);
    assert!(
        info.total_valid_samples.is_none(),
        "zero-total filters out per the implementation"
    );
}

#[test]
fn parse_gapless_handles_itunsmpb_without_value_string() {
    let mut v = b"iTunSMPB".to_vec();
    v.extend_from_slice(&[0u8; 16]);
    let info = parse_gapless_info(&v);
    assert_eq!(info.delay_samples, 0);
    assert!(info.total_valid_samples.is_none());
}

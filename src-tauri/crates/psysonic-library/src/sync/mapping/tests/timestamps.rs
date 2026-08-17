use super::super::*;

#[test]
fn format_iso_roundtrips_zulu_suffix() {
    let ms = parse_iso_ms_str("2024-01-01T00:00:00Z").unwrap();
    assert_eq!(format_iso_ms_z(ms).as_deref(), Some("2024-01-01T00:00:00Z"));
}

#[test]
fn parse_iso_handles_zulu_suffix() {
    let ms = parse_iso_ms_str("2024-01-01T00:00:00Z").unwrap();
    assert_eq!(ms, 1_704_067_200_000);
}

#[test]
fn parse_iso_handles_fractional_and_offset() {
    let ms = parse_iso_ms_str("2024-01-01T00:00:00.123+02:00").unwrap();
    assert_eq!(ms, 1_704_067_200_000);
}

#[test]
fn parse_iso_rejects_garbage() {
    assert!(parse_iso_ms_str("").is_none());
    assert!(parse_iso_ms_str("not-a-date").is_none());
    assert!(parse_iso_ms_str("9999-99-99").is_none());
}

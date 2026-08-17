use super::*;

#[test]
fn resolve_preview_format_hint_sniffs_flac_from_bytes() {
    let hint = resolve_preview_format_hint(
        "https://host/rest/stream.view?id=1",
        None,
        None,
        None,
        b"fLaC\x00\x00\x00\x22",
    );
    assert_eq!(hint.as_deref(), Some("flac"));
}

#[test]
fn resolve_preview_format_hint_prefers_content_type_over_sniff() {
    let hint = resolve_preview_format_hint(
        "https://host/rest/stream.view?id=1",
        Some("audio/mpeg"),
        None,
        None,
        b"fLaC\x00\x00\x00\x22",
    );
    assert_eq!(hint.as_deref(), Some("mp3"));
}

#[test]
fn resolve_preview_format_hint_uses_subsonic_suffix() {
    let hint = resolve_preview_format_hint(
        "https://host/rest/stream.view?id=1",
        None,
        None,
        Some("flac"),
        &[0x00, 0x01, 0x02, 0x03],
    );
    assert_eq!(hint.as_deref(), Some("flac"));
}

#[test]
fn preview_format_hint_from_url_reads_format_query_param() {
    assert_eq!(
        preview_format_hint_from_url("https://h/stream.view?format=opus&id=x"),
        Some("opus".into())
    );
}

pub(crate) fn content_type_to_hint(ct: &str) -> Option<String> {
    let ct = ct.to_ascii_lowercase();
    if ct.contains("mpeg") || ct.contains("mp3") {
        Some("mp3".into())
    } else if ct.contains("aac") || ct.contains("aacp") {
        Some("aac".into())
    } else if ct.contains("ogg") {
        Some("ogg".into())
    } else if ct.contains("flac") {
        Some("flac".into())
    } else if ct.contains("wav") || ct.contains("wave") {
        Some("wav".into())
    } else if ct.contains("aiff") || ct.contains("aifc") {
        Some("aiff".into())
    } else if ct.contains("opus") {
        Some("opus".into())
    }
    // AAC/ALAC in MP4 — Navidrome/nginx often send `audio/mp4`; without a hint we skipped ranged open.
    else if ct.contains("audio/mp4") || ct.contains("x-m4a") || ct.contains("/m4a") {
        Some("m4a".into())
    } else {
        None
    }
}

pub(crate) fn normalize_audio_extension_for_hint(ext: &str) -> Option<String> {
    let ext = ext.trim();
    if !(1..=5).contains(&ext.len()) || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let ext = ext.to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp3"
            | "flac"
            | "ogg"
            | "oga"
            | "opus"
            | "m4a"
            | "mp4"
            | "aac"
            | "wav"
            | "wave"
            | "aiff"
            | "aif"
            | "aifc"
            | "ape"
            | "wv"
            | "webm"
            | "mka"
    )
    .then_some(ext)
}

/// `Content-Disposition: attachment; filename="…"` from some Subsonic proxies.
pub(crate) fn format_hint_from_content_disposition(cd: &str) -> Option<String> {
    fn ext_ok(ext: &str) -> Option<String> {
        let ext = ext
            .trim_matches(|c| c == '"' || c == '\'' || c == ' ')
            .split(';')
            .next()?
            .trim();
        normalize_audio_extension_for_hint(ext)
    }
    fn ext_from_filename(path: &str) -> Option<String> {
        let base = path
            .rsplit('/')
            .next()?
            .trim_matches(|c| c == '"' || c == ' ');
        if base.is_empty() {
            return None;
        }
        let ext = base.rsplit('.').next()?;
        if ext == base {
            return None;
        }
        ext_ok(ext)
    }
    for part in cd.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("filename*=") {
            // RFC 5987: `charset'lang'value`
            let value = rest
                .split("''")
                .nth(1)
                .unwrap_or(rest)
                .trim()
                .trim_matches('"');
            if let Some(ext) = ext_from_filename(value) {
                return Some(ext);
            }
        } else if let Some(rest) = part.strip_prefix("filename=") {
            let value = rest.trim().trim_matches('"');
            if let Some(ext) = ext_from_filename(value) {
                return Some(ext);
            }
        }
    }
    None
}

/// Best Symphonia container hint for playback: ranged/stream media hint, URL tail,
/// Subsonic `song.suffix`, then magic-byte sniff on buffered bytes.
pub(crate) fn resolve_playback_format_hint(
    url_hint: Option<&str>,
    stream_suffix: Option<&str>,
    media_hint: Option<&str>,
    data: Option<&[u8]>,
) -> Option<String> {
    media_hint
        .map(str::to_string)
        .or_else(|| url_hint.map(str::to_string))
        .or_else(|| normalize_stream_suffix_for_hint(stream_suffix))
        .or_else(|| data.and_then(sniff_stream_format_extension))
}

/// Subsonic [`song.suffix`](https://www.subsonic.org/pages/api.jsp#getSong) — stream.view URLs
/// usually have no file extension; this supplies `format_hint` for ranged open.
pub(crate) fn normalize_stream_suffix_for_hint(suffix: Option<&str>) -> Option<String> {
    normalize_audio_extension_for_hint(suffix?)
}

/// Max prefix length for an optional `Range` probe GET when ranged open needs a format hint.
pub(crate) const STREAM_FORMAT_SNIFF_PROBE_BYTES: usize = 256 * 1024;

fn id3v2_tag_len(data: &[u8]) -> usize {
    if data.len() >= 10 && data[0..3] == *b"ID3" {
        let size = ((data[6] as usize & 0x7f) << 21)
            | ((data[7] as usize & 0x7f) << 14)
            | ((data[8] as usize & 0x7f) << 7)
            | (data[9] as usize & 0x7f);
        10usize.saturating_add(size)
    } else {
        0
    }
}

fn adts_frame_sync(b0: u8, b1: u8) -> bool {
    b0 == 0xff && (b1 & 0xf6) == 0xf0
}

fn mp3_frame_sync(b0: u8, b1: u8) -> bool {
    b0 == 0xff && (b1 & 0xe0) == 0xe0
}

/// Magic-byte sniff on the start of an HTTP body when headers / Subsonic suffix / path
/// did not yield a Symphonia [`Hint`] extension (needed for `RangedHttpSource`).
pub(crate) fn sniff_stream_format_extension(data: &[u8]) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    if data.len() >= 4 && data[0..4] == *b"fLaC" {
        return Some("flac".into());
    }
    if data.len() >= 4 && data[0..4] == *b"OggS" {
        return Some("ogg".into());
    }
    if data.len() >= 12 && data[0..4] == *b"RIFF" && data[8..12] == *b"WAVE" {
        return Some("wav".into());
    }
    if data.len() >= 12
        && data[0..4] == *b"FORM"
        && (data[8..12] == *b"AIFF" || data[8..12] == *b"AIFC")
    {
        return Some("aiff".into());
    }
    // ISO-BMFF — `ftyp` inside a box; scan a small window (large `free`/`skip` before `ftyp` is rare but exists).
    let scan = data.len().min(4096).saturating_sub(4);
    for i in 0..=scan {
        if data[i..i + 4] == *b"ftyp" {
            return Some("m4a".into());
        }
    }
    // EBML — WebM / Matroska (.mka)
    if data.len() >= 4 && data[0] == 0x1a && data[1] == 0x45 && data[2] == 0xdf && data[3] == 0xa3 {
        return Some("mka".into());
    }
    // AAC ADTS
    let id3 = id3v2_tag_len(data);
    if id3 < data.len().saturating_sub(2) && adts_frame_sync(data[id3], data[id3 + 1]) {
        return Some("aac".into());
    }
    if data.len() >= 2 && adts_frame_sync(data[0], data[1]) {
        return Some("aac".into());
    }
    // MPEG layer III / II — after ID3
    let off = id3;
    if off + 2 <= data.len() && mp3_frame_sync(data[off], data[off + 1]) {
        return Some("mp3".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_type_recognises_common_audio_mimes() {
        assert_eq!(content_type_to_hint("audio/mpeg"), Some("mp3".into()));
        assert_eq!(content_type_to_hint("audio/aac"), Some("aac".into()));
        assert_eq!(content_type_to_hint("audio/aacp"), Some("aac".into()));
        assert_eq!(content_type_to_hint("audio/ogg"), Some("ogg".into()));
        assert_eq!(content_type_to_hint("audio/flac"), Some("flac".into()));
        assert_eq!(content_type_to_hint("audio/wav"), Some("wav".into()));
        assert_eq!(content_type_to_hint("audio/wave"), Some("wav".into()));
        assert_eq!(content_type_to_hint("audio/aiff"), Some("aiff".into()));
        assert_eq!(content_type_to_hint("audio/x-aiff"), Some("aiff".into()));
        assert_eq!(content_type_to_hint("audio/aifc"), Some("aiff".into()));
        assert_eq!(content_type_to_hint("audio/opus"), Some("opus".into()));
        assert_eq!(content_type_to_hint("audio/mp4"), Some("m4a".into()));
        assert_eq!(content_type_to_hint("audio/x-m4a"), Some("m4a".into()));
    }

    #[test]
    fn content_type_is_case_insensitive() {
        assert_eq!(content_type_to_hint("AUDIO/MPEG"), Some("mp3".into()));
        assert_eq!(content_type_to_hint("Audio/FLAC"), Some("flac".into()));
    }

    #[test]
    fn content_type_returns_none_for_unknown() {
        assert_eq!(content_type_to_hint("text/html"), None);
        assert_eq!(content_type_to_hint("application/octet-stream"), None);
        assert_eq!(content_type_to_hint(""), None);
    }

    #[test]
    fn cd_extracts_extension_from_quoted_filename() {
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"track.flac\""),
            Some("flac".into()),
        );
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"track.aiff\""),
            Some("aiff".into()),
        );
    }

    #[test]
    fn cd_extracts_extension_from_rfc5987_filename_star() {
        assert_eq!(
            format_hint_from_content_disposition("filename*=UTF-8''track.opus"),
            Some("opus".into()),
        );
    }

    #[test]
    fn cd_returns_none_for_unknown_extension() {
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"track.xyz\""),
            None,
        );
    }

    #[test]
    fn cd_returns_none_when_filename_has_no_extension() {
        assert_eq!(
            format_hint_from_content_disposition("attachment; filename=\"trackname\""),
            None,
        );
    }

    #[test]
    fn cd_returns_none_when_no_filename_present() {
        assert_eq!(format_hint_from_content_disposition("inline"), None);
    }

    #[test]
    fn resolve_playback_hint_prefers_media_then_suffix() {
        assert_eq!(
            resolve_playback_format_hint(None, Some("m4a"), Some("flac"), None),
            Some("flac".into()),
        );
        assert_eq!(
            resolve_playback_format_hint(None, Some("m4a"), None, None),
            Some("m4a".into()),
        );
    }

    #[test]
    fn resolve_playback_hint_sniffs_bytes_when_no_suffix() {
        let mut buf = vec![0u8; 4];
        buf.extend_from_slice(b"ftyp");
        buf.extend_from_slice(b"M4A \x00\x00\x02\x00");
        assert_eq!(
            resolve_playback_format_hint(None, None, None, Some(&buf)),
            Some("m4a".into()),
        );
    }

    #[test]
    fn suffix_normalises_known_extensions_lowercase() {
        assert_eq!(
            normalize_stream_suffix_for_hint(Some("MP3")),
            Some("mp3".into())
        );
        assert_eq!(
            normalize_stream_suffix_for_hint(Some("Flac")),
            Some("flac".into())
        );
        assert_eq!(
            normalize_stream_suffix_for_hint(Some("AIFF")),
            Some("aiff".into())
        );
        assert_eq!(
            normalize_stream_suffix_for_hint(Some("AIF")),
            Some("aif".into())
        );
    }

    #[test]
    fn suffix_returns_none_for_empty_or_whitespace() {
        assert_eq!(normalize_stream_suffix_for_hint(None), None);
        assert_eq!(normalize_stream_suffix_for_hint(Some("")), None);
        assert_eq!(normalize_stream_suffix_for_hint(Some("   ")), None);
    }

    #[test]
    fn suffix_returns_none_for_unknown_extension() {
        assert_eq!(normalize_stream_suffix_for_hint(Some("xyz")), None);
        assert_eq!(normalize_stream_suffix_for_hint(Some("psy")), None);
    }

    #[test]
    fn sniff_detects_flac_magic() {
        assert_eq!(
            sniff_stream_format_extension(b"fLaC\x00\x00"),
            Some("flac".into())
        );
    }

    #[test]
    fn sniff_detects_ogg_magic() {
        assert_eq!(
            sniff_stream_format_extension(b"OggS......"),
            Some("ogg".into())
        );
    }

    #[test]
    fn sniff_detects_riff_wave() {
        let mut buf = b"RIFF".to_vec();
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(b"WAVE");
        assert_eq!(sniff_stream_format_extension(&buf), Some("wav".into()));
    }

    #[test]
    fn sniff_detects_aiff_and_aifc() {
        let mut aiff = b"FORM".to_vec();
        aiff.extend_from_slice(&[0u8; 4]);
        aiff.extend_from_slice(b"AIFF");
        assert_eq!(sniff_stream_format_extension(&aiff), Some("aiff".into()));

        let mut aifc = b"FORM".to_vec();
        aifc.extend_from_slice(&[0u8; 4]);
        aifc.extend_from_slice(b"AIFC");
        assert_eq!(sniff_stream_format_extension(&aifc), Some("aiff".into()));
    }

    #[test]
    fn sniff_detects_mp4_ftyp_box() {
        // 4 leading size bytes, then "ftyp" — common MP4 layout.
        let mut buf = vec![0u8; 4];
        buf.extend_from_slice(b"ftyp");
        buf.extend_from_slice(b"M4A \x00\x00\x02\x00");
        assert_eq!(sniff_stream_format_extension(&buf), Some("m4a".into()));
    }

    #[test]
    fn sniff_detects_ebml_matroska() {
        assert_eq!(
            sniff_stream_format_extension(&[0x1a, 0x45, 0xdf, 0xa3, 0x00]),
            Some("mka".into()),
        );
    }

    #[test]
    fn sniff_detects_adts_aac_with_no_id3() {
        assert_eq!(
            sniff_stream_format_extension(&[0xff, 0xf1, 0x00, 0x00]),
            Some("aac".into())
        );
    }

    #[test]
    fn sniff_detects_mp3_frame_sync_with_no_id3() {
        assert_eq!(
            sniff_stream_format_extension(&[0xff, 0xfb, 0x00, 0x00]),
            Some("mp3".into())
        );
    }

    #[test]
    fn sniff_detects_mp3_after_id3v2_tag() {
        // ID3v2 header (10 bytes): "ID3" + 2 version bytes + flags byte + 4 size bytes (synchsafe).
        // Use size = 0 so the MP3 frame sync starts immediately at offset 10.
        let mut buf = vec![b'I', b'D', b'3', 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
        buf.extend_from_slice(&[0xff, 0xfb]);
        assert_eq!(sniff_stream_format_extension(&buf), Some("mp3".into()));
    }

    #[test]
    fn sniff_returns_none_for_empty_or_random_bytes() {
        assert_eq!(sniff_stream_format_extension(&[]), None);
        assert_eq!(
            sniff_stream_format_extension(&[0x00, 0x01, 0x02, 0x03]),
            None
        );
    }
}

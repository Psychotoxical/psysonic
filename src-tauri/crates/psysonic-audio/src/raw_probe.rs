//! Trusted-original fingerprint probe.
//!
//! When playback streams a TRANSCODED representation (client `maxBitRate` cap,
//! or server-forced transcoding), the analysis pipeline must not key canonical
//! data off the transcode's bytes. Navidrome serves the untouched original —
//! before any player/server transcoding overrides — for `format=raw`, and its
//! raw path supports Range requests. Fetching the first 16 KiB of the original
//! yields the same `md5_16kb` fingerprint the untranscoded playback path would
//! compute, so all bitrate representations resolve to one analysis identity.
//!
//! Probe contract (per PR #1334 review): accept the prefix only when the
//! response is `206 Partial Content`, its `Content-Range` starts at byte zero
//! and matches the body length, and the body is not a Subsonic JSON/XML error
//! envelope. On any failure the caller must treat the stream as having NO
//! trusted identity — playback continues, canonical writes are skipped.

use std::time::Duration;

/// First 16 KiB — matches `md5_first_16kb`'s fingerprint window.
pub(crate) const RAW_PROBE_RANGE_END: u64 = 16 * 1024 - 1;

const RAW_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Rebuild a `stream.view` URL as a raw-original probe URL: same track + auth,
/// no transcode params, `format=raw`. Returns `None` for non-HTTP or
/// non-`stream.view` URLs (local files are already originals).
pub(crate) fn build_raw_probe_url(stream_url: &str) -> Option<String> {
    if !stream_url.starts_with("http://") && !stream_url.starts_with("https://") {
        return None;
    }
    let (base, query) = stream_url.split_once('?')?;
    if !base.contains("/stream") {
        return None;
    }
    let mut params: Vec<&str> = query
        .split('&')
        .filter(|kv| {
            let key = kv.split('=').next().unwrap_or("");
            !matches!(key, "maxBitRate" | "format" | "estimateContentLength")
        })
        .collect();
    params.push("format=raw");
    Some(format!("{base}?{}", params.join("&")))
}

/// Whether the body is a Subsonic error envelope rather than media bytes
/// (servers answer `format=raw` requests they don't understand with JSON/XML).
fn looks_like_subsonic_error(body: &[u8]) -> bool {
    let head = &body[..body.len().min(512)];
    let trimmed = head
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .map(|i| &head[i..])
        .unwrap_or(head);
    trimmed.starts_with(b"{") || trimmed.starts_with(b"<?xml") || trimmed.starts_with(b"<subsonic")
}

/// Header-phase validation — runs BEFORE any body bytes are read, so a server
/// that ignored the Range request (200 with the whole file) is rejected
/// without buffering it. Returns the exact prefix length the body must have.
///
/// Contract: `206`, `Content-Range: bytes 0-<end>/<total>` with a numeric
/// total, and `end` exactly `min(16 KiB, total) - 1` — a shorter-than-window
/// prefix of a larger file would fingerprint differently than
/// `md5_first_16kb(original)`, so truncated or inconsistent ranges are
/// rejected outright.
pub(crate) fn expected_prefix_len(status: u16, content_range: Option<&str>) -> Option<usize> {
    if status != 206 {
        return None;
    }
    let spec = content_range?.trim().strip_prefix("bytes ")?;
    let (span, total) = spec.split_once('/')?;
    let total: u64 = total.trim().parse().ok()?; // '*' (unknown total) -> reject
    let (start, end) = span.split_once('-')?;
    if start.trim() != "0" || total == 0 {
        return None;
    }
    let end: u64 = end.trim().parse().ok()?;
    if end >= total {
        return None; // inconsistent: range extends past the advertised size
    }
    if end != (total - 1).min(RAW_PROBE_RANGE_END) {
        return None; // truncated or over-long prefix — wrong fingerprint window
    }
    Some((end + 1) as usize)
}

/// Body-phase validation: exact expected length and not a Subsonic error
/// envelope served with a misleading 206.
pub(crate) fn validate_prefix_body(body: &[u8], expected_len: usize) -> bool {
    body.len() == expected_len && !looks_like_subsonic_error(body)
}

/// Fetch the original file's first 16 KiB via `format=raw` and fingerprint it.
/// `None` on any failure — the caller must then skip canonical analysis writes.
pub(crate) async fn fetch_trusted_original_md5(
    client: &reqwest::Client,
    http_headers: &crate::engine::PlaybackHttpHeaders,
    stream_url: &str,
) -> Option<String> {
    let probe_url = build_raw_probe_url(stream_url)?;
    // Same reverse-proxy gate headers as playback itself — a probe through
    // Pangolin/Cloudflare Access must not 403 while the stream succeeds.
    let req = http_headers.apply(&probe_url, client.get(&probe_url));
    let mut resp = req
        .header("Range", format!("bytes=0-{RAW_PROBE_RANGE_END}"))
        .timeout(RAW_PROBE_TIMEOUT)
        .send()
        .await
        .ok()?;
    // Validate status + Content-Range BEFORE touching the body: a server that
    // ignored the Range request would otherwise make us buffer the whole file.
    let status = resp.status().as_u16();
    let content_range = resp
        .headers()
        .get("Content-Range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let Some(expected_len) = expected_prefix_len(status, content_range.as_deref()) else {
        crate::app_deprintln!(
            "[analysis][raw-probe] rejected pre-body status={status} content_range={content_range:?}"
        );
        return None;
    };
    // Stream the body with a hard cap — never trust the headers alone.
    let mut body: Vec<u8> = Vec::with_capacity(expected_len);
    while let Ok(Some(chunk)) = resp.chunk().await {
        if body.len() + chunk.len() > expected_len {
            crate::app_deprintln!("[analysis][raw-probe] rejected: body exceeds advertised range");
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    if !validate_prefix_body(&body, expected_len) {
        crate::app_deprintln!(
            "[analysis][raw-probe] rejected body_len={} expected={expected_len}",
            body.len()
        );
        return None;
    }
    Some(psysonic_analysis::analysis_cache::md5_first_16kb(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_url_strips_transcode_params_and_requests_raw() {
        let url = "https://s.example/rest/stream.view?id=t1&u=a&t=tok&s=salt&v=1.16.1&c=psysonic&f=json&maxBitRate=128";
        let probe = build_raw_probe_url(url).unwrap();
        assert!(probe.contains("format=raw"));
        assert!(!probe.contains("maxBitRate"));
        assert!(probe.contains("id=t1") && probe.contains("t=tok"));
    }

    #[test]
    fn probe_url_replaces_an_existing_format_param() {
        let url = "https://s.example/rest/stream.view?id=t1&format=mp3&maxBitRate=128";
        let probe = build_raw_probe_url(url).unwrap();
        assert_eq!(probe.matches("format=").count(), 1);
        assert!(probe.ends_with("format=raw"));
    }

    #[test]
    fn probe_url_rejects_local_and_non_stream_urls() {
        assert_eq!(build_raw_probe_url("psysonic-local:///library/t.flac"), None);
        assert_eq!(build_raw_probe_url("https://s.example/rest/getCoverArt.view?id=c"), None);
    }

    #[test]
    fn header_validation_requires_206_zero_start_and_exact_window() {
        // Full window on a large file.
        assert_eq!(expected_prefix_len(206, Some("bytes 0-16383/9999999")), Some(16384));
        // 200 = Range ignored → reject BEFORE reading any body.
        assert_eq!(expected_prefix_len(200, Some("bytes 0-16383/9999999")), None);
        // Range not starting at zero.
        assert_eq!(expected_prefix_len(206, Some("bytes 100-16483/9999999")), None);
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
}

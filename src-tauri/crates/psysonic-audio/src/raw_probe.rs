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

/// Validate a raw-prefix probe response per the acceptance contract.
/// `content_range` is the raw `Content-Range` header value.
pub(crate) fn validate_raw_prefix_response(
    status: u16,
    content_range: Option<&str>,
    body: &[u8],
) -> bool {
    if status != 206 || body.is_empty() {
        return false;
    }
    let Some(range) = content_range else {
        return false;
    };
    // "bytes 0-<end>/<total>" — must start at byte zero and describe the body.
    let Some(spec) = range.trim().strip_prefix("bytes ") else {
        return false;
    };
    let Some((span, _total)) = spec.split_once('/') else {
        return false;
    };
    let Some((start, end)) = span.split_once('-') else {
        return false;
    };
    if start.trim() != "0" {
        return false;
    }
    let Ok(end) = end.trim().parse::<u64>() else {
        return false;
    };
    if end > RAW_PROBE_RANGE_END {
        return false;
    }
    if body.len() as u64 != end + 1 {
        return false;
    }
    !looks_like_subsonic_error(body)
}

/// Fetch the original file's first 16 KiB via `format=raw` and fingerprint it.
/// `None` on any failure — the caller must then skip canonical analysis writes.
pub(crate) async fn fetch_trusted_original_md5(
    client: &reqwest::Client,
    stream_url: &str,
) -> Option<String> {
    let probe_url = build_raw_probe_url(stream_url)?;
    let resp = client
        .get(&probe_url)
        .header("Range", format!("bytes=0-{RAW_PROBE_RANGE_END}"))
        .timeout(RAW_PROBE_TIMEOUT)
        .send()
        .await
        .ok()?;
    let status = resp.status().as_u16();
    let content_range = resp
        .headers()
        .get("Content-Range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp.bytes().await.ok()?;
    if !validate_raw_prefix_response(status, content_range.as_deref(), &body) {
        crate::app_deprintln!(
            "[analysis][raw-probe] rejected status={status} content_range={:?} body_len={}",
            content_range,
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
    fn validation_requires_206_zero_start_and_matching_length() {
        let body = vec![0x66u8; 16 * 1024]; // 'f' — media-ish bytes
        assert!(validate_raw_prefix_response(206, Some("bytes 0-16383/9999999"), &body));
        // Wrong status (whole-file 200 means Range was ignored — unverifiable).
        assert!(!validate_raw_prefix_response(200, Some("bytes 0-16383/9999999"), &body));
        // Range not starting at zero.
        assert!(!validate_raw_prefix_response(206, Some("bytes 100-16483/9999999"), &body));
        // Advertised length disagrees with the body.
        assert!(!validate_raw_prefix_response(206, Some("bytes 0-999/9999999"), &body));
        // Missing header entirely.
        assert!(!validate_raw_prefix_response(206, None, &body));
    }

    #[test]
    fn validation_accepts_short_files_and_rejects_error_envelopes() {
        // File smaller than the probe window: "bytes 0-511/512".
        let short = vec![0x11u8; 512];
        assert!(validate_raw_prefix_response(206, Some("bytes 0-511/512"), &short));
        // Subsonic JSON error served with a misleading 206.
        let err = br#"{"subsonic-response":{"status":"failed"}}"#.to_vec();
        let range = format!("bytes 0-{}/{}", err.len() - 1, err.len());
        assert!(!validate_raw_prefix_response(206, Some(&range), &err));
        // XML error envelope.
        let xml = br#"<?xml version="1.0"?><subsonic-response status="failed"/>"#.to_vec();
        let range = format!("bytes 0-{}/{}", xml.len() - 1, xml.len());
        assert!(!validate_raw_prefix_response(206, Some(&range), &xml));
    }
}

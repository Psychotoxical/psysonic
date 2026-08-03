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
//! Probe contract: accept the prefix only when the
//! response is `206 Partial Content`, its `Content-Range` starts at byte zero
//! and matches the body length, and the body is not a Subsonic JSON/XML error
//! envelope. On any failure the caller must treat the stream as having NO
//! trusted identity — playback continues, canonical writes are skipped.

use std::time::Duration;

use psysonic_core::server_http::{apply_optional_registry_headers, ServerHttpRegistry};

/// First 16 KiB — matches `md5_first_16kb`'s fingerprint window.
pub const RAW_PROBE_RANGE_END: u64 = 16 * 1024 - 1;

const RAW_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const RAW_FULL_FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// Rebuild a `stream.view` URL as a raw-original probe URL: same track + auth,
/// no transcode params, `format=raw`. Returns `None` for non-HTTP or
/// non-`stream.view` URLs (local files are already originals).
pub fn build_raw_probe_url(stream_url: &str) -> Option<String> {
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

/// Whether the request endpoint belongs to a registered profile whose current
/// saved identity explicitly supports Navidrome's `format=raw` contract.
pub fn raw_stream_supported(
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> bool {
    registry.is_some_and(|registry| {
        registry.supports_raw_stream_for_request(server_id, stream_url)
    })
}

/// Whether this exact request is the capability-bound Navidrome raw-original
/// path. The value is intentionally case-sensitive because Navidrome's private
/// contract requires lowercase `format=raw`.
pub fn is_verified_raw_stream_request(
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> bool {
    if !raw_stream_supported(registry, server_id, stream_url) {
        return false;
    }
    reqwest::Url::parse(stream_url).is_ok_and(|url| {
        let mut formats = url
            .query_pairs()
            .filter(|(key, _)| key == "format")
            .map(|(_, value)| value);
        matches!(formats.next().as_deref(), Some("raw")) && formats.next().is_none()
    })
}

fn capability_gated_raw_url(
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> Option<String> {
    if !raw_stream_supported(registry, server_id, stream_url) {
        return None;
    }
    build_raw_probe_url(stream_url)
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
pub fn expected_prefix_len(status: u16, content_range: Option<&str>) -> Option<usize> {
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
pub fn validate_prefix_body(body: &[u8], expected_len: usize) -> bool {
    body.len() == expected_len && !looks_like_subsonic_error(body)
}

/// Fetch the original file's first 16 KiB via `format=raw` and fingerprint it.
/// `None` on any failure — the caller must then skip canonical analysis writes.
pub async fn fetch_trusted_original_md5(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> Option<String> {
    let probe_url = capability_gated_raw_url(registry, server_id, stream_url)?;
    // Same reverse-proxy gate headers as playback itself — a probe through
    // Pangolin/Cloudflare Access must not 403 while the stream succeeds.
    let req = apply_optional_registry_headers(
        registry,
        server_id,
        &probe_url,
        client.get(&probe_url),
    );
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
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > expected_len {
                    crate::app_deprintln!(
                        "[analysis][raw-probe] rejected: body exceeds advertised range"
                    );
                    return None;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    if !validate_prefix_body(&body, expected_len) {
        crate::app_deprintln!(
            "[analysis][raw-probe] rejected body_len={} expected={expected_len}",
            body.len()
        );
        return None;
    }
    Some(crate::analysis_cache::md5_first_16kb(&body))
}

/// Fetch the complete verified original through `format=raw`, bounded by the
/// caller's existing analysis-size cap. The full body must still match the
/// trusted prefix to protect against a revision change between requests.
pub async fn fetch_trusted_original_bytes(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
    trusted_md5_16kb: &str,
    max_bytes: usize,
) -> Option<Vec<u8>> {
    if max_bytes == 0 || trusted_md5_16kb.is_empty() {
        return None;
    }
    let raw_url = capability_gated_raw_url(registry, server_id, stream_url)?;
    let request = apply_optional_registry_headers(
        registry,
        server_id,
        &raw_url,
        client.get(&raw_url),
    );
    let mut response = request
        .timeout(RAW_FULL_FETCH_TIMEOUT)
        .send()
        .await
        .ok()?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
    {
        return None;
    }

    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(max_bytes as u64) as usize,
    );
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len().saturating_add(chunk.len()) > max_bytes {
                    return None;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    if body.is_empty()
        || looks_like_subsonic_error(&body)
        || !bytes_match_trusted(&body, trusted_md5_16kb)
    {
        return None;
    }
    Some(body)
}


/// Whether captured stream bytes ARE the verified original: their own 16 KiB
/// fingerprint equals the trusted one. Used to gate stream-to-local promotion
/// — transcoded bytes must never be written to disk as the original file.
pub fn bytes_match_trusted(bytes: &[u8], trusted_md5_16kb: &str) -> bool {
    !bytes.is_empty() && crate::analysis_cache::md5_first_16kb(bytes) == trusted_md5_16kb
}

/// Outcome of a trusted-identity resolution for one analyzed HTTP stream.
#[derive(Debug, PartialEq, Eq)]
pub enum TrustedProbeVerdict {
    /// The original's fingerprint was verified — store analysis under it.
    Trusted(String),
    /// No positive provenance: the server may be force-transcoding (that is
    /// invisible on the wire), so bytes from an HTTP stream must NOT produce
    /// canonical writes (analysis cache, `content_hash`, facts). Playback and
    /// in-session use are unaffected.
    SkipCanonicalWrites,
}

/// Probe + policy in one place, shared by the playback dispatcher and the
/// HTTP backfill producers so the canonical-identity rules cannot diverge.
/// Canonical identity for HTTP-stream bytes requires POSITIVE original
/// provenance — a first-ever probe failure is not "assume original".
pub async fn resolve_trusted_identity(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> TrustedProbeVerdict {
    match fetch_trusted_original_md5(client, registry, server_id, stream_url).await {
        Some(hash) => TrustedProbeVerdict::Trusted(hash),
        None => TrustedProbeVerdict::SkipCanonicalWrites,
    }
}

#[cfg(test)]
mod byte_match_tests {
    use super::*;

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
}

#[cfg(test)]
mod capability_tests {
    use super::*;
    use psysonic_core::server_http::{
        CustomHeaderEntryWire, CustomHeadersApplyTo, EndpointKind,
        ServerHttpContextSyncWire, ServerHttpEndpointWire,
    };
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn registry_for(endpoint: &str, supports_raw_stream: bool) -> ServerHttpRegistry {
        let registry = ServerHttpRegistry::new();
        registry.sync(ServerHttpContextSyncWire {
            server_id: "server-key".into(),
            app_server_id: "profile-id".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: endpoint.into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: vec![CustomHeaderEntryWire {
                name: "X-Gate".into(),
                value: "token".into(),
            }],
            custom_headers_apply_to: Some(CustomHeadersApplyTo::Public),
            supports_raw_stream,
        });
        registry
    }

    #[tokio::test]
    async fn first_probe_failure_produces_no_canonical_verdict() {
        // Server-forced transcoding is invisible on the wire: a FIRST-EVER
        // probe failure must not be treated as proof the bytes are original.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let url = format!("{}/rest/stream.view?id=t1", server.uri());
        let registry = registry_for(&server.uri(), true);
        let got = resolve_trusted_identity(
            &reqwest::Client::new(), Some(&registry), Some("server-key"), &url,
        )
        .await;
        assert_eq!(got, TrustedProbeVerdict::SkipCanonicalWrites);
    }

    #[tokio::test]
    async fn unknown_or_non_navidrome_endpoint_never_issues_raw_request() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .respond_with(ResponseTemplate::new(206))
            .mount(&server)
            .await;
        let url = format!("{}/rest/stream.view?id=t1", server.uri());

        let unknown = resolve_trusted_identity(
            &reqwest::Client::new(), None, Some("server-key"), &url,
        )
        .await;
        let unsupported_registry = registry_for(&server.uri(), false);
        let unsupported = resolve_trusted_identity(
            &reqwest::Client::new(),
            Some(&unsupported_registry),
            Some("server-key"),
            &url,
        )
        .await;

        assert_eq!(unknown, TrustedProbeVerdict::SkipCanonicalWrites);
        assert_eq!(unsupported, TrustedProbeVerdict::SkipCanonicalWrites);
        assert!(server.received_requests().await.unwrap().is_empty());
    }
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
    fn verified_raw_request_requires_capability_endpoint_and_exact_raw_value() {
        use psysonic_core::server_http::{
            EndpointKind, ServerHttpContextSyncWire, ServerHttpEndpointWire,
        };

        let registry = ServerHttpRegistry::new();
        registry.sync(ServerHttpContextSyncWire {
            server_id: "server-key".into(),
            app_server_id: "profile-id".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://s.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream: true,
        });

        assert!(is_verified_raw_stream_request(
            Some(&registry),
            Some("server-key"),
            "https://s.example/rest/stream.view?id=t1&format=raw",
        ));
        assert!(!is_verified_raw_stream_request(
            Some(&registry),
            Some("server-key"),
            "https://s.example/rest/stream.view?id=t1&format=RAW",
        ));
        assert!(!is_verified_raw_stream_request(
            Some(&registry),
            Some("server-key"),
            "https://other.example/rest/stream.view?id=t1&format=raw",
        ));
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

#[cfg(test)]
mod http_tests {
    use super::*;
    use psysonic_core::server_http::{
        CustomHeaderEntryWire, CustomHeadersApplyTo, EndpointKind,
        ServerHttpContextSyncWire, ServerHttpEndpointWire,
    };
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn registry_for(endpoint: &str) -> ServerHttpRegistry {
        let registry = ServerHttpRegistry::new();
        registry.sync(ServerHttpContextSyncWire {
            server_id: "server-key".into(),
            app_server_id: "profile-id".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: endpoint.into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: vec![CustomHeaderEntryWire {
                name: "X-Gate".into(),
                value: "token".into(),
            }],
            custom_headers_apply_to: Some(CustomHeadersApplyTo::Public),
            supports_raw_stream: true,
        });
        registry
    }

    fn prefix(len: usize) -> Vec<u8> {
        // "fLaC"-leading media-ish bytes — never mistaken for an error envelope.
        let mut v = vec![0x66u8; len];
        v[..4.min(len)].copy_from_slice(&b"fLaC"[..4.min(len)]);
        v
    }

    #[tokio::test]
    async fn probe_accepts_a_valid_206_and_fingerprints_the_prefix() {
        let server = MockServer::start().await;
        let body = prefix(16 * 1024);
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .and(header("Range", "bytes=0-16383"))
            .and(header("X-Gate", "token"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("Content-Range", "bytes 0-16383/9999999")
                    .set_body_bytes(body.clone()),
            )
            .mount(&server)
            .await;
        let url = format!("{}/rest/stream.view?id=t1&u=a&maxBitRate=128", server.uri());
        let registry = registry_for(&server.uri());
        let got = fetch_trusted_original_md5(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
        )
        .await;
        assert_eq!(got, Some(crate::analysis_cache::md5_first_16kb(&body)));
    }

    #[tokio::test]
    async fn probe_rejects_a_200_that_ignored_the_range_request() {
        // Range ignored → whole-file 200. Must be rejected on headers alone.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(prefix(64 * 1024)))
            .mount(&server)
            .await;
        let url = format!("{}/rest/stream.view?id=t1&maxBitRate=128", server.uri());
        let registry = registry_for(&server.uri());
        let got = fetch_trusted_original_md5(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
        )
        .await;
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn probe_rejects_a_subsonic_error_served_as_206() {
        let server = MockServer::start().await;
        let err = br#"{"subsonic-response":{"status":"failed","error":{"code":70}}}"#.to_vec();
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header(
                        "Content-Range",
                        format!("bytes 0-{}/{}", err.len() - 1, err.len()).as_str(),
                    )
                    .set_body_bytes(err),
            )
            .mount(&server)
            .await;
        let url = format!("{}/rest/stream.view?id=t1&maxBitRate=128", server.uri());
        let registry = registry_for(&server.uri());
        let got = fetch_trusted_original_md5(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
        )
        .await;
        assert_eq!(got, None);
    }

    #[tokio::test]
    async fn full_raw_fetch_requires_the_trusted_prefix_and_size_cap() {
        let server = MockServer::start().await;
        let original = prefix(24 * 1024);
        let trusted = crate::analysis_cache::md5_first_16kb(&original);
        let registry = registry_for(&server.uri());
        let url = format!("{}/rest/stream.view?id=t1&maxBitRate=128", server.uri());

        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .and(header("X-Gate", "token"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
            .mount(&server)
            .await;

        let fetched = fetch_trusted_original_bytes(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
            &trusted,
            original.len(),
        )
        .await;
        assert_eq!(fetched.as_deref(), Some(original.as_slice()));

        let oversized = fetch_trusted_original_bytes(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
            &trusted,
            original.len() - 1,
        )
        .await;
        assert_eq!(oversized, None);

        let wrong_prefix = fetch_trusted_original_bytes(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
            "different-revision",
            original.len(),
        )
        .await;
        assert_eq!(wrong_prefix, None);

        let partial_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .respond_with(
                ResponseTemplate::new(206)
                    .insert_header("Content-Range", "bytes 0-16383/24576")
                    .set_body_bytes(original[..16 * 1024].to_vec()),
            )
            .mount(&partial_server)
            .await;
        let partial_registry = registry_for(&partial_server.uri());
        let partial_url = format!("{}/rest/stream.view?id=t1", partial_server.uri());
        let partial = fetch_trusted_original_bytes(
            &reqwest::Client::new(),
            Some(&partial_registry),
            Some("server-key"),
            &partial_url,
            &trusted,
            original.len(),
        )
        .await;
        assert_eq!(partial, None, "partial responses are not complete originals");
    }
}

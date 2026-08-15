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
//! Probe contract: prefer a strict `206 Partial Content` whose `Content-Range`
//! starts at byte zero. Some reverse proxies strip `Range`; for a verified
//! Navidrome raw endpoint, a `200 OK` response is consumed only through the
//! first 16 KiB and then dropped. Error envelopes are never trusted.

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

/// Rebuild a `stream.view` URL as the standard Subsonic original-download
/// endpoint, retaining track/auth parameters but removing transcode controls.
pub fn build_original_download_url(stream_url: &str) -> Option<String> {
    if !stream_url.starts_with("http://") && !stream_url.starts_with("https://") {
        return None;
    }
    let (base, query) = stream_url.split_once('?')?;
    let download_base = if let Some(prefix) = base.strip_suffix("/stream.view") {
        format!("{prefix}/download.view")
    } else {
        let prefix = base.strip_suffix("/stream")?;
        format!("{prefix}/download")
    };
    let params: Vec<&str> = query
        .split('&')
        .filter(|kv| {
            let key = kv.split('=').next().unwrap_or("");
            !matches!(key, "maxBitRate" | "format" | "estimateContentLength")
        })
        .collect();
    Some(format!("{download_base}?{}", params.join("&")))
}

/// Whether the request endpoint belongs to a registered profile whose current
/// saved identity explicitly supports Navidrome's `format=raw` contract.
pub fn raw_stream_supported(
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> bool {
    registry.is_some_and(|registry| registry.supports_raw_stream_for_request(server_id, stream_url))
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubsonicStreamError {
    pub code: i64,
    pub message: String,
}

impl SubsonicStreamError {
    pub fn is_source_unavailable(&self) -> bool {
        let message = self.message.to_ascii_lowercase();
        self.code == 70 || message.contains("no such file or directory")
    }

    pub fn diagnostic_reason(&self) -> &'static str {
        if self
            .message
            .to_ascii_lowercase()
            .contains("no such file or directory")
        {
            "no_such_file_or_directory"
        } else if self.code == 70 {
            "requested_data_not_found"
        } else {
            "subsonic_api_error"
        }
    }
}

fn parse_subsonic_stream_error(body: &[u8]) -> Option<SubsonicStreamError> {
    let envelope: serde_json::Value = serde_json::from_slice(body).ok()?;
    let response = envelope.get("subsonic-response")?;
    let error = response.get("error")?;
    Some(SubsonicStreamError {
        code: error.get("code").and_then(|value| value.as_i64()).unwrap_or(-1),
        message: error
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustedOriginalProbeResult {
    Trusted(String),
    SubsonicError(SubsonicStreamError),
    Unavailable,
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

/// Fetch the original file's first 16 KiB via `format=raw` and fingerprint it,
/// preserving structured Subsonic errors for background analysis handling.
pub async fn probe_trusted_original_md5(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> TrustedOriginalProbeResult {
    let Some(probe_url) = capability_gated_raw_url(registry, server_id, stream_url) else {
        return TrustedOriginalProbeResult::Unavailable;
    };
    // Same reverse-proxy gate headers as playback itself — a probe through
    // Pangolin/Cloudflare Access must not 403 while the stream succeeds.
    let req =
        apply_optional_registry_headers(registry, server_id, &probe_url, client.get(&probe_url));
    let Ok(mut resp) = req
        .header("Range", format!("bytes=0-{RAW_PROBE_RANGE_END}"))
        .timeout(RAW_PROBE_TIMEOUT)
        .send()
        .await
    else {
        return TrustedOriginalProbeResult::Unavailable;
    };
    let status = resp.status().as_u16();
    let content_range = resp
        .headers()
        .get("Content-Range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_length = resp.content_length();
    let full_response = status == 200 && content_range.is_none();
    let target_len = if full_response {
        content_length
            .unwrap_or(RAW_PROBE_RANGE_END + 1)
            .min(RAW_PROBE_RANGE_END + 1) as usize
    } else if let Some(expected_len) = expected_prefix_len(status, content_range.as_deref()) {
        expected_len
    } else {
        crate::app_deprintln!(
            "[analysis][raw-probe] rejected pre-body status={status} content_range={content_range:?} content_length={content_length:?}"
        );
        return TrustedOriginalProbeResult::Unavailable;
    };
    if target_len == 0 {
        return TrustedOriginalProbeResult::Unavailable;
    }
    // Never buffer beyond the fingerprint window, including when a proxy
    // ignored Range and returned the complete original as 200 OK.
    let mut body: Vec<u8> = Vec::with_capacity(target_len);
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let remaining = target_len.saturating_sub(body.len());
                body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                if body.len() == target_len {
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return TrustedOriginalProbeResult::Unavailable,
        }
    }
    let valid_len = body.len() == target_len
        || (full_response && content_length.is_none() && !body.is_empty());
    if let Some(error) = parse_subsonic_stream_error(&body) {
        return TrustedOriginalProbeResult::SubsonicError(error);
    }
    if !valid_len || looks_like_subsonic_error(&body) {
        crate::app_deprintln!(
            "[analysis][raw-probe] rejected body_len={} target={target_len}",
            body.len()
        );
        return TrustedOriginalProbeResult::Unavailable;
    }
    TrustedOriginalProbeResult::Trusted(crate::analysis_cache::md5_first_16kb(&body))
}

pub async fn fetch_trusted_original_md5(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> Option<String> {
    match probe_trusted_original_md5(client, registry, server_id, stream_url).await {
        TrustedOriginalProbeResult::Trusted(hash) => Some(hash),
        TrustedOriginalProbeResult::SubsonicError(_)
        | TrustedOriginalProbeResult::Unavailable => None,
    }
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
    fetch_trusted_original_bytes_result(
        client,
        registry,
        server_id,
        stream_url,
        trusted_md5_16kb,
        max_bytes,
    )
    .await
    .ok()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundedStreamFetchError {
    TooLarge { md5_16kb: String },
    HttpStatus(u16),
    SubsonicApi(SubsonicStreamError),
    RequestFailed(String),
    BodyReadFailed(String),
    InvalidResponse,
}

impl BoundedStreamFetchError {
    pub fn is_permanent_http(&self) -> bool {
        matches!(self, Self::HttpStatus(status) if (400..500).contains(status) && !matches!(status, 401 | 403 | 408 | 425 | 429))
    }
}

impl std::fmt::Display for BoundedStreamFetchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge { .. } => formatter.write_str("response exceeds analysis cap"),
            Self::HttpStatus(status) => write!(formatter, "HTTP {status}"),
            Self::SubsonicApi(error) => {
                write!(
                    formatter,
                    "Subsonic API error {} ({})",
                    error.code,
                    error.diagnostic_reason(),
                )
            }
            Self::RequestFailed(message) => write!(formatter, "request failed: {message}"),
            Self::BodyReadFailed(message) => write!(formatter, "body read failed: {message}"),
            Self::InvalidResponse => formatter.write_str("invalid or empty response"),
        }
    }
}

/// Fetch one already-constructed stream URL into a bounded buffer. This does
/// not establish content identity; callers must do that independently.
pub async fn fetch_bounded_stream_bytes(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, BoundedStreamFetchError> {
    if max_bytes == 0 {
        return Err(BoundedStreamFetchError::InvalidResponse);
    }
    let request =
        apply_optional_registry_headers(registry, server_id, stream_url, client.get(stream_url));
    let mut response = request
        .timeout(RAW_FULL_FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| {
            BoundedStreamFetchError::RequestFailed(error.without_url().to_string())
        })?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(BoundedStreamFetchError::HttpStatus(
            response.status().as_u16(),
        ));
    }
    let content_length = response.content_length();
    let mut too_large = content_length.is_some_and(|length| length > max_bytes as u64);
    let fingerprint_len = RAW_PROBE_RANGE_END as usize + 1;
    let initial_capacity = if too_large {
        fingerprint_len
    } else {
        content_length.unwrap_or(0).min(max_bytes as u64) as usize
    };
    let mut body = Vec::with_capacity(initial_capacity);
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if !too_large && body.len().saturating_add(chunk.len()) > max_bytes {
                    too_large = true;
                }
                if too_large {
                    let remaining = fingerprint_len.saturating_sub(body.len());
                    body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                    if body.len() >= fingerprint_len {
                        break;
                    }
                } else {
                    body.extend_from_slice(&chunk);
                }
            }
            Ok(None) => break,
            Err(error) => {
                return Err(BoundedStreamFetchError::BodyReadFailed(
                    error.without_url().to_string(),
                ));
            }
        }
    }
    if let Some(error) = parse_subsonic_stream_error(&body) {
        return Err(BoundedStreamFetchError::SubsonicApi(error));
    }
    if body.is_empty() || looks_like_subsonic_error(&body) {
        return Err(BoundedStreamFetchError::InvalidResponse);
    }
    if too_large {
        return Err(BoundedStreamFetchError::TooLarge {
            md5_16kb: crate::analysis_cache::md5_first_16kb(&body),
        });
    }
    Ok(body)
}

/// Detailed variant for background jobs that must distinguish a permanent
/// full-buffer size rejection from a transient HTTP/provenance failure.
pub async fn fetch_trusted_original_bytes_result(
    client: &reqwest::Client,
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
    trusted_md5_16kb: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, BoundedStreamFetchError> {
    if max_bytes == 0 || trusted_md5_16kb.is_empty() {
        return Err(BoundedStreamFetchError::InvalidResponse);
    }
    let raw_url = capability_gated_raw_url(registry, server_id, stream_url)
        .ok_or(BoundedStreamFetchError::InvalidResponse)?;
    let body = fetch_bounded_stream_bytes(client, registry, server_id, &raw_url, max_bytes).await?;
    if !bytes_match_trusted(&body, trusted_md5_16kb) {
        return Err(BoundedStreamFetchError::InvalidResponse);
    }
    Ok(body)
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
        CustomHeaderEntryWire, CustomHeadersApplyTo, EndpointKind, ServerHttpContextSyncWire,
        ServerHttpEndpointWire,
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
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
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

        let unknown =
            resolve_trusted_identity(&reqwest::Client::new(), None, Some("server-key"), &url).await;
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
        assert_eq!(
            build_raw_probe_url("psysonic-local:///library/t.flac"),
            None
        );
        assert_eq!(
            build_raw_probe_url("https://s.example/rest/getCoverArt.view?id=c"),
            None
        );
    }

    #[test]
    fn original_download_url_replaces_endpoint_and_strips_transcode_params() {
        let url = "https://s.example/rest/stream.view?id=t1&u=a&t=tok&format=mp3&maxBitRate=64&estimateContentLength=true";
        let download = build_original_download_url(url).unwrap();
        assert!(download.starts_with("https://s.example/rest/download.view?"));
        assert!(download.contains("id=t1"));
        assert!(download.contains("u=a"));
        assert!(download.contains("t=tok"));
        assert!(!download.contains("format="));
        assert!(!download.contains("maxBitRate="));
        assert!(!download.contains("estimateContentLength="));
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
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use psysonic_core::server_http::{
        CustomHeaderEntryWire, CustomHeadersApplyTo, EndpointKind, ServerHttpContextSyncWire,
        ServerHttpEndpointWire,
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
    async fn probe_bounds_a_200_that_ignored_the_range_request_to_the_fingerprint_window() {
        let server = MockServer::start().await;
        let body = prefix(64 * 1024);
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(header("Range", "bytes=0-16383"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
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
        assert_eq!(
            got,
            Some(crate::analysis_cache::md5_first_16kb(&body))
        );
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
    async fn detailed_probe_returns_the_subsonic_error_reason() {
        let server = MockServer::start().await;
        let err = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /music/a.flac: no such file or directory"}}}"#.to_vec();
        Mock::given(method("GET"))
            .and(path("/rest/stream.view"))
            .and(query_param("format", "raw"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(err))
            .mount(&server)
            .await;
        let url = format!("{}/rest/stream.view?id=missing", server.uri());
        let registry = registry_for(&server.uri());

        let result = probe_trusted_original_md5(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
        )
        .await;

        assert_eq!(
            result,
            TrustedOriginalProbeResult::SubsonicError(SubsonicStreamError {
                code: 0,
                message: "open /music/a.flac: no such file or directory".to_string(),
            })
        );
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

        let oversized = fetch_trusted_original_bytes_result(
            &reqwest::Client::new(),
            Some(&registry),
            Some("server-key"),
            &url,
            &trusted,
            original.len() - 1,
        )
        .await;
        assert_eq!(
            oversized,
            Err(BoundedStreamFetchError::TooLarge {
                md5_16kb: trusted.clone(),
            })
        );

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
        assert_eq!(
            partial, None,
            "partial responses are not complete originals"
        );
    }
}

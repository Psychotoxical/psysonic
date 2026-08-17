use std::time::Duration;

use psysonic_core::server_http::{apply_optional_registry_headers, ServerHttpRegistry};

use super::format::capability_gated_raw_url;
use super::protocol::{
    bytes_match_trusted, expected_prefix_len, looks_like_subsonic_error,
    parse_subsonic_stream_error, BoundedStreamFetchError, TrustedOriginalProbeResult,
    TrustedProbeVerdict, RAW_PROBE_RANGE_END,
};

const RAW_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const RAW_FULL_FETCH_TIMEOUT: Duration = Duration::from_secs(120);

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
    let valid_len =
        body.len() == target_len || (full_response && content_length.is_none() && !body.is_empty());
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
        TrustedOriginalProbeResult::SubsonicError(_) | TrustedOriginalProbeResult::Unavailable => {
            None
        }
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
        .map_err(|error| BoundedStreamFetchError::RequestFailed(error.without_url().to_string()))?;
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

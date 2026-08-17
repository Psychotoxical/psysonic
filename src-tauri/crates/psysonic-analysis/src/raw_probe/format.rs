use psysonic_core::server_http::ServerHttpRegistry;

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

pub(super) fn capability_gated_raw_url(
    registry: Option<&ServerHttpRegistry>,
    server_id: Option<&str>,
    stream_url: &str,
) -> Option<String> {
    if !raw_stream_supported(registry, server_id, stream_url) {
        return None;
    }
    build_raw_probe_url(stream_url)
}

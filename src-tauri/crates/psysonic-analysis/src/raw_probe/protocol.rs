/// First 16 KiB — matches `md5_first_16kb`'s fingerprint window.
pub const RAW_PROBE_RANGE_END: u64 = 16 * 1024 - 1;

/// Whether the body is a Subsonic error envelope rather than media bytes
/// (servers answer `format=raw` requests they don't understand with JSON/XML).
pub(super) fn looks_like_subsonic_error(body: &[u8]) -> bool {
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

pub(super) fn parse_subsonic_stream_error(body: &[u8]) -> Option<SubsonicStreamError> {
    let envelope: serde_json::Value = serde_json::from_slice(body).ok()?;
    let response = envelope.get("subsonic-response")?;
    let error = response.get("error")?;
    Some(SubsonicStreamError {
        code: error
            .get("code")
            .and_then(|value| value.as_i64())
            .unwrap_or(-1),
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

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

mod fetch;
mod format;
mod protocol;

pub use fetch::{
    fetch_bounded_stream_bytes, fetch_trusted_original_bytes, fetch_trusted_original_bytes_result,
    fetch_trusted_original_md5, probe_trusted_original_md5, resolve_trusted_identity,
};
pub use format::{
    build_original_download_url, build_raw_probe_url, is_verified_raw_stream_request,
    raw_stream_supported,
};
pub use protocol::{
    bytes_match_trusted, expected_prefix_len, validate_prefix_body, BoundedStreamFetchError,
    SubsonicStreamError, TrustedOriginalProbeResult, TrustedProbeVerdict, RAW_PROBE_RANGE_END,
};

#[cfg(test)]
use protocol::parse_subsonic_stream_error;

#[cfg(test)]
mod tests;

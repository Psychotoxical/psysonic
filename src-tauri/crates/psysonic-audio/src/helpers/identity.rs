/// Subsonic `buildStreamUrl()` uses a fresh random salt on every call, so two
/// URLs for the same track differ in `t`/`s` query params. Compare a stable key.
pub(crate) fn playback_identity(url: &str) -> Option<String> {
    if let Some(path) = url.strip_prefix("psysonic-local://") {
        return Some(format!("local:{path}"));
    }
    if !url.contains("stream.view") {
        return None;
    }
    let q = url.split('?').nth(1)?;
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("id=") {
            let v = v.split('&').next().unwrap_or(v);
            return Some(format!("stream:{v}"));
        }
    }
    None
}

/// Stable id for analysis cache rows and `analysis:waveform-updated`.
/// Prefer the Subsonic track id from the frontend: `psysonic-local://` URLs
/// only map to `local:path` in `playback_identity`, which does not match
/// `analysis_get_waveform_for_track(trackId)` or the UI's `currentTrack.id`.
pub(crate) fn analysis_cache_track_id(logical_track_id: Option<&str>, url: &str) -> Option<String> {
    let logical = logical_track_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    logical.or_else(|| playback_identity(url))
}

/// Identity-relevant query params of a stream URL — the owning account (`u`)
/// plus the requested transcode `format` and `maxBitRate` cap. Rotating auth
/// params (`t`/`s`) stay excluded.
fn stream_quality_signature(url: &str) -> String {
    let Some(q) = url.split('?').nth(1) else {
        return String::new();
    };
    let mut max_bit_rate = "";
    let mut format = "";
    let mut user = "";
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("maxBitRate=") {
            max_bit_rate = v;
        } else if let Some(v) = pair.strip_prefix("format=") {
            format = v;
        } else if let Some(v) = pair.strip_prefix("u=") {
            // Owning account: per-user server transcoding policies can differ,
            // so bytes are never shared across profiles on one endpoint.
            user = v;
        }
    }
    if max_bit_rate.is_empty() && format.is_empty() && user.is_empty() {
        return String::new();
    }
    format!("{user}|{max_bit_rate}|{format}")
}

/// Server base of a Subsonic stream URL — scheme + authority + any path
/// prefix before `/rest/`. Two Navidrome instances behind one reverse-proxy
/// host on different prefixes (`https://host/nav-a` vs `…/nav-b`) are
/// different servers and must never share cached bytes; likewise http vs
/// https transports are kept distinct. Empty for non-HTTP URLs.
fn stream_server_base(url: &str) -> &str {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return "";
    }
    if let Some(idx) = url.find("/rest/") {
        return &url[..idx];
    }
    // No /rest/ segment: fall back to scheme + authority.
    let scheme_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    match url[scheme_end..].find('/') {
        Some(i) => &url[..scheme_end + i],
        None => url.split('?').next().unwrap_or(url),
    }
}

/// Byte-cache equality for stream/preload/chain matching. Two URLs are the
/// same playback target only when they name the same track on the same server
/// base (scheme + authority + path prefix) AND request the same transcode quality — a completed 128 kbps stream must
/// not satisfy a later request for Original or a different cap/format.
/// (Track-level identity for analysis/gain stays `playback_identity`, which is
/// deliberately quality-independent.)
pub(crate) fn same_playback_target(a_url: &str, b_url: &str) -> bool {
    match (playback_identity(a_url), playback_identity(b_url)) {
        (Some(a), Some(b)) => {
            a == b
                && stream_server_base(a_url) == stream_server_base(b_url)
                && stream_quality_signature(a_url) == stream_quality_signature(b_url)
        }
        _ => a_url == b_url,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_target_ignores_rotating_auth_but_not_quality() {
        // Fresh salt/token → still the same target.
        assert!(same_playback_target(
            "https://s/rest/stream.view?id=42&t=aaa&s=x1",
            "https://s/rest/stream.view?id=42&t=bbb&s=x2",
        ));
        // A completed 128 kbps stream must NOT satisfy an Original request…
        assert!(!same_playback_target(
            "https://s/rest/stream.view?id=42&maxBitRate=128",
            "https://s/rest/stream.view?id=42",
        ));
        // …nor a different cap or a different requested format.
        assert!(!same_playback_target(
            "https://s/rest/stream.view?id=42&maxBitRate=128",
            "https://s/rest/stream.view?id=42&maxBitRate=320",
        ));
        assert!(!same_playback_target(
            "https://s/rest/stream.view?id=42&maxBitRate=128&format=opus",
            "https://s/rest/stream.view?id=42&maxBitRate=128&format=mp3",
        ));
        // Identical quality matches.
        assert!(same_playback_target(
            "https://s/rest/stream.view?id=42&maxBitRate=128&format=opus&t=a",
            "https://s/rest/stream.view?id=42&maxBitRate=128&format=opus&t=b",
        ));
    }

    #[test]
    fn same_target_distinguishes_hosts_sharing_a_track_id() {
        assert!(!same_playback_target(
            "https://lan.local/rest/stream.view?id=42",
            "https://public.example/rest/stream.view?id=42",
        ));
    }

    #[test]
    fn same_target_distinguishes_user_accounts_on_one_endpoint() {
        // Two profiles (accounts) on the same server: per-user transcoding
        // policies can differ, so completed/preloaded bytes must never be
        // reused across accounts even when track id and quality match.
        assert!(!same_playback_target(
            "https://s/rest/stream.view?id=42&u=alice&t=a1&s=x1",
            "https://s/rest/stream.view?id=42&u=bob&t=b1&s=x2",
        ));
        // Same account with rotating auth still matches.
        assert!(same_playback_target(
            "https://s/rest/stream.view?id=42&u=alice&t=a1&s=x1",
            "https://s/rest/stream.view?id=42&u=alice&t=a2&s=x2",
        ));
    }

    #[test]
    fn same_target_distinguishes_server_bases_behind_one_proxy_host() {
        // Two Navidrome instances on one host, different path prefixes.
        assert!(!same_playback_target(
            "https://proxy.example/nav-a/rest/stream.view?id=42",
            "https://proxy.example/nav-b/rest/stream.view?id=42",
        ));
        // Same instance, same prefix → same target.
        assert!(same_playback_target(
            "https://proxy.example/nav-a/rest/stream.view?id=42&t=x",
            "https://proxy.example/nav-a/rest/stream.view?id=42&t=y",
        ));
        // http vs https transports stay distinct.
        assert!(!same_playback_target(
            "http://host/rest/stream.view?id=42",
            "https://host/rest/stream.view?id=42",
        ));
    }

    #[test]
    fn playback_identity_for_local_path() {
        assert_eq!(
            playback_identity("psysonic-local:///cache/track.flac"),
            Some("local:/cache/track.flac".into()),
        );
    }

    #[test]
    fn playback_identity_for_subsonic_stream_url() {
        assert_eq!(
            playback_identity("https://server/rest/stream.view?u=user&t=abc&id=42"),
            Some("stream:42".into()),
        );
    }

    #[test]
    fn playback_identity_returns_none_for_url_without_stream_view() {
        assert!(playback_identity("https://server/something").is_none());
    }

    #[test]
    fn playback_identity_returns_none_when_no_id_param_present() {
        assert!(
            playback_identity("https://server/rest/stream.view?u=user&t=abc").is_none(),
            "stream.view URL without an id= param has no stable identity"
        );
    }

    #[test]
    fn analysis_cache_id_prefers_logical_track_id() {
        assert_eq!(
            analysis_cache_track_id(Some("abc"), "https://server/rest/stream.view?id=42"),
            Some("abc".into()),
        );
    }

    #[test]
    fn analysis_cache_id_falls_back_to_playback_identity() {
        assert_eq!(
            analysis_cache_track_id(None, "https://server/rest/stream.view?id=42"),
            Some("stream:42".into()),
        );
    }

    #[test]
    fn analysis_cache_id_treats_whitespace_logical_id_as_missing() {
        assert_eq!(
            analysis_cache_track_id(Some("   "), "https://server/rest/stream.view?id=42"),
            Some("stream:42".into()),
        );
    }

    #[test]
    fn analysis_cache_id_returns_none_when_neither_source_resolves() {
        assert!(analysis_cache_track_id(None, "https://server/other").is_none());
    }

    #[test]
    fn same_target_treats_different_salts_as_same_track() {
        let a = "https://server/rest/stream.view?id=42&u=user&t=AAA&s=salt1";
        let b = "https://server/rest/stream.view?id=42&u=user&t=BBB&s=salt2";
        assert!(same_playback_target(a, b));
    }

    #[test]
    fn same_target_treats_different_ids_as_different_tracks() {
        let a = "https://server/rest/stream.view?id=42&u=user&t=AAA";
        let b = "https://server/rest/stream.view?id=99&u=user&t=AAA";
        assert!(!same_playback_target(a, b));
    }

    #[test]
    fn same_target_falls_back_to_string_compare_for_unknown_urls() {
        assert!(same_playback_target("foo://x", "foo://x"));
        assert!(!same_playback_target("foo://x", "foo://y"));
    }
}

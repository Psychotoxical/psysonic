//! Subsonic `stream.view` URLs for native library analysis backfill.

use url::Url;

use super::auth::SubsonicCredentials;
use super::client::{SUBSONIC_API_VERSION, SUBSONIC_CLIENT_ID};

/// `{origin}/rest` — mirrors frontend `restBaseFromUrl`.
pub fn rest_base_from_url(server_url: &str) -> String {
    let trimmed = server_url.trim().trim_end_matches('/');
    let base = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    format!("{base}/rest")
}

/// Authenticated `stream.view` URL for a library track id.
pub fn build_stream_view_url(
    server_url: &str,
    username: &str,
    password: &str,
    track_id: &str,
) -> String {
    let creds = SubsonicCredentials::from_password(username, password);
    let base = rest_base_from_url(server_url);
    let mut url =
        Url::parse(&format!("{base}/stream.view")).unwrap_or_else(|_| Url::parse("http://invalid/rest/stream.view").unwrap());
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("id", track_id);
        q.append_pair("u", &creds.username);
        q.append_pair("t", &creds.token);
        q.append_pair("s", &creds.salt);
        q.append_pair("v", SUBSONIC_API_VERSION);
        q.append_pair("c", SUBSONIC_CLIENT_ID);
        q.append_pair("f", "json");
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_url_contains_track_and_auth_params() {
        let url = build_stream_view_url(
            "https://music.example",
            "alice",
            "secret",
            "tr-42",
        );
        assert!(url.contains("stream.view"));
        assert!(url.contains("id=tr-42"));
        assert!(url.contains("u=alice"));
        assert!(url.contains("&t="));
        assert!(url.contains("&s="));
    }
}

use reqwest::Client;
use psysonic_core::server_http::ServerHttpRegistry;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const SUBSONIC_CLIENT: &str = "Psysonic";

/// Total cover fetch attempts (1 initial + retries). A busy server can answer
/// covers with 5xx/429/timeouts under our own backfill load, so a couple of
/// backed-off retries recover those without a permanent `.fetch-failed` marker.
const COVER_FETCH_ATTEMPTS: usize = 3;
/// Base backoff between attempts (grows linearly: 1×, 2×, …).
const COVER_FETCH_BACKOFF_MS: u64 = 400;

fn random_salt() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// Build a token-authed Subsonic REST URL `{rest_base}/rest/{endpoint}.view`
/// with the standard `u/t/s/v/c` auth params plus the given `extra` query
/// pairs. Shared by all Subsonic GETs (cover art, `getArtistInfo2`, …).
pub(crate) fn build_subsonic_url(
    rest_base: &str,
    endpoint: &str,
    username: &str,
    password: &str,
    extra: &[(&str, &str)],
) -> String {
    let base = rest_base.trim_end_matches('/');
    let api_base = if base.ends_with("/rest") {
        base.to_string()
    } else {
        format!("{base}/rest")
    };
    let salt = random_salt();
    let token = format!("{:x}", md5::compute(format!("{password}{salt}")));
    let endpoint_url = format!("{api_base}/{endpoint}.view");
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in extra {
        serializer.append_pair(k, v);
    }
    serializer.append_pair("u", username);
    serializer.append_pair("t", &token);
    serializer.append_pair("s", &salt);
    serializer.append_pair("v", "1.16.1");
    serializer.append_pair("c", SUBSONIC_CLIENT);
    let query = serializer.finish();
    match Url::parse(&endpoint_url) {
        Ok(mut url) => {
            url.set_query(Some(&query));
            url.to_string()
        }
        Err(_) => format!("{endpoint_url}?{query}"),
    }
}

pub fn build_cover_art_url(
    rest_base: &str,
    username: &str,
    password: &str,
    cover_art_id: &str,
    size: u32,
) -> String {
    let size_s = size.to_string();
    build_subsonic_url(
        rest_base,
        "getCoverArt",
        username,
        password,
        &[("id", cover_art_id), ("size", &size_s)],
    )
}

/// Outcome of a single fetch attempt: transient errors are worth retrying,
/// permanent ones (a real 4xx like 404 — the cover simply does not exist) are
/// not, so we never hammer the server for genuinely-missing art.
enum FetchAttempt {
    Ok(Vec<u8>),
    Transient(String),
    Permanent(String),
}

async fn fetch_cover_once(
    client: &Client,
    url: &str,
    registry: Option<&ServerHttpRegistry>,
    server_ref: Option<&str>,
) -> FetchAttempt {
    // Single gate-header application point — resolves by `server_ref` first,
    // then falls back to matching the request URL against a registered gated
    // endpoint. No match (non-gated server) leaves the request untouched.
    let req = psysonic_core::server_http::apply_optional_registry_headers(
        registry,
        server_ref,
        url,
        client.get(url),
    );
    let resp = match req.send().await {
        Ok(r) => r,
        // Connection reset / timeout / DNS — transient under server load.
        Err(e) => return FetchAttempt::Transient(e.to_string()),
    };
    let status = resp.status();
    if status.is_success() {
        return match resp.bytes().await {
            Ok(b) => FetchAttempt::Ok(b.to_vec()),
            Err(e) => FetchAttempt::Transient(e.to_string()),
        };
    }
    let msg = format!("cover HTTP {status}");
    if cover_http_status_is_transient(status) {
        FetchAttempt::Transient(msg)
    } else {
        FetchAttempt::Permanent(msg)
    }
}

/// A cover HTTP status worth retrying — i.e. NOT a permanent "cover missing".
///
/// A `4xx` normally means the art is genuinely absent (`404`/`410`) or the
/// request was malformed (`400`) — permanent, so we never hammer the server for
/// it. The exceptions are gate / throttle statuses: behind a Cloudflare Access
/// or Pangolin gate a `401`/`403` means the gate refused a request whose token
/// wasn't applied (e.g. the per-server header registry hadn't been populated yet
/// at startup), which recovers the moment the header lands. Treating those as
/// transient keeps the short retry loop alive across a brief registry gap
/// instead of writing a 30-minute `.fetch-failed` marker for art that is really
/// there.
fn cover_http_status_is_transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || matches!(
            status,
            reqwest::StatusCode::UNAUTHORIZED
                | reqwest::StatusCode::FORBIDDEN
                | reqwest::StatusCode::REQUEST_TIMEOUT
                | reqwest::StatusCode::TOO_EARLY
                | reqwest::StatusCode::TOO_MANY_REQUESTS
        )
}

pub async fn fetch_cover_bytes(
    client: &Client,
    url: &str,
    registry: Option<&ServerHttpRegistry>,
    server_ref: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut last_err = String::from("cover fetch failed");
    for attempt in 0..COVER_FETCH_ATTEMPTS {
        match fetch_cover_once(client, url, registry, server_ref).await {
            FetchAttempt::Ok(bytes) => return Ok(bytes),
            FetchAttempt::Permanent(e) => return Err(e),
            FetchAttempt::Transient(e) => {
                last_err = e;
                if attempt + 1 < COVER_FETCH_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(
                        COVER_FETCH_BACKOFF_MS * (attempt as u64 + 1),
                    ))
                    .await;
                }
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::{build_cover_art_url, cover_http_status_is_transient};
    use reqwest::StatusCode;

    #[test]
    fn gate_and_throttle_statuses_are_transient() {
        // Behind an auth gate a 401/403 is a token/header hiccup that recovers
        // once the per-server header lands — not a missing cover.
        assert!(cover_http_status_is_transient(StatusCode::UNAUTHORIZED));
        assert!(cover_http_status_is_transient(StatusCode::FORBIDDEN));
        assert!(cover_http_status_is_transient(StatusCode::REQUEST_TIMEOUT));
        assert!(cover_http_status_is_transient(StatusCode::TOO_EARLY));
        assert!(cover_http_status_is_transient(StatusCode::TOO_MANY_REQUESTS));
        assert!(cover_http_status_is_transient(StatusCode::BAD_GATEWAY));
        assert!(cover_http_status_is_transient(StatusCode::SERVICE_UNAVAILABLE));
    }

    #[test]
    fn genuine_missing_or_bad_request_is_permanent() {
        // These mean the art really is absent / the request is wrong — marking
        // them failed avoids hammering the server for art that isn't there.
        assert!(!cover_http_status_is_transient(StatusCode::NOT_FOUND));
        assert!(!cover_http_status_is_transient(StatusCode::GONE));
        assert!(!cover_http_status_is_transient(StatusCode::BAD_REQUEST));
    }

    #[test]
    fn cover_url_from_host_root() {
        let url = build_cover_art_url(
            "http://navidrome.local:4533",
            "u",
            "p",
            "al-1",
            800,
        );
        assert!(url.starts_with("http://navidrome.local:4533/rest/getCoverArt.view?"));
        assert!(url.contains("id=al-1"));
        assert!(url.contains("size=800"));
    }

    #[test]
    fn cover_url_when_rest_suffix_already_present() {
        let url = build_cover_art_url(
            "http://navidrome.local:4533/rest",
            "u",
            "p",
            "al-1",
            128,
        );
        assert!(url.starts_with("http://navidrome.local:4533/rest/getCoverArt.view?"));
        assert!(!url.contains("/rest/rest/"));
    }

    #[test]
    fn cover_url_does_not_panic_on_malformed_base() {
        let url = build_cover_art_url("://bad-url", "u", "p", "al-1", 128);
        assert!(url.contains("/rest/getCoverArt.view?"));
        assert!(url.contains("id=al-1"));
    }
}

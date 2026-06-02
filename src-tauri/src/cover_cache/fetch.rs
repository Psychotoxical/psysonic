use reqwest::Client;
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

pub fn build_cover_art_url(
    rest_base: &str,
    username: &str,
    password: &str,
    cover_art_id: &str,
    size: u32,
) -> String {
    let base = rest_base.trim_end_matches('/');
    let api_base = if base.ends_with("/rest") {
        base.to_string()
    } else {
        format!("{base}/rest")
    };
    let salt = random_salt();
    let token = format!("{:x}", md5::compute(format!("{password}{salt}")));
    let endpoint = format!("{api_base}/getCoverArt.view");
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("id", cover_art_id);
    serializer.append_pair("size", &size.to_string());
    serializer.append_pair("u", username);
    serializer.append_pair("t", &token);
    serializer.append_pair("s", &salt);
    serializer.append_pair("v", "1.16.1");
    serializer.append_pair("c", SUBSONIC_CLIENT);
    let query = serializer.finish();
    match Url::parse(&endpoint) {
        Ok(mut url) => {
            url.set_query(Some(&query));
            url.to_string()
        }
        Err(_) => format!("{endpoint}?{query}"),
    }
}

/// Outcome of a single fetch attempt: transient errors are worth retrying,
/// permanent ones (a real 4xx like 404 — the cover simply does not exist) are
/// not, so we never hammer the server for genuinely-missing art.
enum FetchAttempt {
    Ok(Vec<u8>),
    Transient(String),
    Permanent(String),
}

async fn fetch_cover_once(client: &Client, url: &str) -> FetchAttempt {
    let resp = match client.get(url).send().await {
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
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        FetchAttempt::Transient(msg)
    } else {
        FetchAttempt::Permanent(msg)
    }
}

pub async fn fetch_cover_bytes(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let mut last_err = String::from("cover fetch failed");
    for attempt in 0..COVER_FETCH_ATTEMPTS {
        match fetch_cover_once(client, url).await {
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
    use super::build_cover_art_url;

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

//! Auth + retry + HTTP client for Navidrome's native REST API.
//! Used by every other navidrome submodule for `/auth/*` and `/api/*` calls.

/// Authenticate with Navidrome's own REST API and return a Bearer token.
pub async fn navidrome_token(server_url: &str, username: &str, password: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/auth/login", server_url))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    data["token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Navidrome auth: no token in response".to_string())
}

/// Payload returned by Navidrome's `/auth/login`.
#[derive(serde::Serialize)]
pub struct NdLoginResult {
    pub(super) token: String,
    #[serde(rename = "userId")]
    pub(super) user_id: String,
    #[serde(rename = "isAdmin")]
    pub(super) is_admin: bool,
}

/// Flatten an error and its `source` chain into a single readable string so
/// frontend toasts can show the actual transport cause (connection refused,
/// tls handshake fail, cert expired, etc.) instead of reqwest's opaque
/// "error sending request for url (…)" wrapper.
pub fn nd_err(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(" | ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

/// Retry a request-building closure on transient transport errors
/// (connect/timeout — includes ECONNRESET, TLS handshake EOF, DNS flakes).
/// Three attempts with calm backoff: 0 → 300ms → 700ms (total worst case
/// ~1s). Retrying too aggressively (5+ attempts, short backoff) can drive
/// an already-stressed nginx upstream-probe into "offline" mode, which
/// turns a transient glitch into a visible outage. Status-level failures
/// (401/403/400 with body) return immediately — we don't retry logic
/// errors.
pub async fn nd_retry<F, Fut>(mut build_and_send: F) -> Result<reqwest::Response, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    // Reverse-proxies in front of Navidrome (Caddy/nginx + Cloudflare etc.)
    // sometimes drop a TLS handshake mid-stream when their keep-alive pool
    // churns. One 500 ms retry isn't always enough — exponential backoff
    // across 4 attempts gives the upstream pool time to settle without
    // making the user-visible wait worse for the common single-failure case.
    const BACKOFFS_MS: [u64; 3] = [300, 800, 1800];
    let mut last: Option<reqwest::Error> = None;
    for attempt in 0..=BACKOFFS_MS.len() {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(BACKOFFS_MS[attempt - 1])).await;
        }
        match build_and_send().await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                if !e.is_connect() && !e.is_timeout() {
                    return Err(nd_err(e));
                }
                last = Some(e);
            }
        }
    }
    Err(nd_err(last.expect("loop ran at least once")))
}

/// Build a reqwest client for Navidrome's native REST endpoints. Plain
/// `reqwest::Client::new()` defaults to HTTP/2 over ALPN with no User-Agent,
/// which some reverse-proxies (strict nginx rules, Cloudflare Tunnel, CDN
/// WAFs) abort mid-TLS-handshake. Pinning HTTP/1.1 and advertising a real
/// User-Agent makes the handshake match what browsers do for the Subsonic
/// endpoints, so `/auth/*` + `/api/*` go through the same path as `/rest/*`.
///
/// `pool_max_idle_per_host(0)` disables connection pooling. Keeping stale
/// keep-alive connections in the pool caused intermittent "tls handshake
/// eof" errors on the second call to an admin endpoint when a server or
/// proxy had already closed the TCP connection between calls.
pub fn nd_http_client() -> reqwest::Client {
    // TLS 1.2 only: rustls + nginx with TLS-1.3 session resumption caches
    // produces intermittent ECONNRESET mid-handshake when the upstream
    // starts churning keep-alive connections. Pinning TLS 1.2 matches what
    // the WebKit-side Subsonic calls end up negotiating most of the time
    // on these setups.
    reqwest::Client::builder()
        .user_agent(format!("Psysonic/{} (Tauri)", env!("CARGO_PKG_VERSION")))
        .http1_only()
        .pool_max_idle_per_host(0)
        .max_tls_version(reqwest::tls::Version::TLS_1_2)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ── nd_http_client ────────────────────────────────────────────────────────

    #[test]
    fn nd_http_client_builds_without_panicking() {
        // Don't try to inspect — just verify the builder + fallback returns a Client.
        let _client = nd_http_client();
    }

    // ── nd_err ────────────────────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn nd_err_flattens_into_a_single_string() {
        // Provoke a transport error by hitting an unbound port — the error chain
        // typically is "error sending request | tcp connect error | refused".
        let client = reqwest::Client::new();
        let err = client
            .get("http://127.0.0.1:1") // port 1 is reserved, never bound
            .send()
            .await
            .expect_err("connect must fail");
        let flattened = nd_err(err);
        // The flattened string contains at least the top message.
        assert!(!flattened.is_empty());
        // The chain joiner appears zero or more times depending on the OS — we
        // just verify the function doesn't panic and returns something readable.
    }

    // ── nd_retry — uses a synthetic Future, not reqwest, for determinism ──────

    /// Build a reqwest::Error of the connect kind by attempting an immediate
    /// connect to a known-closed port. Reused by the retry tests so we get
    /// errors classified as `is_connect()`.
    async fn synthetic_connect_error() -> reqwest::Error {
        reqwest::Client::new()
            .get("http://127.0.0.1:1")
            .timeout(std::time::Duration::from_millis(50))
            .send()
            .await
            .expect_err("connect must fail")
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nd_retry_returns_immediately_when_first_attempt_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/ok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_c = attempts.clone();
        let url = format!("{}/ok", server.uri());
        let resp = nd_retry(move || {
            attempts_c.fetch_add(1, Ordering::SeqCst);
            let url = url.clone();
            async move { reqwest::Client::new().get(&url).send().await }
        })
        .await
        .expect("first try should win");
        assert_eq!(resp.status(), 200);
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "no retries");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nd_retry_does_not_retry_status_level_errors() {
        // 404 is a status-level error (the future returned Ok(resp) with status 404).
        // Even though the response is "bad", the body is intact; nd_retry must
        // return immediately without retrying.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/missing"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_c = attempts.clone();
        let url = format!("{}/missing", server.uri());
        let resp = nd_retry(move || {
            attempts_c.fetch_add(1, Ordering::SeqCst);
            let url = url.clone();
            async move { reqwest::Client::new().get(&url).send().await }
        })
        .await
        .expect("status errors come back as Ok(resp)");
        assert_eq!(resp.status(), 404);
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "404 must not trigger a retry");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nd_retry_returns_err_when_all_attempts_fail() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_c = attempts.clone();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            nd_retry(move || {
                attempts_c.fetch_add(1, Ordering::SeqCst);
                async {
                    let err = synthetic_connect_error().await;
                    Err(err)
                }
            }),
        )
        .await
        .expect("should not exceed 10s — backoffs total ~3s");
        assert!(result.is_err(), "all attempts failed → Err");
        // 1 initial + 3 retries (BACKOFFS_MS has 3 entries) = 4 total.
        assert_eq!(attempts.load(Ordering::SeqCst), 4);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn nd_retry_returns_immediately_on_non_transient_error() {
        // Builder error (URL parse) is neither connect nor timeout → return immediately.
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempts_c = attempts.clone();
        let result = nd_retry(move || {
            attempts_c.fetch_add(1, Ordering::SeqCst);
            async {
                // reqwest treats malformed URLs as builder errors, neither
                // is_connect() nor is_timeout() — so nd_retry must surface
                // immediately without retrying.
                reqwest::Client::new().get("not-a-valid-url").send().await
            }
        })
        .await;
        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1, "non-transient error must not retry");
    }

    // ── navidrome_token via wiremock ──────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn navidrome_token_returns_token_from_login_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "token": "abc.def.ghi",
                "userId": "u1",
                "isAdmin": true,
            })))
            .mount(&server)
            .await;

        let token = navidrome_token(&server.uri(), "user", "pw").await.unwrap();
        assert_eq!(token, "abc.def.ghi");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn navidrome_token_errors_when_response_omits_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "invalid credentials"
            })))
            .mount(&server)
            .await;

        let err = navidrome_token(&server.uri(), "user", "wrong").await.unwrap_err();
        assert!(err.contains("no token"), "got {err}");
    }
}

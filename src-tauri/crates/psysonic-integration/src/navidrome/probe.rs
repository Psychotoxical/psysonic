//! Navidrome-side probes for the library-sync capability detection.
//!
//! Lives next to `client.rs` / `queries.rs` so the existing native-REST
//! auth shape (`Authorization: Bearer …`) is reused. PR-3a only needs
//! one probe — does the server expose the paginated `/api/song` bulk
//! endpoint? — so this stays a free function rather than a client
//! struct. The full `nd_list_songs`-style ingest loop lands with PR-3b.

use super::client::{nd_err, nd_http_client};

/// Returns `Ok(true)` when `GET /api/song?_start=0&_end=1` answers with
/// a 2xx status, `Ok(false)` for 4xx (auth ok but endpoint missing or
/// disabled) and 5xx surfaces as `Err`. The body is intentionally not
/// inspected — empty libraries still respond with `[]` and a 200.
///
/// Spec §6.1 ties the result to the `NavidromeNativeBulk` capability
/// flag. Wider call into the actual ingest path (`nd_list_songs` port)
/// is PR-3b's job.
pub async fn native_bulk_available(server_url: &str, token: &str) -> Result<bool, String> {
    let client = nd_http_client();
    let url = format!("{}/api/song?_start=0&_end=1", server_url.trim_end_matches('/'));
    let resp = client
        .get(url)
        .header("X-ND-Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(nd_err)?;

    let status = resp.status();
    if status.is_success() {
        return Ok(true);
    }
    if status.is_client_error() {
        // 401/403/404 — endpoint genuinely unavailable for this token /
        // build. Treat as "no native bulk" and fall back to Subsonic.
        return Ok(false);
    }
    Err(format!("HTTP {status}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test(flavor = "multi_thread")]
    async fn native_bulk_available_returns_true_on_200() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .and(query_param("_start", "0"))
            .and(query_param("_end", "1"))
            .and(header("X-ND-Authorization", "Bearer tok-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let ok = native_bulk_available(&server.uri(), "tok-123").await.unwrap();
        assert!(ok);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn native_bulk_available_returns_false_on_404() {
        // Server is reachable, auth might be ok, but the endpoint just
        // doesn't exist (older Navidrome, mod_rewrite mishap, …).
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let ok = native_bulk_available(&server.uri(), "tok").await.unwrap();
        assert!(!ok);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn native_bulk_available_returns_false_on_401_auth_failure() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let ok = native_bulk_available(&server.uri(), "bad").await.unwrap();
        assert!(!ok, "401 reads as `endpoint not available for this caller`");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn native_bulk_available_surfaces_5xx_as_error() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let err = native_bulk_available(&server.uri(), "tok").await.unwrap_err();
        assert!(err.contains("503"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn native_bulk_available_strips_trailing_slash() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/api/song"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let with_slash = format!("{}/", server.uri());
        assert!(native_bulk_available(&with_slash, "tok").await.unwrap());
    }
}

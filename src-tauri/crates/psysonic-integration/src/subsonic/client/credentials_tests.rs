use super::test_support::test_client;
use super::*;
use serde_json::json;
use wiremock::matchers::{method as wm_method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── PR-2b: fresh-credentials-per-request lifecycle ────────────────────

#[test]
fn from_password_client_derives_fresh_credentials_per_request() {
    let client = SubsonicClient::new("http://test", "user", "pw");
    let a = client.build_credentials();
    let b = client.build_credentials();
    assert_ne!(a.salt, b.salt, "from_password mode must refresh salt");
    assert_ne!(a.token, b.token, "different salt → different token");
    assert_eq!(a.username, b.username);
}

#[test]
fn static_credentials_client_returns_same_triple_each_call() {
    let creds = SubsonicCredentials::with_static("u", "tok", "salt");
    let client =
        SubsonicClient::with_static_credentials("http://test", creds, reqwest::Client::new());
    let a = client.build_credentials();
    let b = client.build_credentials();
    assert_eq!(a.token, b.token);
    assert_eq!(a.salt, b.salt);
}

#[tokio::test(flavor = "multi_thread")]
async fn from_password_client_sends_unique_salt_per_request_over_the_wire() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok" }
        })))
        .mount(&server)
        .await;

    let client = SubsonicClient::new(server.uri(), "user", "pw");
    client.ping().await.unwrap();
    client.ping().await.unwrap();

    let received = server.received_requests().await.expect("requests captured");
    assert_eq!(received.len(), 2);
    let salt = |r: &wiremock::Request| {
        r.url
            .query_pairs()
            .find(|(k, _)| k == "s")
            .map(|(_, v)| v.into_owned())
            .expect("`s` param present")
    };
    let token = |r: &wiremock::Request| {
        r.url
            .query_pairs()
            .find(|(k, _)| k == "t")
            .map(|(_, v)| v.into_owned())
            .expect("`t` param present")
    };
    assert_ne!(salt(&received[0]), salt(&received[1]));
    assert_ne!(token(&received[0]), token(&received[1]));
}

#[tokio::test(flavor = "multi_thread")]
async fn client_id_query_param_carries_crate_version() {
    // PR-2b note 2: align `c` with the frontend (`psysonic/<version>`).
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok" }
        })))
        .mount(&server)
        .await;
    test_client(&server.uri()).ping().await.unwrap();

    let received = server.received_requests().await.expect("requests captured");
    let c = received[0]
        .url
        .query_pairs()
        .find(|(k, _)| k == "c")
        .map(|(_, v)| v.into_owned())
        .expect("`c` param present");
    assert!(c.starts_with("psysonic/"), "got `{c}`");
    assert_eq!(c, SUBSONIC_CLIENT_ID);
}

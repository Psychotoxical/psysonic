use super::super::*;
use psysonic_core::server_http::{
    CustomHeaderEntryWire, CustomHeadersApplyTo, EndpointKind, ServerHttpContextSyncWire,
    ServerHttpEndpointWire, ServerHttpRegistry,
};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn registry_for(endpoint: &str) -> ServerHttpRegistry {
    let registry = ServerHttpRegistry::new();
    registry.sync(ServerHttpContextSyncWire {
        server_id: "server-key".into(),
        app_server_id: "profile-id".into(),
        endpoints: vec![ServerHttpEndpointWire {
            url: endpoint.into(),
            kind: EndpointKind::Public,
        }],
        custom_headers: vec![CustomHeaderEntryWire {
            name: "X-Gate".into(),
            value: "token".into(),
        }],
        custom_headers_apply_to: Some(CustomHeadersApplyTo::Public),
        supports_raw_stream: true,
    });
    registry
}

fn prefix(len: usize) -> Vec<u8> {
    // "fLaC"-leading media-ish bytes — never mistaken for an error envelope.
    let mut v = vec![0x66u8; len];
    v[..4.min(len)].copy_from_slice(&b"fLaC"[..4.min(len)]);
    v
}

#[tokio::test]
async fn probe_accepts_a_valid_206_and_fingerprints_the_prefix() {
    let server = MockServer::start().await;
    let body = prefix(16 * 1024);
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .and(header("Range", "bytes=0-16383"))
        .and(header("X-Gate", "token"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("Content-Range", "bytes 0-16383/9999999")
                .set_body_bytes(body.clone()),
        )
        .mount(&server)
        .await;
    let url = format!("{}/rest/stream.view?id=t1&u=a&maxBitRate=128", server.uri());
    let registry = registry_for(&server.uri());
    let got = fetch_trusted_original_md5(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
    )
    .await;
    assert_eq!(got, Some(crate::analysis_cache::md5_first_16kb(&body)));
}

#[tokio::test]
async fn probe_bounds_a_200_that_ignored_the_range_request_to_the_fingerprint_window() {
    let server = MockServer::start().await;
    let body = prefix(64 * 1024);
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(header("Range", "bytes=0-16383"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body.clone()))
        .mount(&server)
        .await;
    let url = format!("{}/rest/stream.view?id=t1&maxBitRate=128", server.uri());
    let registry = registry_for(&server.uri());
    let got = fetch_trusted_original_md5(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
    )
    .await;
    assert_eq!(got, Some(crate::analysis_cache::md5_first_16kb(&body)));
}

#[tokio::test]
async fn probe_rejects_a_subsonic_error_served_as_206() {
    let server = MockServer::start().await;
    let err = br#"{"subsonic-response":{"status":"failed","error":{"code":70}}}"#.to_vec();
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "Content-Range",
                    format!("bytes 0-{}/{}", err.len() - 1, err.len()).as_str(),
                )
                .set_body_bytes(err),
        )
        .mount(&server)
        .await;
    let url = format!("{}/rest/stream.view?id=t1&maxBitRate=128", server.uri());
    let registry = registry_for(&server.uri());
    let got = fetch_trusted_original_md5(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
    )
    .await;
    assert_eq!(got, None);
}

#[tokio::test]
async fn detailed_probe_returns_the_subsonic_error_reason() {
    let server = MockServer::start().await;
    let err = br#"{"subsonic-response":{"status":"failed","error":{"code":0,"message":"open /music/a.flac: no such file or directory"}}}"#.to_vec();
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(err))
        .mount(&server)
        .await;
    let url = format!("{}/rest/stream.view?id=missing", server.uri());
    let registry = registry_for(&server.uri());

    let result = probe_trusted_original_md5(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
    )
    .await;

    assert_eq!(
        result,
        TrustedOriginalProbeResult::SubsonicError(SubsonicStreamError {
            code: 0,
            message: "open /music/a.flac: no such file or directory".to_string(),
        })
    );
}

#[tokio::test]
async fn full_raw_fetch_requires_the_trusted_prefix_and_size_cap() {
    let server = MockServer::start().await;
    let original = prefix(24 * 1024);
    let trusted = crate::analysis_cache::md5_first_16kb(&original);
    let registry = registry_for(&server.uri());
    let url = format!("{}/rest/stream.view?id=t1&maxBitRate=128", server.uri());

    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .and(query_param("format", "raw"))
        .and(header("X-Gate", "token"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
        .mount(&server)
        .await;

    let fetched = fetch_trusted_original_bytes(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
        &trusted,
        original.len(),
    )
    .await;
    assert_eq!(fetched.as_deref(), Some(original.as_slice()));

    let oversized = fetch_trusted_original_bytes_result(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
        &trusted,
        original.len() - 1,
    )
    .await;
    assert_eq!(
        oversized,
        Err(BoundedStreamFetchError::TooLarge {
            md5_16kb: trusted.clone(),
        })
    );

    let wrong_prefix = fetch_trusted_original_bytes(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
        "different-revision",
        original.len(),
    )
    .await;
    assert_eq!(wrong_prefix, None);

    let partial_server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("Content-Range", "bytes 0-16383/24576")
                .set_body_bytes(original[..16 * 1024].to_vec()),
        )
        .mount(&partial_server)
        .await;
    let partial_registry = registry_for(&partial_server.uri());
    let partial_url = format!("{}/rest/stream.view?id=t1", partial_server.uri());
    let partial = fetch_trusted_original_bytes(
        &reqwest::Client::new(),
        Some(&partial_registry),
        Some("server-key"),
        &partial_url,
        &trusted,
        original.len(),
    )
    .await;
    assert_eq!(
        partial, None,
        "partial responses are not complete originals"
    );
}

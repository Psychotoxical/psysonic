use super::super::*;
use psysonic_core::server_http::{
    CustomHeaderEntryWire, CustomHeadersApplyTo, EndpointKind, ServerHttpContextSyncWire,
    ServerHttpEndpointWire, ServerHttpRegistry,
};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn registry_for(endpoint: &str, supports_raw_stream: bool) -> ServerHttpRegistry {
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
        supports_raw_stream,
    });
    registry
}

#[tokio::test]
async fn first_probe_failure_produces_no_canonical_verdict() {
    // Server-forced transcoding is invisible on the wire: a FIRST-EVER
    // probe failure must not be treated as proof the bytes are original.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let url = format!("{}/rest/stream.view?id=t1", server.uri());
    let registry = registry_for(&server.uri(), true);
    let got = resolve_trusted_identity(
        &reqwest::Client::new(),
        Some(&registry),
        Some("server-key"),
        &url,
    )
    .await;
    assert_eq!(got, TrustedProbeVerdict::SkipCanonicalWrites);
}

#[tokio::test]
async fn unknown_or_non_navidrome_endpoint_never_issues_raw_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/stream.view"))
        .respond_with(ResponseTemplate::new(206))
        .mount(&server)
        .await;
    let url = format!("{}/rest/stream.view?id=t1", server.uri());

    let unknown =
        resolve_trusted_identity(&reqwest::Client::new(), None, Some("server-key"), &url).await;
    let unsupported_registry = registry_for(&server.uri(), false);
    let unsupported = resolve_trusted_identity(
        &reqwest::Client::new(),
        Some(&unsupported_registry),
        Some("server-key"),
        &url,
    )
    .await;

    assert_eq!(unknown, TrustedProbeVerdict::SkipCanonicalWrites);
    assert_eq!(unsupported, TrustedProbeVerdict::SkipCanonicalWrites);
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[test]
fn verified_raw_request_requires_capability_endpoint_and_exact_raw_value() {
    let registry = ServerHttpRegistry::new();
    registry.sync(ServerHttpContextSyncWire {
        server_id: "server-key".into(),
        app_server_id: "profile-id".into(),
        endpoints: vec![ServerHttpEndpointWire {
            url: "https://s.example".into(),
            kind: EndpointKind::Public,
        }],
        custom_headers: Vec::new(),
        custom_headers_apply_to: None,
        supports_raw_stream: true,
    });

    assert!(is_verified_raw_stream_request(
        Some(&registry),
        Some("server-key"),
        "https://s.example/rest/stream.view?id=t1&format=raw",
    ));
    assert!(!is_verified_raw_stream_request(
        Some(&registry),
        Some("server-key"),
        "https://s.example/rest/stream.view?id=t1&format=RAW",
    ));
    assert!(!is_verified_raw_stream_request(
        Some(&registry),
        Some("server-key"),
        "https://other.example/rest/stream.view?id=t1&format=raw",
    ));
}

use super::*;
use psysonic_integration::subsonic::{SubsonicClient, SubsonicCredentials};
use serde_json::json;
use std::sync::Arc;
use wiremock::matchers::{header, method as wm_method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ── CapabilityFlags bitfield ─────────────────────────────────────────

#[test]
fn capability_flags_contains_respects_individual_bits() {
    let mut f = CapabilityFlags::default();
    assert!(!f.contains(CapabilityFlags::OPEN_SUBSONIC));
    f.insert(CapabilityFlags::OPEN_SUBSONIC);
    assert!(f.contains(CapabilityFlags::OPEN_SUBSONIC));
    assert!(!f.contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
}

#[test]
fn capability_flags_insert_is_idempotent() {
    let mut f = CapabilityFlags::default();
    f.insert(CapabilityFlags::SUBSONIC_SEARCH3_BULK);
    let after_first = f.bits();
    f.insert(CapabilityFlags::SUBSONIC_SEARCH3_BULK);
    assert_eq!(f.bits(), after_first);
}

#[test]
fn capability_flags_remove_clears_only_the_named_bit() {
    let mut f =
        CapabilityFlags::new(CapabilityFlags::OPEN_SUBSONIC | CapabilityFlags::UNSTABLE_TRACK_IDS);
    f.remove(CapabilityFlags::OPEN_SUBSONIC);
    assert!(!f.contains(CapabilityFlags::OPEN_SUBSONIC));
    assert!(f.contains(CapabilityFlags::UNSTABLE_TRACK_IDS));
}

#[test]
fn capability_flags_bit_values_match_spec_table() {
    // Spec §6.1.1 hex values — pin the wire format so future
    // schema-migration writers don't shift them silently.
    assert_eq!(CapabilityFlags::NAVIDROME_NATIVE_BULK, 0x001);
    assert_eq!(CapabilityFlags::SUBSONIC_SEARCH3_BULK, 0x002);
    assert_eq!(CapabilityFlags::SCAN_STATUS_AVAILABLE, 0x004);
    assert_eq!(CapabilityFlags::OPEN_SUBSONIC, 0x008);
    assert_eq!(CapabilityFlags::UNSTABLE_TRACK_IDS, 0x010);
    assert_eq!(CapabilityFlags::FILE_TREE_BROWSE, 0x020);
}

// ── CapabilityProbe wiremock harness ─────────────────────────────────

fn test_subsonic_client(uri: &str) -> SubsonicClient {
    SubsonicClient::with_static_credentials(
        uri,
        SubsonicCredentials::with_static("user", "tok", "salt"),
        reqwest::Client::new(),
    )
}

fn ok_envelope(body_key: &str, body: serde_json::Value) -> serde_json::Value {
    json!({
        "subsonic-response": {
            "status": "ok",
            "version": "1.16.1",
            body_key: body,
        }
    })
}

async fn mount_subsonic_full_navidrome(server: &MockServer) {
    // ping → navidrome + openSubsonic
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "ok",
                "version": "1.16.1",
                "type": "navidrome",
                "serverVersion": "0.55.2",
                "openSubsonic": true
            }
        })))
        .mount(server)
        .await;
    // search3 empty query
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
            "searchResult3",
            json!({ "song": [{ "id": "x", "title": "y" }] }),
        )))
        .mount(server)
        .await;
    // getScanStatus
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(ok_envelope("scanStatus", json!({ "scanning": false }))),
        )
        .mount(server)
        .await;
    // getIndexes
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getIndexes.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(ok_envelope(
            "indexes",
            json!({ "lastModified": 0, "ignoredArticles": "", "index": [] }),
        )))
        .mount(server)
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_sets_all_subsonic_bits_on_a_fully_capable_navidrome_server() {
    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;

    let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), None, None, None)
        .await
        .unwrap();
    assert!(result
        .flags
        .contains(CapabilityFlags::SUBSONIC_SEARCH3_BULK));
    assert!(result
        .flags
        .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE));
    assert!(result.flags.contains(CapabilityFlags::FILE_TREE_BROWSE));
    assert!(result.flags.contains(CapabilityFlags::OPEN_SUBSONIC));
    assert!(result.flags.contains(CapabilityFlags::UNSTABLE_TRACK_IDS));
    // No navidrome probe creds passed → N1 stays clear.
    assert!(!result
        .flags
        .contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
    assert_eq!(result.server_info.server_type.as_deref(), Some("navidrome"));
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_returns_err_when_subsonic_ping_fails() {
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 40, "message": "Wrong credentials" }
            }
        })))
        .mount(&server)
        .await;

    let err = CapabilityProbe::run(&test_subsonic_client(&server.uri()), None, None, None)
        .await
        .unwrap_err();
    assert!(matches!(err, SubsonicError::Api { code: 40, .. }));
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_keeps_optional_bits_clear_when_their_endpoint_fails() {
    // Minimal Subsonic-like server: ping ok, search3 ok, but
    // scanStatus + getIndexes 4xx. UnstableTrackIds + OpenSubsonic
    // stay clear because the ping envelope omits them.
    let server = MockServer::start().await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/ping.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": { "status": "ok", "version": "1.13" }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/search3.view"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(ok_envelope("searchResult3", json!({}))),
        )
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getScanStatus.view"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 30, "message": "Method not available" }
            }
        })))
        .mount(&server)
        .await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/rest/getIndexes.view"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), None, None, None)
        .await
        .unwrap();
    assert!(result
        .flags
        .contains(CapabilityFlags::SUBSONIC_SEARCH3_BULK));
    assert!(!result
        .flags
        .contains(CapabilityFlags::SCAN_STATUS_AVAILABLE));
    assert!(!result.flags.contains(CapabilityFlags::FILE_TREE_BROWSE));
    assert!(!result.flags.contains(CapabilityFlags::OPEN_SUBSONIC));
    assert!(!result.flags.contains(CapabilityFlags::UNSTABLE_TRACK_IDS));
}

#[tokio::test(flavor = "multi_thread")]
async fn probe_sets_navidrome_native_bulk_when_credentials_succeed() {
    let server = MockServer::start().await;
    mount_subsonic_full_navidrome(&server).await;
    Mock::given(wm_method("GET"))
        .and(wm_path("/api/song"))
        .and(header("X-ND-Authorization", "Bearer nd-tok"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(&server)
        .await;

    let nav = NavidromeProbeCredentials {
        server_url: server.uri(),
        bearer_token: "nd-tok".into(),
    };
    let result = CapabilityProbe::run(&test_subsonic_client(&server.uri()), Some(&nav), None, None)
        .await
        .unwrap();
    assert!(result
        .flags
        .contains(CapabilityFlags::NAVIDROME_NATIVE_BULK));
}

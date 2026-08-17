use super::*;
use serde_json::json;

// ── parse_envelope unit tests (no HTTP) ────────────────────────────────

#[test]
fn parse_envelope_extracts_body_on_ok_status() {
    let body = json!({
        "subsonic-response": {
            "status": "ok",
            "version": "1.16.1",
            "scanStatus": {
                "scanning": false,
                "count": 42
            }
        }
    })
    .to_string();
    let s: ScanStatus = parse_envelope(&body, "scanStatus").unwrap();
    assert_eq!(s.count, Some(42));
}

#[test]
fn parse_envelope_maps_code_70_to_not_found() {
    let body = json!({
        "subsonic-response": {
            "status": "failed",
            "error": { "code": 70, "message": "Song not found" }
        }
    })
    .to_string();
    let err = parse_envelope::<Song>(&body, "song").unwrap_err();
    assert!(matches!(err, SubsonicError::NotFound));
}

#[test]
fn parse_envelope_surfaces_other_error_codes_as_api_variant() {
    let body = json!({
        "subsonic-response": {
            "status": "failed",
            "error": { "code": 40, "message": "Wrong username or password" }
        }
    })
    .to_string();
    let err = parse_envelope::<Song>(&body, "song").unwrap_err();
    match err {
        SubsonicError::Api { code, message } => {
            assert_eq!(code, 40);
            assert!(message.contains("Wrong"));
        }
        other => panic!("expected Api, got {other:?}"),
    }
}

#[test]
fn parse_envelope_rejects_missing_body_key() {
    let body = json!({
        "subsonic-response": { "status": "ok" }
    })
    .to_string();
    let err = parse_envelope::<Song>(&body, "song").unwrap_err();
    assert!(matches!(err, SubsonicError::Decode(_)));
}

#[test]
fn parse_envelope_status_only_accepts_empty_ok() {
    let body = json!({ "subsonic-response": { "status": "ok", "version": "1.16.1" } }).to_string();
    parse_envelope_status_only(&body).unwrap();
}

// ── fingerprint_sample ────────────────────────────────────────────────

#[test]
fn fingerprint_sample_picks_every_nth_id() {
    let ids: Vec<String> = (0..10).map(|i| format!("tr_{i}")).collect();
    let sample = fingerprint_sample(&ids, 4);
    assert_eq!(
        sample.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        vec!["tr_0", "tr_4", "tr_8"]
    );
}

#[test]
fn fingerprint_sample_is_deterministic_across_runs() {
    let ids: Vec<String> = (0..500).map(|i| format!("tr_{i:04}")).collect();
    let a = fingerprint_sample(&ids, 100);
    let b = fingerprint_sample(&ids, 100);
    assert_eq!(a, b);
    assert_eq!(a.len(), 5, "500/100 = 5 samples");
}

#[test]
fn fingerprint_sample_zero_n_is_empty() {
    let ids: Vec<String> = vec!["a".into(), "b".into()];
    assert!(fingerprint_sample(&ids, 0).is_empty());
}

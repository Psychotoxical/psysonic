use serde::de::DeserializeOwned;

use super::super::error::SubsonicError;
use super::super::types::ServerInfo;

/// Validate the Subsonic envelope and return the raw `serde_json::Value`
/// at `body_key`. Maps `error.code = 70` to the dedicated `NotFound`
/// variant; surfaces every other failed status as `Api { code, message }`.
/// Callers either deserialize the value into a typed struct
/// (`parse_envelope`) or keep both alongside (`parse_envelope_with_raw`).
fn parse_envelope_body(body: &str, body_key: &str) -> Result<serde_json::Value, SubsonicError> {
    let envelope: serde_json::Value =
        serde_json::from_str(body).map_err(|e| SubsonicError::Decode(format!("envelope: {e}")))?;
    let response = envelope
        .get("subsonic-response")
        .ok_or_else(|| SubsonicError::Decode("missing `subsonic-response`".into()))?;

    if let Some(err) = response.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) as i32;
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        return Err(map_error(code, message));
    }

    let status = response
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    if status != "ok" {
        return Err(SubsonicError::Decode(format!(
            "unexpected status `{status}`"
        )));
    }

    response
        .get(body_key)
        .cloned()
        .ok_or_else(|| SubsonicError::Decode(format!("missing body key `{body_key}`")))
}

/// Validate the envelope, then deserialize the body into `T`.
pub(super) fn parse_envelope<T: DeserializeOwned>(
    body: &str,
    body_key: &str,
) -> Result<T, SubsonicError> {
    let body_val = parse_envelope_body(body, body_key)?;
    serde_json::from_value(body_val)
        .map_err(|e| SubsonicError::Decode(format!("body `{body_key}`: {e}")))
}

/// Validate the envelope, then return both the typed projection and the
/// raw `serde_json::Value` body sub-tree. PR-3 sync code uses this to
/// keep `track.raw_json` intact while still operating on a typed `Song`
/// at the call site.
pub(super) fn parse_envelope_with_raw<T: DeserializeOwned>(
    body: &str,
    body_key: &str,
) -> Result<(T, serde_json::Value), SubsonicError> {
    let body_val = parse_envelope_body(body, body_key)?;
    let typed = serde_json::from_value(body_val.clone())
        .map_err(|e| SubsonicError::Decode(format!("body `{body_key}`: {e}")))?;
    Ok((typed, body_val))
}

/// Variant of `parse_envelope` for endpoints that carry no body (only
/// `ping` in PR-2). Returns `Ok(())` when `status="ok"` and falls back to
/// the same error mapping.
pub(super) fn parse_envelope_status_only(body: &str) -> Result<(), SubsonicError> {
    let envelope: serde_json::Value =
        serde_json::from_str(body).map_err(|e| SubsonicError::Decode(format!("envelope: {e}")))?;
    let response = envelope
        .get("subsonic-response")
        .ok_or_else(|| SubsonicError::Decode("missing `subsonic-response`".into()))?;

    if let Some(err) = response.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) as i32;
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        return Err(map_error(code, message));
    }

    let status = response
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    match status {
        "ok" => Ok(()),
        other => Err(SubsonicError::Decode(format!(
            "unexpected status `{other}`"
        ))),
    }
}

fn map_error(code: i32, message: String) -> SubsonicError {
    if code == 70 {
        SubsonicError::NotFound
    } else {
        SubsonicError::Api { code, message }
    }
}

/// Inspect the `subsonic-response` envelope itself for server metadata.
/// Used by `server_info()` and by the capability probe.
pub(super) fn parse_server_info(body: &str) -> Result<ServerInfo, SubsonicError> {
    let envelope: serde_json::Value =
        serde_json::from_str(body).map_err(|e| SubsonicError::Decode(format!("envelope: {e}")))?;
    let response = envelope
        .get("subsonic-response")
        .ok_or_else(|| SubsonicError::Decode("missing `subsonic-response`".into()))?;

    if let Some(err) = response.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) as i32;
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        return Err(map_error(code, message));
    }

    let status = response
        .get("status")
        .and_then(|s| s.as_str())
        .unwrap_or_default();
    if status != "ok" {
        return Err(SubsonicError::Decode(format!(
            "unexpected status `{status}`"
        )));
    }

    Ok(ServerInfo {
        server_type: response
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        server_version: response
            .get("serverVersion")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        api_version: response
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        open_subsonic: response
            .get("openSubsonic")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    })
}

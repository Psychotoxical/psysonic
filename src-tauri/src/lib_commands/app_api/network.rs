//! Network helpers exposed as Tauri commands. Currently just DNS lookup for the
//! dual-server-address add/edit form (UI hint only — not for connect).

use std::collections::HashSet;

use std::sync::Arc;

use psysonic_core::server_http::{ServerHttpContext, ServerHttpContextSyncWire, ServerHttpRegistry};
use psysonic_integration::subsonic::{ServerInfo, SubsonicClient, SubsonicError};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::net::lookup_host;

/// Connect-probe timeout — mirrors the WebView axios ping (`subsonic.ts`).
const PROBE_TIMEOUT_SECS: u64 = 15;

/// Resolve a hostname to a deduped list of IP address strings (IPv4 + IPv6).
///
/// Strips a `host:port` suffix before lookup — the form only knows the host.
/// Used by the add/edit-server form to hint whether the entered address
/// classifies as LAN or public (a hostname that resolves to a private range
/// IP suggests the user might want to add a public second address, and
/// vice versa). **Never used for connect** — connect always goes through the
/// existing `pingWithCredentials` path, which carries credentials.
///
/// Returns an empty vec on lookup failure (the UI then shows no hint, by
/// design: a transient DNS hiccup shouldn't block save).
#[tauri::command]
#[specta::specta]
pub(crate) async fn resolve_host_addresses(hostname: String) -> Result<Vec<String>, String> {
    let trimmed = hostname.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Strip port if present. IPv6 literals use [host]:port; bare IPv4/host
    // use host:port. We only resolve the host portion.
    let host_only = strip_port(trimmed);
    if host_only.is_empty() {
        return Ok(Vec::new());
    }

    // tokio's lookup_host requires a port. Append :0 — we discard the port
    // from each returned SocketAddr.
    let lookup_target = if host_only.contains(':') {
        // IPv6 literal — wrap in brackets if not already.
        if host_only.starts_with('[') {
            format!("{}:0", host_only)
        } else {
            format!("[{}]:0", host_only)
        }
    } else {
        format!("{}:0", host_only)
    };

    let addrs = match lookup_host(&lookup_target).await {
        Ok(iter) => iter,
        Err(_) => return Ok(Vec::new()),
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut result = Vec::new();
    for sock in addrs {
        let ip = sock.ip().to_string();
        if seen.insert(ip.clone()) {
            result.push(ip);
        }
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn server_http_context_sync(
    registry: State<'_, Arc<ServerHttpRegistry>>,
    wire: ServerHttpContextSyncWire,
) -> Result<(), String> {
    registry.sync(wire);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn server_http_context_sync_all(
    registry: State<'_, Arc<ServerHttpRegistry>>,
    entries: Vec<ServerHttpContextSyncWire>,
) -> Result<(), String> {
    registry.sync_all(entries);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn server_http_context_clear(
    registry: State<'_, Arc<ServerHttpRegistry>>,
    server_id: String,
    app_server_id: String,
) -> Result<(), String> {
    registry.remove(&server_id, &app_server_id);
    Ok(())
}

/// Result of a connect probe — same shape the WebView `pingWithCredentials`
/// path returns (`PingWithCredentialsResult` on the TS side).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct ServerProbeResult {
    /// `true` when the server answered `ping` with `status="ok"`.
    pub ok: bool,
    /// Server software family (`navidrome`, …) when advertised.
    #[serde(rename = "type")]
    pub server_type: Option<String>,
    /// Server build version when advertised.
    #[serde(rename = "serverVersion")]
    pub server_version: Option<String>,
    /// Whether the server advertises OpenSubsonic extensions.
    #[serde(rename = "openSubsonic")]
    pub open_subsonic: bool,
    /// Short human-readable reason when `ok == false` — the server's own error
    /// message, an HTTP status, or a transport error — so the add/edit form can
    /// tell the user *why* it couldn't connect instead of a blank failure.
    /// `None` on success. Never contains header values or the password.
    pub error: Option<String>,
}

impl ServerProbeResult {
    fn from_info(info: ServerInfo) -> Self {
        Self {
            ok: true,
            server_type: info.server_type,
            server_version: info.server_version,
            open_subsonic: info.open_subsonic,
            error: None,
        }
    }

    fn from_error(err: &SubsonicError) -> Self {
        Self {
            ok: false,
            server_type: None,
            server_version: None,
            open_subsonic: false,
            error: Some(probe_failure_reason(err)),
        }
    }
}

/// Render a compact, user-facing reason from a probe failure. Subsonic API
/// errors surface the server's own message (e.g. "Wrong username or password");
/// HTTP/transport failures surface the status or flattened transport text. No
/// secrets are ever part of a `SubsonicError`, so this is safe to show + log.
fn probe_failure_reason(err: &SubsonicError) -> String {
    match err {
        SubsonicError::Api { code, message } => {
            let msg = message.trim();
            if msg.is_empty() {
                format!("server error {code}")
            } else {
                msg.to_string()
            }
        }
        SubsonicError::HttpStatus(status) => match status.canonical_reason() {
            Some(reason) => format!("HTTP {} {reason}", status.as_u16()),
            None => format!("HTTP {}", status.as_u16()),
        },
        SubsonicError::Transport(m) => m.trim().to_string(),
        SubsonicError::NotFound => "not found".to_string(),
        SubsonicError::Decode(m) => format!("invalid response: {}", m.trim()),
    }
}

fn probe_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(PROBE_TIMEOUT_SECS))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Header-aware connect probe. Runs the Subsonic `ping` over the native
/// reqwest stack instead of the WebView so that per-server custom headers
/// (Cloudflare Access / Pangolin service tokens) ride on the request itself.
///
/// The WebView path can't do this behind an auth gate: a custom header like
/// `Authorization` is not CORS-safelisted, so the browser sends a preflight
/// `OPTIONS` first — and that preflight carries no token, so the gate rejects
/// it and the real request never leaves. Native reqwest never preflights, so
/// the token reaches the origin exactly as it does for streaming / sync.
///
/// `http_context` mirrors `serverHttpContextWireForProfile` for the draft
/// profile being added/edited (endpoints + headers + apply rule); pass `None`
/// for a plain probe with no custom headers. Endpoint/apply matching reuses the
/// same resolver as the data plane, so `base_url` must be the specific endpoint
/// being probed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn probe_server_connection(
    base_url: String,
    username: String,
    password: String,
    http_context: Option<ServerHttpContextSyncWire>,
) -> Result<ServerProbeResult, String> {
    let mut client = SubsonicClient::with_http(base_url, username, password, probe_http_client());
    if let Some(wire) = http_context {
        client = client.with_http_context(ServerHttpContext::from(wire));
    }
    match client.server_info().await {
        Ok(info) => Ok(ServerProbeResult::from_info(info)),
        Err(err) => {
            // Unreachable / wrong credentials / non-ok envelope: surface as
            // `ok:false` plus a reason the UI can show. Header values are never
            // part of `err`, so this is safe to log for diagnostics — the
            // gated-server case used to leave no trace at all.
            crate::app_deprintln!("[connect-probe] ping failed: {err}");
            Ok(ServerProbeResult::from_error(&err))
        }
    }
}

/// Strip a `:port` suffix. Handles `host:port` and `[ipv6]:port`; leaves
/// bracketed IPv6 with no port (`[::1]`) and bare hosts alone.
fn strip_port(input: &str) -> String {
    let s = input.trim();
    // Bracketed IPv6 — `[host]:port` → `host`; `[host]` (no port) → `host`.
    if let Some(rest) = s.strip_prefix('[') {
        if let Some(close) = rest.find(']') {
            return rest[..close].to_string();
        }
        // Malformed bracket — fall through.
    }
    // Hostnames and IPv4 only contain one `:`. IPv6 without brackets cannot
    // be unambiguously split from a port, so leave as-is (lookup_host wraps
    // it for us).
    let colon_count = s.bytes().filter(|&b| b == b':').count();
    if colon_count == 1 {
        if let Some((host, _port)) = s.rsplit_once(':') {
            return host.to_string();
        }
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::{probe_failure_reason, strip_port, ServerProbeResult};
    use psysonic_integration::subsonic::{ServerInfo, SubsonicError};

    #[test]
    fn probe_result_from_info_carries_metadata_and_ok() {
        let info = ServerInfo {
            server_type: Some("navidrome".into()),
            server_version: Some("0.62.0".into()),
            api_version: Some("1.16.1".into()),
            open_subsonic: true,
        };
        let r = ServerProbeResult::from_info(info);
        assert!(r.ok);
        assert_eq!(r.server_type.as_deref(), Some("navidrome"));
        assert_eq!(r.server_version.as_deref(), Some("0.62.0"));
        assert!(r.open_subsonic);
        assert!(r.error.is_none());
    }

    #[test]
    fn probe_result_from_error_is_not_ok_and_carries_reason() {
        let r = ServerProbeResult::from_error(&SubsonicError::Api {
            code: 40,
            message: "Wrong username or password".into(),
        });
        assert!(!r.ok);
        assert!(r.server_type.is_none());
        assert!(r.server_version.is_none());
        assert!(!r.open_subsonic);
        assert_eq!(r.error.as_deref(), Some("Wrong username or password"));
    }

    #[test]
    fn probe_failure_reason_prefers_server_message() {
        let reason = probe_failure_reason(&SubsonicError::Api {
            code: 10,
            message: "missing parameter: 'u'".into(),
        });
        assert_eq!(reason, "missing parameter: 'u'");
    }

    #[test]
    fn probe_failure_reason_falls_back_to_code_when_message_blank() {
        let reason = probe_failure_reason(&SubsonicError::Api {
            code: 40,
            message: "   ".into(),
        });
        assert_eq!(reason, "server error 40");
    }

    #[test]
    fn probe_failure_reason_renders_http_status() {
        let reason = probe_failure_reason(&SubsonicError::HttpStatus(
            reqwest::StatusCode::FORBIDDEN,
        ));
        assert_eq!(reason, "HTTP 403 Forbidden");
    }

    #[test]
    fn strips_host_port_pair() {
        assert_eq!(strip_port("music.example.com:4533"), "music.example.com");
    }

    #[test]
    fn strips_ipv4_port_pair() {
        assert_eq!(strip_port("192.168.0.10:4533"), "192.168.0.10");
    }

    #[test]
    fn leaves_bare_host_alone() {
        assert_eq!(strip_port("music.example.com"), "music.example.com");
    }

    #[test]
    fn unwraps_bracketed_ipv6_with_port() {
        assert_eq!(strip_port("[::1]:4533"), "::1");
    }

    #[test]
    fn unwraps_bracketed_ipv6_without_port() {
        assert_eq!(strip_port("[fe80::1]"), "fe80::1");
    }

    #[test]
    fn leaves_unbracketed_ipv6_alone() {
        // Multiple colons + no brackets — can't tell host from port; safe to
        // hand the raw string to lookup_host, which handles it.
        assert_eq!(strip_port("fe80::1"), "fe80::1");
    }

    #[test]
    fn handles_empty_input() {
        assert_eq!(strip_port(""), "");
    }
}

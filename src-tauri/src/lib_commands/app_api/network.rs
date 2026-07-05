//! Network helpers exposed as Tauri commands. Currently just DNS lookup for the
//! dual-server-address add/edit form (UI hint only — not for connect).

use std::collections::HashSet;

use std::sync::Arc;

use psysonic_core::server_http::{ServerHttpContextSyncWire, ServerHttpRegistry};
use tauri::State;
use tokio::net::lookup_host;

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
    use super::strip_port;

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

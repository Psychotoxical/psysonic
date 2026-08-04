//! Per-server native HTTP context for reverse-proxy headers and server capabilities.
//! Registry is keyed by index key; app server UUID aliases resolve via `ref_to_key`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::RequestBuilder;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum EndpointKind {
    Local,
    Public,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CustomHeadersApplyTo {
    Local,
    #[default]
    Public,
    Both,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct ServerHttpEndpointWire {
    pub url: String,
    pub kind: EndpointKind,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct CustomHeaderEntryWire {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct ServerHttpContextSyncWire {
    #[serde(rename = "serverId")]
    pub server_id: String,
    #[serde(rename = "appServerId")]
    pub app_server_id: String,
    pub endpoints: Vec<ServerHttpEndpointWire>,
    #[serde(rename = "customHeaders", default)]
    pub custom_headers: Vec<CustomHeaderEntryWire>,
    #[serde(rename = "customHeadersApplyTo", default)]
    pub custom_headers_apply_to: Option<CustomHeadersApplyTo>,
    #[serde(rename = "supportsRawStream", default)]
    pub supports_raw_stream: bool,
}

#[derive(Clone, Debug)]
pub struct ServerHttpContext {
    pub endpoints: Vec<(String, EndpointKind)>,
    pub headers: Vec<(String, String)>,
    pub apply_to: CustomHeadersApplyTo,
    pub supports_raw_stream: bool,
}

impl From<ServerHttpContextSyncWire> for ServerHttpContext {
    fn from(w: ServerHttpContextSyncWire) -> Self {
        Self {
            endpoints: w
                .endpoints
                .into_iter()
                .map(|e| (normalize_server_base_url(&e.url), e.kind))
                .collect(),
            headers: w
                .custom_headers
                .into_iter()
                .map(|h| (h.name.trim().to_string(), h.value))
                .filter(|(n, _)| !n.is_empty())
                .collect(),
            apply_to: w.custom_headers_apply_to.unwrap_or_default(),
            supports_raw_stream: w.supports_raw_stream,
        }
    }
}

fn normalize_server_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    }
}

/// Strip `/rest/…`, `/api/…`, `/auth/…`, and query from a full HTTP URL to match TS `requestBaseUrlFromHttpUrl`.
pub fn request_base_url_from_http_url(raw_url: &str) -> String {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let Ok(mut parsed) = url::Url::parse(&with_scheme) else {
        return normalize_server_base_url(trimmed);
    };
    parsed.set_query(None);
    parsed.set_fragment(None);
    let mut path = parsed.path().to_string();
    if let Some(idx) = path.find("/rest/") {
        path.truncate(idx);
    } else if path.ends_with("/rest") {
        path.truncate(path.len().saturating_sub("/rest".len()));
    } else {
        for seg in ["/api/", "/auth/"] {
            if let Some(idx) = path.find(seg) {
                path.truncate(idx);
                break;
            }
        }
    }
    while path.ends_with('/') && path.len() > 1 {
        path.pop();
    }
    parsed.set_path(if path.is_empty() { "/" } else { &path });
    let host = parsed.host_str().unwrap_or_default();
    if host.is_empty() {
        return normalize_server_base_url(trimmed);
    }
    let mut out = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        out.push(':');
        out.push_str(&port.to_string());
    }
    if !path.is_empty() && path != "/" {
        out.push_str(&path);
    }
    normalize_server_base_url(&out)
}

pub fn headers_for_request_base_url(ctx: &ServerHttpContext, request_base_url: &str) -> HeaderMap {
    let mut map = HeaderMap::new();
    if ctx.headers.is_empty() {
        return map;
    }
    let normalized = normalize_server_base_url(request_base_url);
    let Some((_, kind)) = ctx.endpoints.iter().find(|(u, _)| *u == normalized) else {
        return map;
    };
    let apply = match ctx.apply_to {
        CustomHeadersApplyTo::Both => true,
        CustomHeadersApplyTo::Public => *kind == EndpointKind::Public,
        CustomHeadersApplyTo::Local => *kind == EndpointKind::Local,
    };
    if !apply {
        return map;
    }
    for (name, value) in &ctx.headers {
        let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(header_value) = HeaderValue::from_str(value) else {
            continue;
        };
        map.insert(header_name, header_value);
    }
    map
}

pub fn apply_server_headers(
    builder: RequestBuilder,
    ctx: &ServerHttpContext,
    request_base_url: &str,
) -> RequestBuilder {
    let map = headers_for_request_base_url(ctx, request_base_url);
    if map.is_empty() {
        return builder;
    }
    builder.headers(map)
}

pub fn apply_server_headers_for_http_url(
    builder: RequestBuilder,
    ctx: &ServerHttpContext,
    full_http_url: &str,
) -> RequestBuilder {
    let base = request_base_url_from_http_url(full_http_url);
    apply_server_headers(builder, ctx, &base)
}

#[derive(Default)]
pub struct ServerHttpRegistry {
    contexts: Mutex<HashMap<String, Arc<ServerHttpContext>>>,
    ref_to_key: Mutex<HashMap<String, String>>,
}

impl ServerHttpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn sync(&self, wire: ServerHttpContextSyncWire) {
        let index_key = wire.server_id.clone();
        let app_id = wire.app_server_id.clone();
        let ctx = Arc::new(ServerHttpContext::from(wire));
        let mut contexts = self.contexts.lock().unwrap();
        let mut refs = self.ref_to_key.lock().unwrap();
        if let Some(previous_key) = refs.get(&app_id).cloned() {
            if previous_key != index_key {
                contexts.remove(&previous_key);
                refs.remove(&previous_key);
            }
        }
        if ctx.headers.is_empty() && !ctx.supports_raw_stream {
            contexts.remove(&index_key);
            refs.remove(&index_key);
            refs.remove(&app_id);
            return;
        }
        contexts.insert(index_key.clone(), Arc::clone(&ctx));
        refs.insert(index_key.clone(), index_key.clone());
        refs.insert(app_id, index_key);
    }

    pub fn sync_all(&self, entries: Vec<ServerHttpContextSyncWire>) {
        let mut new_contexts = HashMap::new();
        let mut new_refs = HashMap::new();
        for wire in entries {
            let index_key = wire.server_id.clone();
            let app_id = wire.app_server_id.clone();
            let ctx = Arc::new(ServerHttpContext::from(wire));
            if ctx.headers.is_empty() && !ctx.supports_raw_stream {
                continue;
            }
            new_contexts.insert(index_key.clone(), Arc::clone(&ctx));
            new_refs.insert(index_key.clone(), index_key.clone());
            new_refs.insert(app_id, index_key);
        }
        *self.contexts.lock().unwrap() = new_contexts;
        *self.ref_to_key.lock().unwrap() = new_refs;
    }

    pub fn remove(&self, index_key: &str, app_server_id: &str) {
        let mut contexts = self.contexts.lock().unwrap();
        let mut refs = self.ref_to_key.lock().unwrap();
        if let Some(mapped_key) = refs.get(app_server_id).cloned() {
            contexts.remove(&mapped_key);
            refs.remove(&mapped_key);
        }
        contexts.remove(index_key);
        refs.remove(index_key);
        refs.remove(app_server_id);
    }

    pub fn get(&self, index_key: &str) -> Option<Arc<ServerHttpContext>> {
        self.contexts.lock().unwrap().get(index_key).cloned()
    }

    pub fn get_for_server_ref(&self, server_ref: &str) -> Option<Arc<ServerHttpContext>> {
        if server_ref.is_empty() {
            return None;
        }
        let key = {
            let refs = self.ref_to_key.lock().unwrap();
            refs.get(server_ref).cloned()
        };
        if let Some(k) = key {
            return self.get(&k);
        }
        self.get(server_ref)
    }

    /// Fallback when only a server base URL is known (Navidrome invoke paths).
    pub fn get_for_server_url(&self, server_url: &str) -> Option<Arc<ServerHttpContext>> {
        let base = request_base_url_from_http_url(server_url);
        if base.is_empty() {
            return None;
        }
        let contexts = self.contexts.lock().unwrap();
        for ctx in contexts.values() {
            if ctx.endpoints.iter().any(|(u, _)| *u == base) {
                return Some(Arc::clone(ctx));
            }
        }
        None
    }

    /// Resolve a context by `server_ref` when that context owns the request
    /// endpoint, then fall back to endpoint matching. A known ref must never
    /// lend headers or capabilities to an unrelated HTTP URL.
    pub fn resolve_context(
        &self,
        server_ref: Option<&str>,
        full_http_url: &str,
    ) -> Option<Arc<ServerHttpContext>> {
        let request_base = request_base_url_from_http_url(full_http_url);
        if let Some(sid) = server_ref.filter(|s| !s.is_empty()) {
            if let Some(ctx) = self.get_for_server_ref(sid) {
                if ctx.endpoints.iter().any(|(url, _)| *url == request_base) {
                    return Some(ctx);
                }
            }
        }
        self.get_for_server_url(full_http_url)
    }

    /// `format=raw` is only trusted for a registered endpoint whose saved
    /// server identity currently identifies Navidrome.
    pub fn supports_raw_stream_for_request(
        &self,
        server_ref: Option<&str>,
        full_http_url: &str,
    ) -> bool {
        self.resolve_context(server_ref, full_http_url)
            .is_some_and(|ctx| ctx.supports_raw_stream)
    }

}

/// The single entry point for attaching a gated server's custom headers to any
/// native request. Resolves the context by `server_ref` first, then falls back
/// to matching the request URL against a registered gated endpoint; a non-gated
/// server (no match) leaves the builder untouched. Every raw-download call site
/// (streaming, cover art, analysis prefetch, Navidrome auth, offline transfer)
/// and `SubsonicClient::with_registry` funnel through this / `resolve_context`,
/// so gate-header behaviour lives in exactly one place.
pub fn apply_optional_registry_headers(
    registry: Option<&ServerHttpRegistry>,
    server_ref: Option<&str>,
    full_http_url: &str,
    builder: RequestBuilder,
) -> RequestBuilder {
    if let Some(reg) = registry {
        if let Some(ctx) = reg.resolve_context(server_ref, full_http_url) {
            return apply_server_headers_for_http_url(builder, &ctx, full_http_url);
        }
    }
    builder
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_base_url_strips_rest_and_query() {
        let url = "https://music.example/rest/stream.view?id=1&u=x";
        assert_eq!(
            request_base_url_from_http_url(url),
            "https://music.example"
        );
    }

    #[test]
    fn headers_apply_public_only_on_public_endpoint() {
        let ctx = ServerHttpContext {
            endpoints: vec![
                ("http://192.168.0.10".into(), EndpointKind::Local),
                ("https://music.example".into(), EndpointKind::Public),
            ],
            headers: vec![("X-Gate".into(), "secret".into())],
            apply_to: CustomHeadersApplyTo::Public,
            supports_raw_stream: false,
        };
        let lan = headers_for_request_base_url(&ctx, "http://192.168.0.10");
        assert!(lan.is_empty());
        let pub_ = headers_for_request_base_url(&ctx, "https://music.example");
        assert_eq!(pub_.get("X-Gate").map(|v| v.to_str().ok()), Some(Some("secret")));
    }

    #[test]
    fn resolve_context_falls_back_to_url_when_ref_is_stale() {
        // Registry keyed by index key with an app-id alias; endpoint is the gate.
        let reg = ServerHttpRegistry::new();
        reg.sync(ServerHttpContextSyncWire {
            server_id: "127.0.0.1".into(),
            app_server_id: "uuid-1".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "http://127.0.0.1:8899".into(),
                kind: EndpointKind::Local,
            }],
            custom_headers: vec![CustomHeaderEntryWire {
                name: "X-Gate".into(),
                value: "tok".into(),
            }],
            custom_headers_apply_to: Some(CustomHeadersApplyTo::Both),
            supports_raw_stream: false,
        });

        let stream_url = "http://127.0.0.1:8899/rest/stream.view?id=42&u=x&t=y";

        // The audio engine passes a playback server id that is neither the index
        // key nor the app-id alias — it must still resolve via the request URL.
        let ctx = reg
            .resolve_context(Some("some-stale-playback-id"), stream_url)
            .expect("stale ref must fall back to URL endpoint match");
        let headers = headers_for_request_base_url(&ctx, "http://127.0.0.1:8899");
        assert_eq!(headers.get("X-Gate").map(|v| v.to_str().ok()), Some(Some("tok")));

        // A non-gated server URL never resolves — foreign servers stay untouched.
        assert!(reg
            .resolve_context(Some("some-stale-playback-id"), "https://other.example/rest/stream.view?id=1")
            .is_none());
    }

    #[test]
    fn registry_resolves_app_id_alias() {
        let reg = ServerHttpRegistry::new();
        reg.sync(ServerHttpContextSyncWire {
            server_id: "music.example".into(),
            app_server_id: "uuid-1".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://music.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: vec![CustomHeaderEntryWire {
                name: "X-Gate".into(),
                value: "tok".into(),
            }],
            custom_headers_apply_to: Some(CustomHeadersApplyTo::Public),
            supports_raw_stream: false,
        });
        assert!(reg.get("music.example").is_some());
        assert!(reg.get_for_server_ref("uuid-1").is_some());
        assert!(reg.get("uuid-1").is_none());
    }

    #[test]
    fn capability_only_context_is_retained_without_custom_headers() {
        let reg = ServerHttpRegistry::new();
        reg.sync(ServerHttpContextSyncWire {
            server_id: "music.example".into(),
            app_server_id: "uuid-1".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://music.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream: true,
        });

        let stream_url = "https://music.example/rest/stream.view?id=1";
        assert!(reg.get_for_server_ref("uuid-1").is_some());
        assert!(reg.supports_raw_stream_for_request(Some("uuid-1"), stream_url));
        assert!(headers_for_request_base_url(
            &reg.resolve_context(Some("uuid-1"), stream_url).unwrap(),
            "https://music.example"
        )
        .is_empty());
    }

    #[test]
    fn raw_capability_requires_both_navidrome_context_and_registered_endpoint() {
        let reg = ServerHttpRegistry::new();
        reg.sync(ServerHttpContextSyncWire {
            server_id: "music.example".into(),
            app_server_id: "uuid-1".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://music.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream: true,
        });
        reg.sync(ServerHttpContextSyncWire {
            server_id: "subsonic.example".into(),
            app_server_id: "uuid-2".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://subsonic.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: vec![CustomHeaderEntryWire {
                name: "X-Gate".into(),
                value: "token".into(),
            }],
            custom_headers_apply_to: Some(CustomHeadersApplyTo::Public),
            supports_raw_stream: false,
        });

        assert!(!reg.supports_raw_stream_for_request(
            Some("uuid-1"),
            "https://unknown.example/rest/stream.view?id=1"
        ));
        assert!(!reg.supports_raw_stream_for_request(
            Some("uuid-2"),
            "https://subsonic.example/rest/stream.view?id=1"
        ));
    }

    #[test]
    fn profile_resync_revokes_the_previous_endpoint_context() {
        let reg = ServerHttpRegistry::new();
        reg.sync(ServerHttpContextSyncWire {
            server_id: "old.example".into(),
            app_server_id: "uuid-1".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://old.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream: true,
        });
        reg.sync(ServerHttpContextSyncWire {
            server_id: "new.example".into(),
            app_server_id: "uuid-1".into(),
            endpoints: vec![ServerHttpEndpointWire {
                url: "https://new.example".into(),
                kind: EndpointKind::Public,
            }],
            custom_headers: Vec::new(),
            custom_headers_apply_to: None,
            supports_raw_stream: false,
        });

        assert!(reg.get("old.example").is_none());
        assert!(reg.get_for_server_ref("uuid-1").is_none());
        assert!(!reg.supports_raw_stream_for_request(
            None,
            "https://old.example/rest/stream.view?id=1"
        ));
    }
}

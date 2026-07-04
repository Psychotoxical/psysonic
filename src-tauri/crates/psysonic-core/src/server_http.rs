//! Per-server custom HTTP headers for reverse-proxy gates (Pangolin, Cloudflare Access).
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
}

#[derive(Clone, Debug)]
pub struct ServerHttpContext {
    pub endpoints: Vec<(String, EndpointKind)>,
    pub headers: Vec<(String, String)>,
    pub apply_to: CustomHeadersApplyTo,
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
        if ctx.headers.is_empty() {
            self.remove(&index_key, &app_id);
            return;
        }
        {
            let mut contexts = self.contexts.lock().unwrap();
            contexts.insert(index_key.clone(), Arc::clone(&ctx));
        }
        let mut refs = self.ref_to_key.lock().unwrap();
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
            if ctx.headers.is_empty() {
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
        self.contexts.lock().unwrap().remove(index_key);
        let mut refs = self.ref_to_key.lock().unwrap();
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

    pub fn apply_for_http_url(
        &self,
        server_ref: &str,
        full_http_url: &str,
        builder: RequestBuilder,
    ) -> RequestBuilder {
        let Some(ctx) = self.get_for_server_ref(server_ref) else {
            return builder;
        };
        apply_server_headers_for_http_url(builder, &ctx, full_http_url)
    }

    pub fn apply_for_base_url(
        &self,
        server_ref: &str,
        request_base_url: &str,
        builder: RequestBuilder,
    ) -> RequestBuilder {
        let Some(ctx) = self.get_for_server_ref(server_ref) else {
            return builder;
        };
        apply_server_headers(builder, &ctx, request_base_url)
    }
}

/// Apply custom headers when `registry` is present — prefers `server_ref`, falls back to URL match.
pub fn apply_optional_registry_headers(
    registry: Option<&ServerHttpRegistry>,
    server_ref: Option<&str>,
    full_http_url: &str,
    builder: RequestBuilder,
) -> RequestBuilder {
    if let Some(reg) = registry {
        if let Some(sid) = server_ref.filter(|s| !s.is_empty()) {
            return reg.apply_for_http_url(sid, full_http_url, builder);
        }
        if let Some(ctx) = reg.get_for_server_url(full_http_url) {
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
        };
        let lan = headers_for_request_base_url(&ctx, "http://192.168.0.10");
        assert!(lan.is_empty());
        let pub_ = headers_for_request_base_url(&ctx, "https://music.example");
        assert_eq!(pub_.get("X-Gate").map(|v| v.to_str().ok()), Some(Some("secret")));
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
        });
        assert!(reg.get("music.example").is_some());
        assert!(reg.get_for_server_ref("uuid-1").is_some());
        assert!(reg.get("uuid-1").is_none());
    }
}

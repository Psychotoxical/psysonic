use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use psysonic_core::server_http::ServerHttpRegistry;

pub(super) struct RawOriginalResponder {
    pub(super) body: Vec<u8>,
}

impl wiremock::Respond for RawOriginalResponder {
    fn respond(&self, request: &wiremock::Request) -> wiremock::ResponseTemplate {
        if request
            .headers
            .get(reqwest::header::RANGE.as_str())
            .is_some()
        {
            let end = self
                .body
                .len()
                .saturating_sub(1)
                .min(crate::raw_probe::RAW_PROBE_RANGE_END as usize);
            return wiremock::ResponseTemplate::new(206)
                .insert_header(
                    "Content-Range",
                    format!("bytes 0-{end}/{}", self.body.len()).as_str(),
                )
                .set_body_bytes(self.body[..=end].to_vec());
        }
        wiremock::ResponseTemplate::new(200).set_body_bytes(self.body.clone())
    }
}

pub(super) struct ChangingRawOriginalResponder {
    pub(super) first: Vec<u8>,
    pub(super) later: Vec<u8>,
    pub(super) requests: Arc<AtomicUsize>,
}

impl wiremock::Respond for ChangingRawOriginalResponder {
    fn respond(&self, request: &wiremock::Request) -> wiremock::ResponseTemplate {
        let body = if self.requests.fetch_add(1, Ordering::Relaxed) == 0 {
            &self.first
        } else {
            &self.later
        };
        if request
            .headers
            .get(reqwest::header::RANGE.as_str())
            .is_some()
        {
            let end = body
                .len()
                .saturating_sub(1)
                .min(crate::raw_probe::RAW_PROBE_RANGE_END as usize);
            return wiremock::ResponseTemplate::new(206)
                .insert_header(
                    "Content-Range",
                    format!("bytes 0-{end}/{}", body.len()).as_str(),
                )
                .set_body_bytes(body[..=end].to_vec());
        }
        wiremock::ResponseTemplate::new(200).set_body_bytes(body.clone())
    }
}

pub(super) fn analysis_registry(endpoint: &str, supports_raw_stream: bool) -> ServerHttpRegistry {
    use psysonic_core::server_http::{
        EndpointKind, ServerHttpContextSyncWire, ServerHttpEndpointWire,
    };

    let registry = ServerHttpRegistry::new();
    registry.sync(ServerHttpContextSyncWire {
        server_id: "canonical-server".into(),
        app_server_id: "profile-id".into(),
        endpoints: vec![ServerHttpEndpointWire {
            url: endpoint.into(),
            kind: EndpointKind::Public,
        }],
        custom_headers: Vec::new(),
        custom_headers_apply_to: None,
        supports_raw_stream,
    });
    registry
}

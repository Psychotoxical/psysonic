use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::{Arc, Mutex};

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use super::super::range_task::ranged_write_http_range;
use super::super::{OnDemand, RangedHttpSource};
use crate::engine::PlaybackHttpHeaders;

/// Serves whatever inclusive byte range the request asks for out of `body`,
/// as a 206 — models a server that honours arbitrary `Range` requests.
struct RangeResponder {
    body: Vec<u8>,
}

impl Respond for RangeResponder {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let range = req
            .headers
            .get(reqwest::header::RANGE.as_str())
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("bytes="))
            .map(|s| s.to_string());
        let Some(range) = range else {
            return ResponseTemplate::new(200).set_body_bytes(self.body.clone());
        };
        let mut parts = range.splitn(2, '-');
        let start: usize = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let end_inclusive: usize = parts
            .next()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse().ok())
            .unwrap_or(self.body.len().saturating_sub(1));
        let end = (end_inclusive + 1).min(self.body.len());
        ResponseTemplate::new(206).set_body_bytes(self.body[start..end].to_vec())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn read_far_ahead_is_served_by_on_demand_range_fetch() {
    // 4 MiB track; nothing downloaded linearly yet and the download is still
    // "in progress" (done = false). A read whose cursor sits well past the
    // linear front must be satisfied by an on-demand Range fetch.
    let total: usize = 4 * 1024 * 1024;
    let body: Vec<u8> = (0..total).map(|i| (i % 256) as u8).collect();

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/track"))
        .respond_with(RangeResponder { body: body.clone() })
        .mount(&server)
        .await;
    let url = format!("{}/track", server.uri());

    let buf = Arc::new(Mutex::new(vec![0u8; total]));
    let downloaded_to = Arc::new(AtomicUsize::new(0));
    let gen_arc = Arc::new(AtomicU64::new(1));
    let on_demand = Some(Arc::new(OnDemand::new(
        reqwest::Client::new(),
        tokio::runtime::Handle::current(),
        url,
        buf.clone(),
        total as u64,
        gen_arc.clone(),
        1,
        PlaybackHttpHeaders::default(),
    )));
    let mut src = RangedHttpSource {
        buf,
        downloaded_to,
        tail_ready: Arc::new(AtomicBool::new(false)),
        tail_filled_from: Arc::new(AtomicU64::new(0)),
        total_size: total as u64,
        pos: 2 * 1024 * 1024, // 2 MiB — far past the (empty) linear front
        done: Arc::new(AtomicBool::new(false)),
        gen_arc,
        gen: 1,
        on_demand,
    };

    // The blocking read polls until the on-demand fetch fills the region.
    let out = tokio::task::spawn_blocking(move || {
        let mut out = [0u8; 16];
        let n = src.read(&mut out).unwrap();
        (n, out)
    })
    .await
    .unwrap();

    assert_eq!(
        out.0, 16,
        "read returns the requested bytes via on-demand fetch"
    );
    let base = 2 * 1024 * 1024usize;
    let expected: Vec<u8> = (base..base + 16).map(|i| (i % 256) as u8).collect();
    assert_eq!(&out.1[..], &expected[..]);
}

#[tokio::test(flavor = "multi_thread")]
async fn ranged_write_http_range_rejects_200_at_nonzero_offset() {
    // A server that ignores Range and answers 200 with the whole body must
    // NOT be written at a non-zero offset (would corrupt the buffer).
    let server = MockServer::start().await;
    let body = vec![0xCDu8; 4096];
    Mock::given(method("GET"))
        .and(path("/track"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;
    let url = format!("{}/track", server.uri());

    let buf = Arc::new(Mutex::new(vec![0u8; 4096]));
    let gen_arc = Arc::new(AtomicU64::new(1));
    let res = ranged_write_http_range(
        &reqwest::Client::new(),
        &url,
        &buf,
        1024, // non-zero offset
        2047,
        1,
        &gen_arc,
        &PlaybackHttpHeaders::default(),
    )
    .await;

    assert!(res.is_err(), "200 at a non-zero offset must be rejected");
    assert!(
        buf.lock().unwrap().iter().all(|&b| b == 0),
        "buffer must be left untouched on a rejected 200"
    );
}

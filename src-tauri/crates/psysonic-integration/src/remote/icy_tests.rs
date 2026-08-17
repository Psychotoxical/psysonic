use super::*;
use wiremock::matchers::{header, method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test(flavor = "multi_thread")]
async fn fetch_icy_metadata_preserves_utf8() {
    let server = MockServer::start().await;
    let title = "TimJamFer - \u{ff59}\u{ff4f}\u{ff55} \
                 \u{84b8}\u{6c17}\u{30bd}\u{30d5}\u{30c8} \
                 \u{d55c}\u{ae00}";
    let metadata = format!("StreamTitle='{title}';StreamUrl='';");
    let padded_len = metadata.len().div_ceil(16) * 16;
    let mut body = b"AAAA".to_vec();
    body.push((padded_len / 16) as u8);
    body.extend_from_slice(metadata.as_bytes());
    body.resize(5 + padded_len, 0);

    Mock::given(method("GET"))
        .and(wm_path("/stream"))
        .and(header("icy-metadata", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("icy-metaint", "4")
                .set_body_bytes(body),
        )
        .mount(&server)
        .await;

    let result = fetch_icy_metadata(format!("{}/stream", server.uri()))
        .await
        .expect("ICY metadata request should succeed");
    assert_eq!(result.stream_title.as_deref(), Some(title));
}

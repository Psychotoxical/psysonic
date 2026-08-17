use super::super::*;

#[test]
fn probe_url_strips_transcode_params_and_requests_raw() {
    let url = "https://s.example/rest/stream.view?id=t1&u=a&t=tok&s=salt&v=1.16.1&c=psysonic&f=json&maxBitRate=128";
    let probe = build_raw_probe_url(url).unwrap();
    assert!(probe.contains("format=raw"));
    assert!(!probe.contains("maxBitRate"));
    assert!(probe.contains("id=t1") && probe.contains("t=tok"));
}

#[test]
fn probe_url_replaces_an_existing_format_param() {
    let url = "https://s.example/rest/stream.view?id=t1&format=mp3&maxBitRate=128";
    let probe = build_raw_probe_url(url).unwrap();
    assert_eq!(probe.matches("format=").count(), 1);
    assert!(probe.ends_with("format=raw"));
}

#[test]
fn probe_url_rejects_local_and_non_stream_urls() {
    assert_eq!(
        build_raw_probe_url("psysonic-local:///library/t.flac"),
        None
    );
    assert_eq!(
        build_raw_probe_url("https://s.example/rest/getCoverArt.view?id=c"),
        None
    );
}

#[test]
fn original_download_url_replaces_endpoint_and_strips_transcode_params() {
    let url = "https://s.example/rest/stream.view?id=t1&u=a&t=tok&format=mp3&maxBitRate=64&estimateContentLength=true";
    let download = build_original_download_url(url).unwrap();
    assert!(download.starts_with("https://s.example/rest/download.view?"));
    assert!(download.contains("id=t1"));
    assert!(download.contains("u=a"));
    assert!(download.contains("t=tok"));
    assert!(!download.contains("format="));
    assert!(!download.contains("maxBitRate="));
    assert!(!download.contains("estimateContentLength="));
}

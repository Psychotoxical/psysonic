use reqwest::Client;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

const SUBSONIC_CLIENT: &str = "Psysonic";

fn random_salt() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

pub fn build_cover_art_url(
    rest_base: &str,
    username: &str,
    password: &str,
    cover_art_id: &str,
    size: u32,
) -> String {
    let base = rest_base.trim_end_matches('/');
    let mut url = Url::parse(&format!("{base}/rest/getCoverArt.view")).expect("cover url");
    let salt = random_salt();
    let token = format!("{:x}", md5::compute(format!("{password}{salt}")));
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("id", cover_art_id);
        q.append_pair("size", &size.to_string());
        q.append_pair("u", username);
        q.append_pair("t", &token);
        q.append_pair("s", &salt);
        q.append_pair("v", "1.16.1");
        q.append_pair("c", SUBSONIC_CLIENT);
        q.append_pair("f", "json");
    }
    url.to_string()
}

pub async fn fetch_cover_bytes(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("cover HTTP {}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

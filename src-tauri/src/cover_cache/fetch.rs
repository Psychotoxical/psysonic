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
    let api_base = if base.ends_with("/rest") {
        base.to_string()
    } else {
        format!("{base}/rest")
    };
    let mut url = Url::parse(&format!("{api_base}/getCoverArt.view")).expect("cover url");
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
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::build_cover_art_url;

    #[test]
    fn cover_url_from_host_root() {
        let url = build_cover_art_url(
            "http://navidrome.local:4533",
            "u",
            "p",
            "al-1",
            800,
        );
        assert!(url.starts_with("http://navidrome.local:4533/rest/getCoverArt.view?"));
        assert!(url.contains("id=al-1"));
        assert!(url.contains("size=800"));
    }

    #[test]
    fn cover_url_when_rest_suffix_already_present() {
        let url = build_cover_art_url(
            "http://navidrome.local:4533/rest",
            "u",
            "p",
            "al-1",
            128,
        );
        assert!(url.starts_with("http://navidrome.local:4533/rest/getCoverArt.view?"));
        assert!(!url.contains("/rest/rest/"));
    }
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

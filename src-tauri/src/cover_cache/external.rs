//! External artist-artwork providers (image-scraper P0 spike).
//!
//! - Subsonic `getArtistInfo2` → the artist's tag MusicBrainz id (§19 step 2;
//!   MBID resolution stays Rust-side per §23).
//! - fanart.tv `v3/music/<mbid>` → the first `artistbackground` URL.
//!
//! Mirrors the token auth of `fetch.rs`. The chosen background image's bytes
//! are downloaded by the ensure flow via `fetch::fetch_cover_bytes` (a generic
//! retrying GET). All network use is gated by the caller (feature flag +
//! reachability + the dedicated low-concurrency fanart semaphore).

use reqwest::Client;

use super::fetch::build_subsonic_url;

const FANART_API_BASE: &str = "https://webservice.fanart.tv/v3/music";

/// Subsonic `getArtistInfo2.view` (JSON) URL for an artist id.
pub fn build_artist_info2_url(
    rest_base: &str,
    username: &str,
    password: &str,
    artist_id: &str,
) -> String {
    build_subsonic_url(
        rest_base,
        "getArtistInfo2",
        username,
        password,
        &[("id", artist_id), ("f", "json")],
    )
}

/// fanart.tv music endpoint URL for an MBID. The BYOK personal `client_key` is
/// sent **in addition to** the project `api_key` when non-empty (fanart.tv ToS,
/// §22) — never a replacement.
pub fn build_fanart_url(mbid: &str, api_key: &str, client_key: Option<&str>) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("api_key", api_key);
    if let Some(ck) = client_key {
        if !ck.is_empty() {
            serializer.append_pair("client_key", ck);
        }
    }
    format!("{FANART_API_BASE}/{mbid}?{}", serializer.finish())
}

/// GET `getArtistInfo2` and extract `artistInfo2.musicBrainzId` (tag MBID).
/// `Ok(None)` when the artist carries no MBID tag.
pub async fn fetch_artist_tag_mbid(
    client: &Client,
    rest_base: &str,
    username: &str,
    password: &str,
    artist_id: &str,
) -> Result<Option<String>, String> {
    let url = build_artist_info2_url(rest_base, username, password, artist_id);
    let body = http_get_text(client, &url).await?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mbid = v
        .get("subsonic-response")
        .and_then(|r| r.get("artistInfo2"))
        .and_then(|a| a.get("musicBrainzId"))
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(mbid)
}

/// Map a render surface to its fanart.tv JSON array key. `fanart` (the 16:9
/// fullscreen background) → `artistbackground`; `banner` (the wide artist-detail
/// header strip) → `musicbanner`.
pub fn fanart_json_key(surface: &str) -> &'static str {
    match surface {
        "banner" => "musicbanner",
        _ => "artistbackground",
    }
}

/// GET the fanart.tv music JSON for an MBID and return the first image URL for
/// the requested `surface` (the API returns each kind most-liked first).
/// `Ok(None)` when the artist has no image of that kind (404 or empty array).
pub async fn fetch_fanart_image_url(
    client: &Client,
    mbid: &str,
    api_key: &str,
    client_key: Option<&str>,
    surface: &str,
) -> Result<Option<String>, String> {
    let url = build_fanart_url(mbid, api_key, client_key);
    let Some(body) = http_get_text_opt(client, &url).await? else {
        return Ok(None); // 404 → artist has no fanart at all
    };
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let img = v
        .get(fanart_json_key(surface))
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.first())
        .and_then(|o| o.get("url"))
        .and_then(|u| u.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(img)
}

/// Single GET → response text; any non-2xx is an error.
async fn http_get_text(client: &Client, url: &str) -> Result<String, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Single GET → `Some(text)` on success, `None` on 404, error otherwise.
async fn http_get_text_opt(client: &Client, url: &str) -> Result<Option<String>, String> {
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    resp.text().await.map(Some).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artist_info2_url_is_json_and_token_authed() {
        let u = build_artist_info2_url("http://nav.local:4533", "u", "p", "ar-1");
        assert!(u.starts_with("http://nav.local:4533/rest/getArtistInfo2.view?"));
        assert!(u.contains("id=ar-1"));
        assert!(u.contains("f=json"));
        assert!(u.contains("&t=") && u.contains("&s="));
    }

    #[test]
    fn fanart_url_adds_client_key_only_when_present() {
        assert_eq!(
            build_fanart_url("mbid-123", "PROJ", None),
            "https://webservice.fanart.tv/v3/music/mbid-123?api_key=PROJ"
        );
        let byok = build_fanart_url("mbid-123", "PROJ", Some("PERS"));
        assert!(byok.contains("api_key=PROJ") && byok.contains("client_key=PERS"));
        // empty BYOK is ignored — project key only
        assert!(!build_fanart_url("mbid-123", "PROJ", Some("")).contains("client_key"));
    }

    #[test]
    fn parses_first_artistbackground_url() {
        let json = r#"{"artistbackground":[{"id":"1","url":"https://a/bg1.jpg","likes":"9"},{"url":"https://a/bg2.jpg"}]}"#;
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        let bg = v
            .get("artistbackground")
            .and_then(|a| a.as_array())
            .and_then(|arr| arr.first())
            .and_then(|o| o.get("url"))
            .and_then(|u| u.as_str());
        assert_eq!(bg, Some("https://a/bg1.jpg"));
    }

    #[test]
    fn json_key_maps_surface() {
        assert_eq!(fanart_json_key("fanart"), "artistbackground");
        assert_eq!(fanart_json_key("banner"), "musicbanner");
        assert_eq!(fanart_json_key("anything-else"), "artistbackground");
    }
}

//! External album-cover provider: Last.fm `album.getInfo`.

use reqwest::Client;

/// Last.fm v2 endpoint.
const LASTFM_API_BASE: &str = "https://ws.audioscrobbler.com/2.0/";
/// Last.fm "no image" placeholder MD5 — same hash `isRealArtistImage.ts` filters.
pub const LASTFM_NO_IMAGE_HASH: &str = "2a96cbd8b46e442fc41c2b86b821562f";
/// Bundled Last.fm app key, mirroring `FANART_PROJECT_KEY` (which is also
/// `pub(super)`): committed as a literal (desktop-app keys are extractable
/// from any binary anyway). `PSYSONIC_LASTFM_KEY` env overrides it for dev.
/// IMPORTANT: copy the `api_key` from `presets/lastfm.ts:10` ONLY — the
/// scrobbling SECRET sits at `presets/lastfm.ts:11` and must never be copied.
pub(super) const LASTFM_PROJECT_KEY: &str = "9917fb39049225a13bec225ad6d49054";
/// Last.fm expects a meaningful, contactable User-Agent.
const APP_USER_AGENT: &str = concat!(
    "Psysonic/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/Psysonic/psysonic )"
);

/// Last.fm `album.getInfo` image URL, or `Ok(None)` on a definitive miss.
/// `autocorrect=1` is the API default (fixes case/wording). 404 and
/// `error:6` ("Album not found") are both definitive — the caller negative-
/// caches them. Prefers the largest real image, skipping the empty-size entry
/// and the placeholder hash.
pub async fn fetch_lastfm_album_image(
    client: &Client,
    api_key: &str,
    artist: &str,
    album: &str,
) -> Result<Option<String>, String> {
    fetch_lastfm_album_image_with_base(client, api_key, artist, album, LASTFM_API_BASE).await
}

/// Last.fm keys an album under the FIRST artist — the scrobble source (e.g.
/// Spotify) reports the primary artist only, so a Navidrome multi-artist join
/// ("A • B", U+2022 bullet) never exists as a Last.fm artist. Return the first
/// segment when a bullet joiner is present. Split on the bullet ONLY — never on
/// "," or "/" — so a literal artist name like "AC/DC" survives intact (Navidrome
/// deliberately does not split it either).
fn primary_artist(artist: &str) -> &str {
    if artist.contains('•') {
        if let Some(first) = artist.split('•').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    artist
}

/// Same as [`fetch_lastfm_album_image`] but with an explicit endpoint base —
/// the wiremock-testing seam. `base` should end in `/`.
pub async fn fetch_lastfm_album_image_with_base(
    client: &Client,
    api_key: &str,
    artist: &str,
    album: &str,
    base: &str,
) -> Result<Option<String>, String> {
    // Query by the primary artist (see `primary_artist`); the joined form is a
    // guaranteed miss on Last.fm and we don't want to burn the round-trip.
    let artist = primary_artist(artist);
    let url = {
        let mut s = url::form_urlencoded::Serializer::new(format!("{base}?"));
        s.append_pair("method", "album.getInfo");
        s.append_pair("artist", artist);
        s.append_pair("album", album);
        s.append_pair("api_key", api_key);
        s.append_pair("format", "json");
        s.append_pair("autocorrect", "1");
        s.finish()
    };
    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, APP_USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
        if v.get("error").and_then(|e| e.as_i64()) == Some(6) {
            return Ok(None);
        }
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }

    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let images = v.get("album").and_then(|a| a.get("image")).and_then(|i| i.as_array()).cloned().unwrap_or_default();
    for size in ["mega", "extralarge", "large", "medium", "small"] {
        if let Some(url) = images
            .iter()
            .find(|img| img.get("size").and_then(|s| s.as_str()) == Some(size))
            .and_then(|img| img.get("#text"))
            .and_then(|t| t.as_str())
            .filter(|u| u.starts_with("https://") && !u.contains(LASTFM_NO_IMAGE_HASH))
        {
            return Ok(Some(url.to_string()));
        }
    }
    Ok(None)
}

/// Env-overridable bundled key (mirrors `external_ensure.rs` fanart handling).
pub fn lastfm_api_key() -> String {
    std::env::var("PSYSONIC_LASTFM_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| LASTFM_PROJECT_KEY.to_string())
}

/// Resolve a Last.fm album-cover URL directly (Discord chain step).
#[tauri::command]
#[specta::specta]
pub async fn resolve_lastfm_cover(artist: String, album: String) -> Option<String> {
    // 5s timeout mirrors DiscordState.http_client (discord.rs:44-47) so a hung
    // Last.fm request can't stall the Discord presence chain indefinitely.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    fetch_lastfm_album_image(&client, &lastfm_api_key(), &artist, &album)
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Client;
    use wiremock::matchers::{method, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_client() -> Client {
        Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn builds_album_getinfo_query_with_url_encoded_artist_album() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(query_param("method", "album.getInfo"))
            .and(query_param("artist", "pink floyd"))
            .and(query_param("album", "the wall"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "album": {
                    "image": [
                        { "size": "mega", "#text": "https://lastfm/big.jpg" }
                    ]
                }
            })))
            .mount(&server)
            .await;
        let server_uri = server.uri();
        let result = fetch_lastfm_album_image_with_base(
            &test_client(),
            &lastfm_api_key(),
            "pink floyd",
            "the wall",
            &format!("{server_uri}/"),
        )
        .await;
        assert_eq!(result, Ok(Some("https://lastfm/big.jpg".to_string())));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn returns_none_on_error_6_album_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": 6,
                "message": "Album not found"
            })))
            .mount(&server)
            .await;
        let server_uri = server.uri();
        let result = fetch_lastfm_album_image_with_base(
            &test_client(),
            "k",
            "a",
            "b",
            &format!("{server_uri}/"),
        )
        .await;
        assert_eq!(result, Ok(None));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn skips_placeholder_hash_url_and_picks_next_largest_real() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "album": {
                    "image": [
                        { "size": "mega", "#text": format!("https://lastfm/{}.jpg", LASTFM_NO_IMAGE_HASH) },
                        { "size": "extralarge", "#text": "https://lastfm/real-extralarge.jpg" },
                        { "size": "large", "#text": "https://lastfm/real-large.jpg" }
                    ]
                }
            })))
            .mount(&server)
            .await;
        let server_uri = server.uri();
        let result = fetch_lastfm_album_image_with_base(
            &test_client(),
            "k",
            "a",
            "b",
            &format!("{server_uri}/"),
        )
        .await;
        assert_eq!(
            result,
            Ok(Some("https://lastfm/real-extralarge.jpg".to_string()))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn uses_primary_artist_when_display_string_is_bullet_joined() {
        let server = MockServer::start().await;
        // Mock asserts the artist param was reduced to the FIRST segment — the
        // joined "pink floyd • david gilmour" would never match and return 404.
        Mock::given(method("GET"))
            .and(query_param("artist", "pink floyd"))
            .and(query_param("album", "the wall"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "album": {
                    "image": [
                        { "size": "mega", "#text": "https://lastfm/big.jpg" }
                    ]
                }
            })))
            .mount(&server)
            .await;
        let server_uri = server.uri();
        let result = fetch_lastfm_album_image_with_base(
            &test_client(),
            &lastfm_api_key(),
            "pink floyd • david gilmour",
            "the wall",
            &format!("{server_uri}/"),
        )
        .await;
        assert_eq!(result, Ok(Some("https://lastfm/big.jpg".to_string())));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn does_not_split_artist_name_with_a_slash() {
        // "AC/DC" must be sent verbatim — the bullet-only split must not treat
        // the "/" as a joiner. If it did, the request would be "AC" and the
        // mock (expecting "AC/DC") would return 404 → Ok(None), failing the test.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(query_param("artist", "AC/DC"))
            .and(query_param("album", "back in black"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "album": {
                    "image": [
                        { "size": "mega", "#text": "https://lastfm/big.jpg" }
                    ]
                }
            })))
            .mount(&server)
            .await;
        let server_uri = server.uri();
        let result = fetch_lastfm_album_image_with_base(
            &test_client(),
            &lastfm_api_key(),
            "AC/DC",
            "back in black",
            &format!("{server_uri}/"),
        )
        .await;
        assert_eq!(result, Ok(Some("https://lastfm/big.jpg".to_string())));
    }
}

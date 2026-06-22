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
const MUSICBRAINZ_BASE: &str = "https://musicbrainz.org/ws/2";
/// fanart.tv project `api_key`, embedded in the binary like Last.fm's key and as
/// fanart.tv's own terms expect ("sent in addition to your project key" — the app
/// ships a project key, users add a personal one on top). Committed as a literal
/// (not a build secret) so every build — CI, local, AUR, Nix, from-source — has
/// it; desktop-app keys are extractable from any binary anyway. Users can still
/// add their own personal key (BYOK, §22), sent in addition to this one.
pub(super) const FANART_PROJECT_KEY: &str = "a32e00543d18deadb797bc0cc9826760";
/// MusicBrainz requires a meaningful, contactable User-Agent (their ToS).
const MUSICBRAINZ_USER_AGENT: &str = concat!(
    "Psysonic/",
    env!("CARGO_PKG_VERSION"),
    " ( https://github.com/Psychotoxical/psysonic )"
);

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
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
    rest_base: &str,
    username: &str,
    password: &str,
    artist_id: &str,
) -> Result<Option<String>, String> {
    let url = build_artist_info2_url(rest_base, username, password, artist_id);
    let body = http_get_text_scoped(client, registry, server_ref, &url).await?;
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

/// Outcome of a name→MusicBrainz artist-MBID resolution (§19).
pub enum MbResolution {
    /// A single, confident artist MBID (one artist across high-score releases).
    Found(String),
    /// Multiple candidate artists — never guess; the caller backs off 24h.
    Ambiguous,
    /// No matching release at all.
    None,
}

/// Escape the Lucene special characters that would break a MusicBrainz query.
fn mb_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Strip a single trailing parenthetical / bracketed qualifier (e.g.
/// "(2004 Remastered)", "[Deluxe Edition]") so a decorated library album title
/// still matches the canonical MusicBrainz release. Leaves leading qualifiers
/// (e.g. "(What's the Story) Morning Glory?") untouched.
fn normalize_album_for_mb(title: &str) -> String {
    let t = title.trim();
    let stripped = if t.ends_with(')') {
        t.rfind(" (").map(|i| &t[..i]).unwrap_or(t)
    } else if t.ends_with(']') {
        t.rfind(" [").map(|i| &t[..i]).unwrap_or(t)
    } else {
        t
    };
    stripped.trim().to_string()
}

/// Resolve an artist MBID by name, confirmed by an album release (§19). One
/// query to the MusicBrainz release search; the primary artist across the
/// high-confidence releases wins, conflicting ids → `Ambiguous`. Sends the
/// required User-Agent. The caller enforces the ≤1 req/s rate limit.
pub async fn resolve_mbid_via_musicbrainz(
    client: &Client,
    artist_name: &str,
    album_title: &str,
) -> Result<MbResolution, String> {
    let album = normalize_album_for_mb(album_title);
    let query = format!(
        "artist:\"{}\" AND release:\"{}\"",
        mb_escape(artist_name),
        mb_escape(&album)
    );
    // Scope the (non-Send) serializer so it is dropped before the await below.
    let url = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("query", &query);
        serializer.append_pair("fmt", "json");
        serializer.append_pair("limit", "8");
        format!("{MUSICBRAINZ_BASE}/release/?{}", serializer.finish())
    };

    let resp = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, MUSICBRAINZ_USER_AGENT)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(classify_mb_releases(&v))
}

/// Pure classification of a MusicBrainz release-search response: the primary
/// artist id of each release scoring ≥ 90. One distinct id → `Found`, several →
/// `Ambiguous`, none → `None`.
fn classify_mb_releases(v: &serde_json::Value) -> MbResolution {
    let mut ids = std::collections::BTreeSet::new();
    if let Some(releases) = v.get("releases").and_then(|r| r.as_array()) {
        for rel in releases {
            let score = rel.get("score").and_then(|s| s.as_i64()).unwrap_or(0);
            if score < 90 {
                continue;
            }
            if let Some(id) = rel
                .get("artist-credit")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
                .and_then(|c| c.get("artist"))
                .and_then(|a| a.get("id"))
                .and_then(|i| i.as_str())
            {
                ids.insert(id.to_string());
            }
        }
    }
    match ids.len() {
        0 => MbResolution::None,
        1 => MbResolution::Found(ids.into_iter().next().unwrap_or_default()),
        _ => MbResolution::Ambiguous,
    }
}

/// Single GET → response text; any non-2xx is an error.
async fn http_get_text_scoped(
    client: &Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: Option<&str>,
    url: &str,
) -> Result<String, String> {
    let resp = psysonic_core::server_http::apply_optional_registry_headers(
        registry,
        server_ref,
        url,
        client.get(url),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
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

    #[test]
    fn normalize_album_strips_trailing_qualifier_only() {
        assert_eq!(normalize_album_for_mb("Show No Mercy (2004 Remastered)"), "Show No Mercy");
        assert_eq!(normalize_album_for_mb("Album [Deluxe Edition]"), "Album");
        assert_eq!(normalize_album_for_mb("Reign in Blood"), "Reign in Blood");
        // leading qualifier left intact (does not end with a close bracket)
        assert_eq!(
            normalize_album_for_mb("(What's the Story) Morning Glory?"),
            "(What's the Story) Morning Glory?"
        );
    }

    #[test]
    fn mb_escape_handles_quotes_and_backslashes() {
        assert_eq!(mb_escape("AC/DC"), "AC/DC");
        assert_eq!(mb_escape(r#"a"b"#), r#"a\"b"#);
        assert_eq!(mb_escape(r"a\b"), r"a\\b");
    }

    #[test]
    fn classify_mb_picks_single_high_score_artist() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"releases":[
                {"score":100,"artist-credit":[{"artist":{"id":"mbid-A"}}]},
                {"score":95,"artist-credit":[{"artist":{"id":"mbid-A"}}]},
                {"score":40,"artist-credit":[{"artist":{"id":"mbid-Z"}}]}
            ]}"#,
        )
        .unwrap();
        assert!(matches!(classify_mb_releases(&v), MbResolution::Found(id) if id == "mbid-A"));
    }

    #[test]
    fn classify_mb_ambiguous_and_none() {
        let two: serde_json::Value = serde_json::from_str(
            r#"{"releases":[
                {"score":100,"artist-credit":[{"artist":{"id":"mbid-A"}}]},
                {"score":92,"artist-credit":[{"artist":{"id":"mbid-B"}}]}
            ]}"#,
        )
        .unwrap();
        assert!(matches!(classify_mb_releases(&two), MbResolution::Ambiguous));

        let low: serde_json::Value =
            serde_json::from_str(r#"{"releases":[{"score":50,"artist-credit":[{"artist":{"id":"x"}}]}]}"#)
                .unwrap();
        assert!(matches!(classify_mb_releases(&low), MbResolution::None));

        let empty: serde_json::Value = serde_json::from_str(r#"{"releases":[]}"#).unwrap();
        assert!(matches!(classify_mb_releases(&empty), MbResolution::None));
    }
}

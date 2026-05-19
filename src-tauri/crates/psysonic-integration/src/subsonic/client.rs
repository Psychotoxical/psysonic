//! `SubsonicClient` — read-only Subsonic REST surface needed by the
//! library-sync engine (phase B per spec §10 / PR-2). Auth is the legacy
//! salted-md5 token (spec v1.13+); request shape is GET to
//! `{base}/rest/{method}.view?u&t&s&v&c&f=json&…`.
//!
//! This client is pure Rust — **no `#[tauri::command]`**. Tauri commands
//! that talk to the library live in PR-5 / phase D.

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::auth::SubsonicCredentials;
use super::error::{flatten_reqwest_error, SubsonicError};
use super::types::{Album, AlbumSummary, ArtistIndex, ScanStatus, SearchResult, Song};

/// Protocol level we advertise — pre-OpenSubsonic Subsonic baseline that
/// Navidrome and other servers in the wild support. OpenSubsonic
/// extensions deserialize when present (additive on the wire).
pub const SUBSONIC_API_VERSION: &str = "1.16.1";

/// Subsonic `c` parameter — server logs and rate-limiters key off this.
pub const SUBSONIC_CLIENT_ID: &str = "psysonic";

pub struct SubsonicClient {
    base_url: String,
    credentials: SubsonicCredentials,
    http: reqwest::Client,
}

impl SubsonicClient {
    /// Build a client with our default HTTP setup (gzip, JSON, no funky
    /// pooling tweaks — Subsonic gateways are simpler than the Navidrome
    /// native-REST path).
    pub fn new(base_url: impl Into<String>, credentials: SubsonicCredentials) -> Self {
        Self::with_http(base_url, credentials, default_http_client())
    }

    /// Build a client with a caller-supplied `reqwest::Client`. Used by
    /// tests (custom timeouts, no UA cap) and by callers that want to
    /// share a pool across multiple Subsonic servers.
    pub fn with_http(
        base_url: impl Into<String>,
        credentials: SubsonicCredentials,
        http: reqwest::Client,
    ) -> Self {
        let mut url = base_url.into();
        while url.ends_with('/') {
            url.pop();
        }
        Self { base_url: url, credentials, http }
    }

    /// B1 — ping. Returns `Ok(())` when the server replied with
    /// `status="ok"`; surfaces `SubsonicError::Api{40,…}` for invalid
    /// credentials and the usual transport / status errors otherwise.
    pub async fn ping(&self) -> Result<(), SubsonicError> {
        let body = self.send("ping", &[]).await?;
        parse_envelope_status_only(&body)
    }

    /// B2 — `getScanStatus`. Lightweight poll for huge libraries
    /// (spec §2.3 / §6.2.2).
    pub async fn get_scan_status(&self) -> Result<ScanStatus, SubsonicError> {
        self.fetch("getScanStatus", &[], "scanStatus").await
    }

    /// B5 — `getIndexes(musicFolderId?, ifModifiedSince?)`. File-tree
    /// browse with conditional fetch — when `ifModifiedSince` matches the
    /// server's `lastScan`, the response body is empty but the
    /// `lastModified` watermark is still returned (spec §3.1).
    pub async fn get_indexes(
        &self,
        music_folder_id: Option<&str>,
        if_modified_since_ms: Option<i64>,
    ) -> Result<ArtistIndex, SubsonicError> {
        let ims = if_modified_since_ms.map(|n| n.to_string());
        let mut params: Vec<(&str, &str)> = Vec::new();
        if let Some(id) = music_folder_id {
            params.push(("musicFolderId", id));
        }
        if let Some(ref s) = ims {
            params.push(("ifModifiedSince", s));
        }
        self.fetch("getIndexes", &params, "indexes").await
    }

    /// B8 — `getArtists(musicFolderId?)`. ID3-path artist index. Always
    /// returns full body; clients compare `last_modified_ms` against the
    /// watermark in `sync_state` to decide whether a delta pass is needed
    /// (spec §2.2.1).
    pub async fn get_artists(
        &self,
        music_folder_id: Option<&str>,
    ) -> Result<ArtistIndex, SubsonicError> {
        let mut params: Vec<(&str, &str)> = Vec::new();
        if let Some(id) = music_folder_id {
            params.push(("musicFolderId", id));
        }
        self.fetch("getArtists", &params, "artists").await
    }

    /// B3a — `getAlbumList2(type, size, offset, musicFolderId?)`. Returns
    /// just the album summaries; the caller follows up with `get_album`
    /// per id to enumerate songs.
    pub async fn get_album_list2(
        &self,
        list_type: &str,
        size: u32,
        offset: u32,
        music_folder_id: Option<&str>,
    ) -> Result<Vec<AlbumSummary>, SubsonicError> {
        let size_s = size.to_string();
        let offset_s = offset.to_string();
        let mut params: Vec<(&str, &str)> = vec![
            ("type", list_type),
            ("size", size_s.as_str()),
            ("offset", offset_s.as_str()),
        ];
        if let Some(id) = music_folder_id {
            params.push(("musicFolderId", id));
        }
        let wrapped: AlbumListWrapper =
            self.fetch("getAlbumList2", &params, "albumList2").await?;
        Ok(wrapped.album)
    }

    /// B3b — `getAlbum(id)`. Returns the album metadata plus the full song list.
    pub async fn get_album(&self, album_id: &str) -> Result<Album, SubsonicError> {
        self.fetch("getAlbum", &[("id", album_id)], "album").await
    }

    /// B4 — `search3(query, songCount, songOffset, musicFolderId?)`.
    /// Navidrome accepts an empty query and returns all songs paged —
    /// spec §2.4 documents that quirk and Psysonic already relies on it.
    pub async fn search3(
        &self,
        query: &str,
        song_count: u32,
        song_offset: u32,
        music_folder_id: Option<&str>,
    ) -> Result<SearchResult, SubsonicError> {
        let song_count_s = song_count.to_string();
        let song_offset_s = song_offset.to_string();
        let mut params: Vec<(&str, &str)> = vec![
            ("query", query),
            ("songCount", song_count_s.as_str()),
            ("songOffset", song_offset_s.as_str()),
        ];
        if let Some(id) = music_folder_id {
            params.push(("musicFolderId", id));
        }
        self.fetch("search3", &params, "searchResult3").await
    }

    /// B6 — `getSong(id)`. Returns `SubsonicError::NotFound` when the
    /// server replies with error code 70 (spec §2.6) — the tombstone
    /// reconciler matches on that variant directly.
    pub async fn get_song(&self, song_id: &str) -> Result<Song, SubsonicError> {
        self.fetch("getSong", &[("id", song_id)], "song").await
    }

    async fn fetch<T: DeserializeOwned>(
        &self,
        method: &str,
        extra: &[(&str, &str)],
        body_key: &str,
    ) -> Result<T, SubsonicError> {
        let body = self.send(method, extra).await?;
        parse_envelope(&body, body_key)
    }

    async fn send(&self, method: &str, extra: &[(&str, &str)]) -> Result<String, SubsonicError> {
        let auth = [
            ("u", self.credentials.username.as_str()),
            ("t", self.credentials.token.as_str()),
            ("s", self.credentials.salt.as_str()),
            ("v", SUBSONIC_API_VERSION),
            ("c", SUBSONIC_CLIENT_ID),
            ("f", "json"),
        ];
        let mut query: Vec<(&str, &str)> = auth.to_vec();
        query.extend_from_slice(extra);

        let resp = self
            .http
            .get(format!("{}/rest/{method}.view", self.base_url))
            .query(&query)
            .send()
            .await
            .map_err(|e| SubsonicError::Transport(flatten_reqwest_error(e)))?;

        if !resp.status().is_success() {
            return Err(SubsonicError::HttpStatus(resp.status()));
        }
        resp.text()
            .await
            .map_err(|e| SubsonicError::Transport(flatten_reqwest_error(e)))
    }
}

#[derive(Deserialize)]
struct AlbumListWrapper {
    #[serde(default)]
    album: Vec<AlbumSummary>,
}

fn default_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(format!("Psysonic/{} (Tauri)", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Parse the standard Subsonic envelope. Maps `error.code = 70` to the
/// dedicated `NotFound` variant; surfaces every other failed status as
/// `Api { code, message }`. On success, deserializes the body keyed by
/// `body_key` (e.g. `"album"`, `"artists"`, `"scanStatus"`).
fn parse_envelope<T: DeserializeOwned>(body: &str, body_key: &str) -> Result<T, SubsonicError> {
    let envelope: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| SubsonicError::Decode(format!("envelope: {e}")))?;
    let response = envelope
        .get("subsonic-response")
        .ok_or_else(|| SubsonicError::Decode("missing `subsonic-response`".into()))?;

    if let Some(err) = response.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) as i32;
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        return Err(map_error(code, message));
    }

    let status = response.get("status").and_then(|s| s.as_str()).unwrap_or_default();
    if status != "ok" {
        return Err(SubsonicError::Decode(format!("unexpected status `{status}`")));
    }

    let body_val = response
        .get(body_key)
        .ok_or_else(|| SubsonicError::Decode(format!("missing body key `{body_key}`")))?
        .clone();
    serde_json::from_value(body_val)
        .map_err(|e| SubsonicError::Decode(format!("body `{body_key}`: {e}")))
}

/// Variant of `parse_envelope` for endpoints that carry no body (only
/// `ping` in PR-2). Returns `Ok(())` when `status="ok"` and falls back to
/// the same error mapping.
fn parse_envelope_status_only(body: &str) -> Result<(), SubsonicError> {
    let envelope: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| SubsonicError::Decode(format!("envelope: {e}")))?;
    let response = envelope
        .get("subsonic-response")
        .ok_or_else(|| SubsonicError::Decode("missing `subsonic-response`".into()))?;

    if let Some(err) = response.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) as i32;
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        return Err(map_error(code, message));
    }

    let status = response.get("status").and_then(|s| s.as_str()).unwrap_or_default();
    match status {
        "ok" => Ok(()),
        other => Err(SubsonicError::Decode(format!("unexpected status `{other}`"))),
    }
}

fn map_error(code: i32, message: String) -> SubsonicError {
    if code == 70 {
        SubsonicError::NotFound
    } else {
        SubsonicError::Api { code, message }
    }
}

/// B9 — pick every `every_n`-th id from a sorted list. Used by the
/// server-fingerprint pass on re-add: 1 % of cached track ids are
/// probed via `get_song` and any 404 (`NotFound`) means the server's
/// id space drifted (spec §5.6, P19). The actual probing + comparison
/// is glue code in `psysonic-library` (PR-3 territory); this crate
/// just ships the deterministic sampling primitive so both sides use
/// the same selection logic.
pub fn fingerprint_sample(track_ids: &[String], every_n: usize) -> Vec<&String> {
    if every_n == 0 {
        return Vec::new();
    }
    track_ids
        .iter()
        .enumerate()
        .filter(|(i, _)| i % every_n == 0)
        .map(|(_, id)| id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method as wm_method, path as wm_path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ── parse_envelope unit tests (no HTTP) ────────────────────────────────

    #[test]
    fn parse_envelope_extracts_body_on_ok_status() {
        let body = json!({
            "subsonic-response": {
                "status": "ok",
                "version": "1.16.1",
                "scanStatus": {
                    "scanning": false,
                    "count": 42
                }
            }
        })
        .to_string();
        let s: ScanStatus = parse_envelope(&body, "scanStatus").unwrap();
        assert_eq!(s.count, Some(42));
    }

    #[test]
    fn parse_envelope_maps_code_70_to_not_found() {
        let body = json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 70, "message": "Song not found" }
            }
        })
        .to_string();
        let err = parse_envelope::<Song>(&body, "song").unwrap_err();
        assert!(matches!(err, SubsonicError::NotFound));
    }

    #[test]
    fn parse_envelope_surfaces_other_error_codes_as_api_variant() {
        let body = json!({
            "subsonic-response": {
                "status": "failed",
                "error": { "code": 40, "message": "Wrong username or password" }
            }
        })
        .to_string();
        let err = parse_envelope::<Song>(&body, "song").unwrap_err();
        match err {
            SubsonicError::Api { code, message } => {
                assert_eq!(code, 40);
                assert!(message.contains("Wrong"));
            }
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[test]
    fn parse_envelope_rejects_missing_body_key() {
        let body = json!({
            "subsonic-response": { "status": "ok" }
        })
        .to_string();
        let err = parse_envelope::<Song>(&body, "song").unwrap_err();
        assert!(matches!(err, SubsonicError::Decode(_)));
    }

    #[test]
    fn parse_envelope_status_only_accepts_empty_ok() {
        let body = json!({ "subsonic-response": { "status": "ok", "version": "1.16.1" } }).to_string();
        parse_envelope_status_only(&body).unwrap();
    }

    // ── fingerprint_sample ────────────────────────────────────────────────

    #[test]
    fn fingerprint_sample_picks_every_nth_id() {
        let ids: Vec<String> = (0..10).map(|i| format!("tr_{i}")).collect();
        let sample = fingerprint_sample(&ids, 4);
        assert_eq!(
            sample.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
            vec!["tr_0", "tr_4", "tr_8"]
        );
    }

    #[test]
    fn fingerprint_sample_is_deterministic_across_runs() {
        let ids: Vec<String> = (0..500).map(|i| format!("tr_{i:04}")).collect();
        let a = fingerprint_sample(&ids, 100);
        let b = fingerprint_sample(&ids, 100);
        assert_eq!(a, b);
        assert_eq!(a.len(), 5, "500/100 = 5 samples");
    }

    #[test]
    fn fingerprint_sample_zero_n_is_empty() {
        let ids: Vec<String> = vec!["a".into(), "b".into()];
        assert!(fingerprint_sample(&ids, 0).is_empty());
    }

    // ── SubsonicClient wiremock end-to-end ────────────────────────────────

    fn test_credentials() -> SubsonicCredentials {
        SubsonicCredentials::with_static("user", "deadbeef", "saltsalt")
    }

    fn test_client(uri: &str) -> SubsonicClient {
        SubsonicClient::new(uri, test_credentials())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ping_sends_auth_params_and_returns_ok() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .and(query_param("u", "user"))
            .and(query_param("t", "deadbeef"))
            .and(query_param("s", "saltsalt"))
            .and(query_param("v", SUBSONIC_API_VERSION))
            .and(query_param("c", SUBSONIC_CLIENT_ID))
            .and(query_param("f", "json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "version": "1.16.1" }
            })))
            .mount(&server)
            .await;

        test_client(&server.uri()).ping().await.expect("ping must succeed");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ping_surfaces_wrong_credentials_as_code_40() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 40, "message": "Wrong username or password" }
                }
            })))
            .mount(&server)
            .await;

        let err = test_client(&server.uri()).ping().await.unwrap_err();
        assert!(matches!(err, SubsonicError::Api { code: 40, .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_song_returns_typed_song() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .and(query_param("id", "tr_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "song": {
                        "id": "tr_1",
                        "title": "Aurora",
                        "artist": "Anna",
                        "albumId": "al_1",
                        "duration": 240,
                        "track": 3
                    }
                }
            })))
            .mount(&server)
            .await;

        let song = test_client(&server.uri()).get_song("tr_1").await.unwrap();
        assert_eq!(song.title, "Aurora");
        assert_eq!(song.album_id.as_deref(), Some("al_1"));
        assert_eq!(song.track_number, Some(3));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_song_maps_error_70_to_not_found() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "failed",
                    "error": { "code": 70, "message": "Song not found" }
                }
            })))
            .mount(&server)
            .await;

        let err = test_client(&server.uri()).get_song("missing").await.unwrap_err();
        assert!(matches!(err, SubsonicError::NotFound));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_scan_status_parses_typed_struct() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getScanStatus.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "scanStatus": {
                        "scanning": true,
                        "count": 9001,
                        "folderCount": 12
                    }
                }
            })))
            .mount(&server)
            .await;

        let s = test_client(&server.uri()).get_scan_status().await.unwrap();
        assert!(s.scanning);
        assert_eq!(s.count, Some(9001));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_indexes_forwards_optional_if_modified_since() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getIndexes.view"))
            .and(query_param("ifModifiedSince", "1716840000000"))
            .and(query_param("musicFolderId", "lib-1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "indexes": {
                        "lastModified": 1716840000000_i64,
                        "ignoredArticles": "The",
                        "index": []
                    }
                }
            })))
            .mount(&server)
            .await;

        let ix = test_client(&server.uri())
            .get_indexes(Some("lib-1"), Some(1_716_840_000_000))
            .await
            .unwrap();
        assert_eq!(ix.last_modified_ms, Some(1_716_840_000_000));
        assert!(ix.index.is_empty(), "empty body when nothing changed");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_artists_omits_music_folder_when_none() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getArtists.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "artists": {
                        "lastModified": 1716840000000_i64,
                        "ignoredArticles": "",
                        "index": [
                            { "name": "A", "artist": [
                                { "id": "ar_1", "name": "Anna" }
                            ]}
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let ix = test_client(&server.uri()).get_artists(None).await.unwrap();
        assert_eq!(ix.index.len(), 1);
        assert_eq!(ix.index[0].artist[0].name, "Anna");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_album_list2_unwraps_album_array() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbumList2.view"))
            .and(query_param("type", "alphabeticalByName"))
            .and(query_param("size", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "albumList2": {
                        "album": [
                            { "id": "al_1", "name": "First" },
                            { "id": "al_2", "name": "Second" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let albums = test_client(&server.uri())
            .get_album_list2("alphabeticalByName", 500, 0, None)
            .await
            .unwrap();
        assert_eq!(albums.len(), 2);
        assert_eq!(albums[1].id, "al_2");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_album_includes_song_list() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .and(query_param("id", "al_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "album": {
                        "id": "al_1",
                        "name": "Test Album",
                        "songCount": 2,
                        "song": [
                            { "id": "tr_1", "title": "One",  "track": 1 },
                            { "id": "tr_2", "title": "Two",  "track": 2 }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let album = test_client(&server.uri()).get_album("al_1").await.unwrap();
        assert_eq!(album.song.len(), 2);
        assert_eq!(album.song[0].title, "One");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search3_handles_empty_query_navidrome_quirk() {
        // Spec §2.4: Navidrome accepts empty query → returns all songs paged.
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .and(query_param("query", ""))
            .and(query_param("songCount", "100"))
            .and(query_param("songOffset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "searchResult3": {
                        "song": [
                            { "id": "tr_1", "title": "One" },
                            { "id": "tr_2", "title": "Two" }
                        ]
                    }
                }
            })))
            .mount(&server)
            .await;

        let sr = test_client(&server.uri()).search3("", 100, 0, None).await.unwrap();
        assert_eq!(sr.song.len(), 2);
        assert!(sr.artist.is_empty());
        assert!(sr.album.is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn base_url_trailing_slash_does_not_double_up() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok" }
            })))
            .mount(&server)
            .await;

        // Append a trailing slash + and additional slashes — the constructor
        // strips them so the request path stays `/rest/ping.view`, not
        // `//rest/ping.view`.
        let url = format!("{}///", server.uri());
        SubsonicClient::new(url, test_credentials())
            .ping()
            .await
            .expect("ping with trailing slashes must reach the same endpoint");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn http_500_returns_http_status_error_without_decode() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let err = test_client(&server.uri()).ping().await.unwrap_err();
        match err {
            SubsonicError::HttpStatus(s) => assert_eq!(s.as_u16(), 500),
            other => panic!("expected HttpStatus, got {other:?}"),
        }
    }
}

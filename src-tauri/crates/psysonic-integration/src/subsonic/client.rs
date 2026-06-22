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
use super::types::{Album, AlbumSummary, ArtistIndex, ScanStatus, SearchResult, ServerInfo, Song};
use psysonic_core::server_http::{apply_server_headers, ServerHttpContext};

/// Protocol level we advertise — pre-OpenSubsonic Subsonic baseline that
/// Navidrome and other servers in the wild support. OpenSubsonic
/// extensions deserialize when present (additive on the wire).
pub const SUBSONIC_API_VERSION: &str = "1.16.1";

/// Subsonic `c` parameter — server logs and rate-limiters key off this.
/// Matches the frontend `subsonicClient.ts` shape (`psysonic/<version>`)
/// so Navidrome log lines correlate across the WebView and Rust sync
/// paths.
pub const SUBSONIC_CLIENT_ID: &str = concat!("psysonic/", env!("CARGO_PKG_VERSION"));

#[derive(Clone)]
enum CredentialsMode {
    /// Production path: cache the plaintext password and derive a fresh
    /// `(token = md5(password || salt), salt)` per request. Matches the
    /// frontend's `getAuthParams()` lifecycle and follows Subsonic
    /// replay-resistance guidance.
    FromPassword { username: String, password: String },
    /// Test path: re-use a pre-derived credentials triple as-is. Used by
    /// wiremock tests (deterministic query params) and by callers that
    /// already maintain a cached token+salt.
    Static(SubsonicCredentials),
}

#[derive(Clone)]
pub struct SubsonicClient {
    base_url: String,
    credentials: CredentialsMode,
    http: reqwest::Client,
    http_context: Option<ServerHttpContext>,
}

impl SubsonicClient {
    /// Production constructor — caches the password and derives a fresh
    /// salt + token on every API call.
    pub fn new(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self::with_http(base_url, username, password, default_http_client())
    }

    /// As `new`, but with a caller-supplied `reqwest::Client` — used by
    /// callers that share a pool across multiple Subsonic servers or
    /// need custom timeouts.
    pub fn with_http(
        base_url: impl Into<String>,
        username: impl Into<String>,
        password: impl Into<String>,
        http: reqwest::Client,
    ) -> Self {
        let mut url = base_url.into();
        while url.ends_with('/') {
            url.pop();
        }
        Self {
            base_url: url,
            credentials: CredentialsMode::FromPassword {
                username: username.into(),
                password: password.into(),
            },
            http,
            http_context: None,
        }
    }

    pub fn with_http_context(mut self, ctx: ServerHttpContext) -> Self {
        self.http_context = Some(ctx);
        self
    }

    /// Production helper — attach registry context when present for `server_ref`
    /// (app server id or index key).
    pub fn with_registry(
        self,
        registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
        server_ref: &str,
    ) -> Self {
        registry
            .and_then(|r| r.get_for_server_ref(server_ref))
            .map(|ctx| self.clone().with_http_context((*ctx).clone()))
            .unwrap_or(self)
    }

    /// Test-/cache-friendly constructor — re-uses the same
    /// `SubsonicCredentials` triple on every call. Wiremock tests rely on
    /// this for deterministic `s=` and `t=` query params; production code
    /// goes through `new` / `with_http`.
    pub fn with_static_credentials(
        base_url: impl Into<String>,
        credentials: SubsonicCredentials,
        http: reqwest::Client,
    ) -> Self {
        let mut url = base_url.into();
        while url.ends_with('/') {
            url.pop();
        }
        Self {
            base_url: url,
            credentials: CredentialsMode::Static(credentials),
            http,
            http_context: None,
        }
    }

    pub(crate) fn build_credentials(&self) -> SubsonicCredentials {
        match &self.credentials {
            CredentialsMode::FromPassword { username, password } => {
                SubsonicCredentials::from_password(username, password)
            }
            CredentialsMode::Static(c) => c.clone(),
        }
    }

    /// B1 — ping. Returns `Ok(())` when the server replied with
    /// `status="ok"`; surfaces `SubsonicError::Api{40,…}` for invalid
    /// credentials and the usual transport / status errors otherwise.
    pub async fn ping(&self) -> Result<(), SubsonicError> {
        let body = self.send("ping", &[]).await?;
        parse_envelope_status_only(&body)
    }

    /// C1 helper — `#ping` with the envelope metadata captured. Used by
    /// the capability probe to detect server type (`navidrome` →
    /// `UnstableTrackIds`) and OpenSubsonic support without issuing a
    /// second request.
    pub async fn server_info(&self) -> Result<ServerInfo, SubsonicError> {
        let body = self.send("ping", &[]).await?;
        parse_server_info(&body)
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

    /// Variant of `search3` returning the raw `serde_json::Value` for
    /// the `searchResult3` body alongside the typed projection. The S1
    /// ingest path (PR-3b InitialSyncRunner) needs the per-song raw
    /// sub-trees verbatim for `track.raw_json`, so unknown OpenSubsonic
    /// extensions (`replayGain`, `contributors`, …) survive ingest
    /// instead of being lost in the typed reserialise (ADR-7).
    pub async fn search3_with_raw(
        &self,
        query: &str,
        song_count: u32,
        song_offset: u32,
        music_folder_id: Option<&str>,
    ) -> Result<(SearchResult, serde_json::Value), SubsonicError> {
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
        let body = self.send("search3", &params).await?;
        parse_envelope_with_raw(&body, "searchResult3")
    }

    /// B6 — `getSong(id)`. Returns `SubsonicError::NotFound` when the
    /// server replies with error code 70 (spec §2.6) — the tombstone
    /// reconciler matches on that variant directly.
    pub async fn get_song(&self, song_id: &str) -> Result<Song, SubsonicError> {
        self.fetch("getSong", &[("id", song_id)], "song").await
    }

    /// Variant of `get_song` that also returns the raw `serde_json::Value`
    /// the server sent for the `song` body. The sync engine (PR-3) stores
    /// that raw object verbatim in `track.raw_json` so OpenSubsonic
    /// extensions (`contributors`, `replayGain`, future fields) survive
    /// without being mirrored into the typed `Song` struct.
    pub async fn get_song_with_raw(
        &self,
        song_id: &str,
    ) -> Result<(Song, serde_json::Value), SubsonicError> {
        let body = self.send("getSong", &[("id", song_id)]).await?;
        parse_envelope_with_raw(&body, "song")
    }

    /// Variant of `get_album` returning the raw `serde_json::Value` for
    /// the `album` body alongside the typed projection. The album JSON
    /// already nests the full song list, so the sync engine can derive
    /// per-track `raw_json` cells (each entry in `album.song`) without
    /// issuing follow-up `get_song` calls.
    pub async fn get_album_with_raw(
        &self,
        album_id: &str,
    ) -> Result<(Album, serde_json::Value), SubsonicError> {
        let body = self.send("getAlbum", &[("id", album_id)]).await?;
        parse_envelope_with_raw(&body, "album")
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
        let creds = self.build_credentials();
        let auth = [
            ("u", creds.username.as_str()),
            ("t", creds.token.as_str()),
            ("s", creds.salt.as_str()),
            ("v", SUBSONIC_API_VERSION),
            ("c", SUBSONIC_CLIENT_ID),
            ("f", "json"),
        ];
        let mut query: Vec<(&str, &str)> = auth.to_vec();
        query.extend_from_slice(extra);

        let mut req = self
            .http
            .get(format!("{}/rest/{method}.view", self.base_url))
            .query(&query);
        if let Some(ctx) = &self.http_context {
            req = apply_server_headers(req, ctx, &self.base_url);
        }

        let resp = req
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

pub fn subsonic_client_with_registry(
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    server_ref: &str,
    base_url: impl Into<String>,
    username: impl Into<String>,
    password: impl Into<String>,
) -> SubsonicClient {
    SubsonicClient::new(base_url, username, password).with_registry(registry, server_ref)
}

/// Validate the Subsonic envelope and return the raw `serde_json::Value`
/// at `body_key`. Maps `error.code = 70` to the dedicated `NotFound`
/// variant; surfaces every other failed status as `Api { code, message }`.
/// Callers either deserialize the value into a typed struct
/// (`parse_envelope`) or keep both alongside (`parse_envelope_with_raw`).
fn parse_envelope_body(body: &str, body_key: &str) -> Result<serde_json::Value, SubsonicError> {
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

    response
        .get(body_key)
        .cloned()
        .ok_or_else(|| SubsonicError::Decode(format!("missing body key `{body_key}`")))
}

/// Validate the envelope, then deserialize the body into `T`.
fn parse_envelope<T: DeserializeOwned>(body: &str, body_key: &str) -> Result<T, SubsonicError> {
    let body_val = parse_envelope_body(body, body_key)?;
    serde_json::from_value(body_val)
        .map_err(|e| SubsonicError::Decode(format!("body `{body_key}`: {e}")))
}

/// Validate the envelope, then return both the typed projection and the
/// raw `serde_json::Value` body sub-tree. PR-3 sync code uses this to
/// keep `track.raw_json` intact while still operating on a typed `Song`
/// at the call site.
fn parse_envelope_with_raw<T: DeserializeOwned>(
    body: &str,
    body_key: &str,
) -> Result<(T, serde_json::Value), SubsonicError> {
    let body_val = parse_envelope_body(body, body_key)?;
    let typed = serde_json::from_value(body_val.clone())
        .map_err(|e| SubsonicError::Decode(format!("body `{body_key}`: {e}")))?;
    Ok((typed, body_val))
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

/// Inspect the `subsonic-response` envelope itself for server metadata.
/// Used by `server_info()` and by the capability probe.
fn parse_server_info(body: &str) -> Result<ServerInfo, SubsonicError> {
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

    Ok(ServerInfo {
        server_type: response.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
        server_version: response
            .get("serverVersion")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        api_version: response.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()),
        open_subsonic: response.get("openSubsonic").and_then(|v| v.as_bool()).unwrap_or(false),
    })
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
        SubsonicClient::with_static_credentials(uri, test_credentials(), reqwest::Client::new())
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

        // Append a trailing slash + additional slashes — the constructor
        // strips them so the request path stays `/rest/ping.view`, not
        // `//rest/ping.view`.
        let url = format!("{}///", server.uri());
        SubsonicClient::with_static_credentials(url, test_credentials(), reqwest::Client::new())
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

    // ── PR-2b: fresh-credentials-per-request lifecycle ────────────────────

    #[test]
    fn from_password_client_derives_fresh_credentials_per_request() {
        let client = SubsonicClient::new("http://test", "user", "pw");
        let a = client.build_credentials();
        let b = client.build_credentials();
        assert_ne!(a.salt, b.salt, "from_password mode must refresh salt");
        assert_ne!(a.token, b.token, "different salt → different token");
        assert_eq!(a.username, b.username);
    }

    #[test]
    fn static_credentials_client_returns_same_triple_each_call() {
        let creds = SubsonicCredentials::with_static("u", "tok", "salt");
        let client = SubsonicClient::with_static_credentials(
            "http://test",
            creds,
            reqwest::Client::new(),
        );
        let a = client.build_credentials();
        let b = client.build_credentials();
        assert_eq!(a.token, b.token);
        assert_eq!(a.salt, b.salt);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn from_password_client_sends_unique_salt_per_request_over_the_wire() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok" }
            })))
            .mount(&server)
            .await;

        let client = SubsonicClient::new(server.uri(), "user", "pw");
        client.ping().await.unwrap();
        client.ping().await.unwrap();

        let received = server.received_requests().await.expect("requests captured");
        assert_eq!(received.len(), 2);
        let salt = |r: &wiremock::Request| {
            r.url
                .query_pairs()
                .find(|(k, _)| k == "s")
                .map(|(_, v)| v.into_owned())
                .expect("`s` param present")
        };
        let token = |r: &wiremock::Request| {
            r.url
                .query_pairs()
                .find(|(k, _)| k == "t")
                .map(|(_, v)| v.into_owned())
                .expect("`t` param present")
        };
        assert_ne!(salt(&received[0]), salt(&received[1]));
        assert_ne!(token(&received[0]), token(&received[1]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn client_id_query_param_carries_crate_version() {
        // PR-2b note 2: align `c` with the frontend (`psysonic/<version>`).
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok" }
            })))
            .mount(&server)
            .await;
        test_client(&server.uri()).ping().await.unwrap();

        let received = server.received_requests().await.expect("requests captured");
        let c = received[0]
            .url
            .query_pairs()
            .find(|(k, _)| k == "c")
            .map(|(_, v)| v.into_owned())
            .expect("`c` param present");
        assert!(c.starts_with("psysonic/"), "got `{c}`");
        assert_eq!(c, SUBSONIC_CLIENT_ID);
    }

    // ── PR-2b: raw_json capture for ingest (PR-3 prep) ────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn get_song_with_raw_returns_typed_and_raw_subtree() {
        let server = MockServer::start().await;
        let song = json!({
            "id": "tr_1",
            "title": "Title",
            "artist": "Artist",
            "musicBrainzId": "abc-123",
            "replayGain": { "trackGain": -1.2, "albumGain": -0.8 },
            "contributors": [
                { "role": "producer", "artistId": "ar_9", "name": "Prod" }
            ]
        });
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getSong.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "song": song.clone() }
            })))
            .mount(&server)
            .await;

        let (typed, raw) = test_client(&server.uri())
            .get_song_with_raw("tr_1")
            .await
            .unwrap();
        assert_eq!(typed.id, "tr_1");
        assert_eq!(typed.title, "Title");
        // Typed struct picks up the new musicBrainzId alias.
        assert_eq!(typed.mbid_recording.as_deref(), Some("abc-123"));

        // Raw value preserves OpenSubsonic extensions the typed struct
        // doesn't mirror — exactly what `track.raw_json` needs.
        assert_eq!(raw.get("replayGain"), song.get("replayGain"));
        assert_eq!(raw.get("contributors"), song.get("contributors"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search3_with_raw_keeps_song_extensions_in_raw_tree() {
        let server = MockServer::start().await;
        let result_body = json!({
            "song": [
                { "id": "tr_1", "title": "One",  "replayGain": { "trackGain": -1.5 } },
                { "id": "tr_2", "title": "Two", "contributors": [{ "role": "producer" }] }
            ]
        });
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "searchResult3": result_body.clone() }
            })))
            .mount(&server)
            .await;

        let (typed, raw) = test_client(&server.uri())
            .search3_with_raw("", 100, 0, None)
            .await
            .unwrap();
        assert_eq!(typed.song.len(), 2);

        // Raw value preserves the typed-struct-incompatible fields.
        let raw_songs = raw.get("song").and_then(|v| v.as_array()).expect("song array");
        assert_eq!(raw_songs.len(), 2);
        assert_eq!(
            raw_songs[0].get("replayGain"),
            result_body.get("song").unwrap().as_array().unwrap()[0].get("replayGain")
        );
        assert_eq!(
            raw_songs[1].get("contributors"),
            result_body.get("song").unwrap().as_array().unwrap()[1].get("contributors")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search3_with_raw_empty_envelope_maps_to_empty_search_result() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/search3.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "searchResult3": {} }
            })))
            .mount(&server)
            .await;
        let (typed, raw) = test_client(&server.uri())
            .search3_with_raw("", 50, 0, None)
            .await
            .unwrap();
        assert!(typed.song.is_empty());
        assert!(typed.album.is_empty());
        // Empty `searchResult3: {}` survives as an empty Object in raw,
        // not Null — runner relies on this for the `get("song")` path.
        assert!(raw.is_object());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_album_with_raw_keeps_song_extensions_in_raw_tree() {
        let server = MockServer::start().await;
        let album = json!({
            "id": "al_1",
            "name": "Album",
            "song": [
                { "id": "tr_1", "title": "One", "track": 1, "musicBrainzId": "mb-1" },
                { "id": "tr_2", "title": "Two", "track": 2, "replayGain": { "trackGain": -3.0 } }
            ]
        });
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/getAlbum.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "album": album.clone() }
            })))
            .mount(&server)
            .await;

        let (typed, raw) = test_client(&server.uri())
            .get_album_with_raw("al_1")
            .await
            .unwrap();
        assert_eq!(typed.song.len(), 2);
        assert_eq!(typed.song[0].mbid_recording.as_deref(), Some("mb-1"));

        // Per-track raw entries survive in `raw.song[i]`.
        let raw_songs = raw.get("song").and_then(|v| v.as_array()).expect("song array");
        assert_eq!(raw_songs.len(), 2);
        assert_eq!(
            raw_songs[1].get("replayGain"),
            album.get("song").unwrap().as_array().unwrap()[1].get("replayGain")
        );
    }

    // ── server_info / parse_server_info ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread")]
    async fn server_info_extracts_navidrome_envelope_metadata() {
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": {
                    "status": "ok",
                    "version": "1.16.1",
                    "type": "navidrome",
                    "serverVersion": "0.55.2",
                    "openSubsonic": true
                }
            })))
            .mount(&server)
            .await;

        let info = test_client(&server.uri()).server_info().await.unwrap();
        assert_eq!(info.server_type.as_deref(), Some("navidrome"));
        assert_eq!(info.server_version.as_deref(), Some("0.55.2"));
        assert_eq!(info.api_version.as_deref(), Some("1.16.1"));
        assert!(info.open_subsonic);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn server_info_falls_back_to_defaults_for_minimal_envelope() {
        // Older Subsonic servers may omit type / serverVersion / openSubsonic.
        let server = MockServer::start().await;
        Mock::given(wm_method("GET"))
            .and(wm_path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "subsonic-response": { "status": "ok", "version": "1.16.1" }
            })))
            .mount(&server)
            .await;

        let info = test_client(&server.uri()).server_info().await.unwrap();
        assert!(info.server_type.is_none());
        assert!(info.server_version.is_none());
        assert!(!info.open_subsonic);
        assert_eq!(info.api_version.as_deref(), Some("1.16.1"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn server_info_surfaces_wrong_credentials_as_code_40() {
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

        let err = test_client(&server.uri()).server_info().await.unwrap_err();
        assert!(matches!(err, SubsonicError::Api { code: 40, .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_song_with_raw_maps_error_70_to_not_found_like_get_song() {
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

        let err = test_client(&server.uri())
            .get_song_with_raw("missing")
            .await
            .unwrap_err();
        assert!(matches!(err, SubsonicError::NotFound));
    }
}

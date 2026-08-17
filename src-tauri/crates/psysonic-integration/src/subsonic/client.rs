//! `SubsonicClient` — read-only Subsonic REST surface needed by the
//! library-sync engine (phase B per spec §10 / PR-2). Auth is the legacy
//! salted-md5 token (spec v1.13+); request shape is GET to
//! `{base}/rest/{method}.view?u&t&s&v&c&f=json&…`.
//!
//! This client is pure Rust — **no `#[tauri::command]`**. Tauri commands
//! that talk to the library live in PR-5 / phase D.

use serde::de::DeserializeOwned;
use serde::Deserialize;

mod envelope;

use super::auth::SubsonicCredentials;
use super::error::{flatten_reqwest_error, SubsonicError};
use super::types::{
    Album, AlbumSummary, ArtistIndex, MusicFolder, ScanStatus, SearchResult, ServerInfo, Song,
};
use envelope::{
    parse_envelope, parse_envelope_status_only, parse_envelope_with_raw, parse_server_info,
};
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

    /// B2 — `getMusicFolders()`. Returns the server's music libraries /
    /// folders. Used by the library-tagging pass to scope `getAlbumList2`
    /// without re-ingesting tracks.
    pub async fn get_music_folders(&self) -> Result<Vec<MusicFolder>, SubsonicError> {
        let wrapped: MusicFoldersWrapper =
            self.fetch("getMusicFolders", &[], "musicFolders").await?;
        Ok(wrapped.music_folder)
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
        let wrapped: AlbumListWrapper = self.fetch("getAlbumList2", &params, "albumList2").await?;
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

    /// Raw WebView-transport bridge: the caller (TypeScript) has already built
    /// the *full* query — auth params (`u`/`t`/`s`/`v`/`c`/`f`) plus the
    /// endpoint's own args — so this only attaches gate headers + UA and hands
    /// the untouched response body back for the frontend to parse. It lets
    /// gated servers (Cloudflare Access, Pangolin, …) reach every Subsonic
    /// endpoint the WebView would otherwise call over `axios`, where a
    /// non-safelisted header trips a CORS preflight the gate rejects.
    ///
    /// `endpoint` is the REST path segment *including* `.view`
    /// (e.g. `getAlbumList2.view`). `post_form` sends the params as an
    /// `application/x-www-form-urlencoded` body (OpenSubsonic `formPost`, for
    /// large multi-`id` calls) instead of a query string.
    pub async fn send_raw(
        &self,
        endpoint: &str,
        params: &[(String, String)],
        post_form: bool,
    ) -> Result<String, SubsonicError> {
        let url = format!("{}/rest/{endpoint}", self.base_url);
        let mut req = if post_form {
            self.http.post(&url).form(params)
        } else {
            self.http.get(&url).query(params)
        };
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

#[derive(Deserialize)]
struct MusicFoldersWrapper {
    #[serde(
        rename = "musicFolder",
        default,
        deserialize_with = "crate::subsonic::types::de_music_folder_one_or_many"
    )]
    music_folder: Vec<MusicFolder>,
}

fn default_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        // Shared wire UA (aligned with the main WebView at startup) so native
        // Subsonic calls share the WebView's client identity on the server
        // instead of registering a separate `[Psysonic]` session.
        .user_agent(psysonic_core::user_agent::subsonic_wire_user_agent())
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
mod credentials_tests;
#[cfg(test)]
mod envelope_tests;
#[cfg(test)]
mod raw_tests;
#[cfg(test)]
mod server_info_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod wire_tests;

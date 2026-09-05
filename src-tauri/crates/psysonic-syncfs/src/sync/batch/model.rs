use crate::file_transfer::apply_server_http_get;
use crate::sync::device::TrackSyncInfo;

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubsonicAuthPayload {
    pub(super) base_url: String,
    pub(super) u: String,
    pub(super) t: String,
    pub(super) s: String,
    pub(super) v: String,
    pub(super) c: String,
    pub(super) f: String,
    pub(super) server_id: String,
    pub(super) server_index_key: String,
}

#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncSourcePayload {
    #[serde(rename = "type")]
    pub(super) source_type: String,
    pub(super) id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) path_id: Option<String>,
    pub(super) server_index_key: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceSyncLayoutMode {
    #[default]
    SelfContained,
    SharedAlbumTree,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceSyncPlaylistPathMode {
    #[default]
    PlaylistRelative,
    DeviceRooted,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncPlannedPlaylist {
    pub source_key: String,
    pub name: String,
    pub path_id: Option<String>,
    pub relative_path: String,
    pub tracks: Vec<serde_json::Value>,
    pub references: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncManifestFile {
    pub track_id: String,
    pub relative_path: String,
    pub source_keys: Vec<String>,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSyncManifestPlaylist {
    pub source_key: String,
    pub relative_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeltaResult {
    pub(crate) plan_id: String,
    pub(crate) device_id: String,
    pub(crate) add_bytes: u64,
    pub(crate) add_count: u32,
    pub(crate) del_bytes: u64,
    pub(crate) del_count: u32,
    pub(crate) reclaimable_bytes: u64,
    pub(crate) available_bytes: u64,
    pub(crate) tracks: Vec<serde_json::Value>,
    pub(crate) delete_paths: Vec<String>,
    pub(crate) deferred_delete_paths: Vec<String>,
    pub(crate) playlists: Vec<DeviceSyncPlannedPlaylist>,
    pub(crate) manifest_files: Vec<DeviceSyncManifestFile>,
    pub(crate) manifest_playlists: Vec<DeviceSyncManifestPlaylist>,
}

pub async fn fetch_subsonic_songs(
    client: &reqwest::Client,
    registry: Option<&psysonic_core::server_http::ServerHttpRegistry>,
    auth: &SubsonicAuthPayload,
    endpoint: &str,
    id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{}/{}", auth.base_url, endpoint);
    let query = vec![
        ("u", auth.u.as_str()),
        ("t", auth.t.as_str()),
        ("s", auth.s.as_str()),
        ("v", auth.v.as_str()),
        ("c", auth.c.as_str()),
        ("f", auth.f.as_str()),
        ("id", id),
    ];
    let res = apply_server_http_get(client, registry, Some(&auth.server_id), &url)
        .query(&query)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let json: serde_json::Value = res.json().await.map_err(|error| error.to_string())?;
    parse_subsonic_songs(&json, endpoint)
}

pub(crate) fn estimate_track_size_bytes(track: &serde_json::Value) -> u64 {
    track
        .get("size")
        .and_then(|size| size.as_u64())
        .unwrap_or_else(|| {
            track
                .get("duration")
                .and_then(|duration| duration.as_u64())
                .unwrap_or(0)
                * 320_000
                / 8
        })
}

pub(crate) fn track_sync_info_from_subsonic_json(
    track: &serde_json::Value,
    track_id: &str,
    playlist_name: Option<&str>,
    playlist_id: Option<&str>,
    playlist_index: Option<u32>,
) -> TrackSyncInfo {
    let suffix = track
        .get("suffix")
        .and_then(|value| value.as_str())
        .unwrap_or("mp3");
    let artist_raw = track
        .get("artist")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let album_artist = track
        .get("albumArtist")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(artist_raw);
    TrackSyncInfo {
        id: track_id.to_string(),
        url: String::new(),
        suffix: suffix.to_string(),
        artist: artist_raw.to_string(),
        album_artist: album_artist.to_string(),
        album: track
            .get("album")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        title: track
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        track_number: track
            .get("track")
            .and_then(|value| value.as_u64())
            .map(|number| number as u32),
        duration: track
            .get("duration")
            .and_then(|value| value.as_u64())
            .map(|number| number as u32),
        playlist_name: playlist_name.map(str::to_string),
        playlist_id: playlist_id.map(str::to_string),
        playlist_index,
    }
}

pub(crate) fn inject_playlist_context(
    track: &mut serde_json::Value,
    playlist_name: Option<&str>,
    playlist_id: Option<&str>,
    playlist_index: Option<u32>,
) {
    if let Some(object) = track.as_object_mut() {
        if let Some(name) = playlist_name {
            object.insert(
                "_playlistName".to_string(),
                serde_json::Value::String(name.to_string()),
            );
        }
        if let Some(id) = playlist_id {
            object.insert(
                "_playlistId".to_string(),
                serde_json::Value::String(id.to_string()),
            );
        }
        if let Some(index) = playlist_index {
            object.insert(
                "_playlistIndex".to_string(),
                serde_json::Value::Number(index.into()),
            );
        }
    }
}

pub(crate) fn subsonic_response_root(
    json: &serde_json::Value,
) -> Result<&serde_json::Value, String> {
    let root = json
        .get("subsonic-response")
        .ok_or_else(|| "No subsonic-response".to_string())?;
    if root.get("status").and_then(|value| value.as_str()) == Some("failed") {
        let message = root
            .get("error")
            .and_then(|value| value.get("message"))
            .and_then(|value| value.as_str())
            .unwrap_or("Subsonic request failed");
        return Err(message.to_string());
    }
    Ok(root)
}

pub fn parse_subsonic_songs(
    json: &serde_json::Value,
    endpoint: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let root = subsonic_response_root(json)?;
    let songs = if endpoint == "getAlbum.view" {
        root.get("album").and_then(|album| album.get("song"))
    } else if endpoint == "getPlaylist.view" {
        root.get("playlist")
            .and_then(|playlist| playlist.get("entry"))
    } else {
        None
    };

    if let Some(array) = songs.and_then(|value| value.as_array()) {
        return Ok(array.clone());
    }
    if let Some(object) = songs.and_then(|value| value.as_object()) {
        return Ok(vec![serde_json::Value::Object(object.clone())]);
    }
    Ok(vec![])
}

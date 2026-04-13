// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod discord;
#[cfg(target_os = "windows")]
mod taskbar_win;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::Ordering;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// Tracks which user-configured shortcuts are currently registered (shortcut_str → action).
/// Prevents on_shortcut() accumulating duplicate handlers across JS reloads (HMR / StrictMode).
type ShortcutMap = Mutex<HashMap<String, String>>;

/// Maximum number of offline track downloads that can run concurrently.
/// The frontend queues more tasks than this; Rust is the real throttle.
const MAX_DL_CONCURRENCY: usize = 4;

/// Shared semaphore that caps simultaneous `download_track_offline` executions.
type DownloadSemaphore = Arc<tokio::sync::Semaphore>;

/// Holds the live system-tray icon handle.  `None` means the tray is currently hidden/removed.
/// Dropping the inner `TrayIcon` fully removes it from the OS notification area on all platforms.
type TrayState = Mutex<Option<TrayIcon>>;

/// Shared handle to OS media controls (MPRIS2 on Linux, Now Playing on macOS, SMTC on Windows).
/// `None` if souvlaki failed to initialize (e.g. no D-Bus session on Linux).
type MprisControls = Mutex<Option<souvlaki::MediaControls>>;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

#[tauri::command]
fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

/// Toggle native window decorations at runtime (Linux custom title bar opt-out).
#[tauri::command]
fn set_window_decorations(enabled: bool, app_handle: tauri::AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.set_decorations(enabled);
        // Re-enabling native decorations on GTK causes the window manager to
        // re-stack the window, which drops focus. Bring it back immediately.
        if enabled {
            let _ = win.set_focus();
        }
    }
}


/// Authenticate with Navidrome's own REST API and return a Bearer token.
async fn navidrome_token(server_url: &str, username: &str, password: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/auth/login", server_url))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    data["token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Navidrome auth: no token in response".to_string())
}

#[tauri::command]
async fn upload_playlist_cover(
    server_url: String,
    playlist_id: String,
    username: String,
    password: String,
    file_bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), String> {
    let token = navidrome_token(&server_url, &username, &password).await?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("cover.jpg")
        .mime_str(&mime_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("image", part);
    reqwest::Client::new()
        .post(format!("{}/api/playlist/{}/image", server_url, playlist_id))
        .header("X-ND-Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn upload_radio_cover(
    server_url: String,
    radio_id: String,
    username: String,
    password: String,
    file_bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), String> {
    let token = navidrome_token(&server_url, &username, &password).await?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("cover.jpg")
        .mime_str(&mime_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("image", part);
    reqwest::Client::new()
        .post(format!("{}/api/radio/{}/image", server_url, radio_id))
        .header("X-ND-Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn upload_artist_image(
    server_url: String,
    artist_id: String,
    username: String,
    password: String,
    file_bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), String> {
    let token = navidrome_token(&server_url, &username, &password).await?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("cover.jpg")
        .mime_str(&mime_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("image", part);
    reqwest::Client::new()
        .post(format!("{}/api/artist/{}/image", server_url, artist_id))
        .header("X-ND-Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn delete_radio_cover(
    server_url: String,
    radio_id: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let token = navidrome_token(&server_url, &username, &password).await?;
    let resp = reqwest::Client::new()
        .delete(format!("{}/api/radio/{}/image", server_url, radio_id))
        .header("X-ND-Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    // 404/503 = no image existed — treat as success
    if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND && resp.status() != reqwest::StatusCode::SERVICE_UNAVAILABLE {
        resp.error_for_status().map_err(|e| e.to_string())?;
    }
    Ok(())
}

const RADIO_PAGE_SIZE: u32 = 25;

/// Search the radio-browser.info directory (needs User-Agent header — CORS would block WebView).
#[tauri::command]
async fn search_radio_browser(query: String, offset: u32) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::new();
    let limit_s = RADIO_PAGE_SIZE.to_string();
    let offset_s = offset.to_string();
    let resp = client
        .get("https://de1.api.radio-browser.info/json/stations/search")
        .header("User-Agent", "psysonic/1.0")
        .query(&[
            ("name", query.as_str()),
            ("hidebroken", "true"),
            ("limit", limit_s.as_str()),
            ("offset", offset_s.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    resp.json::<Vec<serde_json::Value>>().await.map_err(|e| e.to_string())
}

/// Fetch top-voted stations from radio-browser.info for initial suggestions.
#[tauri::command]
async fn get_top_radio_stations(offset: u32) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::new();
    let limit_s = RADIO_PAGE_SIZE.to_string();
    let offset_s = offset.to_string();
    let resp = client
        .get("https://de1.api.radio-browser.info/json/stations/topvote")
        .header("User-Agent", "psysonic/1.0")
        .query(&[("limit", limit_s.as_str()), ("offset", offset_s.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    resp.json::<Vec<serde_json::Value>>().await.map_err(|e| e.to_string())
}

/// Fetch arbitrary URL bytes (e.g. radio station favicon) through Rust to bypass CORS.
/// Returns (bytes, content_type).
#[tauri::command]
async fn fetch_url_bytes(url: String) -> Result<(Vec<u8>, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", "psysonic/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .trim()
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok((bytes.to_vec(), content_type))
}

/// Fetch a JSON API endpoint through Rust to bypass CORS/WebView networking restrictions.
/// Returns the response body as a UTF-8 string for parsing on the JS side.
#[tauri::command]
async fn fetch_json_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", "psysonic/1.0")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(text)
}

/// ICY metadata response returned to the frontend.
#[derive(serde::Serialize)]
struct IcyMetadata {
    /// The `StreamTitle` from the inline ICY metadata block in the stream (e.g. `"Artist - Title"`).
    stream_title: Option<String>,
    /// Value of the `icy-name` response header.
    icy_name: Option<String>,
    /// Value of the `icy-genre` response header.
    icy_genre: Option<String>,
    /// Value of the `icy-url` response header.
    icy_url: Option<String>,
    /// Value of the `icy-description` response header.
    icy_description: Option<String>,
}

/// Extract the first `File1=` stream URL from a PLS playlist file.
fn parse_pls_stream_url(content: &str) -> Option<String> {
    content.lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().starts_with("file1="))
        .and_then(|l| {
            let url = l[6..].trim();
            (url.starts_with("http://") || url.starts_with("https://"))
                .then(|| url.to_string())
        })
}

/// Extract the first non-comment HTTP URL from an M3U/M3U8 playlist file.
fn parse_m3u_stream_url(content: &str) -> Option<String> {
    content.lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#')
            && (l.starts_with("http://") || l.starts_with("https://")))
        .map(str::to_string)
}

/// If `url` points to a PLS or M3U playlist, fetch it and return the first
/// stream URL it contains.  Returns `None` for direct stream URLs.
async fn resolve_playlist_url(client: &reqwest::Client, url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url).to_lowercase();
    let is_pls = path.ends_with(".pls");
    let is_m3u = path.ends_with(".m3u") || path.ends_with(".m3u8");
    if !is_pls && !is_m3u {
        return None;
    }

    let resp = client
        .get(url)
        .header("User-Agent", "psysonic/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;

    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();

    let text = resp.text().await.ok()?;

    if is_pls || ct.contains("scpls") || ct.contains("pls+xml") {
        parse_pls_stream_url(&text)
    } else {
        parse_m3u_stream_url(&text)
    }
}

/// Fetch ICY in-stream metadata from a radio stream URL.
///
/// Sends a GET request with `Icy-MetaData: 1` and reads just enough bytes
/// (up to `icy-metaint` audio bytes plus the following metadata block) to
/// extract the `StreamTitle`.  The connection is dropped as soon as the
/// first metadata chunk has been parsed, so bandwidth usage is minimal.
///
/// If `url` is a PLS or M3U playlist file it is resolved to the first direct
/// stream URL before the ICY request is made.
#[tauri::command]
async fn fetch_icy_metadata(url: String) -> Result<IcyMetadata, String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Resolve PLS/M3U playlist files to their first direct stream URL.
    let url = resolve_playlist_url(&client, &url).await.unwrap_or(url);

    let resp = client
        .get(&url)
        .header("Icy-MetaData", "1")
        .header("User-Agent", "psysonic/1.0")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Harvest ICY headers before consuming the body.
    let headers = resp.headers();
    let icy_name        = headers.get("icy-name").and_then(|v| v.to_str().ok()).map(str::to_string);
    let icy_genre       = headers.get("icy-genre").and_then(|v| v.to_str().ok()).map(str::to_string);
    let icy_url         = headers.get("icy-url").and_then(|v| v.to_str().ok()).map(str::to_string);
    let icy_description = headers.get("icy-description").and_then(|v| v.to_str().ok()).map(str::to_string);
    let metaint: Option<usize> = headers
        .get("icy-metaint")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // If the server doesn't advertise a metaint we can still return header info.
    let Some(metaint) = metaint else {
        return Ok(IcyMetadata { stream_title: None, icy_name, icy_genre, icy_url, icy_description });
    };

    // Cap metaint at 64 KiB to avoid reading unreasonably large audio chunks.
    let metaint = metaint.min(65_536);
    let needed  = metaint + 1; // +1 for the metadata-length byte

    let mut buf: Vec<u8> = Vec::with_capacity(needed + 256);
    let mut stream = resp.bytes_stream();

    while buf.len() < needed {
        let Some(chunk) = stream.next().await else { break };
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
    }

    if buf.len() < needed {
        // Stream ended before we reached the metadata block.
        return Ok(IcyMetadata { stream_title: None, icy_name, icy_genre, icy_url, icy_description });
    }

    // The byte immediately after `metaint` audio bytes encodes metadata length:
    //   actual_bytes = length_byte * 16
    let meta_len = buf[metaint] as usize * 16;
    if meta_len == 0 {
        return Ok(IcyMetadata { stream_title: None, icy_name, icy_genre, icy_url, icy_description });
    }

    // We may need to read a few more chunks to get the full metadata block.
    let total_needed = needed + meta_len;
    while buf.len() < total_needed {
        let Some(chunk) = stream.next().await else { break };
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
    }

    let meta_start = needed; // index of first metadata byte
    let meta_end   = (meta_start + meta_len).min(buf.len());
    let meta_bytes = &buf[meta_start..meta_end];

    // ICY metadata is Latin-1 encoded; convert to a Rust String lossily.
    let meta_str: String = meta_bytes
        .iter()
        .map(|&b| if b == 0 { '\0' } else { b as char })
        .collect::<String>();

    // Parse StreamTitle='...' — value ends at the next unescaped single-quote.
    let stream_title = meta_str
        .split("StreamTitle='")
        .nth(1)
        .and_then(|s| {
            // Find closing quote that is NOT preceded by a backslash.
            let mut prev = '\0';
            let mut end = s.len();
            for (i, c) in s.char_indices() {
                if c == '\'' && prev != '\\' {
                    end = i;
                    break;
                }
                prev = c;
            }
            let title = s[..end].trim().to_string();
            if title.is_empty() { None } else { Some(title) }
        });

    Ok(IcyMetadata { stream_title, icy_name, icy_genre, icy_url, icy_description })
}

/// Resolve a PLS or M3U playlist URL to its first direct stream URL.
/// Returns the original URL unchanged if it is not a recognised playlist format
/// or if the playlist cannot be fetched/parsed.
#[tauri::command]
async fn resolve_stream_url(url: String) -> String {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    else {
        return url;
    };
    resolve_playlist_url(&client, &url).await.unwrap_or(url)
}

/// Proxy Last.fm API calls through Rust/reqwest to avoid WebView networking restrictions.
/// `params` is a list of [key, value] pairs (method must be included).
/// If `sign` is true an api_sig is computed. If `get` is true, a GET request is made.
#[tauri::command]
async fn lastfm_request(
    params: Vec<[String; 2]>,
    sign: bool,
    get: bool,
    api_key: String,
    api_secret: String,
) -> Result<serde_json::Value, String> {
    use std::collections::HashMap;

    let mut map: HashMap<String, String> = params.into_iter().map(|[k, v]| (k, v)).collect();
    map.insert("api_key".into(), api_key.clone());

    if sign {
        let mut keys: Vec<String> = map.keys().cloned().collect();
        keys.sort();
        let sig_str: String = keys.iter()
            .filter(|k| k.as_str() != "format" && k.as_str() != "callback")
            .map(|k| format!("{}{}", k, map[k]))
            .collect::<String>();
        let sig_input = format!("{}{}", sig_str, api_secret);
        let digest = md5::compute(sig_input.as_bytes());
        map.insert("api_sig".into(), format!("{:x}", digest));
    }

    map.insert("format".into(), "json".into());

    let client = reqwest::Client::new();
    let resp = if get {
        client
            .get("https://ws.audioscrobbler.com/2.0/")
            .query(&map)
            .header("User-Agent", "psysonic/1.13.0")
            .send()
            .await
    } else {
        client
            .post("https://ws.audioscrobbler.com/2.0/")
            .form(&map)
            .header("User-Agent", "psysonic/1.13.0")
            .send()
            .await
    }.map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if let Some(err) = json.get("error") {
        return Err(format!("Last.fm {} {}", err, json.get("message").and_then(|m| m.as_str()).unwrap_or("")));
    }

    Ok(json)
}


#[tauri::command]
fn register_global_shortcut(
    app: tauri::AppHandle,
    shortcut_map: tauri::State<ShortcutMap>,
    shortcut: String,
    action: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let mut map = shortcut_map.lock().unwrap();

    // Idempotent: if this exact shortcut+action is already registered, skip.
    // This prevents on_shortcut() from accumulating duplicate handlers when
    // registerAll() is called again after a JS HMR reload or StrictMode double-effect.
    if map.get(&shortcut).map(|a| a == &action).unwrap_or(false) {
        return Ok(());
    }

    // Unregister any existing OS grab for this shortcut before re-registering.
    if let Ok(s) = shortcut.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(s);
    }
    map.insert(shortcut.clone(), action.clone());
    drop(map); // release lock before the blocking OS call

    let parsed: Shortcut = shortcut.parse().map_err(|_| format!("Invalid shortcut: {shortcut}"))?;
    app.global_shortcut()
        .on_shortcut(parsed, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let event_name = match action.as_str() {
                    "play-pause"  => "media:play-pause",
                    "next"        => "media:next",
                    "prev"        => "media:prev",
                    "volume-up"   => "media:volume-up",
                    "volume-down" => "media:volume-down",
                    _             => return,
                };
                let _ = app.emit(event_name, ());
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn unregister_global_shortcut(
    app: tauri::AppHandle,
    shortcut_map: tauri::State<ShortcutMap>,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    shortcut_map.lock().unwrap().remove(&shortcut);
    let parsed: Shortcut = shortcut.parse().map_err(|_| format!("Invalid shortcut: {shortcut}"))?;
    app.global_shortcut().unregister(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn mpris_set_metadata(
    controls: tauri::State<MprisControls>,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    cover_url: Option<String>,
    duration_secs: Option<f64>,
) -> Result<(), String> {
    use souvlaki::MediaMetadata;
    use std::time::Duration;

    let duration = duration_secs.map(|s| Duration::from_secs_f64(s));
    let mut guard = controls.lock().unwrap();
    let Some(ctrl) = guard.as_mut() else { return Ok(()); };
    ctrl.set_metadata(MediaMetadata {
        title: title.as_deref(),
        artist: artist.as_deref(),
        album: album.as_deref(),
        cover_url: cover_url.as_deref(),
        duration,
    })
    .map_err(|e| format!("MPRIS set_metadata failed: {e:?}"))
}

#[tauri::command]
fn mpris_set_playback(
    controls: tauri::State<MprisControls>,
    playing: bool,
    position_secs: Option<f64>,
) -> Result<(), String> {
    use souvlaki::{MediaPlayback, MediaPosition};
    use std::time::Duration;

    let progress = position_secs.map(|s| MediaPosition(Duration::from_secs_f64(s)));
    let playback = if playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };
    let mut guard = controls.lock().unwrap();
    let Some(ctrl) = guard.as_mut() else { return Ok(()); };
    ctrl.set_playback(playback)
        .map_err(|e| format!("MPRIS set_playback failed: {e:?}"))
}

/// Returns true if `path` is an accessible directory (used for pre-flight checks in the frontend).
#[tauri::command]
fn check_dir_accessible(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

// ─── Offline Track Cache ──────────────────────────────────────────────────────

/// Streams an HTTP response body directly to `dest_path` in small chunks.
/// Never buffers the full file in memory — keeps RAM flat regardless of file size.
async fn stream_to_file(response: reqwest::Response, dest_path: &std::path::Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Downloads a single track to the app's offline cache directory.
/// Returns the absolute file path so TypeScript can store it and later
/// construct a `psysonic-local://<path>` URL for the audio engine.
#[tauri::command]
async fn download_track_offline(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    dl_sem: tauri::State<'_, DownloadSemaphore>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    // Determine base cache directory.
    let cache_dir = if let Some(ref cd) = custom_dir {
        let base = std::path::PathBuf::from(cd);
        // Check that the volume/directory is still accessible.
        if !base.exists() {
            return Err("VOLUME_NOT_FOUND".to_string());
        }
        base.join(&server_id)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-offline")
            .join(&server_id)
    };

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    // Already cached — skip re-download (no semaphore needed).
    if file_path.exists() {
        return Ok(path_str);
    }

    // Acquire a download slot. The permit is held for the duration of the HTTP transfer
    // and released automatically when this function returns (success or error).
    let _permit = dl_sem.acquire().await.map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    // Stream directly to a .part file; rename on success to avoid partial files.
    let part_path = file_path.with_extension(format!("{suffix}.part"));
    if let Err(e) = stream_to_file(response, &part_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(e);
    }
    tokio::fs::rename(&part_path, &file_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(path_str)
}

/// Returns the total size in bytes of all files in the offline cache directory (and optional custom dir).
#[tauri::command]
async fn get_offline_cache_size(custom_dir: Option<String>, app: tauri::AppHandle) -> u64 {
    fn dir_size(root: std::path::PathBuf) -> u64 {
        if !root.exists() { return 0; }
        let mut total: u64 = 0;
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(meta) = std::fs::metadata(&path) {
                    total += meta.len();
                }
            }
        }
        total
    }

    let default_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("psysonic-offline"),
        Err(_) => return 0,
    };
    let mut total = dir_size(default_dir);

    if let Some(cd) = custom_dir {
        let custom = std::path::PathBuf::from(cd);
        if custom != std::path::PathBuf::from("") {
            total += dir_size(custom);
        }
    }
    total
}

/// Removes a cached track from the offline cache. Accepts the full local path
/// (stored in OfflineTrackMeta) so it works regardless of which directory was used.
/// After deleting the file, empty parent directories up to (but not including)
/// `base_dir` are pruned using `remove_dir` (never `remove_dir_all`).
#[tauri::command]
async fn delete_offline_track(
    local_path: String,
    base_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&local_path);
    if file_path.exists() {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Determine the safe boundary — never delete at or above this directory.
    let boundary = if let Some(bd) = base_dir.filter(|s| !s.is_empty()) {
        std::path::PathBuf::from(bd)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-offline")
    };

    // Walk upward, pruning directories that have become empty.
    // Stops as soon as a non-empty directory or the boundary is reached.
    let mut current = file_path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == boundary || !dir.starts_with(&boundary) {
            break;
        }
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break; // Directory still has contents — stop pruning.
                }
                if std::fs::remove_dir(&dir).is_err() {
                    break; // Could not remove (e.g. permissions) — stop.
                }
                current = dir.parent().map(|p| p.to_path_buf());
            }
            Err(_) => break,
        }
    }

    Ok(())
}

// ─── Hot playback cache (ephemeral; queue-based prefetch) ─────────────────────

fn resolve_hot_cache_root(
    custom_dir: Option<String>,
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    if let Some(ref cd) = custom_dir.filter(|s| !s.is_empty()) {
        let base = std::path::PathBuf::from(cd);
        if !base.exists() {
            return Err("VOLUME_NOT_FOUND".to_string());
        }
        Ok(base.join("psysonic-hot-cache"))
    } else {
        Ok(app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("psysonic-hot-cache"))
    }
}

/// Returns true if the current Linux system is Arch-based
/// (checks /etc/arch-release and /etc/os-release).
#[tauri::command]
fn check_arch_linux() -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/etc/arch-release").exists() {
            return true;
        }
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                let lower = line.to_lowercase();
                if lower.starts_with("id=arch") { return true; }
                if lower.starts_with("id_like=") && lower.contains("arch") { return true; }
            }
        }
        false
    }
    #[cfg(not(target_os = "linux"))]
    { false }
}

/// Progress payload emitted during an update binary download.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgress {
    bytes: u64,
    total: Option<u64>,
}

/// Downloads an update installer/package to the user's Downloads folder.
/// Emits `update:download:progress` events with `{ bytes, total }` every 250 ms.
/// Returns the final absolute file path on success.
#[tauri::command]
async fn download_update(url: String, filename: String, app: tauri::AppHandle) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncWriteExt;

    const EMIT_INTERVAL: Duration = Duration::from_millis(250);

    let dest_dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(&filename);
    let part_path = dest_dir.join(format!("{}.part", filename));

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let total = response.content_length();

    let result: Result<u64, String> = async {
        let mut file = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| e.to_string())?;

        let mut bytes_done: u64 = 0;
        let mut stream = response.bytes_stream();
        let mut last_emit = Instant::now();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            bytes_done += chunk.len() as u64;

            if last_emit.elapsed() >= EMIT_INTERVAL {
                let _ = app.emit("update:download:progress", UpdateDownloadProgress {
                    bytes: bytes_done,
                    total,
                });
                last_emit = Instant::now();
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(bytes_done)
    }.await;

    match result {
        Err(e) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            Err(e)
        }
        Ok(bytes_done) => {
            let _ = app.emit("update:download:progress", UpdateDownloadProgress {
                bytes: bytes_done,
                total: Some(bytes_done),
            });
            tokio::fs::rename(&part_path, &dest_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(dest_path.to_string_lossy().into_owned())
        }
    }
}

/// Fetches synced lyrics from Netease Cloud Music for a given artist + title.
/// Performs a track search, then fetches the LRC string for the best match.
/// Returns `None` if no match or no lyrics are found.
#[tauri::command]
async fn fetch_netease_lyrics(artist: String, title: String) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let query = format!("{} {}", artist, title);
    let params = [("s", query.as_str()), ("type", "1"), ("limit", "5")];
    let search: serde_json::Value = client
        .post("https://music.163.com/api/search/get")
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
        .header("Referer", "https://music.163.com")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let song_id = match search["result"]["songs"][0]["id"].as_i64() {
        Some(id) => id,
        None => return Ok(None),
    };

    let lyrics: serde_json::Value = client
        .get(format!(
            "https://music.163.com/api/song/lyric?id={}&lv=1&kv=1&tv=-1",
            song_id
        ))
        .header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")
        .header("Referer", "https://music.163.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let lrc = lyrics["lrc"]["lyric"].as_str().unwrap_or("").trim().to_string();
    Ok(if lrc.is_empty() { None } else { Some(lrc) })
}

/// Reads embedded synced / unsynced lyrics from a local audio file.
///
/// Priority order:
///   MP3  → ID3v2 SYLT (synchronized, ms timestamps) → ID3v2 USLT (plain)
///   FLAC → Vorbis SYNCEDLYRICS (LRC string)          → Vorbis LYRICS (plain)
///
/// Returns a standard LRC string (`[mm:ss.cc]line\n…`) for synced lyrics,
/// or plain text for unsynced lyrics.  Returns `None` when no lyrics are found.
/// Errors are silenced and mapped to `None` so the frontend falls through to the
/// next lyrics source without crashing.
#[tauri::command]
fn get_embedded_lyrics(path: String) -> Option<String> {
    use lofty::file::FileType;
    use lofty::prelude::*;
    use lofty::probe::Probe;

    let fpath = std::path::Path::new(&path);
    if !fpath.exists() {
        return None;
    }

    // Detect file type from magic bytes only — no full tag read yet.
    // guess_file_type() consumes self and returns Self, so reassign.
    let probe = Probe::open(fpath).ok()?;
    let probe = probe.guess_file_type().ok()?;
    let file_type = probe.file_type();

    // ── MP3 / MPEG: use the `id3` crate for SYLT / USLT ─────────────────────
    // lofty's MpegFile::id3v2_tag field is pub(crate) — not accessible here.
    // The `id3` crate exposes a clean public API for typed ID3v2 frames.
    if matches!(file_type, Some(FileType::Mpeg)) {
        use id3::{Content, Tag as Id3Tag};

        if let Ok(tag) = Id3Tag::read_from_path(fpath) {
            // 1. SYLT — millisecond-timestamped synced lyrics.
            for frame in tag.frames() {
                if frame.id() != "SYLT" {
                    continue;
                }
                if let Content::SynchronisedLyrics(sylt) = frame.content() {
                    // Only accept millisecond timestamps — MPEG-frame-based
                    // timestamps can't be converted to wall-clock seconds.
                    if sylt.timestamp_format != id3::frame::TimestampFormat::Ms {
                        continue;
                    }
                    let lrc: String = sylt
                        .content
                        .iter()
                        .filter_map(|(ms, text)| {
                            let t = text.trim();
                            if t.is_empty() {
                                return None;
                            }
                            let mins = ms / 60_000;
                            let secs = (ms % 60_000) / 1_000;
                            let cs   = (ms % 1_000) / 10;
                            // [mm:ss.cc] matches parseLrc's /\d+(?:\.\d*)?/ regex
                            Some(format!("[{:02}:{:02}.{:02}]{}\n", mins, secs, cs, t))
                        })
                        .collect();
                    if !lrc.is_empty() {
                        return Some(lrc.trim_end().to_owned());
                    }
                }
            }

            // 2. USLT — unsynchronized lyrics, plain-text fallback.
            for frame in tag.frames() {
                if frame.id() != "USLT" {
                    continue;
                }
                if let Content::Lyrics(uslt) = frame.content() {
                    let text = uslt.text.trim();
                    if !text.is_empty() {
                        return Some(text.to_owned());
                    }
                }
            }
        }
        return None; // MPEG file but no usable lyrics found
    }

    // ── FLAC / Vorbis / Opus / M4A: generic lofty tag API ────────────────────
    // Vorbis SYNCEDLYRICS stores a complete LRC string in a plain comment field.
    // It is not a known lofty ItemKey, so access it via ItemKey::Unknown.
    let tagged = probe.read().ok()?;
    for tag in tagged.tags() {
        if let Some(lrc) = tag.get_string(&ItemKey::Unknown("SYNCEDLYRICS".to_owned())) {
            let lrc = lrc.trim();
            if !lrc.is_empty() {
                return Some(lrc.to_owned());
            }
        }
        if let Some(plain) = tag.get_string(&ItemKey::Lyrics) {
            let plain = plain.trim();
            if !plain.is_empty() {
                return Some(plain.to_owned());
            }
        }
    }

    None
}

/// Opens a directory in the OS file manager (Explorer / Finder / Nautilus).
/// Uses platform-specific process spawning — tauri-plugin-shell's open() only
/// allows https:// URLs per the capability scope and fails silently for paths.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Progress payload emitted to the frontend during a ZIP download.
/// `total` is `None` when the server doesn't send a `Content-Length` header
/// (Navidrome on-the-fly ZIPs).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ZipProgress {
    id: String,
    bytes: u64,
    total: Option<u64>,
}

/// Downloads a server-generated ZIP (album/playlist) directly to disk via streaming.
/// Emits `download:zip:progress` events every 500 ms so the frontend can show
/// live MB-counter without holding any binary data in the WebView process.
/// Returns the final destination path on success.
#[tauri::command]
async fn download_zip(
    id: String,
    url: String,
    dest_path: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncWriteExt;

    const EMIT_INTERVAL: Duration = Duration::from_millis(500);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(7200)) // up to 2 h for large on-the-fly ZIPs
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    let total = response.content_length(); // None for Navidrome on-the-fly ZIPs
    let part_path = format!("{dest_path}.part");

    // Stream to .part file; rename on success, delete on error.
    let result: Result<u64, String> = async {
        let mut file = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| e.to_string())?;

        let mut bytes_done: u64 = 0;
        let mut stream = response.bytes_stream();
        let mut last_emit = Instant::now();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            bytes_done += chunk.len() as u64;

            if last_emit.elapsed() >= EMIT_INTERVAL {
                let _ = app.emit("download:zip:progress", ZipProgress {
                    id: id.clone(),
                    bytes: bytes_done,
                    total,
                });
                last_emit = Instant::now();
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        Ok(bytes_done)
    }.await;

    match result {
        Err(e) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            Err(e)
        }
        Ok(bytes_done) => {
            // Final emission so the frontend sees 100 % (or final MB count).
            let _ = app.emit("download:zip:progress", ZipProgress {
                id: id.clone(),
                bytes: bytes_done,
                total: Some(bytes_done),
            });
            tokio::fs::rename(&part_path, &dest_path)
                .await
                .map_err(|e| e.to_string())?;
            Ok(dest_path)
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HotCacheDownloadResult {
    path: String,
    size: u64,
}

/// Downloads a single track into the hot playback cache (separate from offline library).
/// Optional `custom_dir`: parent folder; files go under `<custom_dir>/psysonic-hot-cache/<server_id>/`.
/// Returns absolute path and file size for `psysonic-local://` URLs.
#[tauri::command]
async fn download_track_hot_cache(
    track_id: String,
    server_id: String,
    url: String,
    suffix: String,
    custom_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<HotCacheDownloadResult, String> {
    let root = resolve_hot_cache_root(custom_dir, &app)?;
    let cache_dir = root.join(&server_id);

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| e.to_string())?;

    let file_path = cache_dir.join(format!("{}.{}", track_id, suffix));
    let path_str = file_path.to_string_lossy().to_string();

    if file_path.exists() {
        let size = tokio::fs::metadata(&file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        return Ok(HotCacheDownloadResult {
            path: path_str,
            size,
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    // Stream directly to a .part file; rename on success to avoid partial files.
    let part_path = file_path.with_extension(format!("{suffix}.part"));
    if let Err(e) = stream_to_file(response, &part_path).await {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(e);
    }
    tokio::fs::rename(&part_path, &file_path)
        .await
        .map_err(|e| e.to_string())?;

    let size = tokio::fs::metadata(&file_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(HotCacheDownloadResult {
        path: path_str,
        size,
    })
}

#[tauri::command]
async fn get_hot_cache_size(custom_dir: Option<String>, app: tauri::AppHandle) -> u64 {
    fn dir_size(root: std::path::PathBuf) -> u64 {
        if !root.exists() {
            return 0;
        }
        let mut total: u64 = 0;
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let rd = match std::fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in rd.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(meta) = std::fs::metadata(&path) {
                    total += meta.len();
                }
            }
        }
        total
    }

    resolve_hot_cache_root(custom_dir, &app)
        .map(|root| dir_size(root))
        .unwrap_or(0)
}

#[tauri::command]
async fn delete_hot_cache_track(
    local_path: String,
    custom_dir: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let file_path = std::path::PathBuf::from(&local_path);
    if file_path.exists() {
        tokio::fs::remove_file(&file_path)
            .await
            .map_err(|e| e.to_string())?;
    }

    let boundary = resolve_hot_cache_root(custom_dir, &app)?;

    let mut current = file_path.parent().map(|p| p.to_path_buf());
    while let Some(dir) = current {
        if dir == boundary || !dir.starts_with(&boundary) {
            break;
        }
        match std::fs::read_dir(&dir) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    break;
                }
                if std::fs::remove_dir(&dir).is_err() {
                    break;
                }
                current = dir.parent().map(|p| p.to_path_buf());
            }
            Err(_) => break,
        }
    }

    Ok(())
}

/// Removes the entire hot cache root (`psysonic-hot-cache` for the active location).
#[tauri::command]
async fn purge_hot_cache(custom_dir: Option<String>, app: tauri::AppHandle) -> Result<(), String> {
    let dir = resolve_hot_cache_root(custom_dir, &app)?;
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Builds and returns a new system-tray icon with all menu items and event handlers.
/// Called from `setup()` (initial creation) and from `toggle_tray_icon` (re-creation).
fn build_tray_icon(app: &tauri::AppHandle) -> tauri::Result<TrayIcon> {
    let play_pause = MenuItemBuilder::with_id("play_pause", "Play / Pause").build(app)?;
    let next       = MenuItemBuilder::with_id("next",       "Next Track").build(app)?;
    let previous   = MenuItemBuilder::with_id("previous",   "Previous Track").build(app)?;
    let sep1       = PredefinedMenuItem::separator(app)?;
    let show_hide  = MenuItemBuilder::with_id("show_hide",  "Show / Hide").build(app)?;
    let sep2       = PredefinedMenuItem::separator(app)?;
    let quit       = MenuItemBuilder::with_id("quit",       "Exit Psysonic").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&play_pause)
        .item(&previous)
        .item(&next)
        .item(&sep1)
        .item(&show_hide)
        .item(&sep2)
        .item(&quit)
        .build()?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Psysonic")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "play_pause" => { let _ = app.emit("tray:play-pause", ()); }
            "next"       => { let _ = app.emit("tray:next", ()); }
            "previous"   => { let _ = app.emit("tray:previous", ()); }
            "show_hide"  => {
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
            "quit" => { stop_audio_engine(app); app.exit(0); }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            }
        })
        .build(app)
}

/// Show (`true`) or fully remove (`false`) the system-tray icon.
///
/// The command is strictly idempotent:
/// - `show=true`  when the icon is already present → no-op (prevents duplicate icons).
/// - `show=false` when the icon is already absent  → no-op.
///
/// For removal, `set_visible(false)` is called explicitly before the handle is
/// dropped because some platforms (Windows notification area, certain Linux DEs)
/// process the OS removal asynchronously — hiding first prevents a brief "ghost"
/// icon from appearing alongside a freshly created one.
#[tauri::command]
fn toggle_tray_icon(
    app: tauri::AppHandle,
    tray_state: tauri::State<TrayState>,
    show: bool,
) -> Result<(), String> {
    let mut guard = tray_state.lock().unwrap();

    if show {
        // Early-return when already shown — never build a second icon.
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(build_tray_icon(&app).map_err(|e| e.to_string())?);
    } else if let Some(tray) = guard.take() {
        // Hide synchronously before dropping so the OS processes the removal
        // before any subsequent show=true call can create a new icon.
        let _ = tray.set_visible(false);
        // `tray` drops here → frees the OS resource (NIM_DELETE / StatusNotifierItem / NSStatusItem).
    }

    Ok(())
}

/// Stops the Rust audio engine cleanly (mirrors the logic in `audio_stop`).
/// Called before process exit on macOS to ensure audio stops immediately.
fn stop_audio_engine(app: &tauri::AppHandle) {
    let engine = app.state::<audio::AudioEngine>();
    engine.generation.fetch_add(1, Ordering::SeqCst);
    *engine.chained_info.lock().unwrap() = None;
    drop(engine.radio_state.lock().unwrap().take());
    let mut cur = engine.current.lock().unwrap();
    if let Some(sink) = cur.sink.take() { sink.stop(); }
}

/// Returns `true` if running under a tiling window manager (Hyprland, Sway, i3,
/// bspwm, AwesomeWM, Openbox, etc.).  Detection is based on environment variables
/// set by the compositor / DE.
#[cfg(target_os = "linux")]
fn is_tiling_wm() -> bool {
    // Direct compositor signatures (most reliable).
    let direct = [
        "HYPRLAND_INSTANCE_SIGNATURE", // Hyprland
        "SWAYSOCK",                     // Sway
        "I3SOCK",                       // i3
    ]
    .iter()
    .any(|&var| std::env::var_os(var).is_some());

    if direct {
        return true;
    }

    // Check XDG_CURRENT_DESKTOP for known tiling WMs.
    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
        let desktop = desktop.to_lowercase();
        let tiling_wms = [
            "hyprland", "sway", "i3", "bspwm", "awesome", "openbox",
            "xmonad", "dwm", "qtile", "herbstluftwm", "leftwm",
        ];
        if tiling_wms.iter().any(|&wm| desktop.contains(wm)) {
            return true;
        }
    }

    false
}

/// Tauri command: returns true when WEBKIT_DISABLE_COMPOSITING_MODE=1 is set.
/// The frontend uses this to apply a CSS class that swaps out GPU-only effects
/// (backdrop-filter, CSS filter, mask-image) for software-friendly equivalents.
#[tauri::command]
fn no_compositing_mode() -> bool {
    std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

/// Tauri command: lets the frontend know whether we're running under a tiling
/// WM so it can decide whether to render the custom TitleBar component.
#[tauri::command]
fn is_tiling_wm_cmd() -> bool {
    #[cfg(target_os = "linux")]
    {
        is_tiling_wm()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

pub fn run() {
    let (audio_engine, _audio_thread) = audio::create_engine();

    tauri::Builder::default()
        .manage(audio_engine)
        .manage(ShortcutMap::default())
        .manage(discord::DiscordState::new())
        .manage(Arc::new(tokio::sync::Semaphore::new(MAX_DL_CONCURRENCY)) as DownloadSemaphore)
        .manage(TrayState::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let window = app.get_webview_window("main").expect("no main window");
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }))

        .setup(|app| {
            // ── Custom title bar on Linux ─────────────────────────────────
            // Remove OS window decorations on all Linux so the React TitleBar
            // can take over.  The frontend checks is_tiling_wm() to decide
            // whether to actually render the TitleBar (hidden on tiling WMs).
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_decorations(false);
                }
            }

            // ── System tray ───────────────────────────────────────────────
            // Always build on startup; the frontend calls toggle_tray_icon(false)
            // immediately after load if the user has disabled the tray icon.
            {
                let tray = build_tray_icon(app.handle())?;
                *app.state::<TrayState>().lock().unwrap() = Some(tray);
            }

            // ── MPRIS2 / OS media controls via souvlaki ──────────────────
            {
                use souvlaki::{MediaControlEvent, MediaControls, PlatformConfig};

                // Collect pre-conditions and the platform-specific HWND.
                // Returns None early (with a log) on any unrecoverable condition
                // so app.manage() always executes exactly once at the bottom.
                let maybe_controls: Option<MediaControls> = (|| {
                    // Linux: requires a live D-Bus session.
                    #[cfg(target_os = "linux")]
                    {
                        let dbus_ok = std::env::var("DBUS_SESSION_BUS_ADDRESS")
                            .map(|v| !v.is_empty())
                            .unwrap_or(false);
                        if !dbus_ok {
                            eprintln!("[Psysonic] No D-Bus session — MPRIS media controls disabled");
                            return None;
                        }
                    }

                    // Windows: souvlaki SMTC must hook into the existing Win32
                    // message loop rather than spinning up its own. Pass the
                    // main window's HWND so it can do so. If we can't get one,
                    // skip init (no crash, just no media overlay).
                    #[cfg(target_os = "windows")]
                    let hwnd = {
                        use tauri::Manager;
                        let h = app.get_webview_window("main")
                            .and_then(|w| w.hwnd().ok())
                            .map(|h| h.0 as *mut std::ffi::c_void);
                        if h.is_none() {
                            eprintln!("[Psysonic] Could not get HWND — Windows media controls disabled");
                            return None;
                        }
                        h
                    };
                    #[cfg(not(target_os = "windows"))]
                    let hwnd: Option<*mut std::ffi::c_void> = None;

                    let config = PlatformConfig {
                        dbus_name: "psysonic",
                        display_name: "Psysonic",
                        hwnd,
                    };

                    match MediaControls::new(config) {
                        Ok(mut controls) => {
                            let app_handle = app.handle().clone();
                            if let Err(e) = controls.attach(move |event: MediaControlEvent| {
                                match event {
                                    MediaControlEvent::Toggle
                                    | MediaControlEvent::Play
                                    | MediaControlEvent::Pause => {
                                        let _ = app_handle.emit("media:play-pause", ());
                                    }
                                    MediaControlEvent::Next => {
                                        let _ = app_handle.emit("media:next", ());
                                    }
                                    MediaControlEvent::Previous => {
                                        let _ = app_handle.emit("media:prev", ());
                                    }
                                    MediaControlEvent::Seek(direction) => {
                                        use souvlaki::SeekDirection;
                                        let delta: f64 = match direction {
                                            SeekDirection::Forward  =>  5.0,
                                            SeekDirection::Backward => -5.0,
                                        };
                                        let _ = app_handle.emit("media:seek-relative", delta);
                                    }
                                    MediaControlEvent::SetPosition(pos) => {
                                        let secs = pos.0.as_secs_f64();
                                        let _ = app_handle.emit("media:seek-absolute", secs);
                                    }
                                    _ => {}
                                }
                            }) {
                                eprintln!("[Psysonic] Failed to attach media controls: {e:?}");
                            }
                            Some(controls)
                        }
                        Err(e) => {
                            eprintln!("[Psysonic] Could not create media controls: {e:?}");
                            None
                        }
                    }
                })();

                app.manage(MprisControls::new(maybe_controls));
            }

            // ── Windows Taskbar Thumbnail Toolbar ────────────────────────
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        taskbar_win::init(app.handle(), hwnd.0 as isize);
                    }
                }
            }

            // ── Audio device-change watcher ───────────────────────────────
            {
                use tauri::Manager;
                let engine = app.state::<audio::AudioEngine>();
                audio::start_device_watcher(&engine, app.handle().clone());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();

                    #[cfg(target_os = "macos")]
                    {
                        // On macOS the red close button quits the app entirely.
                        // Stop the audio engine first so sound cuts immediately.
                        let app = window.app_handle();
                        stop_audio_engine(app);
                        app.exit(0);
                    }

                    #[cfg(not(target_os = "macos"))]
                    {
                        // Let JS decide: minimize to tray or exit, based on user setting.
                        let _ = window.emit("window:close-requested", ());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            exit_app,
            set_window_decorations,
            no_compositing_mode,
            is_tiling_wm_cmd,
            register_global_shortcut,
            unregister_global_shortcut,
            mpris_set_metadata,
            mpris_set_playback,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_resume,
            audio::audio_stop,
            audio::audio_seek,
            audio::audio_set_volume,
            audio::audio_update_replay_gain,
            audio::audio_set_eq,
            audio::autoeq_entries,
            audio::autoeq_fetch_profile,
            audio::audio_preload,
            audio::audio_play_radio,
            audio::audio_set_crossfade,
            audio::audio_set_gapless,
            audio::audio_list_devices,
            audio::audio_default_output_device_name,
            audio::audio_set_device,
            audio::audio_chain_preload,
            discord::discord_update_presence,
            discord::discord_clear_presence,
            lastfm_request,
            upload_playlist_cover,
            upload_radio_cover,
            upload_artist_image,
            delete_radio_cover,
            search_radio_browser,
            get_top_radio_stations,
            fetch_url_bytes,
            fetch_json_url,
            fetch_icy_metadata,
            resolve_stream_url,
            download_track_offline,
            delete_offline_track,
            get_offline_cache_size,
            download_track_hot_cache,
            get_hot_cache_size,
            delete_hot_cache_track,
            purge_hot_cache,
            toggle_tray_icon,
            check_dir_accessible,
            download_zip,
            check_arch_linux,
            download_update,
            open_folder,
            get_embedded_lyrics,
            fetch_netease_lyrics,
            #[cfg(target_os = "windows")]
            taskbar_win::update_taskbar_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Psysonic");
}

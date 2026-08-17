use psysonic_core::icy::IcyMetadataBlock;
use psysonic_core::user_agent::subsonic_wire_user_agent;

mod provider_http;

use provider_http::provider_http_client;

pub const RADIO_PAGE_SIZE: u32 = 25;

/// Search the radio-browser.info directory (needs User-Agent header — CORS would block WebView).
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn search_radio_browser(
    query: String,
    offset: u32,
) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::new();
    let limit_s = RADIO_PAGE_SIZE.to_string();
    let offset_s = offset.to_string();
    let resp = client
        .get("https://de1.api.radio-browser.info/json/stations/search")
        .header("User-Agent", subsonic_wire_user_agent())
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
    resp.json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| e.to_string())
}

/// Fetch top-voted stations from radio-browser.info for initial suggestions.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn get_top_radio_stations(offset: u32) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::new();
    let limit_s = RADIO_PAGE_SIZE.to_string();
    let offset_s = offset.to_string();
    let resp = client
        .get("https://de1.api.radio-browser.info/json/stations/topvote")
        .header("User-Agent", subsonic_wire_user_agent())
        .query(&[("limit", limit_s.as_str()), ("offset", offset_s.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    resp.json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| e.to_string())
}

/// Fetch arbitrary URL bytes (e.g. radio station favicon) through Rust to bypass CORS.
/// Returns (bytes, content_type).
#[tauri::command]
#[specta::specta]
pub async fn fetch_url_bytes(url: String) -> Result<(Vec<u8>, String), String> {
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
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
// NOT specta-collected: raw-JSON passthrough (FE JSON.parses the string) — kept hand-written on generate_handler! with the scrobbler/fetch family.
#[tauri::command]
pub async fn fetch_json_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
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
#[derive(serde::Serialize, specta::Type)]
pub struct IcyMetadata {
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
pub fn parse_pls_stream_url(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().starts_with("file1="))
        .and_then(|l| {
            let url = l[6..].trim();
            (url.starts_with("http://") || url.starts_with("https://")).then(|| url.to_string())
        })
}

/// Extract the first non-comment HTTP URL from an M3U/M3U8 playlist file.
pub fn parse_m3u_stream_url(content: &str) -> Option<String> {
    content
        .lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                && !l.starts_with('#')
                && (l.starts_with("http://") || l.starts_with("https://"))
        })
        .map(str::to_string)
}

/// If `url` points to a PLS or M3U playlist, fetch it and return the first
/// stream URL it contains.  Returns `None` for direct stream URLs.
pub async fn resolve_playlist_url(client: &reqwest::Client, url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url).to_lowercase();
    let is_pls = path.ends_with(".pls");
    let is_m3u = path.ends_with(".m3u") || path.ends_with(".m3u8");
    if !is_pls && !is_m3u {
        return None;
    }

    let resp = client
        .get(url)
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
#[specta::specta]
pub async fn fetch_icy_metadata(url: String) -> Result<IcyMetadata, String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Resolve PLS/M3U playlist files to their first direct stream URL.
    let url = resolve_playlist_url(&client, &url).await.unwrap_or(url);

    let resp = client
        .get(&url)
        .header("Icy-MetaData", "1")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    // Harvest ICY headers before consuming the body.
    let headers = resp.headers();
    let icy_name = headers
        .get("icy-name")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let icy_genre = headers
        .get("icy-genre")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let icy_url = headers
        .get("icy-url")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let icy_description = headers
        .get("icy-description")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let metaint: Option<usize> = headers
        .get("icy-metaint")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());

    // If the server doesn't advertise a metaint we can still return header info.
    let Some(metaint) = metaint else {
        return Ok(IcyMetadata {
            stream_title: None,
            icy_name,
            icy_genre,
            icy_url,
            icy_description,
        });
    };

    // Cap metaint at 64 KiB to avoid reading unreasonably large audio chunks.
    let metaint = metaint.min(65_536);
    let needed = metaint + 1; // +1 for the metadata-length byte

    let mut buf: Vec<u8> = Vec::with_capacity(needed + 256);
    let mut stream = resp.bytes_stream();

    while buf.len() < needed {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
    }

    if buf.len() < needed {
        // Stream ended before we reached the metadata block.
        return Ok(IcyMetadata {
            stream_title: None,
            icy_name,
            icy_genre,
            icy_url,
            icy_description,
        });
    }

    // The byte immediately after `metaint` audio bytes encodes metadata length:
    //   actual_bytes = length_byte * 16
    let meta_len = buf[metaint] as usize * 16;
    if meta_len == 0 {
        return Ok(IcyMetadata {
            stream_title: None,
            icy_name,
            icy_genre,
            icy_url,
            icy_description,
        });
    }

    // We may need to read a few more chunks to get the full metadata block.
    let total_needed = needed + meta_len;
    while buf.len() < total_needed {
        let Some(chunk) = stream.next().await else {
            break;
        };
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
    }

    let meta_start = needed; // index of first metadata byte
    let meta_end = (meta_start + meta_len).min(buf.len());
    let meta_bytes = &buf[meta_start..meta_end];

    let metadata = IcyMetadataBlock::parse(meta_bytes);
    let stream_title = metadata.stream_title().map(str::to_owned);

    Ok(IcyMetadata {
        stream_title,
        icy_name,
        icy_genre,
        icy_url,
        icy_description,
    })
}

/// Resolve a PLS or M3U playlist URL to its first direct stream URL.
/// Returns the original URL unchanged if it is not a recognised playlist format
/// or if the playlist cannot be fetched/parsed.
#[tauri::command]
#[specta::specta]
pub async fn resolve_stream_url(url: String) -> String {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    else {
        return url;
    };
    resolve_playlist_url(&client, &url).await.unwrap_or(url)
}

/// Default Audioscrobbler v2 endpoint (Last.fm). Other presets (Libre.fm,
/// Rocksky, GNU FM, Maloja compat) pass their own `base_url`.
const LASTFM_API_BASE: &str = "https://ws.audioscrobbler.com/2.0/";

/// Maloja Audioscrobbler-compat surface all share this one command.
///
/// `params` is a list of [key, value] pairs (method must be included). If `sign`
/// is true an `api_sig` is computed (MD5 of sorted params + secret). If `get` is
/// true a GET request is made, otherwise a form POST.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn audioscrobbler_request(
    base_url: String,
    params: Vec<[String; 2]>,
    sign: bool,
    get: bool,
    api_key: String,
    api_secret: String,
) -> Result<serde_json::Value, String> {
    use std::collections::HashMap;

    let base = if base_url.trim().is_empty() {
        LASTFM_API_BASE.to_string()
    } else {
        base_url
    };

    let mut map: HashMap<String, String> = params.into_iter().map(|[k, v]| (k, v)).collect();
    map.insert("api_key".into(), api_key.clone());

    if sign {
        let mut keys: Vec<String> = map.keys().cloned().collect();
        keys.sort();
        let sig_str: String = keys
            .iter()
            .filter(|k| k.as_str() != "format" && k.as_str() != "callback")
            .map(|k| format!("{}{}", k, map[k]))
            .collect::<String>();
        let sig_input = format!("{}{}", sig_str, api_secret);
        let digest = md5::compute(sig_input.as_bytes());
        map.insert("api_sig".into(), format!("{:x}", digest));
    }

    map.insert("format".into(), "json".into());

    let client = provider_http_client()?;
    let resp = if get {
        client
            .get(&base)
            .query(&map)
            .header("User-Agent", subsonic_wire_user_agent())
            .send()
            .await
    } else {
        client
            .post(&base)
            .form(&map)
            .header("User-Agent", subsonic_wire_user_agent())
            .send()
            .await
    }
    .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if let Some(err) = json.get("error") {
        return Err(format!(
            "Audioscrobbler {} {}",
            err,
            json.get("message").and_then(|m| m.as_str()).unwrap_or("")
        ));
    }

    Ok(json)
}

/// Generic ListenBrainz transport. Used by both the direct
/// `api.listenbrainz.org` preset and the Maloja `/apis/listenbrainz` compat
/// surface — they differ only by `base_url`. Auth is a `Token` header.
///
/// `path` is appended to `base_url` (e.g. `/1/submit-listens`). When `json_body`
/// is present the request is a POST with that body; otherwise a GET.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn listenbrainz_request(
    base_url: String,
    path: String,
    auth_token: String,
    json_body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let client = provider_http_client()?;

    let mut req = if json_body.is_some() {
        client.post(&url)
    } else {
        client.get(&url)
    };
    req = req
        .header("Authorization", format!("Token {}", auth_token))
        .header("User-Agent", subsonic_wire_user_agent());
    if let Some(body) = json_body {
        req = req.json(&body);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = json.get("error").and_then(|m| m.as_str()).unwrap_or("");
        return Err(format!("ListenBrainz {} {}", status.as_u16(), msg));
    }

    Ok(json)
}

/// Generic Maloja native (`/apis/mlj_1`) transport. Protocol-agnostic JSON:
/// the caller builds the body (including the Maloja key) and chooses the path.
///
/// `path` is appended to `base_url`. When `json_body` is present the request is a
/// POST with that body; otherwise a GET with `query` pairs.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn maloja_request(
    base_url: String,
    path: String,
    query: Vec<[String; 2]>,
    json_body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let client = provider_http_client()?;

    let resp = if let Some(body) = json_body {
        client.post(&url).json(&body)
    } else {
        let q: Vec<(String, String)> = query.into_iter().map(|[k, v]| (k, v)).collect();
        client.get(&url).query(&q)
    }
    .header("User-Agent", subsonic_wire_user_agent())
    .send()
    .await
    .map_err(|e| e.to_string())?;

    let status = resp.status();
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = json
            .get("error")
            .and_then(|e| e.get("desc").or_else(|| e.get("type")))
            .and_then(|m| m.as_str())
            .unwrap_or("");
        return Err(format!("Maloja {} {}", status.as_u16(), msg));
    }

    Ok(json)
}

#[cfg(test)]
mod icy_tests;
#[cfg(test)]
mod playlist_tests;
#[cfg(test)]
mod provider_tests;

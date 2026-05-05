use super::*;

pub(crate) fn resolve_hot_cache_root(
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
pub(crate) fn check_arch_linux() -> bool {
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
pub(crate) struct UpdateDownloadProgress {
    bytes: u64,
    total: Option<u64>,
}

/// Downloads an update installer/package to the user's Downloads folder.
/// Emits `update:download:progress` events with `{ bytes, total }` every 250 ms.
/// Returns the final absolute file path on success.
#[tauri::command]
pub(crate) async fn download_update(url: String, filename: String, app: tauri::AppHandle) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncWriteExt;

    const EMIT_INTERVAL: Duration = Duration::from_millis(250);

    let dest_dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let dest_path = dest_dir.join(&filename);
    let part_path = dest_dir.join(format!("{}.part", filename));

    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
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
pub(crate) async fn fetch_netease_lyrics(artist: String, title: String) -> Result<Option<String>, String> {
    let client = reqwest::Client::builder()
        .user_agent(subsonic_wire_user_agent())
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let query = format!("{} {}", artist, title);
    let params = [("s", query.as_str()), ("type", "1"), ("limit", "5")];
    let search: serde_json::Value = client
        .post("https://music.163.com/api/search/get")
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
pub(crate) fn get_embedded_lyrics(path: String) -> Option<String> {
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
    // In newer lofty versions, construct dynamic keys via ItemKey::from_key.
    let tagged = probe.read().ok()?;
    for tag in tagged.tags() {
        if let Some(sync_key) = ItemKey::from_key(tag.tag_type(), "SYNCEDLYRICS") {
            if let Some(lrc) = tag.get_string(sync_key) {
                let lrc = lrc.trim();
                if !lrc.is_empty() {
                    return Some(lrc.to_owned());
                }
            }
        }
        if let Some(plain) = tag.get_string(ItemKey::Lyrics) {
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
pub(crate) fn open_folder(path: String) -> Result<(), String> {
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
pub(crate) struct ZipProgress {
    id: String,
    bytes: u64,
    total: Option<u64>,
}

/// Downloads a server-generated ZIP (album/playlist) directly to disk via streaming.
/// Emits `download:zip:progress` events every 500 ms so the frontend can show
/// live MB-counter without holding any binary data in the WebView process.
/// Returns the final destination path on success.
#[tauri::command]
pub(crate) async fn download_zip(
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
        .user_agent(subsonic_wire_user_agent())
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
pub(crate) struct HotCacheDownloadResult {
    pub(crate) path: String,
    pub(crate) size: u64,
}

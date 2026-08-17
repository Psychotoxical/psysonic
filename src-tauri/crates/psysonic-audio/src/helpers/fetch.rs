use std::sync::atomic::Ordering;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};

use super::identity::same_playback_target;
use crate::engine::AudioEngine;

/// Fetch track bytes from the preload cache or via HTTP.
pub(crate) async fn fetch_data(
    url: &str,
    state: &AudioEngine,
    gen: u64,
    app: &AppHandle,
) -> Result<Option<Vec<u8>>, String> {
    // Check completed streamed-track cache first (manual streaming fallback cache).
    let streamed_cached = {
        let mut streamed = state.stream_completed_cache.lock().unwrap();
        if streamed
            .as_ref()
            .is_some_and(|p| same_playback_target(&p.url, url))
        {
            streamed.take().map(|p| p.data)
        } else {
            None
        }
    };
    if let Some(data) = streamed_cached {
        return Ok(Some(data));
    }

    // Spill path is cloned (not taken) so replay of the same URL can still read from disk
    // until hot-cache promote consumes the file via `take_stream_completed_spill_for_url`.
    let spill_path = {
        let guard = state.stream_completed_spill.lock().unwrap();
        guard
            .as_ref()
            .filter(|p| same_playback_target(&p.url, url))
            .map(|p| p.path.clone())
    };
    if let Some(path) = spill_path {
        let data = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        if !data.is_empty() {
            crate::app_deprintln!(
                "[stream] fetch_data from spill path={} bytes={}",
                path.display(),
                data.len()
            );
            return Ok(Some(data));
        }
    }

    // Check preload cache next.
    let cached = {
        let mut preloaded = state.preloaded.lock().unwrap();
        if preloaded
            .as_ref()
            .is_some_and(|p| same_playback_target(&p.url, url))
        {
            preloaded.take().map(|p| p.data)
        } else {
            None
        }
    };

    if let Some(data) = cached {
        return Ok(Some(data));
    }

    // Offline cache — local file written by download_track_offline.
    if let Some(path) = url.strip_prefix("psysonic-local://") {
        let data = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        return Ok(Some(data));
    }

    fetch_http_data(url, state, gen, app).await
}

/// Fetch bytes directly from HTTP, bypassing preload/completed caches.
/// Used when a cached buffer failed validation and a genuinely fresh body is required.
pub(crate) async fn fetch_http_data(
    url: &str,
    state: &AudioEngine,
    gen: u64,
    app: &AppHandle,
) -> Result<Option<Vec<u8>>, String> {
    let response = crate::engine::playback_scoped_get(state, app, url, None)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let ct = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    let server_hdr = response
        .headers()
        .get("server")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("-");
    // Strip auth params from URL before logging.
    let safe_url = url.split('?').next().unwrap_or(url);
    crate::app_deprintln!(
        "[audio] fetch {} → {} | content-type: {} | server: {}",
        safe_url,
        status,
        ct,
        server_hdr
    );
    if !response.status().is_success() {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded
        }
        let status = response.status().as_u16();
        let msg = format!("HTTP {status}");
        app.emit("audio:error", &msg).ok();
        return Err(msg);
    }
    // Stream the body, checking gen between chunks so a rapid manual skip can
    // abort a superseded download mid-flight and free bandwidth for the new one.
    let hint = response.content_length().unwrap_or(0) as usize;
    let mut stream = response.bytes_stream();
    let mut data = Vec::with_capacity(hint);
    while let Some(chunk) = stream.next().await {
        if state.generation.load(Ordering::SeqCst) != gen {
            return Ok(None); // superseded — abort
        }
        data.extend_from_slice(&chunk.map_err(|e| e.to_string())?);
    }
    Ok(Some(data))
}

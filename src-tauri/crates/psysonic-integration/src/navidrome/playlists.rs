//! Playlist CRUD via Navidrome's native REST API. The smart-playlist rules
//! payload is forwarded as-is so the frontend can compose any rule the
//! Navidrome version supports without backend changes.

use std::sync::Arc;

use psysonic_core::server_http::ServerHttpRegistry;
use tauri::State;

use super::client::{nd_apply_request, nd_err, nd_http_client, nd_retry};

/// GET `/api/playlist` — list playlists; pass `smart=true` to filter smart playlists.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn nd_list_playlists(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    smart: Option<bool>,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let base = format!("{}/api/playlist", server_url);
    let auth = format!("Bearer {}", token);
    let resp = nd_retry(|| {
        let base = base.clone();
        let auth = auth.clone();
        async move {
            let mut req = nd_apply_request(
                Some(reg),
                None,
                &base,
                nd_http_client()
                    .get(&base)
                    .header("X-ND-Authorization", auth),
            );
            if let Some(s) = smart {
                req = req.query(&[("smart", s)]);
            }
            req.send().await
        }
    })
    .await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// POST `/api/playlist` — create playlist (supports smart rules payload).
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn nd_create_playlist(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let url = format!("{}/api/playlist", server_url);
    let auth = format!("Bearer {}", token);
    let resp = nd_retry(|| {
        let url = url.clone();
        let auth = auth.clone();
        let body = body.clone();
        async move {
            nd_apply_request(
                Some(reg),
                None,
                &url,
                nd_http_client()
                    .post(&url)
                    .header("X-ND-Authorization", auth)
                    .json(&body),
            )
            .send()
            .await
        }
    })
    .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// PUT `/api/playlist/{id}` — update playlist (supports smart rules payload).
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn nd_update_playlist(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    id: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let url = format!("{}/api/playlist/{}", server_url, id);
    let auth = format!("Bearer {}", token);
    let resp = nd_retry(|| {
        let url = url.clone();
        let auth = auth.clone();
        let body = body.clone();
        async move {
            nd_apply_request(
                Some(reg),
                None,
                &url,
                nd_http_client()
                    .put(&url)
                    .header("X-ND-Authorization", auth)
                    .json(&body),
            )
            .send()
            .await
        }
    })
    .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

/// GET `/api/playlist/{id}` — get a single playlist (includes smart rules if available).
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn nd_get_playlist(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    id: String,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let url = format!("{}/api/playlist/{}", server_url, id);
    let auth = format!("Bearer {}", token);
    let resp = nd_retry(|| {
        let url = url.clone();
        let auth = auth.clone();
        async move {
            nd_apply_request(
                Some(reg),
                None,
                &url,
                nd_http_client()
                    .get(&url)
                    .header("X-ND-Authorization", auth),
            )
            .send()
            .await
        }
    })
    .await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

/// DELETE `/api/playlist/{id}` — delete playlist.
#[tauri::command]
#[specta::specta]
pub async fn nd_delete_playlist(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    id: String,
) -> Result<(), String> {
    let reg = http_registry.as_ref();
    let url = format!("{}/api/playlist/{}", server_url, id);
    let auth = format!("Bearer {}", token);
    let resp = nd_retry(|| {
        let url = url.clone();
        let auth = auth.clone();
        async move {
            nd_apply_request(
                Some(reg),
                None,
                &url,
                nd_http_client()
                    .delete(&url)
                    .header("X-ND-Authorization", auth),
            )
            .send()
            .await
        }
    })
    .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(())
}

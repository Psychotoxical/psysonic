//! Image / artwork upload + delete commands. Each command does a one-shot
//! login (via `navidrome_token`) and then a multipart POST to the relevant
//! `/api/{playlist|radio|artist}/{id}/image` endpoint.

use std::sync::Arc;

use psysonic_core::server_http::ServerHttpRegistry;
use tauri::State;

use super::client::{navidrome_token_with_registry, nd_apply_request, nd_http_client};

#[tauri::command]
#[specta::specta]
pub async fn upload_playlist_cover(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    playlist_id: String,
    username: String,
    password: String,
    file_bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), String> {
    let reg = http_registry.as_ref();
    let token = navidrome_token_with_registry(Some(reg), &server_url, &username, &password).await?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("cover.jpg")
        .mime_str(&mime_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("image", part);
    let url = format!("{}/api/playlist/{}/image", server_url, playlist_id);
    nd_apply_request(
        Some(reg),
        None,
        &url,
        nd_http_client()
            .post(&url)
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .multipart(form),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?
    .error_for_status()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn upload_radio_cover(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    radio_id: String,
    username: String,
    password: String,
    file_bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), String> {
    let reg = http_registry.as_ref();
    let token = navidrome_token_with_registry(Some(reg), &server_url, &username, &password).await?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("cover.jpg")
        .mime_str(&mime_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("image", part);
    let url = format!("{}/api/radio/{}/image", server_url, radio_id);
    nd_apply_request(
        Some(reg),
        None,
        &url,
        nd_http_client()
            .post(&url)
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .multipart(form),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?
    .error_for_status()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn upload_artist_image(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    artist_id: String,
    username: String,
    password: String,
    file_bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), String> {
    let reg = http_registry.as_ref();
    let token = navidrome_token_with_registry(Some(reg), &server_url, &username, &password).await?;
    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name("cover.jpg")
        .mime_str(&mime_type)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("image", part);
    let url = format!("{}/api/artist/{}/image", server_url, artist_id);
    nd_apply_request(
        Some(reg),
        None,
        &url,
        nd_http_client()
            .post(&url)
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .multipart(form),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?
    .error_for_status()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_radio_cover(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    radio_id: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let reg = http_registry.as_ref();
    let token = navidrome_token_with_registry(Some(reg), &server_url, &username, &password).await?;
    let url = format!("{}/api/radio/{}/image", server_url, radio_id);
    let resp = nd_apply_request(
        Some(reg),
        None,
        &url,
        nd_http_client()
            .delete(&url)
            .header("X-ND-Authorization", format!("Bearer {}", token)),
    )
    .send()
    .await
    .map_err(|e| e.to_string())?;
    // 404/503 = no image existed — treat as success
    if !resp.status().is_success()
        && resp.status() != reqwest::StatusCode::NOT_FOUND
        && resp.status() != reqwest::StatusCode::SERVICE_UNAVAILABLE
    {
        resp.error_for_status().map_err(|e| e.to_string())?;
    }
    Ok(())
}

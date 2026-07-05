//! Login + admin user CRUD. Each authenticated command takes a Bearer
//! `token` (obtained via `navidrome_login`); admin-only ones return 401/403
//! when the caller is not an admin.

use std::sync::Arc;

use psysonic_core::server_http::ServerHttpRegistry;
use tauri::State;

use super::client::{nd_apply_request, nd_err, nd_http_client, nd_retry, NdLoginResult};

/// Log in to Navidrome's native REST API. Returns a Bearer token and whether the user is admin.
#[tauri::command]
#[specta::specta]
pub async fn navidrome_login(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    username: String,
    password: String,
) -> Result<NdLoginResult, String> {
    let reg = http_registry.as_ref();
    let body = serde_json::json!({ "username": username, "password": password });
    let login_url = format!("{}/auth/login", server_url.trim_end_matches('/'));
    let resp = nd_retry(|| {
        let login_url = login_url.clone();
        let body = body.clone();
        async move {
            nd_apply_request(
                Some(reg),
                None,
                &login_url,
                nd_http_client().post(&login_url).json(&body),
            )
            .send()
            .await
        }
    })
    .await?;
    if !resp.status().is_success() {
        return Err(format!("Navidrome login failed: HTTP {}", resp.status()));
    }
    let data: serde_json::Value = resp.json().await.map_err(nd_err)?;
    let token = data["token"].as_str().ok_or("no token in response")?.to_string();
    let user_id = data["id"].as_str().unwrap_or("").to_string();
    let is_admin = data["isAdmin"].as_bool().unwrap_or(false);
    Ok(NdLoginResult {
        token,
        user_id,
        is_admin,
    })
}

/// GET `/api/user` — admin only. Returns the raw JSON array verbatim so the frontend can pick fields.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn nd_list_users(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let url = format!("{}/api/user", server_url);
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
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// POST `/api/user` — create a user.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn nd_create_user(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    user_name: String,
    name: String,
    email: String,
    password: String,
    is_admin: bool,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let body = serde_json::json!({
        "userName": user_name,
        "name": name,
        "email": email,
        "password": password,
        "isAdmin": is_admin,
    });
    let url = format!("{}/api/user", server_url);
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

/// PUT `/api/user/{id}` — update a user. Pass an empty `password` to leave it unchanged.
// NOT specta-collected: serde_json::Value in the command signature — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn nd_update_user(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    id: String,
    user_name: String,
    name: String,
    email: String,
    password: String,
    is_admin: bool,
) -> Result<serde_json::Value, String> {
    let reg = http_registry.as_ref();
    let mut body = serde_json::json!({
        "id": id,
        "userName": user_name,
        "name": name,
        "email": email,
        "isAdmin": is_admin,
    });
    if !password.is_empty() {
        body["password"] = serde_json::Value::String(password);
    }
    let url = format!("{}/api/user/{}", server_url, id);
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

/// DELETE `/api/user/{id}`.
#[tauri::command]
#[specta::specta]
pub async fn nd_delete_user(
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_url: String,
    token: String,
    id: String,
) -> Result<(), String> {
    let reg = http_registry.as_ref();
    let url = format!("{}/api/user/{}", server_url, id);
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

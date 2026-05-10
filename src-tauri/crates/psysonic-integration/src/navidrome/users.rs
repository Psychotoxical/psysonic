//! Login + admin user CRUD. Each authenticated command takes a Bearer
//! `token` (obtained via `navidrome_login`); admin-only ones return 401/403
//! when the caller is not an admin.

use super::client::{nd_err, nd_http_client, nd_retry, NdLoginResult};

/// Log in to Navidrome's native REST API. Returns a Bearer token and whether the user is admin.
#[tauri::command]
pub async fn navidrome_login(
    server_url: String,
    username: String,
    password: String,
) -> Result<NdLoginResult, String> {
    let body = serde_json::json!({ "username": username, "password": password });
    let resp = nd_retry(|| {
        nd_http_client()
            .post(format!("{}/auth/login", server_url))
            .json(&body)
            .send()
    }).await?;
    if !resp.status().is_success() {
        return Err(format!("Navidrome login failed: HTTP {}", resp.status()));
    }
    let data: serde_json::Value = resp.json().await.map_err(nd_err)?;
    let token = data["token"].as_str().ok_or("no token in response")?.to_string();
    let user_id = data["id"].as_str().unwrap_or("").to_string();
    let is_admin = data["isAdmin"].as_bool().unwrap_or(false);
    Ok(NdLoginResult { token, user_id, is_admin })
}

/// GET `/api/user` — admin only. Returns the raw JSON array verbatim so the frontend can pick fields.
#[tauri::command]
pub async fn nd_list_users(
    server_url: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .get(format!("{}/api/user", server_url))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    }).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// POST `/api/user` — create a user.
#[tauri::command]
pub async fn nd_create_user(
    server_url: String,
    token: String,
    user_name: String,
    name: String,
    email: String,
    password: String,
    is_admin: bool,
) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({
        "userName": user_name,
        "name": name,
        "email": email,
        "password": password,
        "isAdmin": is_admin,
    });
    let resp = nd_retry(|| {
        nd_http_client()
            .post(format!("{}/api/user", server_url))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
    }).await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// PUT `/api/user/{id}` — update a user. Pass an empty `password` to leave it unchanged.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn nd_update_user(
    server_url: String,
    token: String,
    id: String,
    user_name: String,
    name: String,
    email: String,
    password: String,
    is_admin: bool,
) -> Result<serde_json::Value, String> {
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
    let resp = nd_retry(|| {
        nd_http_client()
            .put(format!("{}/api/user/{}", server_url, id))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
    }).await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

/// DELETE `/api/user/{id}`.
#[tauri::command]
pub async fn nd_delete_user(
    server_url: String,
    token: String,
    id: String,
) -> Result<(), String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .delete(format!("{}/api/user/{}", server_url, id))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    }).await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(())
}

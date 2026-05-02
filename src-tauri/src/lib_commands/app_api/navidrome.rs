use super::*;

/// Authenticate with Navidrome's own REST API and return a Bearer token.
pub(crate) async fn navidrome_token(server_url: &str, username: &str, password: &str) -> Result<String, String> {
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
pub(crate) async fn upload_playlist_cover(
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
pub(crate) async fn upload_radio_cover(
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
pub(crate) async fn upload_artist_image(
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
pub(crate) async fn delete_radio_cover(
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

/// Payload returned by Navidrome's `/auth/login`.
#[derive(serde::Serialize)]
pub(crate) struct NdLoginResult {
    token: String,
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "isAdmin")]
    is_admin: bool,
}

/// Flatten an error and its `source` chain into a single readable string so
/// frontend toasts can show the actual transport cause (connection refused,
/// tls handshake fail, cert expired, etc.) instead of reqwest's opaque
/// "error sending request for url (…)" wrapper.
pub(crate) fn nd_err(e: reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
    while let Some(s) = src {
        msg.push_str(" | ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

/// Retry a request-building closure on transient transport errors
/// (connect/timeout — includes ECONNRESET, TLS handshake EOF, DNS flakes).
/// Three attempts with calm backoff: 0 → 300ms → 700ms (total worst case
/// ~1s). Retrying too aggressively (5+ attempts, short backoff) can drive
/// an already-stressed nginx upstream-probe into "offline" mode, which
/// turns a transient glitch into a visible outage. Status-level failures
/// (401/403/400 with body) return immediately — we don't retry logic
/// errors.
pub(crate) async fn nd_retry<F, Fut>(mut build_and_send: F) -> Result<reqwest::Response, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, reqwest::Error>>,
{
    const BACKOFFS_MS: [u64; 1] = [500];
    let mut last: Option<reqwest::Error> = None;
    for attempt in 0..=BACKOFFS_MS.len() {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(BACKOFFS_MS[attempt - 1])).await;
        }
        match build_and_send().await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                if !e.is_connect() && !e.is_timeout() {
                    return Err(nd_err(e));
                }
                last = Some(e);
            }
        }
    }
    Err(nd_err(last.expect("loop ran at least once")))
}

/// Build a reqwest client for Navidrome's native REST endpoints. Plain
/// `reqwest::Client::new()` defaults to HTTP/2 over ALPN with no User-Agent,
/// which some reverse-proxies (strict nginx rules, Cloudflare Tunnel, CDN
/// WAFs) abort mid-TLS-handshake. Pinning HTTP/1.1 and advertising a real
/// User-Agent makes the handshake match what browsers do for the Subsonic
/// endpoints, so `/auth/*` + `/api/*` go through the same path as `/rest/*`.
///
/// `pool_max_idle_per_host(0)` disables connection pooling. Keeping stale
/// keep-alive connections in the pool caused intermittent "tls handshake
/// eof" errors on the second call to an admin endpoint when a server or
/// proxy had already closed the TCP connection between calls.
pub(crate) fn nd_http_client() -> reqwest::Client {
    // TLS 1.2 only: rustls + nginx with TLS-1.3 session resumption caches
    // produces intermittent ECONNRESET mid-handshake when the upstream
    // starts churning keep-alive connections. Pinning TLS 1.2 matches what
    // the WebKit-side Subsonic calls end up negotiating most of the time
    // on these setups.
    reqwest::Client::builder()
        .user_agent(format!("Psysonic/{} (Tauri)", env!("CARGO_PKG_VERSION")))
        .http1_only()
        .pool_max_idle_per_host(0)
        .max_tls_version(reqwest::tls::Version::TLS_1_2)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Log in to Navidrome's native REST API. Returns a Bearer token and whether the user is admin.
#[tauri::command]
pub(crate) async fn navidrome_login(
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
pub(crate) async fn nd_list_users(
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
pub(crate) async fn nd_create_user(
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
pub(crate) async fn nd_update_user(
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
pub(crate) async fn nd_delete_user(
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

/// GET `/api/song?_sort=...&_order=...&_start=...&_end=...` — paginated song list.
/// Available to any authenticated user (no admin required). Returns raw JSON array.
#[tauri::command]
pub(crate) async fn nd_list_songs(
    server_url: String,
    token: String,
    sort: String,
    order: String,
    start: u32,
    end: u32,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/api/song?_sort={}&_order={}&_start={}&_end={}",
        server_url, sort, order, start, end
    );
    let resp = nd_retry(|| {
        nd_http_client()
            .get(&url)
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    }).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// GET `/api/library` — list all libraries (admin only). Returns the raw JSON array.
#[tauri::command]
pub(crate) async fn nd_list_libraries(
    server_url: String,
    token: String,
) -> Result<serde_json::Value, String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .get(format!("{}/api/library", server_url))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    }).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// PUT `/api/user/{id}/library` — assign libraries to a non-admin user.
/// Admin users auto-receive all libraries; calling this for an admin returns HTTP 400.
#[tauri::command]
pub(crate) async fn nd_set_user_libraries(
    server_url: String,
    token: String,
    id: String,
    library_ids: Vec<i64>,
) -> Result<(), String> {
    let body = serde_json::json!({ "libraryIds": library_ids });
    let resp = nd_retry(|| {
        nd_http_client()
            .put(format!("{}/api/user/{}/library", server_url, id))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
    }).await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(())
}

/// GET `/api/playlist` — list playlists; pass `smart=true` to filter smart playlists.
#[tauri::command]
pub(crate) async fn nd_list_playlists(
    server_url: String,
    token: String,
    smart: Option<bool>,
) -> Result<serde_json::Value, String> {
    let resp = nd_retry(|| {
        let client = nd_http_client();
        let mut req = client
            .get(format!("{}/api/playlist", server_url))
            .header("X-ND-Authorization", format!("Bearer {}", token));
        if let Some(s) = smart {
            req = req.query(&[("smart", s)]);
        }
        req.send()
    })
    .await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// POST `/api/playlist` — create playlist (supports smart rules payload).
#[tauri::command]
pub(crate) async fn nd_create_playlist(
    server_url: String,
    token: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .post(format!("{}/api/playlist", server_url))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
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
#[tauri::command]
pub(crate) async fn nd_update_playlist(
    server_url: String,
    token: String,
    id: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .put(format!("{}/api/playlist/{}", server_url, id))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .json(&body)
            .send()
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
#[tauri::command]
pub(crate) async fn nd_get_playlist(
    server_url: String,
    token: String,
    id: String,
) -> Result<serde_json::Value, String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .get(format!("{}/api/playlist/{}", server_url, id))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
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
pub(crate) async fn nd_delete_playlist(
    server_url: String,
    token: String,
    id: String,
) -> Result<(), String> {
    let resp = nd_retry(|| {
        nd_http_client()
            .delete(format!("{}/api/playlist/{}", server_url, id))
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    })
    .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status, text));
    }
    Ok(())
}

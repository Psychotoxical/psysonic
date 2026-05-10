//! Native-API queries that the Subsonic API doesn't cover or covers
//! incompletely: songs, role-filtered artist/album lists, libraries,
//! per-user library assignment, and absolute song path resolution.

use super::client::{navidrome_token, nd_err, nd_http_client, nd_retry};

/// GET `/api/song?_sort=...&_order=...&_start=...&_end=...` — paginated song list.
/// Available to any authenticated user (no admin required). Returns raw JSON array.
#[tauri::command]
pub async fn nd_list_songs(
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

/// Build the `_filters` JSON for native-API list calls. Optionally narrows the
/// query to a single library — `library_id` is the same scope key the Navidrome
/// web UI sends, and it matches the Subsonic `musicFolderId` we store per server.
fn nd_build_filters(seed: serde_json::Map<String, serde_json::Value>, library_id: Option<&str>) -> String {
    let mut obj = seed;
    if let Some(lib) = library_id {
        // Navidrome stores library ids as i64; our state holds them as strings
        // (Subsonic musicFolderId). Send numeric when parseable, fall back to
        // string for safety against future non-numeric ids.
        let val = lib.parse::<i64>()
            .map(|n| serde_json::Value::Number(n.into()))
            .unwrap_or_else(|_| serde_json::Value::String(lib.to_string()));
        obj.insert("library_id".to_string(), val);
    }
    serde_json::Value::Object(obj).to_string()
}

/// GET `/api/artist?_filters={"role":"<role>"}&_sort=...&_order=...&_start=...&_end=...`
/// — paginated list of artists that have at least one credit in the given role.
/// Navidrome 0.55.0+ (uses `library_artist.stats` JSON aggregate). Available to any
/// authenticated user. Returns raw JSON array.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn nd_list_artists_by_role(
    server_url: String,
    token: String,
    role: String,
    sort: String,
    order: String,
    start: u32,
    end: u32,
    library_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut seed = serde_json::Map::new();
    seed.insert("role".to_string(), serde_json::Value::String(role.clone()));
    let filters = nd_build_filters(seed, library_id.as_deref());
    let start_s = start.to_string();
    let end_s = end.to_string();
    let resp = nd_retry(|| {
        nd_http_client()
            .get(format!("{}/api/artist", server_url))
            .query(&[
                ("_filters", filters.as_str()),
                ("_sort", sort.as_str()),
                ("_order", order.as_str()),
                ("_start", start_s.as_str()),
                ("_end", end_s.as_str()),
            ])
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    }).await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>().await.map_err(nd_err)
}

/// GET `/api/album?_filters={"role_<role>_id":"<artistId>"}&_sort=...&_order=...&_start=...&_end=...`
/// — paginated list of albums in which `artist_id` holds the given participant role.
/// Subsonic `getArtist.view` only walks AlbumArtist relations, so composer-only
/// (or conductor-only, lyricist-only, …) credits are unreachable there. Navidrome
/// generates `role_<role>_id` filters dynamically from `model.AllRoles`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn nd_list_albums_by_artist_role(
    server_url: String,
    token: String,
    artist_id: String,
    role: String,
    sort: String,
    order: String,
    start: u32,
    end: u32,
    library_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let filter_key = format!("role_{}_id", role);
    let mut seed = serde_json::Map::new();
    seed.insert(filter_key, serde_json::Value::String(artist_id.clone()));
    let filters = nd_build_filters(seed, library_id.as_deref());
    let start_s = start.to_string();
    let end_s = end.to_string();
    let resp = nd_retry(|| {
        nd_http_client()
            .get(format!("{}/api/album", server_url))
            .query(&[
                ("_filters", filters.as_str()),
                ("_sort", sort.as_str()),
                ("_order", order.as_str()),
                ("_start", start_s.as_str()),
                ("_end", end_s.as_str()),
            ])
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
pub async fn nd_list_libraries(
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
pub async fn nd_set_user_libraries(
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

/// GET `/api/song/{id}` and return the absolute filesystem `path` field.
///
/// Subsonic `getSong.view` returns at most a relative path (`Artist/Album/track.flac`),
/// or nothing at all on Navidrome. The Navidrome native API exposes the absolute
/// path the server stores the file at — same source Feishin and the Navidrome web
/// client use for their "show file location" feature. Logs in fresh (no token
/// cache yet); the call is occasional (Song Info modal open) so the extra
/// roundtrip is acceptable.
///
/// Returns `Ok(None)` when the response has no `path` field — Navidrome can omit
/// it for non-admin users on some configurations.
#[tauri::command]
pub async fn nd_get_song_path(
    server_url: String,
    username: String,
    password: String,
    id: String,
) -> Result<Option<String>, String> {
    let token = navidrome_token(&server_url, &username, &password).await?;
    let url = format!("{}/api/song/{}", server_url, id);
    let resp = nd_retry(|| {
        nd_http_client()
            .get(&url)
            .header("X-ND-Authorization", format!("Bearer {}", token))
            .send()
    })
    .await?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let data: serde_json::Value = resp.json().await.map_err(nd_err)?;
    Ok(data["path"].as_str().map(|s| s.to_string()).filter(|s| !s.is_empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_json_object(s: &str) -> serde_json::Map<String, serde_json::Value> {
        let v: serde_json::Value = serde_json::from_str(s).expect("valid JSON");
        v.as_object().expect("object").clone()
    }

    #[test]
    fn build_filters_emits_seed_unchanged_when_library_id_none() {
        let mut seed = serde_json::Map::new();
        seed.insert("role".to_string(), serde_json::Value::String("composer".to_string()));
        let out = nd_build_filters(seed, None);
        let parsed = parse_json_object(&out);
        assert_eq!(parsed.get("role").unwrap(), "composer");
        assert!(!parsed.contains_key("library_id"));
    }

    #[test]
    fn build_filters_inserts_numeric_library_id_when_parseable() {
        let seed = serde_json::Map::new();
        let out = nd_build_filters(seed, Some("42"));
        let parsed = parse_json_object(&out);
        let lib = parsed.get("library_id").expect("library_id present");
        assert_eq!(lib.as_i64(), Some(42), "numeric library_id stored as Number");
    }

    #[test]
    fn build_filters_falls_back_to_string_for_non_numeric_library_id() {
        let seed = serde_json::Map::new();
        let out = nd_build_filters(seed, Some("abc-123"));
        let parsed = parse_json_object(&out);
        let lib = parsed.get("library_id").expect("library_id present");
        assert_eq!(lib.as_str(), Some("abc-123"));
        assert!(lib.as_i64().is_none());
    }

    #[test]
    fn build_filters_preserves_existing_seed_keys_alongside_library_id() {
        let mut seed = serde_json::Map::new();
        seed.insert("role".to_string(), serde_json::Value::String("conductor".to_string()));
        seed.insert(
            "role_lyricist_id".to_string(),
            serde_json::Value::String("artist-7".to_string()),
        );
        let out = nd_build_filters(seed, Some("3"));
        let parsed = parse_json_object(&out);
        assert_eq!(parsed.get("role").unwrap(), "conductor");
        assert_eq!(parsed.get("role_lyricist_id").unwrap(), "artist-7");
        assert_eq!(parsed.get("library_id").unwrap().as_i64(), Some(3));
    }
}

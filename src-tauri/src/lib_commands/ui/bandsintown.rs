use super::*;

// ── Bandsintown ──────────────────────────────────────────────────────────────
// Public REST API: https://rest.bandsintown.com/artists/{name}/events?app_id=…
// Bandsintown whitelists app IDs — arbitrary strings now return 403 Forbidden.
// `js_app_id` is the ID their own embeddable widget uses and is broadly accepted.
pub(crate) const BANDSINTOWN_APP_ID: &str = "js_app_id";

#[derive(serde::Serialize, Default)]
pub(crate) struct BandsintownEvent {
    datetime: String,        // ISO 8601 (e.g. "2026-04-23T20:30:00")
    venue_name: String,
    venue_city: String,
    venue_region: String,
    venue_country: String,
    url: String,
    on_sale_datetime: String,
    lineup: Vec<String>,
}

/// Fetch upcoming Bandsintown events for an artist by name.
/// Returns an empty list on any failure (404, network, parse) — the UI
/// just hides the section in that case.
#[tauri::command]
pub(crate) async fn fetch_bandsintown_events(artist_name: String) -> Result<Vec<BandsintownEvent>, String> {
    let trimmed = artist_name.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    // Bandsintown expects the artist name URL-encoded; their API treats `/` as a
    // path separator (so e.g. AC/DC must be encoded as AC%252FDC).
    let encoded: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
    let url = format!(
        "https://rest.bandsintown.com/artists/{}/events?app_id={}",
        encoded, BANDSINTOWN_APP_ID
    );
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(vec![]),
    };
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return Ok(vec![]),
    };
    if !resp.status().is_success() {
        return Ok(vec![]);
    }
    let raw: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(vec![]),
    };
    let arr = match raw.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };
    let mut out: Vec<BandsintownEvent> = Vec::with_capacity(arr.len().min(20));
    for item in arr.iter().take(20) {
        let venue = item.get("venue").cloned().unwrap_or(serde_json::Value::Null);
        let lineup = item
            .get("lineup")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default();
        out.push(BandsintownEvent {
            datetime: item.get("datetime").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            venue_name: venue.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            venue_city: venue.get("city").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            venue_region: venue.get("region").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            venue_country: venue.get("country").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            url: item.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            on_sale_datetime: item.get("on_sale_datetime").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            lineup,
        });
    }
    Ok(out)
}

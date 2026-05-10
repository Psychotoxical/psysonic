//! Discord Rich Presence integration.
//!
//! Album artwork is fetched from the iTunes Search API and passed directly to
//! Discord via the large_image URL field. This avoids the need to pre-upload
//! assets to the Discord Developer Portal.
//!
//! The commands silently no-op when Discord is not running or the App ID is wrong,
//! so the app always starts cleanly regardless of Discord availability.

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use reqwest::blocking::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const DISCORD_APP_ID: &str = "1489544859718258779";

/// Cache entry for iTunes artwork lookup (avoids repeated API calls for same album).
pub struct ArtworkCacheEntry {
    pub url: String,
    pub fetched_at: Instant,
}

/// TTL: 1 hour — album artwork doesn't change, but we don't want to cache failures forever.
const ARTWORK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

pub struct DiscordState {
    pub client: Mutex<Option<DiscordIpcClient>>,
    /// Cache: "artist|album" -> artwork URL. Arc so it can be shared into spawn_blocking.
    pub artwork_cache: Arc<Mutex<HashMap<String, ArtworkCacheEntry>>>,
    /// HTTP client for iTunes API requests. blocking::Client is Clone (Arc-internally).
    pub http_client: Client,
}

impl DiscordState {
    pub fn new() -> Self {
        DiscordState {
            client: Mutex::new(None),
            artwork_cache: Arc::new(Mutex::new(HashMap::new())),
            http_client: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }
}

impl Default for DiscordState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── iTunes Search API ───────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct ItunesResponse {
    results: Vec<ItunesResult>,
}

#[derive(Deserialize, Debug)]
#[allow(non_snake_case)]
struct ItunesResult {
    collectionName: Option<String>,
    artistName: Option<String>,
    artworkUrl100: Option<String>,
}

/// Normalize string for comparison: lowercase, trim, collapse whitespace.
fn normalize(s: &str) -> String {
    s.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Search for album artwork via iTunes Search API.
/// Returns a higher-resolution URL (600x600) if found.
///
/// Takes explicit `client` and `cache` so this can be called from inside
/// `tokio::task::spawn_blocking` without needing a reference to `DiscordState`.
/// iTunes Search API endpoint. Lifted to a constant so [`search_itunes_artwork_with_base`]
/// can be redirected at a wiremock instance in tests.
const ITUNES_SEARCH_URL: &str = "https://itunes.apple.com/search";

fn search_itunes_artwork(
    client: &Client,
    cache: &Mutex<HashMap<String, ArtworkCacheEntry>>,
    artist: &str,
    album: &str,
    title: &str,
) -> Option<String> {
    search_itunes_artwork_with_base(client, cache, artist, album, title, ITUNES_SEARCH_URL)
}

/// Test-friendly variant of [`search_itunes_artwork`] that takes the search
/// endpoint as a parameter. Production calls always go through the wrapper
/// above, which pins the iTunes URL.
fn search_itunes_artwork_with_base(
    client: &Client,
    cache: &Mutex<HashMap<String, ArtworkCacheEntry>>,
    artist: &str,
    album: &str,
    title: &str,
    base_url: &str,
) -> Option<String> {
    let cache_key = format!("{}|{}", artist, album);

    // Check cache first
    {
        let c = cache.lock().ok()?;
        if let Some(entry) = c.get(&cache_key) {
            if entry.fetched_at.elapsed() < ARTWORK_CACHE_TTL {
                return Some(entry.url.clone());
            }
        }
    }

    let norm_artist = normalize(artist);
    let norm_album = normalize(album);
    let norm_title = normalize(title);

    // Strategy 1: exact match search — "artist" "album"
    let mut url = url::Url::parse(base_url).ok()?;
    url.query_pairs_mut()
        .append_pair("term", &format!("\"{}\" \"{}\"", artist, album))
        .append_pair("media", "music")
        .append_pair("entity", "album")
        .append_pair("limit", "5");

    if let Some(result) = search_with_url(client, url, &norm_artist, &norm_album) {
        cache_and_return(cache, cache_key, &result);
        return Some(result);
    }

    // Strategy 2: relaxed search — artist album (no quotes)
    let mut url = url::Url::parse(base_url).ok()?;
    url.query_pairs_mut()
        .append_pair("term", &format!("{} {}", artist, album))
        .append_pair("media", "music")
        .append_pair("entity", "album")
        .append_pair("limit", "10");

    if let Some(result) = search_with_url(client, url, &norm_artist, &norm_album) {
        cache_and_return(cache, cache_key, &result);
        return Some(result);
    }

    // Strategy 3: search by track title — artist + title (for singles/rare albums)
    if !title.is_empty() {
        let mut url = url::Url::parse(base_url).ok()?;
        url.query_pairs_mut()
            .append_pair("term", &format!("{} {}", artist, title))
            .append_pair("media", "music")
            .append_pair("entity", "song")
            .append_pair("limit", "10");

        if let Some(result) = search_with_url(client, url, &norm_artist, &norm_title) {
            cache_and_return(cache, cache_key, &result);
            return Some(result);
        }
    }

    None
}

fn search_with_url(
    client: &Client,
    url: url::Url,
    norm_artist: &str,
    norm_album: &str,
) -> Option<String> {
    let resp = client.get(url).send().ok()?;
    let body: ItunesResponse = resp.json().ok()?;

    for result in &body.results {
        let collection = normalize(result.collectionName.as_deref().unwrap_or(""));
        let result_artist = normalize(result.artistName.as_deref().unwrap_or(""));

        // Flexible matching: check if strings contain each other
        // This handles cases like "The Beatles" vs "Beatles" or album subtitle differences
        let artist_match = norm_artist == result_artist
            || norm_artist.contains(&result_artist)
            || result_artist.contains(norm_artist)
            || words_overlap(norm_artist, &result_artist);

        let album_match = norm_album == collection
            || norm_album.contains(&collection)
            || collection.contains(norm_album)
            || words_overlap(norm_album, &collection);

        if artist_match && album_match {
            return Some(result.artworkUrl100.as_ref()?.replace("100x100", "600x600"));
        }
    }

    None
}

/// Check if two strings share at least 50% of their words.
fn words_overlap(a: &str, b: &str) -> bool {
    let words_a: std::collections::HashSet<_> = a.split_whitespace().collect();
    let words_b: std::collections::HashSet<_> = b.split_whitespace().collect();

    if words_a.is_empty() || words_b.is_empty() {
        return false;
    }

    let common = words_a.intersection(&words_b).count();
    let min_len = words_a.len().min(words_b.len());

    common >= min_len / 2 + min_len % 2 // At least 50% overlap
}

fn cache_and_return(
    cache: &Mutex<HashMap<String, ArtworkCacheEntry>>,
    key: String,
    url: &str,
) {
    if let Ok(mut c) = cache.lock() {
        c.insert(
            key,
            ArtworkCacheEntry {
                url: url.to_string(),
                fetched_at: Instant::now(),
            },
        );
    }
}

/// Try to create and connect a fresh IPC client. Returns None silently on failure.
///
/// In debug builds (i.e. `npx tauri dev`) every step of the IPC handshake is
/// logged so the renderer's terminal output shows exactly where the
/// connection breaks. Release builds stay completely silent.
fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
    if let Err(_e) = client.connect() {
        #[cfg(debug_assertions)]
        crate::app_eprintln!("[discord] connect() failed: {} (Discord desktop running?)", _e);
        return None;
    }
    #[cfg(debug_assertions)]
    crate::app_eprintln!("[discord] IPC connected (app_id={})", DISCORD_APP_ID);
    Some(client)
}

/// Apply a template string, replacing placeholders with actual values.
/// Supported placeholders: {title}, {artist}, {album}
fn apply_template(template: &str, title: &str, artist: &str, album: Option<&str>) -> String {
    let album_text = album.unwrap_or("");
    template
        .replace("{title}", title)
        .replace("{artist}", artist)
        .replace("{album}", album_text)
}

/// Bundled output of [`compute_discord_text_fields`].
pub(crate) struct DiscordTextFields {
    pub details: String,
    pub state: String,
    pub large_text: String,
}

/// Pure helper: resolve all three configurable Discord text fields, applying
/// the supplied templates (or falling back to documented defaults).
pub(crate) fn compute_discord_text_fields(
    title: &str,
    artist: &str,
    album: Option<&str>,
    details_template: Option<&str>,
    state_template: Option<&str>,
    large_text_template: Option<&str>,
) -> DiscordTextFields {
    let details = apply_template(
        details_template.unwrap_or("{artist} - {title}"),
        title,
        artist,
        album,
    );
    let state = apply_template(state_template.unwrap_or("{album}"), title, artist, album);
    let large_text = apply_template(
        large_text_template.unwrap_or("{album}"),
        title,
        artist,
        album,
    );
    DiscordTextFields {
        details,
        state,
        large_text,
    }
}

/// Pure helper: compute the Unix-timestamp `start` field that Discord uses
/// to show "X minutes elapsed" when `elapsed_secs` is supplied.
pub(crate) fn compute_discord_start_timestamp(elapsed_secs: f64, now_unix_secs: i64) -> i64 {
    now_unix_secs - elapsed_secs.floor() as i64
}

/// Update the Discord Rich Presence activity.
///
/// - `is_playing`: true = playing (timer shown), false = paused (no timer, state shows "Paused").
/// - `elapsed_secs`: seconds already played. `None` when paused — no timestamp is sent so
///   Discord stops any running timer.
/// - `cover_art_url`: optional direct URL to album artwork.
/// - `fetch_itunes_covers`: if true, fetch artwork from the iTunes Search API when no
///   `cover_art_url` is provided. If false (default), fall back to the Psysonic app icon
///   without making any external request — required for privacy opt-in.
/// - `details_template`: template string for the "details" field. Default: "{artist} - {title}".
///   Supported placeholders: {title}, {artist}, {album}
/// - `state_template`: template string for the "state" field. Default: "{album}".
///   Supported placeholders: {title}, {artist}, {album}
/// - `large_text_template`: template string for the large image tooltip. Default: "{album}".
///   Supported placeholders: {title}, {artist}, {album}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn discord_update_presence(
    state: tauri::State<'_, DiscordState>,
    title: String,
    artist: String,
    album: Option<String>,
    is_playing: bool,
    elapsed_secs: Option<f64>,
    cover_art_url: Option<String>,
    fetch_itunes_covers: bool,
    details_template: Option<String>,
    state_template: Option<String>,
    large_text_template: Option<String>,
) -> Result<(), String> {
    // Resolve artwork on a dedicated blocking thread — reqwest::blocking must not
    // run on the Tokio async executor directly.
    // Only hit the iTunes API if the user has explicitly opted in.
    let artwork_url: Option<String> = if let Some(url) = cover_art_url {
        Some(url)
    } else if fetch_itunes_covers {
        if let Some(ref album_name) = album {
            let http_client = state.http_client.clone();
            let cache = Arc::clone(&state.artwork_cache);
            let artist_c = artist.clone();
            let album_c = album_name.clone();
            let title_c = title.clone();
            tokio::task::spawn_blocking(move || {
                search_itunes_artwork(&http_client, &cache, &artist_c, &album_c, &title_c)
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        }
    } else {
        None
    };

    let mut guard = state.client.lock().unwrap();

    // (Re)connect lazily — handles the case where Discord starts after the app.
    if guard.is_none() {
        match try_connect() {
            Some(client) => *guard = Some(client),
            None => return Ok(()), // Discord not running — silently skip
        }
    }

    let client = guard.as_mut().unwrap();

    let texts = compute_discord_text_fields(
        &title,
        &artist,
        album.as_deref(),
        details_template.as_deref(),
        state_template.as_deref(),
        large_text_template.as_deref(),
    );

    let assets = if let Some(ref url) = artwork_url {
        Assets::new()
            .large_image(url.as_str())
            .large_text(&texts.large_text)
    } else {
        // Fallback to default Psysonic icon
        Assets::new()
            .large_image("psysonic")
            .large_text(&texts.large_text)
    };

    // When paused: clear activity completely to avoid any timer issues
    // When playing: show full activity with timer
    if !is_playing {
        if let Err(_e) = client.clear_activity() {
            #[cfg(debug_assertions)]
            crate::app_eprintln!("[discord] clear_activity (pause) failed, dropping client: {}", _e);
            *guard = None;
        }
        return Ok(());
    }

    // Only reach here when playing
    let activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(&texts.details)
        .state(&texts.state)
        .assets(assets)
        .timestamps(if let Some(elapsed) = elapsed_secs {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            Timestamps::new().start(compute_discord_start_timestamp(elapsed, now))
        } else {
            Timestamps::new()
        });

    if let Err(_e) = client.set_activity(activity) {
        #[cfg(debug_assertions)]
        crate::app_eprintln!("[discord] set_activity failed, dropping client: {}", _e);
        *guard = None;
    } else {
        #[cfg(debug_assertions)]
        crate::app_eprintln!(
            "[discord] activity sent: \"{}\" / \"{}\"",
            texts.details,
            texts.state
        );
    }

    Ok(())
}

/// Clear the Discord Rich Presence activity (e.g. playback stopped).
#[tauri::command]
pub fn discord_clear_presence(state: tauri::State<DiscordState>) -> Result<(), String> {
    let mut guard = state.client.lock().unwrap();
    if let Some(client) = guard.as_mut() {
        if let Err(_e) = client.clear_activity() {
            #[cfg(debug_assertions)]
            crate::app_eprintln!("[discord] clear_activity failed, dropping client: {}", _e);
            *guard = None;
        } else {
            #[cfg(debug_assertions)]
            crate::app_eprintln!("[discord] activity cleared");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ── normalize ─────────────────────────────────────────────────────────────

    #[test]
    fn normalize_lowercases_and_collapses_whitespace() {
        assert_eq!(normalize("  Pink   FLOYD  "), "pink floyd");
        assert_eq!(normalize("The\tBeatles\n"), "the beatles");
    }

    #[test]
    fn normalize_returns_empty_for_pure_whitespace() {
        assert_eq!(normalize(""), "");
        assert_eq!(normalize("   "), "");
    }

    #[test]
    fn normalize_preserves_unicode_letters() {
        assert_eq!(normalize("Sigur Rós"), "sigur rós");
        assert_eq!(normalize("Mötley Crüe"), "mötley crüe");
    }

    // ── words_overlap ─────────────────────────────────────────────────────────

    #[test]
    fn words_overlap_returns_false_for_empty_inputs() {
        assert!(!words_overlap("", "anything"));
        assert!(!words_overlap("anything", ""));
        assert!(!words_overlap("", ""));
    }

    #[test]
    fn words_overlap_returns_true_for_full_match() {
        assert!(words_overlap("a b c", "a b c"));
    }

    #[test]
    fn words_overlap_meets_50_percent_threshold() {
        // "a b" vs "a c" — 1 of 2 words overlap → 50% (just meets ceil-half).
        assert!(words_overlap("a b", "a c"));
    }

    #[test]
    fn words_overlap_below_threshold_returns_false() {
        // 1 of 4 words overlap = 25%.
        assert!(!words_overlap("a b c d", "a x y z"));
    }

    #[test]
    fn words_overlap_handles_asymmetric_lengths() {
        // "the beatles" (2 words) vs "the beatles greatest hits" (4 words):
        // 2 common, min_len = 2 → threshold = 1+0 = 1, so true.
        assert!(words_overlap("the beatles", "the beatles greatest hits"));
    }

    // ── apply_template ────────────────────────────────────────────────────────

    #[test]
    fn apply_template_replaces_all_placeholders() {
        let out = apply_template(
            "{artist} - {title} ({album})",
            "Comfortably Numb",
            "Pink Floyd",
            Some("The Wall"),
        );
        assert_eq!(out, "Pink Floyd - Comfortably Numb (The Wall)");
    }

    #[test]
    fn apply_template_substitutes_empty_for_missing_album() {
        let out = apply_template("{album}", "t", "a", None);
        assert_eq!(out, "");
    }

    #[test]
    fn apply_template_leaves_unknown_placeholders_untouched() {
        // Only {title}, {artist}, {album} are supported — {year} stays literal.
        let out = apply_template("{title} ({year})", "t", "a", None);
        assert_eq!(out, "t ({year})");
    }

    #[test]
    fn apply_template_repeats_replacement_for_repeated_placeholder() {
        let out = apply_template("{artist} / {artist}", "t", "AC/DC", None);
        assert_eq!(out, "AC/DC / AC/DC");
    }

    // ── compute_discord_text_fields ──────────────────────────────────────────

    #[test]
    fn text_fields_use_documented_defaults_when_templates_are_none() {
        let f = compute_discord_text_fields("Song", "Artist", Some("Album"), None, None, None);
        assert_eq!(f.details, "Artist - Song");
        assert_eq!(f.state, "Album");
        assert_eq!(f.large_text, "Album");
    }

    #[test]
    fn text_fields_apply_supplied_templates_overriding_defaults() {
        let f = compute_discord_text_fields(
            "Song",
            "Artist",
            Some("Album"),
            Some("{title} | {album}"),
            Some("by {artist}"),
            Some("{album} ({artist})"),
        );
        assert_eq!(f.details, "Song | Album");
        assert_eq!(f.state, "by Artist");
        assert_eq!(f.large_text, "Album (Artist)");
    }

    #[test]
    fn text_fields_substitute_empty_for_missing_album() {
        let f = compute_discord_text_fields("Song", "Artist", None, None, None, None);
        // {album} placeholder → empty, but the surrounding template stays.
        assert_eq!(f.details, "Artist - Song");
        assert_eq!(f.state, "");
        assert_eq!(f.large_text, "");
    }

    #[test]
    fn text_fields_handle_unicode_and_special_characters() {
        let f = compute_discord_text_fields(
            "Bohemian Rhapsody",
            "Queen",
            Some("A Night at the Opera"),
            Some("{artist} – {title}"),
            None,
            None,
        );
        assert_eq!(f.details, "Queen – Bohemian Rhapsody");
    }

    // ── compute_discord_start_timestamp ──────────────────────────────────────

    #[test]
    fn start_timestamp_subtracts_floor_of_elapsed() {
        // elapsed=42.7 → floor=42; start = now - 42
        assert_eq!(compute_discord_start_timestamp(42.7, 1_700_000_000), 1_699_999_958);
    }

    #[test]
    fn start_timestamp_for_zero_elapsed_equals_now() {
        assert_eq!(compute_discord_start_timestamp(0.0, 1_700_000_000), 1_700_000_000);
    }

    #[test]
    fn start_timestamp_handles_fractional_seconds_via_floor() {
        // 0.999 → floor 0 (same as just-started)
        assert_eq!(compute_discord_start_timestamp(0.999, 1_700_000_000), 1_700_000_000);
        // 1.0001 → floor 1
        assert_eq!(compute_discord_start_timestamp(1.0001, 1_700_000_000), 1_699_999_999);
    }

    // ── cache_and_return ──────────────────────────────────────────────────────

    #[test]
    fn cache_and_return_inserts_entry_with_url() {
        let cache: Mutex<HashMap<String, ArtworkCacheEntry>> = Mutex::new(HashMap::new());
        cache_and_return(&cache, "key".to_string(), "https://example/600x600.jpg");
        let g = cache.lock().unwrap();
        let entry = g.get("key").expect("entry inserted");
        assert_eq!(entry.url, "https://example/600x600.jpg");
        // fetched_at is set to now() — sanity-check it's recent.
        assert!(entry.fetched_at.elapsed() < std::time::Duration::from_secs(1));
    }

    // ── search_with_url against wiremock ──────────────────────────────────────

    fn itunes_blocking_client() -> Client {
        // Mirror the production builder used by DiscordState.
        Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search_with_url_returns_600x600_when_artist_and_album_match() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "collectionName": "The Wall",
                        "artistName": "Pink Floyd",
                        "artworkUrl100": "https://is1-ssl.mzstatic.com/100x100bb.jpg"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let url = url::Url::parse(&format!("{server_uri}/search")).unwrap();
            search_with_url(&itunes_blocking_client(), url, "pink floyd", "the wall")
        })
        .await
        .unwrap();

        assert_eq!(
            result,
            Some("https://is1-ssl.mzstatic.com/600x600bb.jpg".to_string()),
            "100x100 must be replaced with 600x600"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search_with_url_returns_none_when_no_results_match() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "collectionName": "Some Other Album",
                        "artistName": "Different Artist",
                        "artworkUrl100": "https://x/100x100.jpg"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let url = url::Url::parse(&format!("{server_uri}/search")).unwrap();
            search_with_url(&itunes_blocking_client(), url, "pink floyd", "the wall")
        })
        .await
        .unwrap();

        assert!(result.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search_with_url_returns_none_for_empty_results() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": []
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let url = url::Url::parse(&format!("{server_uri}/search")).unwrap();
            search_with_url(&itunes_blocking_client(), url, "x", "y")
        })
        .await
        .unwrap();

        assert!(result.is_none());
    }

    // ── search_itunes_artwork_with_base — full strategy ladder + cache ──────

    #[tokio::test(flavor = "multi_thread")]
    async fn artwork_with_base_returns_cached_url_without_network() {
        // No mock — if the function tries to hit the network it'll fail with
        // a transport error rather than the cached value.
        let server = MockServer::start().await;
        let cache: Mutex<HashMap<String, ArtworkCacheEntry>> = Mutex::new(HashMap::new());
        cache.lock().unwrap().insert(
            "Pink Floyd|The Wall".to_string(),
            ArtworkCacheEntry {
                url: "https://cached/600x600.jpg".to_string(),
                fetched_at: Instant::now(),
            },
        );

        let server_uri = server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let url = format!("{server_uri}/search");
            search_itunes_artwork_with_base(
                &itunes_blocking_client(),
                &cache,
                "Pink Floyd",
                "The Wall",
                "Comfortably Numb",
                &url,
            )
        })
        .await
        .unwrap();

        assert_eq!(result, Some("https://cached/600x600.jpg".to_string()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn artwork_with_base_uses_strategy_1_when_exact_match_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "collectionName": "The Wall",
                        "artistName": "Pink Floyd",
                        "artworkUrl100": "https://itunes/strategy1/100x100.jpg"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let cache: Mutex<HashMap<String, ArtworkCacheEntry>> = Mutex::new(HashMap::new());
        let result = tokio::task::spawn_blocking(move || {
            let url = format!("{server_uri}/search");
            search_itunes_artwork_with_base(
                &itunes_blocking_client(),
                &cache,
                "Pink Floyd",
                "The Wall",
                "Comfortably Numb",
                &url,
            )
        })
        .await
        .unwrap();

        assert_eq!(
            result,
            Some("https://itunes/strategy1/600x600.jpg".to_string()),
            "first matching strategy returns immediately + caches"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn artwork_with_base_returns_none_when_no_strategy_matches() {
        let server = MockServer::start().await;
        // Server always returns empty results — every strategy misses.
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": []
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let cache: Mutex<HashMap<String, ArtworkCacheEntry>> = Mutex::new(HashMap::new());
        let result = tokio::task::spawn_blocking(move || {
            let url = format!("{server_uri}/search");
            search_itunes_artwork_with_base(
                &itunes_blocking_client(),
                &cache,
                "Unknown",
                "Album",
                "Title",
                &url,
            )
        })
        .await
        .unwrap();

        assert!(result.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn artwork_with_base_caches_successful_lookup_for_subsequent_calls() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "collectionName": "Album",
                        "artistName": "Artist",
                        "artworkUrl100": "https://itunes/cached/100x100.jpg"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let cache: Arc<Mutex<HashMap<String, ArtworkCacheEntry>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let cache_clone = Arc::clone(&cache);
        let _first = tokio::task::spawn_blocking(move || {
            let url = format!("{server_uri}/search");
            search_itunes_artwork_with_base(
                &itunes_blocking_client(),
                &cache_clone,
                "Artist",
                "Album",
                "T",
                &url,
            )
        })
        .await
        .unwrap();

        // After first lookup, cache must hold the resolved URL.
        let entry_url = cache.lock().unwrap().get("Artist|Album").map(|e| e.url.clone());
        assert_eq!(
            entry_url,
            Some("https://itunes/cached/600x600.jpg".to_string()),
            "successful lookup must populate the artwork cache",
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn search_with_url_uses_words_overlap_for_fuzzy_artist_match() {
        // Server returns "The Beatles" but our normalised query is just "beatles" —
        // contains() catches it, but this exercises the words_overlap branch by
        // using artist names where neither contains the other and only word overlap
        // matches.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "collectionName": "Help",
                        "artistName": "The Fab Four Beatles",
                        "artworkUrl100": "https://x/100x100.jpg"
                    }
                ]
            })))
            .mount(&server)
            .await;

        let server_uri = server.uri();
        let result = tokio::task::spawn_blocking(move || {
            let url = url::Url::parse(&format!("{server_uri}/search")).unwrap();
            // "fab beatles" vs "the fab four beatles" — word overlap = 2 of 2,
            // 50% threshold met, contains() also catches "beatles".
            search_with_url(&itunes_blocking_client(), url, "fab beatles", "help")
        })
        .await
        .unwrap();

        assert_eq!(result, Some("https://x/600x600.jpg".to_string()));
    }
}

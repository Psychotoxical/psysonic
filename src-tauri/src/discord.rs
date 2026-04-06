/// Discord Rich Presence integration.
///
/// Album artwork is fetched from the iTunes Search API and passed directly to
/// Discord via the large_image URL field. This avoids the need to pre-upload
/// assets to the Discord Developer Portal.
///
/// The commands silently no-op when Discord is not running or the App ID is wrong,
/// so the app always starts cleanly regardless of Discord availability.

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use reqwest::blocking::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
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
    /// Cache: "artist|album" -> artwork URL
    pub artwork_cache: Mutex<HashMap<String, ArtworkCacheEntry>>,
    /// HTTP client for iTunes API requests.
    pub http_client: Client,
}

impl DiscordState {
    pub fn new() -> Self {
        DiscordState {
            client: Mutex::new(None),
            artwork_cache: Mutex::new(HashMap::new()),
            http_client: Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
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
fn search_itunes_artwork(state: &DiscordState, artist: &str, album: &str, title: &str) -> Option<String> {
    let cache_key = format!("{}|{}", artist, album);

    // Check cache first
    {
        let cache = state.artwork_cache.lock().ok()?;
        if let Some(entry) = cache.get(&cache_key) {
            if entry.fetched_at.elapsed() < ARTWORK_CACHE_TTL {
                return Some(entry.url.clone());
            }
        }
    }

    let norm_artist = normalize(artist);
    let norm_album = normalize(album);
    let norm_title = normalize(title);

    // Strategy 1: exact match search — "artist" "album"
    let mut url = url::Url::parse("https://itunes.apple.com/search").ok()?;
    url.query_pairs_mut()
        .append_pair("term", &format!("\"{}\" \"{}\"", artist, album))
        .append_pair("media", "music")
        .append_pair("entity", "album")
        .append_pair("limit", "5");

    if let Some(result) = search_with_url(&state.http_client, url, &norm_artist, &norm_album) {
        cache_and_return(&state.artwork_cache, cache_key, &result);
        return Some(result);
    }

    // Strategy 2: relaxed search — artist album (no quotes)
    let mut url = url::Url::parse("https://itunes.apple.com/search").ok()?;
    url.query_pairs_mut()
        .append_pair("term", &format!("{} {}", artist, album))
        .append_pair("media", "music")
        .append_pair("entity", "album")
        .append_pair("limit", "10");

    if let Some(result) = search_with_url(&state.http_client, url, &norm_artist, &norm_album) {
        cache_and_return(&state.artwork_cache, cache_key, &result);
        return Some(result);
    }

    // Strategy 3: search by track title — artist + title (for singles/rare albums)
    if !title.is_empty() {
        let mut url = url::Url::parse("https://itunes.apple.com/search").ok()?;
        url.query_pairs_mut()
            .append_pair("term", &format!("{} {}", artist, title))
            .append_pair("media", "music")
            .append_pair("entity", "song")
            .append_pair("limit", "10");

        if let Some(result) = search_with_url(&state.http_client, url, &norm_artist, &norm_title) {
            cache_and_return(&state.artwork_cache, cache_key, &result);
            return Some(result);
        }
    }

    None
}

fn search_with_url(
    client: &reqwest::blocking::Client,
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
            || result_artist.contains(&norm_artist)
            || words_overlap(&norm_artist, &result_artist);

        let album_match = norm_album == collection
            || norm_album.contains(&collection)
            || collection.contains(&norm_album)
            || words_overlap(&norm_album, &collection);

        if artist_match && album_match {
            return Some(
                result.artworkUrl100.as_ref()?.replace("100x100", "600x600")
            );
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
    
    common >= min_len / 2 + min_len % 2  // At least 50% overlap
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
fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(DISCORD_APP_ID).ok()?;
    client.connect().ok()?;
    Some(client)
}

/// Update the Discord Rich Presence activity.
///
/// - `elapsed_secs`: seconds already played. `None` when paused — Discord shows
///   the song/artist without a running timer.
/// - `cover_art_url`: optional direct URL to album artwork. If None, tries to
///   fetch from iTunes Search API using artist + album.
#[tauri::command]
pub fn discord_update_presence(
    state: tauri::State<DiscordState>,
    title: String,
    artist: String,
    album: Option<String>,
    elapsed_secs: Option<f64>,
    cover_art_url: Option<String>,
) -> Result<(), String> {
    let mut guard = state.client.lock().unwrap();

    // (Re)connect lazily — handles the case where Discord starts after the app.
    if guard.is_none() {
        match try_connect() {
            Some(client) => *guard = Some(client),
            None => return Ok(()), // Discord not running — silently skip
        }
    }

    let client = guard.as_mut().unwrap();

    // Discord RPC only exposes two visible text rows (details + state).
    // The application name "Psysonic" is shown automatically by Discord as the
    // header line. Album goes into large_text — visible as a hover tooltip on
    // the cover art icon.
    let large_text = album.as_deref().unwrap_or("Psysonic");

    // Resolve artwork URL: prefer explicit cover_art_url, fallback to iTunes search
    let artwork_url: Option<String> = cover_art_url.or_else(|| {
        album.as_ref().and_then(|a| search_itunes_artwork(&state, &artist, a, &title))
    });

    let assets = if let Some(ref url) = artwork_url {
        Assets::new()
            .large_image(url.as_str())
            .large_text(large_text)
    } else {
        // Fallback to default Psysonic icon
        Assets::new()
            .large_image("psysonic")
            .large_text(large_text)
    };

    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .details(&title)
        .state(&artist)
        .assets(assets);

    // Start timestamp: Discord auto-counts up from this point. We back-calculate
    // it so the displayed elapsed time matches the actual playback position.
    if let Some(elapsed) = elapsed_secs {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let start = now - elapsed.floor() as i64;
        activity = activity.timestamps(Timestamps::new().start(start));
    }

    if client.set_activity(activity).is_err() {
        // IPC pipe broke (Discord restarted etc.) — drop the client so the next
        // call re-connects.
        *guard = None;
    }

    Ok(())
}

/// Clear the Discord Rich Presence activity (e.g. playback stopped).
#[tauri::command]
pub fn discord_clear_presence(state: tauri::State<DiscordState>) -> Result<(), String> {
    let mut guard = state.client.lock().unwrap();
    if let Some(client) = guard.as_mut() {
        if client.clear_activity().is_err() {
            *guard = None;
        }
    }
    Ok(())
}

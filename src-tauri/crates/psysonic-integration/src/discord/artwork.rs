use reqwest::blocking::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Cache entry for iTunes artwork lookup (avoids repeated API calls for same album).
pub struct ArtworkCacheEntry {
    pub url: String,
    pub fetched_at: Instant,
}

/// TTL: 1 hour — album artwork doesn't change, but we don't want to cache failures forever.
const ARTWORK_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(3600);

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
pub(super) fn normalize(s: &str) -> String {
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

pub(super) fn search_itunes_artwork(
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
pub(super) fn search_itunes_artwork_with_base(
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

pub(super) fn search_with_url(
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
pub(super) fn words_overlap(a: &str, b: &str) -> bool {
    let words_a: std::collections::HashSet<_> = a.split_whitespace().collect();
    let words_b: std::collections::HashSet<_> = b.split_whitespace().collect();

    if words_a.is_empty() || words_b.is_empty() {
        return false;
    }

    let common = words_a.intersection(&words_b).count();
    let min_len = words_a.len().min(words_b.len());

    common >= min_len / 2 + min_len % 2 // At least 50% overlap
}

pub(super) fn cache_and_return(
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

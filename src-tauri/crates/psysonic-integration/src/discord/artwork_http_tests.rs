use super::artwork::*;
use reqwest::blocking::Client;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use wiremock::matchers::{method, path as wm_path};
use wiremock::{Mock, MockServer, ResponseTemplate};

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
    let entry_url = cache
        .lock()
        .unwrap()
        .get("Artist|Album")
        .map(|e| e.url.clone());
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

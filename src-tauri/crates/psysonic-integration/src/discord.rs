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
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod artwork;
mod presence;

use artwork::search_itunes_artwork;
pub use artwork::ArtworkCacheEntry;
#[cfg(test)]
use presence::apply_template;
use presence::{
    compute_discord_start_timestamp, compute_discord_text_fields, is_publishable_image_url,
};

const DISCORD_APP_ID: &str = "1489544859718258779";

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

/// Try to create and connect a fresh IPC client. Returns None silently on failure.
///
/// In debug builds (i.e. `npx tauri dev`) every step of the IPC handshake is
/// logged so the renderer's terminal output shows exactly where the
/// connection breaks. Release builds stay completely silent.
fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(DISCORD_APP_ID);
    if let Err(_e) = client.connect() {
        #[cfg(debug_assertions)]
        crate::app_eprintln!(
            "[discord] connect() failed: {} (Discord desktop running?)",
            _e
        );
        return None;
    }
    #[cfg(debug_assertions)]
    crate::app_eprintln!("[discord] IPC connected (app_id={})", DISCORD_APP_ID);
    Some(client)
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
/// - `name_template`: template string overriding Discord's default application name in the
///   user list (e.g. "🎵 Bohemian Rhapsody" instead of "🎵 Psysonic"). Default: "{title}".
///   Empty string falls back to the registered Discord application name.
///   Supported placeholders: {title}, {artist}, {album}
// NOT specta-collected: >10 total params exceed specta's SpectaFn arg cap. Stays hand-written on generate_handler!.
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
    name_template: Option<String>,
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

    // Backstop: reject any URL that isn't safe to publish, no matter which
    // path above produced it. Falls back to the app icon on rejection.
    let artwork_url = artwork_url.filter(|url| {
        let ok = is_publishable_image_url(url);
        if !ok {
            #[cfg(debug_assertions)]
            crate::app_eprintln!("[discord] rejected non-publishable artwork_url");
        }
        ok
    });

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
        name_template.as_deref(),
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
            crate::app_eprintln!(
                "[discord] clear_activity (pause) failed, dropping client: {}",
                _e
            );
            *guard = None;
        }
        return Ok(());
    }

    // Only reach here when playing
    let mut activity = Activity::new().activity_type(ActivityType::Listening);
    if !texts.name.is_empty() {
        activity = activity.name(texts.name.as_str());
    }
    let activity = activity
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
#[specta::specta]
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
mod artwork_http_tests;
#[cfg(test)]
mod artwork_unit_tests;
#[cfg(test)]
mod security_tests;
#[cfg(test)]
mod text_tests;

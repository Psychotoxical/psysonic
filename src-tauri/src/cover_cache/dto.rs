use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheEnsureResult {
    pub hit: bool,
    pub path: String,
    pub tier: u32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheStatsDto {
    pub bytes: u64,
    pub count: u64,
    pub pressure: String,
    pub auto_download_enabled: bool,
    pub entry_count: u64,
}

/// Live cover HTTP / WebP-encode slots — mirrors analysis pipeline probe shape.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverPipelineQueueStatsDto {
    pub http_max: u32,
    pub http_active: u32,
    pub cpu_ui_max: u32,
    pub cpu_ui_active: u32,
    pub cpu_backfill_max: u32,
    pub cpu_backfill_active: u32,
    pub library_backfill_http_max: u32,
    pub library_backfill_http_active: u32,
    pub library_backfill_pass_running: bool,
    /// Cumulative covers produced by on-demand (UI) ensures since process start.
    pub ui_ensured_total: u64,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCacheEnsureArgs {
    pub server_index_key: String,
    /// `album` or `artist` — with `cache_entity_id` selects the SHA-256 cache directory.
    pub cache_kind: String,
    pub cache_entity_id: String,
    /// Navidrome / Subsonic `getCoverArt` id (`al-*`, `ar-*`, …).
    pub cover_art_id: String,
    pub tier: u32,
    pub rest_base_url: String,
    pub username: String,
    pub password: String,
    /// Library backfill: all derived tiers, no `cover:tier-ready` floods to the webview.
    #[serde(default)]
    pub library_bulk: bool,
    /// Library server id (DB key) — set by backfill so a failed fetch can be logged
    /// with the album/artist name. On-demand UI ensures leave it `None`.
    #[serde(default)]
    pub library_server_id: Option<String>,
    /// External artwork (§16): when true, an artist `fanart`/`banner` ensure may
    /// fetch from fanart.tv into `{tier}-{provider}.webp`. Gated by the master
    /// toggle (off by default); the project key is embedded (`FANART_PROJECT_KEY`).
    #[serde(default)]
    pub external_artwork_enabled: bool,
    /// Surface intent for external artwork — `fanart` for the 16:9 artist
    /// background. `None` on plain cover ensures.
    #[serde(default)]
    pub surface_kind: Option<String>,
    /// Artist display name — context for the §19 name→MusicBrainz fallback when
    /// the artist carries no tag MBID. `None` skips that fallback.
    #[serde(default)]
    pub artist_name: Option<String>,
    /// Album title currently in context (fullscreen playback) — disambiguates
    /// the name→MusicBrainz query (§19).
    #[serde(default)]
    pub album_title: Option<String>,
    /// Optional BYOK personal fanart.tv key from settings — sent in addition to
    /// the project key (§22). Falls back to the `PSYSONIC_FANART_CLIENT_KEY` env.
    #[serde(default)]
    pub external_artwork_byok: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverCachePeekItem {
    pub server_index_key: String,
    pub cache_kind: String,
    pub cache_entity_id: String,
    pub tier: u32,
    /// Frontend `coverStorageKey` — echoed in the batch result map.
    pub storage_key: String,
}

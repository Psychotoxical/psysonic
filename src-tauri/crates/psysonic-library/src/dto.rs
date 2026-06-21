//! Public DTOs the Tauri command surface returns. camelCase wire shape
//! per `src-tauri/CLAUDE.md`. PR-5a only defines what the read-only
//! commands need; PR-5b adds sync-progress / cancel-ack shapes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filter::{EntityKind, FilterOp};
use crate::repos::TrackRow;
use crate::store::LibraryStore;

/// `library_get_status` payload — mirrors the `sync_state` row plus a
/// few derived counters from `track`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateDto {
    pub server_id: String,
    pub library_scope: String,
    #[serde(default)]
    pub sync_phase: String,
    #[serde(default)]
    pub capability_flags: u32,
    #[serde(default)]
    pub library_tier: String,
    pub last_full_sync_at: Option<i64>,
    pub last_delta_sync_at: Option<i64>,
    pub next_poll_at: Option<i64>,
    pub server_last_scan_iso: Option<String>,
    pub indexes_last_modified_ms: Option<i64>,
    pub artists_last_modified_ms: Option<i64>,
    /// Space-separated leading articles from the server's `getArtists` response.
    pub ignored_articles: Option<String>,
    pub local_track_count: Option<i64>,
    pub server_track_count: Option<i64>,
    pub last_error: Option<String>,
    /// `MAX(server_updated_at)` over local non-deleted tracks — the
    /// implicit "tracks watermark" the N1-delta uses.
    pub local_tracks_max_updated_ms: Option<i64>,
    /// Cheap `EXISTS` over `track` — avoids a full `COUNT(*)` on every status read.
    #[serde(default)]
    pub has_local_tracks: bool,
    /// Active/resumed initial-sync ingest strategy (`n1` / `s1` / `s2`), if any.
    #[serde(default)]
    pub ingest_strategy: Option<String>,
    /// Cursor phase during initial sync (`ingest`, `artist_pass`, …).
    #[serde(default)]
    pub ingest_phase: Option<String>,
    /// Tracks ingested so far per persisted cursor (informational during IS-3).
    #[serde(default)]
    pub cursor_ingested_count: Option<u32>,
    /// Server flagged after N1 deep-offset failure — prefers S1/S2 on next run.
    #[serde(default)]
    pub n1_bulk_unreliable: Option<bool>,
}

/// E3 readiness summary attached to a single-track `library_get_track` read.
/// Per-server, read-only, best-effort — never blocks on the network. Omitted
/// from list/batch reads (would be one analysis probe per row).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackEnrichmentDto {
    pub waveform_ready: bool,
    pub loudness_ready: bool,
    pub lyrics_cached: bool,
}

/// `library_get_track` / `library_search` row shape — flat projection
/// over `track`'s hot columns plus the raw JSON sub-tree. Frontend
/// re-assembles its own `LibraryTrack` shape from this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrackDto {
    // Ref
    pub server_id: String,
    pub id: String,
    pub content_hash: Option<String>,

    // Hot columns
    pub title: String,
    pub title_sort: Option<String>,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub album: String,
    pub album_id: Option<String>,
    pub album_artist: Option<String>,
    pub duration_sec: i64,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub suffix: Option<String>,
    pub bit_rate: Option<i64>,
    pub size_bytes: Option<i64>,
    pub cover_art_id: Option<String>,
    pub starred_at: Option<i64>,
    pub user_rating: Option<i64>,
    pub play_count: Option<i64>,
    pub played_at: Option<i64>,
    pub server_path: Option<String>,
    pub library_id: Option<String>,
    pub isrc: Option<String>,
    pub mbid_recording: Option<String>,
    pub bpm: Option<i64>,
    /// `'analysis'` | `'tag'` — only on Advanced Search rows with BPM dual-storage projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpm_source: Option<String>,
    pub replay_gain_track_db: Option<f64>,
    pub replay_gain_album_db: Option<f64>,

    pub server_updated_at: Option<i64>,
    pub server_created_at: Option<i64>,
    pub synced_at: i64,

    /// E3 readiness summary. Only populated by `library_get_track`; `None`
    /// (omitted on the wire) for list/batch projections via `from_row`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enrichment: Option<TrackEnrichmentDto>,

    /// Original Subsonic / Navidrome song JSON the sync engine stored.
    /// Frontend parses this lazily when it needs OpenSubsonic extras
    /// (contributors, replayGain detail, …).
    pub raw_json: Value,
}

impl LibraryTrackDto {
    pub fn from_row(row: &TrackRow) -> Self {
        let raw_json: Value = serde_json::from_str(&row.raw_json).unwrap_or(Value::Null);
        Self {
            server_id: row.server_id.clone(),
            id: row.id.clone(),
            content_hash: row.content_hash.clone(),
            title: row.title.clone(),
            title_sort: row.title_sort.clone(),
            artist: row.artist.clone(),
            artist_id: row.artist_id.clone(),
            album: row.album.clone(),
            album_id: row.album_id.clone(),
            album_artist: row.album_artist.clone(),
            duration_sec: row.duration_sec,
            track_number: row.track_number,
            disc_number: row.disc_number,
            year: row.year,
            genre: row.genre.clone(),
            suffix: row.suffix.clone(),
            bit_rate: row.bit_rate,
            size_bytes: row.size_bytes,
            cover_art_id: row.cover_art_id.clone(),
            starred_at: row.starred_at,
            user_rating: row.user_rating,
            play_count: row.play_count,
            played_at: row.played_at,
            server_path: row.server_path.clone(),
            library_id: row.library_id.clone(),
            isrc: row.isrc.clone(),
            mbid_recording: row.mbid_recording.clone(),
            bpm: row.bpm,
            bpm_source: None,
            replay_gain_track_db: row.replay_gain_track_db,
            replay_gain_album_db: row.replay_gain_album_db,
            server_updated_at: row.server_updated_at,
            server_created_at: row.server_created_at,
            synced_at: row.synced_at,
            enrichment: None,
            raw_json,
        }
    }
}

/// `library_get_tracks_batch` / `library_search` envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTracksEnvelope {
    pub tracks: Vec<LibraryTrackDto>,
    pub total: u32,
}

/// `library_get_artifact` payload — one row of `track_artifact`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackArtifactDto {
    pub server_id: String,
    pub track_id: String,
    pub artifact_kind: String,
    pub format: String,
    pub source_kind: String,
    pub source_id: String,
    pub language: Option<String>,
    pub content_text: Option<String>,
    pub content_bytes: i64,
    pub not_found: bool,
    pub content_hash: Option<String>,
    pub fetched_at: i64,
    pub expires_at: Option<i64>,
}

/// `library_get_facts` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackFactDto {
    pub server_id: String,
    pub track_id: String,
    pub fact_kind: String,
    pub value_real: Option<f64>,
    pub value_int: Option<i64>,
    pub value_text: Option<String>,
    pub unit: Option<String>,
    pub source_kind: String,
    pub source_id: String,
    pub confidence: f64,
    pub content_hash: Option<String>,
    pub fetched_at: i64,
    pub expires_at: Option<i64>,
}

/// `library_get_offline_path` outcome — either a path string or a
/// `missing` flag so the frontend can show a hint without polling.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OfflinePathDto {
    pub server_id: String,
    pub track_id: String,
    pub local_path: Option<String>,
    pub missing: bool,
}

/// Compact track reference used as input by `library_get_tracks_batch`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TrackRefDto {
    pub server_id: String,
    pub track_id: String,
    #[serde(default)]
    pub content_hash: Option<String>,
}

/// Input to `library_put_artifact`. Same shape as `TrackArtifactDto`
/// minus the server-supplied `server_id` / `track_id` (provided as
/// command args) and `fetched_at` (stamped server-side from `now`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactInputDto {
    pub artifact_kind: String,
    pub format: String,
    pub source_kind: String,
    pub source_id: String,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub content_text: Option<String>,
    #[serde(default)]
    pub content_blob: Option<Vec<u8>>,
    #[serde(default)]
    pub content_bytes: i64,
    #[serde(default)]
    pub not_found: bool,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Input to `library_put_fact`. Shape matches `TrackFactDto` minus the
/// indices.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FactInputDto {
    pub fact_kind: String,
    #[serde(default)]
    pub value_real: Option<f64>,
    #[serde(default)]
    pub value_int: Option<i64>,
    #[serde(default)]
    pub value_text: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    pub source_kind: String,
    pub source_id: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

fn default_confidence() -> f64 {
    1.0
}

/// Input to `library_record_play_session`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionInputDto {
    pub server_id: String,
    pub track_id: String,
    pub started_at_ms: i64,
    pub listened_sec: f64,
    pub position_max_sec: f64,
    pub end_reason: String,
    /// Player-known duration when `track.duration_sec` in the index is missing/zero.
    #[serde(default)]
    pub duration_sec_hint: Option<i64>,
}

/// Cross-server year summary for the Player stats tab.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionYearSummaryDto {
    pub total_listened_sec: f64,
    /// Listening sessions (plays clustered by idle gap).
    pub session_count: u32,
    /// Individual track plays (`COUNT(*)`).
    pub track_play_count: u32,
    /// Distinct tracks heard at least once in the year.
    pub unique_track_count: u32,
    /// Calendar days with at least one recorded play.
    pub listening_day_count: u32,
    pub full_count: u32,
    pub partial_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionHeatmapDayDto {
    pub date: String,
    pub track_play_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionDayTotalsDto {
    pub total_listened_sec: f64,
    pub session_count: u32,
    pub track_play_count: u32,
    pub full_count: u32,
    pub partial_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionDayTrackDto {
    pub server_id: String,
    pub track_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub listened_sec: f64,
    pub completion: String,
    pub started_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionDayDetailDto {
    pub totals: PlaySessionDayTotalsDto,
    pub tracks: Vec<PlaySessionDayTrackDto>,
}

/// Summary for one day in the recent-days list (no track rows).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionRecentDayDto {
    pub date: String,
    pub total_listened_sec: f64,
    pub session_count: u32,
    pub track_play_count: u32,
    pub full_count: u32,
    pub partial_count: u32,
}

/// Earliest/latest calendar years with at least one session (local TZ).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlaySessionYearBoundsDto {
    pub min_year: Option<i32>,
    pub max_year: Option<i32>,
}

/// Min/max `year` from indexed tracks for a server (Albums year filter UI).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogYearBoundsDto {
    pub min_year: Option<i32>,
    pub max_year: Option<i32>,
}

/// Per-genre album/track totals from the local track catalog (Genres cloud + browse).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenreAlbumCountDto {
    pub value: String,
    pub album_count: u32,
    pub song_count: u32,
}

/// `library_list_albums_by_genre` request — paginated genre album browse (local index).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGenreAlbumsRequest {
    pub server_id: String,
    pub genre: String,
    #[serde(default)]
    pub library_scope: Option<String>,
    #[serde(default)]
    pub sort: Vec<LibrarySortClause>,
    #[serde(default = "default_genre_album_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub include_total: bool,
}

fn default_genre_album_limit() -> u32 {
    50
}

/// `library_list_albums_by_genre` response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryGenreAlbumsResponse {
    pub albums: Vec<LibraryAlbumDto>,
    pub has_more: bool,
    pub total: Option<u32>,
    pub source: String,
}

/// `library_purge_server` outcome.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReportDto {
    pub tracks_deleted: u32,
    pub albums_deleted: u32,
    pub artists_deleted: u32,
    pub offline_rows_deleted: u32,
    /// Total bytes freed across the purged scopes (best-effort).
    pub bytes_freed: i64,
}

/// `library_sync_start` ack.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncJobDto {
    pub job_id: String,
    pub server_id: String,
    /// `"initial_sync"` or `"delta_sync"`.
    pub kind: String,
}

// ──────────────────────────────────────────────────────────────────────
//  PR-5d — Advanced Search (§5.13) + cross-server search (§5.5B)
// ──────────────────────────────────────────────────────────────────────

/// `library_advanced_search` row shape for an album. Flat projection over
/// the `album` hot columns plus the raw JSON sub-tree (mirrors
/// `LibraryTrackDto`'s lazy-parse contract).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAlbumDto {
    pub server_id: String,
    pub id: String,
    pub name: String,
    pub artist: Option<String>,
    pub artist_id: Option<String>,
    pub song_count: Option<i64>,
    pub duration_sec: Option<i64>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub cover_art_id: Option<String>,
    pub starred_at: Option<i64>,
    pub synced_at: i64,
    pub raw_json: Value,
}

/// `library_advanced_search` row shape for an artist.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryArtistDto {
    pub server_id: String,
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_sort: Option<String>,
    pub album_count: Option<i64>,
    pub synced_at: i64,
    pub raw_json: Value,
}

/// One filter predicate. `field` is a `FilterFieldRegistry` id (§5.13.3),
/// `op` the comparison, `value` / `valueTo` the operands. `between` uses
/// both bounds (inclusive); scalar ops use `value` only; `isTrue` ignores
/// the value side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilterClause {
    pub field: String,
    pub op: FilterOp,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub value_to: Option<Value>,
}

/// One sort key. `field` is a registry id; `dir` is `asc` / `desc`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySortClause {
    pub field: String,
    pub dir: SortDir,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// `library_advanced_search` request (§5.13.2). `query` is shorthand for an
/// `fts` clause on the text fields; `entityTypes` controls which of the
/// three queries run; `filters` are combined with AND.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAdvancedSearchRequest {
    pub server_id: String,
    #[serde(default)]
    pub library_scope: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    pub entity_types: Vec<EntityKind>,
    #[serde(default)]
    pub filters: Vec<LibraryFilterClause>,
    #[serde(default)]
    pub starred_only: Option<bool>,
    /// When set, album browse is limited to these ids (e.g. server `getStarred2`
    /// intersected with local lossless / genre filters). Not combined with
    /// `starred_only` — use one or the other.
    #[serde(default)]
    pub restrict_album_ids: Option<Vec<String>>,
    /// When true, album text search matches title/name only (not album artist).
    #[serde(default)]
    pub query_album_title_only: Option<bool>,
    #[serde(default)]
    pub sort: Vec<LibrarySortClause>,
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
    /// When true, skip per-entity COUNT queries (Live Search / small pages).
    #[serde(default)]
    pub skip_totals: bool,
}

/// Per-entity result counts (full match count, not page size).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchTotals {
    pub artists: u32,
    pub albums: u32,
    pub tracks: u32,
}

/// `library_advanced_search` response (§5.13.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryAdvancedSearchResponse {
    pub artists: Vec<LibraryArtistDto>,
    pub albums: Vec<LibraryAlbumDto>,
    pub tracks: Vec<LibraryTrackDto>,
    pub totals: LibrarySearchTotals,
    /// Distinct registry field ids that were actually applied — UI chips /
    /// debug. Includes `starred` when `starredOnly` is set.
    pub applied_filters: Vec<String>,
    /// Always `"local"` from this command (it queries the local index); the
    /// frontend's fallback decides local vs network (§5.13.6).
    pub source: String,
}

/// `library_live_search` response — lean FTS dropdown (§5.9 / P24).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLiveSearchRequest {
    pub server_id: String,
    pub query: String,
    #[serde(default)]
    pub library_scope: Option<String>,
    #[serde(default)]
    pub artist_limit: Option<u32>,
    #[serde(default)]
    pub album_limit: Option<u32>,
    #[serde(default)]
    pub song_limit: Option<u32>,
    #[serde(default)]
    pub request_epoch: Option<u64>,
}

/// `library_live_search` response — lean FTS dropdown (§5.9 / P24).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLiveSearchResponse {
    pub artists: Vec<LibraryArtistDto>,
    pub albums: Vec<LibraryAlbumDto>,
    pub tracks: Vec<LibraryTrackDto>,
    pub source: String,
}

/// `library_list_lossless_albums` request — paginated lossless browse (local index).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLosslessAlbumsRequest {
    pub server_id: String,
    #[serde(default)]
    pub library_scope: Option<String>,
    #[serde(default = "default_lossless_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

fn default_lossless_limit() -> u32 {
    30
}

/// `library_list_lossless_albums` response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLosslessAlbumsResponse {
    pub albums: Vec<LibraryAlbumDto>,
    pub has_more: bool,
    pub source: String,
}

/// `library_get_artist_lossless_browse` request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryArtistLosslessBrowseRequest {
    pub server_id: String,
    pub artist_id: String,
    #[serde(default)]
    pub library_scope: Option<String>,
}

/// Lossless albums + tracks for one artist (local index).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryArtistLosslessBrowseResponse {
    pub albums: Vec<LibraryAlbumDto>,
    pub tracks: Vec<LibraryTrackDto>,
    pub source: String,
}

/// `library_search_cross_server` response (§5.5B / §5.9).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCrossServerSearchResponse {
    /// Primary FTS-union hits, deduped by canonical id where a link exists.
    pub hits: Vec<LibraryTrackDto>,
    /// Fuzzy fallback (§5.9 / H3): per-server `title LIKE` matches that the
    /// exact FTS pass missed (diacritics, partial words). Excludes anything
    /// already in `hits` and dedupes by canonical id against them.
    pub fuzzy: Vec<LibraryTrackDto>,
    /// The server ids that were actually searched (resolved from the
    /// request's `servers` or all `ready` servers).
    pub servers_searched: Vec<String>,
}

/// Read `MAX(server_updated_at)` for non-deleted tracks on this server
/// — used by `SyncStateDto` so callers can show "tracks watermark" in
/// Settings without a separate column.
pub fn local_tracks_max_updated_ms(
    store: &LibraryStore,
    server_id: &str,
) -> Result<Option<i64>, String> {
    store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT MAX(server_updated_at) FROM track \
                 WHERE server_id = ?1 AND deleted = 0",
                rusqlite::params![server_id],
                |row| row.get::<_, Option<i64>>(0),
            )
        })
        .map_err(|e| e.to_string())
}

/// Cheap `EXISTS` — true when at least one non-deleted track is indexed.
pub fn track_index_nonempty(store: &LibraryStore, server_id: &str) -> Result<bool, String> {
    store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT EXISTS(SELECT 1 FROM track WHERE server_id = ?1 AND deleted = 0 LIMIT 1)",
                rusqlite::params![server_id],
                |row| row.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

/// Live non-deleted track count for a server (used when the sync_state
/// snapshot is missing or stale).
pub fn count_local_tracks(store: &LibraryStore, server_id: &str) -> Result<i64, String> {
    store
        .with_read_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                rusqlite::params![server_id],
                |row| row.get(0),
            )
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::TrackRepository;

    fn sample_row() -> TrackRow {
        TrackRow {
            server_id: "s1".into(),
            id: "tr_1".into(),
            title: "Hello".into(),
            title_sort: None,
            artist: Some("World".into()),
            artist_id: Some("ar_1".into()),
            album: "An Album".into(),
            album_id: Some("al_1".into()),
            album_artist: Some("World".into()),
            duration_sec: 240,
            track_number: Some(3),
            disc_number: Some(1),
            year: Some(2024),
            genre: Some("Ambient".into()),
            suffix: Some("flac".into()),
            bit_rate: Some(1000),
            size_bytes: Some(32_000_000),
            cover_art_id: Some("cv_1".into()),
            starred_at: None,
            user_rating: None,
            play_count: Some(0),
            played_at: None,
            server_path: Some("/path/x.flac".into()),
            library_id: Some("1".into()),
            isrc: Some("USRC17607839".into()),
            mbid_recording: Some("mb-1".into()),
            bpm: Some(120),
            replay_gain_track_db: Some(-1.2),
            replay_gain_album_db: Some(-0.8),
            content_hash: Some("deadbeef".into()),
            server_updated_at: Some(1_700_000_000),
            server_created_at: Some(1_699_000_000),
            deleted: false,
            synced_at: 1_700_000_500,
            raw_json: r#"{"replayGain":{"trackGain":-1.2}}"#.into(),
        }
    }

    #[test]
    fn library_track_dto_serializes_field_names_camel_case() {
        let dto = LibraryTrackDto::from_row(&sample_row());
        let json = serde_json::to_value(&dto).unwrap();
        // Spot-check critical wire keys — IPC contract.
        for key in [
            "serverId",
            "contentHash",
            "albumArtist",
            "durationSec",
            "trackNumber",
            "discNumber",
            "coverArtId",
            "userRating",
            "playCount",
            "playedAt",
            "serverPath",
            "libraryId",
            "mbidRecording",
            "replayGainTrackDb",
            "replayGainAlbumDb",
            "serverUpdatedAt",
            "syncedAt",
            "rawJson",
        ] {
            assert!(
                json.get(key).is_some(),
                "expected camelCase key `{key}` in serialized DTO, got {json}"
            );
        }
    }

    #[test]
    fn library_track_dto_parses_raw_json_into_value() {
        let dto = LibraryTrackDto::from_row(&sample_row());
        let rg = dto
            .raw_json
            .get("replayGain")
            .and_then(|v| v.get("trackGain"))
            .and_then(|v| v.as_f64())
            .unwrap();
        assert!((rg - -1.2).abs() < 0.001);
    }

    #[test]
    fn library_track_dto_falls_back_to_null_on_invalid_raw_json() {
        let mut row = sample_row();
        row.raw_json = "{not valid json}".into();
        let dto = LibraryTrackDto::from_row(&row);
        assert!(dto.raw_json.is_null(), "invalid JSON must surface as Value::Null");
    }

    #[test]
    fn local_tracks_max_updated_returns_max_over_non_deleted_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        let mut r1 = sample_row();
        r1.server_updated_at = Some(1_000);
        let mut r2 = sample_row();
        r2.id = "tr_2".into();
        r2.server_updated_at = Some(3_000);
        let mut r3 = sample_row();
        r3.id = "tr_3".into();
        r3.server_updated_at = Some(5_000);
        r3.deleted = true;
        repo.upsert_batch(&[r1, r2, r3]).unwrap();

        assert_eq!(
            local_tracks_max_updated_ms(&store, "s1").unwrap(),
            Some(3_000),
            "deleted rows must be excluded"
        );
    }

    #[test]
    fn count_local_tracks_matches_non_deleted_rows() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackRepository::new(&store);
        let mut deleted = sample_row();
        deleted.id = "tr_del".into();
        deleted.deleted = true;
        repo.upsert_batch(&[sample_row(), deleted]).unwrap();
        assert_eq!(count_local_tracks(&store, "s1").unwrap(), 1);
    }

    #[test]
    fn track_ref_dto_roundtrips_through_json() {
        let r = TrackRefDto {
            server_id: "s1".into(),
            track_id: "tr_1".into(),
            content_hash: Some("h".into()),
        };
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json.get("serverId").and_then(|v| v.as_str()), Some("s1"));
        let back: TrackRefDto = serde_json::from_value(json).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn sync_state_dto_omits_null_optionals_cleanly() {
        let dto = SyncStateDto {
            server_id: "s1".into(),
            library_scope: "".into(),
            sync_phase: "idle".into(),
            capability_flags: 0,
            library_tier: "unknown".into(),
            last_full_sync_at: None,
            last_delta_sync_at: None,
            next_poll_at: None,
            server_last_scan_iso: None,
            indexes_last_modified_ms: None,
            artists_last_modified_ms: None,
            ignored_articles: None,
            local_track_count: None,
            server_track_count: None,
            last_error: None,
            local_tracks_max_updated_ms: None,
            has_local_tracks: false,
            ingest_strategy: None,
            ingest_phase: None,
            cursor_ingested_count: None,
            n1_bulk_unreliable: None,
        };
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(
            json.get("syncPhase").and_then(|v| v.as_str()),
            Some("idle")
        );
        // `null` survives as JSON null, not omitted — explicit shape
        // for the WebView so it can distinguish "missing" from
        // "unset".
        assert!(json.get("lastFullSyncAt").unwrap().is_null());
    }
}

//! Tauri commands — read-only surface for PR-5a (spec §7.1). Mutating
//! commands + sync lifecycle land in PR-5b. All commands take a
//! `State<LibraryRuntime>` so the top crate's `setup()` can wire one
//! shared `Arc<LibraryStore>` across the whole IPC surface.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_integration::navidrome::navidrome_token_with_registry;
use psysonic_integration::subsonic::subsonic_client_with_registry;

use crate::advanced_search;
use crate::analysis_backfill::{self, LibraryAnalysisBackfillBatchDto, LibraryAnalysisProgressDto};
use crate::cover_resolve::CoverEntryDto;
use crate::cross_server;
use crate::dto::{
    local_tracks_max_updated_ms, ArtifactInputDto, EntityUserRatingDto, EntityUserRatingRefDto,
    FactInputDto, LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse,
    LibraryCrossServerSearchResponse, LibraryLiveSearchRequest, LibraryLiveSearchResponse,
    LibraryMainstageAlbumsRequest, LibraryMainstageAlbumsResponse, LibraryMostPlayedRequest,
    LibraryMostPlayedResponse, LibraryScopeAlbumDetailRequest, LibraryScopeAlbumDetailResponse,
    LibraryScopeArtistDetailRequest, LibraryScopeArtistDetailResponse, LibraryScopeBrowseRequest,
    LibraryScopeBrowseResponse, LibraryScopeComposerDetailRequest,
    LibraryScopeComposerDetailResponse, LibraryScopeListRequest, LibraryScopeSearchRequest,
    LibraryAlbumOverlayResolutionDto, LibraryEntitySourceDto,
    LibraryResolveAlbumOverlayRequest, LibraryResolveEntitySourcesRequest, LibraryStatisticsDto,
    LibraryStatisticsRequest, LibraryTrackDto, LibraryTracksEnvelope,
    OfflinePathDto, PlaySessionDayDetailDto, PlaySessionHeatmapDayDto, PlaySessionInputDto,
    PlaySessionRecentDayDto, PlaySessionRecentTrackDto, PlaySessionYearBoundsDto,
    PlaySessionYearSummaryDto, PurgeReportDto, SyncJobDto, SyncStateDto, TrackArtifactDto,
    TrackFactDto, TrackRefDto,
};
use crate::live_search;
use crate::payload::{LibrarySyncIdlePayload, LibrarySyncProgressPayload};
use crate::repos::{PlaySessionRepository, SyncStateRepository, TrackRepository};
use crate::runtime::{CurrentJob, LibraryRuntime, SyncSession};
use crate::scope_merge;
use crate::search::search_tracks;
use crate::store::LibraryStore;
use crate::sync::bandwidth::ParallelismBudget;
use crate::sync::bandwidth::PlaybackHint;
use crate::sync::capability::{
    probe_and_persist_with_timeout, CapabilityFlags, NavidromeProbeCredentials,
};
use crate::sync::delta::DeltaSyncRunner;
use crate::sync::error::SyncError;
use crate::sync::initial::InitialSyncRunner;
use crate::sync::library_tag::run_tag_pass_best_effort;
use crate::sync::progress::{ChannelProgress, Progress, ProgressEvent};
use crate::sync::tombstone::should_auto_reconcile_scope;

static NEXT_SYNC_JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Run synchronous SQLite / library read work off the async runtime worker.
async fn library_spawn_blocking<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce() -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("library blocking worker failed: {e}"))?
}

/// Cap for `library_get_tracks_batch` per spec §7.1 ("max 100 refs/call").
const TRACKS_BATCH_LIMIT: usize = 100;
/// Shared cache callers can request or update at most 300 entity ratings per call.
const ENTITY_USER_RATINGS_BATCH_LIMIT: usize = 300;
const ANALYSIS_PROGRESS_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy)]
struct BindSessionTimeouts {
    token: Duration,
    probe: Duration,
}

struct BindSessionRequest {
    server_id: String,
    base_url: String,
    username: String,
    password: String,
    library_scope: Option<String>,
}

const BIND_SESSION_TIMEOUTS: BindSessionTimeouts = BindSessionTimeouts {
    token: Duration::from_secs(10),
    probe: Duration::from_secs(30),
};

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryServerKeyMigrationDto {
    pub legacy_id: String,
    pub index_key: String,
}

/// Resolve cover disk + fetch ids from the local library (`album` | `artist` | `track`).
#[tauri::command]
#[specta::specta]
pub fn library_resolve_cover_entry(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    entity: String,
    entity_id: String,
) -> Result<Option<CoverEntryDto>, String> {
    let server_id = server_id.trim();
    let entity_id = entity_id.trim();
    if server_id.is_empty() || entity_id.is_empty() {
        return Ok(None);
    }
    let store = &runtime.store;
    match entity.trim() {
        "album" => crate::cover_resolve::resolve_album_cover_entry(store, server_id, entity_id),
        "artist" => crate::cover_resolve::resolve_artist_cover_entry(store, server_id, entity_id),
        "track" => crate::cover_resolve::resolve_track_cover_entry(store, server_id, entity_id),
        other => Err(format!(
            "unknown cover entity kind: `{other}` (expected album|artist|track)"
        )),
    }
}

/// Distinct disc count for an album in the local index (`0` when unknown / no live
/// tracks, `1` for a single-disc release). The frontend gates per-disc cover
/// resolution (`dc-<albumId>:<discNumber>`) on `> 1` so single-disc albums keep the
/// shared album cover slot across the queue, playbar and disc separators.
#[tauri::command]
#[specta::specta]
pub fn library_album_disc_count(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    album_id: String,
) -> Result<u32, String> {
    let server_id = server_id.trim();
    let album_id = album_id.trim();
    if server_id.is_empty() || album_id.is_empty() {
        return Ok(0);
    }
    crate::cover_resolve::album_disc_count(&runtime.store, server_id, album_id)
}

/// Hard cap on one `library_resolve_artist_ids` call. A joined credit has a handful of
/// participants; anything beyond this is a caller bug, and the surplus resolves to
/// `None` rather than turning a render path into an unbounded query loop.
const RESOLVE_ARTIST_IDS_MAX: usize = 32;

/// Resolve credit names to indexed artist ids, positionally aligned with `names`.
///
/// For rows whose server sent only a joined credit string ("A feat. B") instead of the
/// structured `artists` list: the frontend splits the string on the server's own
/// separators and asks here for the ids, so every named artist can be linked and not
/// just the primary one. Names with no artist row come back as `null`.
#[tauri::command]
#[specta::specta]
pub fn library_resolve_artist_ids(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    names: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let capped = names.len().min(RESOLVE_ARTIST_IDS_MAX);
    let mut resolved = crate::repos::ArtistRepository::new(&runtime.store)
        .resolve_ids_by_name(server_id.trim(), &names[..capped])?;
    resolved.resize(names.len(), None);
    Ok(resolved)
}

#[tauri::command]
#[specta::specta]
pub fn library_analysis_backfill_batch(
    app: AppHandle,
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<LibraryAnalysisBackfillBatchDto, String> {
    let (dto, _) = analysis_backfill::collect_analysis_backfill_batch(
        &app,
        &runtime,
        server_id.trim(),
        analysis_backfill::AnalysisBackfillScanPhase::Candidates,
        cursor.as_deref().filter(|s| !s.is_empty()),
        limit,
    )?;
    Ok(dto)
}

#[tauri::command]
#[specta::specta]
pub fn library_analysis_progress(
    app: AppHandle,
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<LibraryAnalysisProgressDto, String> {
    let server_id = server_id.trim().to_string();
    if server_id.is_empty() {
        return Ok(LibraryAnalysisProgressDto {
            total_tracks: 0,
            pending_tracks: 0,
            done_tracks: 0,
        });
    }

    let cached = runtime.analysis_progress_snapshot(&server_id);
    if let Some(entry) = cached.as_ref() {
        if entry.updated_at.elapsed() <= ANALYSIS_PROGRESS_CACHE_TTL {
            return Ok(entry.value.clone());
        }
    }

    if runtime.mark_analysis_progress_in_flight(&server_id) {
        let app_handle = app.clone();
        let server_id_clone = server_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let Some(runtime) = app_handle.try_state::<LibraryRuntime>() else {
                return;
            };
            let progress = analysis_backfill::collect_analysis_progress(
                &app_handle,
                &runtime,
                server_id_clone.trim(),
            );
            match progress {
                Ok(value) => runtime.set_analysis_progress(&server_id_clone, value),
                Err(_) => runtime.clear_analysis_progress_in_flight(&server_id_clone),
            }
        });
    }

    Ok(cached
        .map(|entry| entry.value)
        .unwrap_or(LibraryAnalysisProgressDto {
            total_tracks: 0,
            pending_tracks: 0,
            done_tracks: 0,
        }))
}

#[tauri::command]
#[specta::specta]
pub fn library_count_live_tracks(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<i64, String> {
    let server_id = server_id.trim().to_string();
    if server_id.is_empty() {
        return Ok(0);
    }
    let repo = TrackRepository::new(&runtime.store);
    repo.count_live_tracks(&server_id)
}

/// Index-backed Statistics aggregates for one or more selected servers/folders.
/// Deliberately does not merge equivalent albums/artists between scopes.
#[tauri::command]
#[specta::specta]
pub async fn library_scope_statistics(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryStatisticsRequest,
) -> Result<LibraryStatisticsDto, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::statistics::query_statistics(&store, &request)).await
}

/// Ranked local-index albums and album artists for selected servers/folders.
#[tauri::command]
#[specta::specta]
pub async fn library_scope_most_played(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryMostPlayedRequest,
) -> Result<LibraryMostPlayedResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::most_played::query_most_played(&store, &request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn library_get_status(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    library_scope: Option<String>,
) -> Result<SyncStateDto, String> {
    let scope = library_scope.unwrap_or_default();
    let row: Option<SyncStateRow> = runtime
        .store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT sync_phase, capability_flags, library_tier, last_full_sync_at, \
                 last_delta_sync_at, next_poll_at, server_last_scan_iso, \
                 indexes_last_modified_ms, artists_last_modified_ms, ignored_articles, \
                 local_track_count, server_track_count, last_error \
                 FROM sync_state WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, scope],
                |r| {
                    Ok(SyncStateRow {
                        sync_phase: r.get(0)?,
                        capability_flags: r.get::<_, i64>(1)?.max(0) as u32,
                        library_tier: r.get(2)?,
                        last_full_sync_at: r.get(3)?,
                        last_delta_sync_at: r.get(4)?,
                        next_poll_at: r.get(5)?,
                        server_last_scan_iso: r.get(6)?,
                        indexes_last_modified_ms: r.get(7)?,
                        artists_last_modified_ms: r.get(8)?,
                        ignored_articles: r.get(9)?,
                        local_track_count: r.get(10)?,
                        server_track_count: r.get(11)?,
                        last_error: r.get(12)?,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| e.to_string())?;

    let local_tracks_max_updated_ms =
        if row.as_ref().is_some_and(|r| r.sync_phase == "initial_sync") {
            None
        } else {
            local_tracks_max_updated_ms(&runtime.store, &server_id)?
        };
    let tracks = TrackRepository::new(&runtime.store);
    let has_local_tracks = tracks
        .has_live_tracks_in_scope(&server_id, &scope)
        .unwrap_or(false);
    let sync_state = SyncStateRepository::new(&runtime.store);
    let (ingest_strategy, ingest_phase, cursor_ingested_count) = sync_state
        .get_initial_sync_cursor(&server_id, &scope)
        .ok()
        .flatten()
        .map(|v| parse_ingest_cursor(&v))
        .unwrap_or((None, None, None));
    let n1_bulk_unreliable = sync_state
        .get_n1_bulk_unreliable(&server_id, &scope)
        .ok()
        .flatten();
    let row = row.unwrap_or_default();
    let local_track_count = resolve_local_track_count(
        &row,
        cursor_ingested_count,
        has_local_tracks,
        &runtime.store,
        &server_id,
        &scope,
    );
    // `SyncStateRepository::ensure` is intentionally NOT called from
    // the read path — `library_get_status` on a fresh server returns
    // an "idle / unknown" stub without writing a row. PR-5b writes
    // the row when `bind_session` lands.
    Ok(SyncStateDto {
        server_id,
        library_scope: scope,
        sync_phase: row.sync_phase,
        capability_flags: row.capability_flags,
        library_tier: row.library_tier,
        last_full_sync_at: row.last_full_sync_at,
        last_delta_sync_at: row.last_delta_sync_at,
        next_poll_at: row.next_poll_at,
        server_last_scan_iso: row.server_last_scan_iso,
        indexes_last_modified_ms: row.indexes_last_modified_ms,
        artists_last_modified_ms: row.artists_last_modified_ms,
        ignored_articles: row.ignored_articles,
        local_track_count,
        server_track_count: row.server_track_count,
        last_error: row.last_error,
        local_tracks_max_updated_ms,
        has_local_tracks,
        ingest_strategy,
        ingest_phase,
        cursor_ingested_count,
        n1_bulk_unreliable,
    })
}

fn parse_ingest_cursor(raw: &Value) -> (Option<String>, Option<String>, Option<u32>) {
    if raw.as_object().is_none_or(|o| o.is_empty()) {
        return (None, None, None);
    }
    let strategy = raw
        .get("strategy")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let phase = raw
        .get("phase")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let ingested = raw
        .get("ingested_count")
        .and_then(|v| v.as_u64())
        .map(|n| n.min(u32::MAX as u64) as u32);
    (strategy, phase, ingested)
}

/// Avoid full-table `COUNT(*)` while `initial_sync` is writing — use the
/// cheap cursor / snapshot counters updated on each cursor persist instead.
fn resolve_local_track_count(
    row: &SyncStateRow,
    cursor_ingested_count: Option<u32>,
    has_local_tracks: bool,
    store: &LibraryStore,
    server_id: &str,
    library_scope: &str,
) -> Option<i64> {
    if row.sync_phase == "initial_sync" {
        let snapshot = row.local_track_count.unwrap_or(0);
        let cursor = cursor_ingested_count.map(i64::from).unwrap_or(0);
        let best = snapshot.max(cursor);
        return if best > 0 {
            Some(best)
        } else {
            row.local_track_count
        };
    }
    match row.local_track_count {
        Some(n) if n > 0 => Some(n),
        _ if has_local_tracks => TrackRepository::new(store)
            .count_live_tracks_in_scope(server_id, library_scope)
            .ok(),
        _ => row.local_track_count,
    }
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_search(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
    library_scope: Option<String>,
    library_scopes: Option<Vec<String>>,
) -> Result<LibraryTracksEnvelope, String> {
    let scopes = effective_library_scopes(library_scope.as_deref(), library_scopes.as_deref());
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0);
    let hits = search_tracks(
        &runtime.store,
        &server_id,
        &query,
        limit as i64 + offset as i64,
        &scopes,
    )?;
    let mut paged: Vec<TrackRefDto> = hits
        .into_iter()
        .skip(offset as usize)
        .map(|h| TrackRefDto {
            server_id: h.server_id,
            track_id: h.id,
            content_hash: None,
        })
        .collect();
    paged.truncate(limit as usize);

    let total = paged.len() as u32;
    let tracks = hydrate_refs(&runtime, &paged)?;
    Ok(LibraryTracksEnvelope { tracks, total })
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_get_track(
    runtime: State<'_, LibraryRuntime>,
    app: AppHandle,
    server_id: String,
    track_id: String,
) -> Result<Option<LibraryTrackDto>, String> {
    let repo = TrackRepository::new(&runtime.store);
    let Some(row) = repo.find_one(&server_id, &track_id)? else {
        return Ok(None);
    };
    let mut dto = LibraryTrackDto::from_row(&row);

    // E3 enrichment (read-only, per-server, best-effort — never blocks on the
    // network). Only the single-track read pays for this; list/batch projections
    // leave `enrichment = None`.
    let now = now_unix_ms();
    let lyrics_cached = crate::repos::ArtifactRepository::new(&runtime.store)
        .lyrics_cached(&server_id, &track_id, now)
        .unwrap_or(false);
    // waveform/loudness readiness is gated on a known content_hash (md5_16kb,
    // populated by E2) and probed via the analysis-readiness port. Absent
    // port or hash ⇒ not ready.
    let (waveform_ready, loudness_ready) =
        match row.content_hash.as_deref().filter(|s| !s.is_empty()) {
            Some(md5) => app
                .try_state::<psysonic_core::ports::AnalysisReadinessQuery>()
                .map(|q| q.readiness(&server_id, &track_id, md5))
                .unwrap_or((false, false)),
            None => (false, false),
        };
    dto.enrichment = Some(crate::dto::TrackEnrichmentDto {
        waveform_ready,
        loudness_ready,
        lyrics_cached,
    });
    Ok(Some(dto))
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_get_tracks_batch(
    runtime: State<'_, LibraryRuntime>,
    refs: Vec<TrackRefDto>,
) -> Result<Vec<LibraryTrackDto>, String> {
    if refs.len() > TRACKS_BATCH_LIMIT {
        return Err(format!(
            "library_get_tracks_batch: refs exceeds cap ({} > {})",
            refs.len(),
            TRACKS_BATCH_LIMIT
        ));
    }
    hydrate_refs(&runtime, &refs)
}

/// Read cached owner-scoped ratings. Invalid keys and cache misses are omitted.
#[tauri::command]
#[specta::specta]
pub async fn library_get_entity_user_ratings(
    runtime: State<'_, LibraryRuntime>,
    refs: Vec<EntityUserRatingRefDto>,
) -> Result<Vec<EntityUserRatingDto>, String> {
    if refs.len() > ENTITY_USER_RATINGS_BATCH_LIMIT {
        return Err(format!(
            "library_get_entity_user_ratings: refs exceeds cap ({} > {})",
            refs.len(),
            ENTITY_USER_RATINGS_BATCH_LIMIT
        ));
    }
    let store = runtime.store.clone();
    library_spawn_blocking(move || get_entity_user_ratings(&store, &refs)).await
}

/// Upsert cached owner-scoped ratings. Invalid keys are ignored.
#[tauri::command]
#[specta::specta]
pub async fn library_put_entity_user_ratings(
    runtime: State<'_, LibraryRuntime>,
    ratings: Vec<EntityUserRatingDto>,
) -> Result<(), String> {
    if ratings.len() > ENTITY_USER_RATINGS_BATCH_LIMIT {
        return Err(format!(
            "library_put_entity_user_ratings: ratings exceeds cap ({} > {})",
            ratings.len(),
            ENTITY_USER_RATINGS_BATCH_LIMIT
        ));
    }
    let store = runtime.store.clone();
    library_spawn_blocking(move || put_entity_user_ratings(&store, &ratings, now_unix_ms())).await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_get_tracks_by_album(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    album_id: String,
) -> Result<Vec<LibraryTrackDto>, String> {
    let rows = TrackRepository::new(&runtime.store).find_by_album(&server_id, &album_id)?;
    Ok(rows.iter().map(LibraryTrackDto::from_row).collect())
}

/// Upsert Subsonic API song payloads into the library index so pin/download can
/// build `media/library/…` paths before a full sync has ingested the rows.
// NOT specta-collected: takes a serde_json::Value arg — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub fn library_upsert_songs_from_api(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    songs: Vec<serde_json::Value>,
) -> Result<u32, String> {
    upsert_songs_from_api(&runtime.store, &server_id, songs)
}

fn upsert_songs_from_api(
    store: &LibraryStore,
    server_id: &str,
    songs: Vec<serde_json::Value>,
) -> Result<u32, String> {
    use crate::sync::subsonic_song_to_track_row;
    use psysonic_integration::subsonic::Song;

    if songs.is_empty() {
        return Ok(0);
    }
    let synced_at = now_unix_ms();
    let repo = TrackRepository::new(store);
    let mut rows = Vec::with_capacity(songs.len());
    for raw in songs {
        let song: Song = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        rows.push(subsonic_song_to_track_row(server_id, &song, &raw, synced_at, None));
    }
    repo.upsert_batch(&rows)?;
    Ok(rows.len() as u32)
}

#[tauri::command]
#[specta::specta]
pub async fn library_get_artifact(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    artifact_kind: String,
    source_kind: Option<String>,
    source_id: Option<String>,
    format: Option<String>,
) -> Result<Option<TrackArtifactDto>, String> {
    // E4: typed repo owns the §5.12 lazy-expiry + flexible lookup.
    crate::repos::ArtifactRepository::new(&runtime.store).get(
        &server_id,
        &track_id,
        &artifact_kind,
        source_kind.as_deref(),
        source_id.as_deref(),
        format.as_deref(),
        now_unix_ms(),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn library_get_facts(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    fact_kinds: Option<Vec<String>>,
) -> Result<Vec<TrackFactDto>, String> {
    // E4: typed repo owns the §5.12 lazy-expiry + provenance rules.
    crate::repos::FactRepository::new(&runtime.store).get(
        &server_id,
        &track_id,
        &fact_kinds.unwrap_or_default(),
        now_unix_ms(),
    )
}

#[tauri::command]
#[specta::specta]
pub async fn library_get_offline_path(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
) -> Result<OfflinePathDto, String> {
    let path = runtime
        .store
        .with_conn("cmd.get_offline_path", |conn| {
            conn.query_row(
                "SELECT local_path FROM track_offline \
                 WHERE server_id = ?1 AND track_id = ?2",
                params![server_id, track_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .map_err(|e| e.to_string())?;
    Ok(OfflinePathDto {
        server_id,
        track_id,
        missing: path.is_none(),
        local_path: path,
    })
}

// ──────────────────────────────────────────────────────────────────────
//  PR-5d — Advanced Search (§5.13) + cross-server search (§5.5B)
// ──────────────────────────────────────────────────────────────────────

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_advanced_search(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryAdvancedSearchRequest,
) -> Result<LibraryAdvancedSearchResponse, String> {
    let store = Arc::clone(&runtime.store);
    let trace_album_browse = psysonic_core::logging::should_log_albums_browse_trace()
        && request.entity_types.len() == 1
        && request.entity_types[0] == crate::filter::EntityKind::Album
        && request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none();
    let trace_artists_browse = psysonic_core::logging::should_log_artists_browse_trace()
        && request.entity_types.len() == 1
        && request.entity_types[0] == crate::filter::EntityKind::Artist
        && request
            .query
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none();
    let trace_offset = request.offset;
    let trace_limit = request.limit;
    let trace_filter_count = request.filters.len();
    let trace_scope_count = request
        .library_scopes
        .as_ref()
        .map(|scopes| scopes.len())
        .unwrap_or(if request.library_scope.is_some() {
            1
        } else {
            0
        });
    let trace_advanced_search = psysonic_core::logging::should_log_debug();
    let trace_entity_types = format!("{:?}", request.entity_types);
    let trace_filters = request
        .filters
        .iter()
        .map(|filter| format!("{}:{}", filter.field, filter.op.as_str()))
        .collect::<Vec<_>>();
    let trace_skip_totals = request.skip_totals;
    library_spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let result = advanced_search::run_advanced_search(&store, &request);
        if trace_advanced_search {
            crate::app_deprintln!(
                "[library-db][advanced-search] entity_types={} scope_count={} filters={:?} limit={} offset={} skip_totals={} elapsed_ms={}",
                trace_entity_types,
                trace_scope_count,
                trace_filters,
                trace_limit,
                trace_offset,
                trace_skip_totals,
                t0.elapsed().as_millis(),
            );
        }
        if trace_album_browse {
            let step_ms = t0.elapsed().as_millis();
            let album_count = result.as_ref().map(|r| r.albums.len()).unwrap_or(0);
            crate::app_deprintln!(
                "[frontend][albums-browse] {}",
                serde_json::json!({
                    "step": "rust_advanced_search",
                    "elapsedMs": 0,
                    "details": {
                        "stepMs": step_ms,
                        "albums": album_count,
                        "offset": trace_offset,
                        "limit": trace_limit,
                        "filterCount": trace_filter_count,
                        "scopeCount": trace_scope_count,
                        "ok": result.is_ok(),
                    }
                })
            );
        }
        if trace_artists_browse {
            let step_ms = t0.elapsed().as_millis();
            let artist_count = result.as_ref().map(|r| r.artists.len()).unwrap_or(0);
            crate::app_deprintln!(
                "[frontend][artists-browse] {}",
                serde_json::json!({
                    "step": "rust_advanced_search",
                    "elapsedMs": 0,
                    "details": {
                        "stepMs": step_ms,
                        "artists": artist_count,
                        "offset": trace_offset,
                        "limit": trace_limit,
                        "filterCount": trace_filter_count,
                        "scopeCount": trace_scope_count,
                        "skipTotals": request.skip_totals,
                        "creditMode": request.artist_credit_mode,
                        "letterBucket": request.artist_letter_bucket,
                        "ok": result.is_ok(),
                    }
                })
            );
        }
        result
    })
    .await
}

/// Narrow local Favorites snapshot. Artist stars remain server-owned and are
/// supplied by the subsequent `getStarred2` refresh.
#[tauri::command]
pub async fn library_list_starred(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<crate::starred_browse::LibraryStarredResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::starred_browse::list_starred(&store, &server_id)).await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_list_lossless_albums(
    runtime: State<'_, LibraryRuntime>,
    request: crate::dto::LibraryLosslessAlbumsRequest,
) -> Result<crate::dto::LibraryLosslessAlbumsResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::lossless_albums::list_lossless_albums(&store, &request))
        .await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_list_albums_by_genre(
    runtime: State<'_, LibraryRuntime>,
    request: crate::dto::LibraryGenreAlbumsRequest,
) -> Result<crate::dto::LibraryGenreAlbumsResponse, String> {
    let store = Arc::clone(&runtime.store);
    let trace = psysonic_core::logging::should_log_albums_browse_trace();
    let trace_genre = request.genre.clone();
    let trace_offset = request.offset;
    let trace_limit = request.limit;
    library_spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let result = crate::genre_album_browse::list_albums_by_genre(&store, &request);
        if trace {
            let step_ms = t0.elapsed().as_millis();
            let album_count = result.as_ref().map(|r| r.albums.len()).unwrap_or(0);
            crate::app_deprintln!(
                "[frontend][albums-browse] {}",
                serde_json::json!({
                    "step": "rust_list_albums_by_genre",
                    "elapsedMs": 0,
                    "details": {
                        "stepMs": step_ms,
                        "albums": album_count,
                        "genre": trace_genre,
                        "offset": trace_offset,
                        "limit": trace_limit,
                        "ok": result.is_ok(),
                    }
                })
            );
        }
        result
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub fn library_genre_tags_inspect(
    runtime: State<'_, LibraryRuntime>,
) -> Result<crate::genre_tags_backfill::GenreTagsInspectDto, String> {
    crate::genre_tags_backfill::inspect_genre_tags_backfill(&runtime.store)
}

#[tauri::command]
#[specta::specta]
pub async fn library_genre_tags_run(
    app: tauri::AppHandle,
    runtime: State<'_, LibraryRuntime>,
) -> Result<(), String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || {
        crate::genre_tags_backfill::run_genre_tags_backfill(&store, &app)
    })
    .await
}

/// Ensure precomputed cluster identity keys are current without blocking Tauri's main thread.
#[tauri::command]
#[specta::specta]
pub async fn library_cluster_rebuild(
    runtime: State<'_, LibraryRuntime>,
    server_id: Option<String>,
) -> Result<u64, String> {
    let server_id = server_id
        .map(|server_id| server_id.trim().to_string())
        .filter(|server_id| !server_id.is_empty());
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || match server_id.as_deref() {
        Some(server_id) => crate::identity::ensure_cluster_keys_built(&store, server_id),
        None => crate::identity::rebuild_cluster_keys(&store, None),
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn library_resolve_entity_sources(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryResolveEntitySourcesRequest,
) -> Result<Vec<LibraryEntitySourceDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || scope_merge::resolve_entity_sources(&store, &request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn library_resolve_album_overlay(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryResolveAlbumOverlayRequest,
) -> Result<Vec<LibraryAlbumOverlayResolutionDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::album_overlay::resolve_album_overlay(&store, &request))
        .await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_scope_list_albums(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeListRequest,
) -> Result<Vec<crate::dto::LibraryAlbumDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || scope_merge::list_albums(&store, &request)).await
}

/// Candidate-first indexed browse for ordinary Albums / Tracks / Artists pages.
#[tauri::command]
pub async fn library_scope_browse(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeBrowseRequest,
) -> Result<LibraryScopeBrowseResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::scope_browse::browse(&store, &request)).await
}

#[tauri::command]
pub fn library_scope_browse_projection_inspect(
    runtime: State<'_, LibraryRuntime>,
) -> Result<crate::browse_projection::ScopeBrowseProjectionInspectDto, String> {
    crate::browse_projection::inspect(&runtime.store)
}

#[tauri::command]
pub async fn library_scope_browse_projection_run(
    app: tauri::AppHandle,
    runtime: State<'_, LibraryRuntime>,
) -> Result<(), String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::browse_projection::run_backfill(&store, &app)).await
}

// NOT specta-collected: returns LibraryAlbumDto carrying raw_json: Value.
#[tauri::command]
pub async fn library_scope_list_mainstage_albums(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryMainstageAlbumsRequest,
) -> Result<LibraryMainstageAlbumsResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::mainstage_browse::list_mainstage_albums(&store, &request))
        .await
}

// NOT specta-collected: returns LibraryArtistDto carrying raw_json: Value.
#[tauri::command]
pub async fn library_list_random_artists(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    limit: Option<u32>,
) -> Result<Vec<crate::dto::LibraryArtistDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || {
        crate::random_artists::list_random_artists(&store, &server_id, limit)
    })
    .await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_scope_list_artists(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeListRequest,
) -> Result<Vec<crate::dto::LibraryArtistDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || scope_merge::list_artists(&store, &request)).await
}

// NOT specta-collected: returns LibraryArtistDto carrying raw_json: Value.
#[tauri::command]
pub async fn library_scope_list_composers(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeListRequest,
) -> Result<Vec<crate::dto::LibraryArtistDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::composer_scope::list_composers(&store, &request)).await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_scope_search_tracks(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeSearchRequest,
) -> Result<Vec<LibraryTrackDto>, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || scope_merge::search_tracks(&store, &request)).await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_scope_album_detail(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeAlbumDetailRequest,
) -> Result<LibraryScopeAlbumDetailResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || scope_merge::album_detail(&store, &request)).await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_scope_artist_detail(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeArtistDetailRequest,
) -> Result<LibraryScopeArtistDetailResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || scope_merge::artist_detail(&store, &request)).await
}

// NOT specta-collected: response carries raw_json: Value.
#[tauri::command]
pub async fn library_scope_composer_detail(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryScopeComposerDetailRequest,
) -> Result<LibraryScopeComposerDetailResponse, String> {
    let store = Arc::clone(&runtime.store);
    library_spawn_blocking(move || crate::composer_scope::composer_detail(&store, &request)).await
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_get_artist_lossless_browse(
    runtime: State<'_, LibraryRuntime>,
    request: crate::dto::LibraryArtistLosslessBrowseRequest,
) -> Result<crate::dto::LibraryArtistLosslessBrowseResponse, String> {
    crate::artist_lossless_browse::get_artist_lossless_browse(&runtime.store, &request)
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_live_search(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryLiveSearchRequest,
) -> Result<LibraryLiveSearchResponse, String> {
    let empty = || LibraryLiveSearchResponse {
        artists: Vec::new(),
        albums: Vec::new(),
        tracks: Vec::new(),
        source: "local".to_string(),
    };
    if let Some(epoch) = request.request_epoch {
        runtime.register_live_search_epoch(epoch);
        if !runtime.live_search_still_current(epoch) {
            return Ok(empty());
        }
    }
    let result = live_search::run_live_search(
        &runtime.store,
        &request.server_id,
        &request.query,
        request.library_scope.as_deref(),
        request.library_scopes.as_deref(),
        request.artist_limit.unwrap_or(5),
        request.album_limit.unwrap_or(5),
        request.song_limit.unwrap_or(10),
    )?;
    if request
        .request_epoch
        .is_some_and(|epoch| !runtime.live_search_still_current(epoch))
    {
        return Ok(empty());
    }
    Ok(result)
}

// NOT specta-collected: returns a DTO carrying `raw_json: Value` (LibraryTrack/Album/ArtistDto) — specta rc.25 can't export serde_json::Value. Stays hand-written on generate_handler!.
#[tauri::command]
pub async fn library_search_cross_server(
    runtime: State<'_, LibraryRuntime>,
    query: String,
    limit: Option<u32>,
    servers: Option<Vec<String>>,
) -> Result<LibraryCrossServerSearchResponse, String> {
    let limit = limit.unwrap_or(100);
    cross_server::run_cross_server_search(&runtime.store, &query, limit, servers.as_deref(), None)
}

// ── helpers ──────────────────────────────────────────────────────────

/// Ordered multi-scope wins; else single `library_scope`; empty = all libraries.
fn effective_library_scopes(
    library_scope: Option<&str>,
    library_scopes: Option<&[String]>,
) -> Vec<String> {
    if let Some(list) = library_scopes {
        return crate::search::normalized_library_scopes(list);
    }
    crate::search::normalized_library_scopes(
        &library_scope
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
    )
}

fn hydrate_refs(
    runtime: &LibraryRuntime,
    refs: &[TrackRefDto],
) -> Result<Vec<LibraryTrackDto>, String> {
    let pairs: Vec<(String, String)> = refs
        .iter()
        .map(|r| (r.server_id.clone(), r.track_id.clone()))
        .collect();
    let rows = TrackRepository::new(&runtime.store).find_batch(&pairs)?;
    Ok(rows.iter().map(LibraryTrackDto::from_row).collect())
}

#[derive(Default)]
struct SyncStateRow {
    sync_phase: String,
    capability_flags: u32,
    library_tier: String,
    last_full_sync_at: Option<i64>,
    last_delta_sync_at: Option<i64>,
    next_poll_at: Option<i64>,
    server_last_scan_iso: Option<String>,
    indexes_last_modified_ms: Option<i64>,
    artists_last_modified_ms: Option<i64>,
    ignored_articles: Option<String>,
    local_track_count: Option<i64>,
    server_track_count: Option<i64>,
    last_error: Option<String>,
}

use rusqlite::OptionalExtension;

// ──────────────────────────────────────────────────────────────────────
//  PR-5b — session / lifecycle / mutate / purge
// ──────────────────────────────────────────────────────────────────────

/// Normalise a server URL the same way the frontend's
/// `authStore.getBaseUrl()` does — prepend `http://` when no scheme is
/// present and strip the trailing slash. `server.url` is stored bare
/// (e.g. `nas.example.com`); without this reqwest rejects the request
/// with "relative URL without a base".
fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    with_scheme.trim_end_matches('/').to_string()
}

/// Acquire a Navidrome native-API bearer with a few retries. `/auth/login`
/// is occasionally flaky; one transient miss must not strip N1 for the whole
/// session (R7-15 Q3). Returns `None` only after every attempt fails — the
/// caller falls back to a cached bearer / the Subsonic-only path. Never logs
/// the token or credentials.
async fn navidrome_token_with_retry(
    registry: Option<&ServerHttpRegistry>,
    base_url: &str,
    username: &str,
    password: &str,
) -> Option<String> {
    const ATTEMPTS: u32 = 3;
    for attempt in 1..=ATTEMPTS {
        match navidrome_token_with_registry(registry, base_url, username, password).await {
            Ok(tok) => return Some(tok),
            Err(_) if attempt < ATTEMPTS => {
                tokio::time::sleep(Duration::from_millis(250 * attempt as u64)).await;
            }
            Err(_) => return None,
        }
    }
    None
}

#[tauri::command]
#[specta::specta]
pub async fn library_sync_bind_session(
    runtime: State<'_, LibraryRuntime>,
    http_registry: State<'_, Arc<ServerHttpRegistry>>,
    server_id: String,
    base_url: String,
    username: String,
    password: String,
    library_scope: Option<String>,
) -> Result<(), String> {
    bind_sync_session_inner(
        &runtime,
        http_registry.as_ref(),
        BindSessionRequest {
            server_id,
            base_url,
            username,
            password,
            library_scope,
        },
        BIND_SESSION_TIMEOUTS,
    )
    .await
}

async fn bind_sync_session_inner(
    runtime: &LibraryRuntime,
    http_registry: &ServerHttpRegistry,
    request: BindSessionRequest,
    timeouts: BindSessionTimeouts,
) -> Result<(), String> {
    let BindSessionRequest {
        server_id,
        base_url,
        username,
        password,
        library_scope,
    } = request;
    let base_url = normalize_base_url(&base_url);
    let _barrier = runtime
        .cancel_and_drain_sync(None, Some(&server_id))
        .await?;

    // Prime the Navidrome native-API bearer at bind time (spec §6.1 + PR-5
    // kickoff Q5) so N1 probe / ingest works without every command passing a
    // token. `/auth/login` is flaky, so retry a few times; if it still fails,
    // keep a bearer cached from a prior bind rather than dropping to
    // Subsonic-only — a transient miss must not strip an N1-capable server
    // (R7-15 Q3). Non-Navidrome servers stay `None` and sync via Subsonic.
    let old_session = runtime.get_session(&server_id);
    let token_result = tokio::time::timeout(
        timeouts.token,
        navidrome_token_with_retry(Some(http_registry), &base_url, &username, &password),
    )
    .await;
    let navidrome_token_cached = match token_result {
        Ok(Some(token)) => Some(token),
        Ok(None) | Err(_) => old_session
            .as_ref()
            .and_then(|session| session.navidrome_token.clone()),
    };

    let session = SyncSession {
        server_id: server_id.clone(),
        base_url: base_url.clone(),
        username: username.clone(),
        password: password.clone(),
        navidrome_token: navidrome_token_cached.clone(),
        library_scope: library_scope.clone(),
    };

    // Run the probe + persist capability flags. Failure to probe is a
    // bind-time error. Publish only after success so a failed replacement
    // leaves the previous session available.
    let subsonic = subsonic_client_with_registry(
        Some(http_registry),
        &server_id,
        base_url.clone(),
        username.clone(),
        password.clone(),
    );
    let navidrome_creds = navidrome_token_cached.map(|tok| NavidromeProbeCredentials {
        server_url: base_url,
        bearer_token: tok,
    });
    let scope = library_scope.as_deref().unwrap_or_default();
    probe_and_persist_with_timeout(
        &runtime.store,
        &subsonic,
        navidrome_creds.as_ref(),
        Some(http_registry),
        &server_id,
        scope,
        timeouts.probe,
    )
    .await
    .map_err(|e| format!("bind probe failed: {e}"))?;
    runtime.set_session(session)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn library_sync_clear_session(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<(), String> {
    clear_sync_session(&runtime, &server_id).await
}

async fn clear_sync_session(runtime: &LibraryRuntime, server_id: &str) -> Result<(), String> {
    let _barrier = runtime
        .cancel_and_drain_sync(None, Some(server_id))
        .await?;
    runtime.clear_session(server_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn library_set_playback_hint(
    runtime: State<'_, LibraryRuntime>,
    hint: String,
) -> Result<(), String> {
    let parsed = match hint.as_str() {
        "idle" => PlaybackHint::Idle,
        "playing" => PlaybackHint::Playing,
        "prefetch_active" => PlaybackHint::PrefetchActive,
        other => return Err(format!("unknown playback hint: `{other}`")),
    };
    runtime.set_playback_hint(parsed);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn library_get_playback_hint(runtime: State<'_, LibraryRuntime>) -> Result<String, String> {
    Ok(match runtime.current_playback_hint() {
        PlaybackHint::Idle => "idle".to_string(),
        PlaybackHint::Playing => "playing".to_string(),
        PlaybackHint::PrefetchActive => "prefetch_active".to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn library_sync_start(
    app: AppHandle,
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    mode: String,
    library_scope: Option<String>,
) -> Result<SyncJobDto, String> {
    library_sync_start_inner(app, runtime, server_id, mode, library_scope, false).await
}

/// Map a runner result for the sync-idle event. Cancellation is expected —
/// the user cancelled, or a newer `library_sync_start` superseded this job
/// (e.g. a server switch, or the startup resume) — and must never surface as
/// a failure toast (error.rs: "Cancelled is silent").
fn sync_outcome_to_result<T>(r: Result<T, SyncError>) -> Result<(), String> {
    match r {
        Ok(_) => Ok(()),
        Err(SyncError::Cancelled) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

async fn library_sync_start_inner(
    app: AppHandle,
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    mode: String,
    library_scope: Option<String>,
    force_full_tombstone: bool,
) -> Result<SyncJobDto, String> {
    // Every foreground start supersedes the previous job, regardless of mode
    // or server. Drain it before installing the replacement so no late cursor
    // or ingest write can race the new runner. Read the session afterwards so
    // a concurrent rebind/purge cannot leave this start using a stale snapshot.
    let _barrier = runtime.cancel_and_drain_sync(None, None).await?;
    let session = runtime.get_session(&server_id).ok_or_else(|| {
        format!("no bound session for server `{server_id}` — call library_sync_bind_session first")
    })?;
    let scope = library_scope
        .clone()
        .or(session.library_scope.clone())
        .unwrap_or_default();
    let kind = resolve_sync_job_kind(&mode, &scope, force_full_tombstone)?;
    let mut capability_flags = load_capability_flags(&runtime, &server_id, &scope)?;
    // N1 needs the Navidrome bearer. Without a cached token this run is
    // Subsonic-only even on an N1-capable server — mask the flag for *this*
    // run's strategy selection (R7-15 Q3 "proceed as Subsonic-only"). The
    // persisted server capability stays untouched, so a later bind that
    // recovers the token can use N1 again.
    if session.navidrome_token.is_none() {
        capability_flags.remove(CapabilityFlags::NAVIDROME_NATIVE_BULK);
    }

    let job_id = format!(
        "{}_{}_{}",
        server_id,
        now_unix_ms(),
        NEXT_SYNC_JOB_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(tokio::sync::Notify::new());
    let job = CurrentJob {
        job_id: job_id.clone(),
        server_id: server_id.clone(),
        kind: kind.to_string(),
        cancel: Arc::clone(&cancel),
        abort_handle: None,
        done: Arc::clone(&done),
    };
    runtime.install_current_job(job)?;

    // Spawn the runner in a detached task. Progress events flow
    // through an mpsc channel to the orchestrator that emits Tauri
    // events; the runner doesn't need an AppHandle.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
    let progress: Arc<dyn Progress + Send + Sync> = Arc::new(ChannelProgress::new(tx));

    let store = Arc::clone(&runtime.store);
    let session_clone = session.clone();
    let scope_for_task = scope.clone();
    let kind_for_task = kind.to_string();
    let cancel_for_task = Arc::clone(&cancel);
    let job_id_for_task = job_id.clone();
    let parallelism = ParallelismBudget::resolve(runtime.current_playback_hint());

    let app_for_runner = app.clone();
    let runner_handle: tokio::task::JoinHandle<Result<(), String>> =
        tokio::task::spawn(async move {
            let registry = app_for_runner.state::<Arc<ServerHttpRegistry>>();
            let subsonic = subsonic_client_with_registry(
                Some(registry.as_ref()),
                &session_clone.server_id,
                session_clone.base_url.clone(),
                session_clone.username.clone(),
                session_clone.password.clone(),
            );
            let navidrome_creds =
                session_clone
                    .navidrome_token
                    .clone()
                    .map(|tok| NavidromeProbeCredentials {
                        server_url: session_clone.base_url.clone(),
                        bearer_token: tok,
                    });

            let result: Result<(), String> = if kind_for_task == "initial_sync" {
                let mut runner = InitialSyncRunner::new(
                    &store,
                    &subsonic,
                    session_clone.server_id.clone(),
                    scope_for_task.clone(),
                    capability_flags,
                )
                .with_cancellation(Arc::clone(&cancel_for_task))
                .with_progress(Arc::clone(&progress))
                .with_parallelism_budget(parallelism)
                .with_http_registry(Some(Arc::clone(&registry)));
                if let Some(creds) = navidrome_creds.clone() {
                    runner = runner.with_navidrome_credentials(creds);
                }
                let run = sync_outcome_to_result(runner.run().await);
                if run.is_ok() {
                    run_tag_pass_best_effort(
                        &store,
                        &subsonic,
                        &session_clone.server_id,
                        Some(Arc::clone(&cancel_for_task)),
                        Arc::clone(&progress),
                        false,
                    )
                    .await;
                }
                run
            } else {
                // Delta uses the mismatch budget when the local/server count gap
                // crosses the threshold. Manual Verify is a separate stable full
                // pass, so it cannot be skipped by an unchanged watermark or stop
                // after one 200-row chunk.
                let tombstone_budget = if force_full_tombstone {
                    0
                } else {
                    compute_tombstone_budget(&store, &session_clone.server_id, &scope_for_task)
                };
                let mut runner = DeltaSyncRunner::new(
                    &store,
                    &subsonic,
                    session_clone.server_id.clone(),
                    scope_for_task.clone(),
                    capability_flags,
                )
                .with_cancellation(Arc::clone(&cancel_for_task))
                .with_progress(Arc::clone(&progress))
                .with_http_registry(Some(Arc::clone(&registry)));
                if force_full_tombstone {
                    runner = runner.with_full_tombstone_pass();
                } else if tombstone_budget > 0 {
                    runner = runner.with_tombstone_budget(tombstone_budget);
                }
                if let Some(creds) = navidrome_creds.clone() {
                    runner = runner.with_navidrome_credentials(creds);
                }
                let run = sync_outcome_to_result(runner.run().await);
                if run.is_ok() {
                    run_tag_pass_best_effort(
                        &store,
                        &subsonic,
                        &session_clone.server_id,
                        Some(Arc::clone(&cancel_for_task)),
                        Arc::clone(&progress),
                        true,
                    )
                    .await;
                }
                run
            };

            // Closing the mpsc sender by dropping `progress` so the
            // orchestrator's drain loop terminates.
            drop(progress);
            let _ = job_id_for_task; // silence unused on Err
            result
        });
    if let Err(error) =
        runtime.attach_current_job_abort_handle(&job_id, runner_handle.abort_handle())
    {
        runner_handle.abort();
        runtime.clear_current_job_if_matches(&job_id);
        done.notify_one();
        return Err(error);
    }

    // Orchestrator: drain progress + emit Tauri events, then emit
    // sync-idle when the runner exits.
    let app_for_emit = app.clone();
    let server_id_for_emit = server_id.clone();
    let scope_for_emit = scope.clone();
    let kind_for_emit = kind.to_string();
    let job_id_for_emit = job_id.clone();
    let done_for_emit = Arc::clone(&done);
    tokio::task::spawn(async move {
        // Drain progress events; loop ends when sender is dropped.
        while let Some(event) = rx.recv().await {
            let payload = LibrarySyncProgressPayload::from_event(
                &event,
                &server_id_for_emit,
                &scope_for_emit,
            );
            let _ = app_for_emit.emit(LibrarySyncProgressPayload::PROGRESS_EVENT_NAME, &payload);
        }
        // Wait for the runner to finish + emit sync-idle.
        let mut outcome = match runner_handle.await {
            Ok(Ok(())) => {
                LibrarySyncIdlePayload::ok(
                    &server_id_for_emit,
                    &scope_for_emit,
                    &kind_for_emit,
                    "foreground",
                )
                .with_job_id(&job_id_for_emit)
            }
            Ok(Err(msg)) => LibrarySyncIdlePayload::err(
                &server_id_for_emit,
                &scope_for_emit,
                &kind_for_emit,
                "foreground",
                &msg,
            )
            .with_job_id(&job_id_for_emit),
            Err(join_err) if join_err.is_cancelled() => {
                LibrarySyncIdlePayload::ok(
                    &server_id_for_emit,
                    &scope_for_emit,
                    &kind_for_emit,
                    "foreground",
                )
                .with_job_id(&job_id_for_emit)
            }
            Err(join_err) => LibrarySyncIdlePayload::err(
                &server_id_for_emit,
                &scope_for_emit,
                &kind_for_emit,
                "foreground",
                &format!("sync task panicked: {join_err}"),
            )
            .with_job_id(&job_id_for_emit),
        };
        if outcome.ok {
            let identity_store = app_for_emit
                .try_state::<LibraryRuntime>()
                .map(|runtime| Arc::clone(&runtime.store));
            if let Some(store) = identity_store {
                let identity_server_id = server_id_for_emit.clone();
                if let Err(error) = library_spawn_blocking(move || {
                    crate::identity::ensure_cluster_keys_built(&store, &identity_server_id)
                        .map(|_| ())
                })
                .await
                {
                    crate::app_eprintln!(
                        "[library-cluster] foreground maintenance failed server_id={}: {}",
                        server_id_for_emit,
                        error
                    );
                    outcome.mark_failed(format!("identity maintenance failed: {error}"));
                }
            }
        }
        if let Some(runtime) = app_for_emit.try_state::<LibraryRuntime>() {
            let _ = runtime.store.checkpoint_wal("sync.checkpoint");
        }
        let _ = app_for_emit.emit(LibrarySyncProgressPayload::IDLE_EVENT_NAME, &outcome);

        // Clear before notifying so a woken drain waiter cannot observe the
        // completed slot and wait for a second, nonexistent notification.
        if let Some(state) = app_for_emit.try_state::<LibraryRuntime>() {
            state.complete_current_job(&job_id_for_emit, &done_for_emit);
        } else {
            done_for_emit.notify_one();
        }
    });

    Ok(SyncJobDto {
        job_id,
        server_id,
        kind: kind.to_string(),
    })
}

/// Manual «Verify library integrity» — same dispatch shape as
/// `library_sync_start { mode: 'delta' }`, but the runner bypasses delta
/// watermarks and completes a stable full tombstone pass.
#[tauri::command]
#[specta::specta]
pub async fn library_sync_verify_integrity(
    app: AppHandle,
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    library_scope: Option<String>,
) -> Result<SyncJobDto, String> {
    library_sync_start_inner(
        app,
        runtime,
        server_id,
        "delta".to_string(),
        library_scope,
        /* force_full_tombstone */ true,
    )
    .await
}

fn resolve_sync_job_kind(
    mode: &str,
    library_scope: &str,
    force_full_tombstone: bool,
) -> Result<&'static str, String> {
    match mode {
        "full" => Ok("initial_sync"),
        // `getSong` proves that an id exists, not that it still belongs to a
        // music folder. Scoped Verify uses the scope-safe full resync and
        // generation sweep instead of the server-wide tombstone probe.
        "delta" if force_full_tombstone && !library_scope.is_empty() => Ok("initial_sync"),
        "delta" => Ok("delta_sync"),
        other => Err(format!("unknown sync mode: `{other}`")),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn library_sync_cancel(
    runtime: State<'_, LibraryRuntime>,
    job_id: Option<String>,
) -> Result<(), String> {
    // If supplied, `job_id` is matched while holding the lifecycle lock. A
    // stale cancel therefore cannot race a replacement and cancel the new job.
    let _barrier = runtime
        .cancel_and_drain_sync(job_id.as_deref(), None)
        .await?;
    Ok(())
}

/// Record the playback-derived `md5_16kb` as `track.content_hash` for
/// `(server_id, track_id)` (E2). A no-op when the value is empty or the library
/// has no row for that pair (index off for the server). Shared by the
/// analysis→library content_hash bridge (registered in the shell crate) and by
/// [`library_patch_track`]'s `contentHash` field. The playback hash is
/// authoritative, so this overwrites unconditionally; sync ingest preserves it
/// via `COALESCE(NULLIF(excluded.content_hash,''), …)` in the upsert.
pub fn patch_content_hash(
    runtime: &LibraryRuntime,
    server_id: &str,
    track_id: &str,
    md5_16kb: &str,
) -> Result<(), String> {
    if md5_16kb.is_empty() {
        return Ok(());
    }
    runtime
        .store
        .with_conn("cmd.patch_content_hash", |conn| {
            conn.execute(
                "UPDATE track SET content_hash = ?3 \
                 WHERE server_id = ?1 AND id = ?2",
                params![server_id, track_id, md5_16kb],
            )?;
            Ok(())
        })
        .map_err(|e| e.to_string())
}

// NOT specta-collected: takes a serde_json::Value arg — specta rc.25 can't export it. Stays hand-written on generate_handler!.
#[tauri::command]
pub fn library_patch_track(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    patch: Value,
) -> Result<(), String> {
    apply_track_patch(&runtime, &server_id, &track_id, &patch)
}

/// Apply a sparse `library_patch_track` JSON patch (extracted from the command
/// so it is unit-testable without a Tauri `State`). Only fields explicitly
/// present in `patch` are applied; absent keys leave the column untouched. For
/// the nullable integer fields, an explicit `null` clears the column (e.g.
/// `unstar` → `starredAt: null`): `.map` keeps the present/absent distinction
/// (outer `Some` = key present), `as_i64()` yields the value or `None` → bound
/// as SQL NULL. Spec §6.5 patch-on-use: `starred_at`, `user_rating`,
/// `play_count`, `played_at`; §8.1 E2: `content_hash`. All UPDATEs no-op when
/// the library has no row for `(server_id, track_id)`.
pub(crate) fn apply_track_patch(
    runtime: &LibraryRuntime,
    server_id: &str,
    track_id: &str,
    patch: &Value,
) -> Result<(), String> {
    let starred_at = patch.get("starredAt").map(|v| v.as_i64());
    let user_rating = patch.get("userRating").map(|v| v.as_i64());
    let play_count = patch.get("playCount").map(|v| v.as_i64());
    let played_at = patch.get("playedAt").map(|v| v.as_i64());
    let content_hash = patch
        .get("contentHash")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    runtime
        .store
        .with_conn("cmd.patch_track", |conn| {
            // One UPDATE per field present — keeps SQL simple and
            // matches the spec's per-field patch semantics.
            if let Some(v) = starred_at {
                conn.execute(
                    "UPDATE track SET starred_at = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = user_rating {
                conn.execute(
                    "UPDATE track SET user_rating = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = play_count {
                conn.execute(
                    "UPDATE track SET play_count = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = played_at {
                conn.execute(
                    "UPDATE track SET played_at = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            if let Some(v) = content_hash {
                conn.execute(
                    "UPDATE track SET content_hash = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, track_id, v],
                )?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn library_put_artifact(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    artifact: ArtifactInputDto,
) -> Result<(), String> {
    // E4: typed repo owns the upsert + the §5.12 512 KB size cap.
    crate::repos::ArtifactRepository::new(&runtime.store).put(
        &server_id,
        &track_id,
        &artifact,
        now_unix_ms(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn library_put_fact(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    fact: FactInputDto,
) -> Result<(), String> {
    // E4: typed repo owns the upsert + the §5.12 user-override rule
    // (a `user` bpm fact also writes the hot `track.bpm` column).
    crate::repos::FactRepository::new(&runtime.store).put(
        &server_id,
        &track_id,
        &fact,
        now_unix_ms(),
    )
}

#[tauri::command]
#[specta::specta]
pub fn library_record_play_session(
    runtime: State<'_, LibraryRuntime>,
    input: PlaySessionInputDto,
) -> Result<(), String> {
    PlaySessionRepository::new(&runtime.store).insert(&input)
}

#[tauri::command]
#[specta::specta]
pub fn library_get_player_stats_year_summary(
    runtime: State<'_, LibraryRuntime>,
    year: i32,
) -> Result<PlaySessionYearSummaryDto, String> {
    PlaySessionRepository::new(&runtime.store).year_summary(year)
}

#[tauri::command]
#[specta::specta]
pub fn library_get_player_stats_heatmap(
    runtime: State<'_, LibraryRuntime>,
    year: i32,
) -> Result<Vec<PlaySessionHeatmapDayDto>, String> {
    PlaySessionRepository::new(&runtime.store).heatmap(year)
}

#[tauri::command]
#[specta::specta]
pub fn library_get_player_stats_day_detail(
    runtime: State<'_, LibraryRuntime>,
    date_iso: String,
) -> Result<PlaySessionDayDetailDto, String> {
    PlaySessionRepository::new(&runtime.store).day_detail(&date_iso)
}

#[tauri::command]
#[specta::specta]
pub fn library_get_player_stats_year_bounds(
    runtime: State<'_, LibraryRuntime>,
) -> Result<PlaySessionYearBoundsDto, String> {
    PlaySessionRepository::new(&runtime.store).year_bounds()
}

#[tauri::command]
#[specta::specta]
pub fn library_get_player_stats_recent_days(
    runtime: State<'_, LibraryRuntime>,
    limit: Option<u32>,
) -> Result<Vec<PlaySessionRecentDayDto>, String> {
    PlaySessionRepository::new(&runtime.store).recent_days(limit.unwrap_or(30))
}

#[tauri::command]
#[specta::specta]
pub fn library_get_recent_play_sessions(
    runtime: State<'_, LibraryRuntime>,
    limit: Option<u32>,
    since_ms: Option<i64>,
) -> Result<Vec<PlaySessionRecentTrackDto>, String> {
    PlaySessionRepository::new(&runtime.store).recent_plays(limit.unwrap_or(50), since_ms)
}

#[tauri::command]
#[specta::specta]
pub async fn library_purge_server(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    include_analysis: Option<bool>,
    include_offline: Option<bool>,
) -> Result<PurgeReportDto, String> {
    // R7-16 Q7: `includeAnalysis` is a deliberate v1 no-op — analysis blobs are
    // expensive to rebuild (full-file decode) and the same host may return under
    // a new login / app server_id with identical file content, so a purge or
    // server-remove never deletes waveform/loudness rows. Kept on the surface for
    // forward compat; explicit cleanup stays Settings → Storage + queue reseed.
    let _ = include_analysis;
    let include_offline = include_offline.unwrap_or(false);

    // Stop a foreground job for this server and wait for any active scheduler
    // tick before deleting. The guard also blocks replacement jobs and new
    // scheduler ticks until the purge transaction and session clear finish.
    let _barrier = runtime
        .cancel_and_drain_sync(None, Some(&server_id))
        .await?;
    runtime.clear_session(&server_id);
    purge_server_data(&runtime, &server_id, include_offline)
}

fn purge_server_data(
    runtime: &LibraryRuntime,
    server_id: &str,
    include_offline: bool,
) -> Result<PurgeReportDto, String> {
    let mut report = PurgeReportDto::default();
    runtime
        .store
        .with_conn_mut("cmd.purge_server", |conn| {
            let tx = conn.transaction()?;
            let track_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let album_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM album WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let artist_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM artist WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let offline_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM track_offline WHERE server_id = ?1",
                params![server_id],
                |r| r.get(0),
            )?;
            let offline_bytes: Option<i64> = tx
                .query_row(
                    "SELECT SUM(file_size_bytes) FROM track_offline WHERE server_id = ?1",
                    params![server_id],
                    |r| r.get(0),
                )
                .ok();

            // Tear down child rows first (no cascade configured) so
            // the FK constraints on track stay happy.
            tx.execute(
                "DELETE FROM track_extension WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_fact WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_artifact WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_canonical_link WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_id_history WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM play_session WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM track_genre WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM canonical_enrichment_link WHERE owner_server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM album_browse_projection WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM composer_album_projection WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM artist_artwork_lookup WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM entity_user_rating WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM library_tag_state WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM library_tag_cursor WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM cluster.track_cluster_key WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM cluster.cluster_meta WHERE key = ?1",
                params![format!("dirty_server:{server_id}")],
            )?;
            tx.execute(
                "DELETE FROM identity_invalidation WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute("DELETE FROM track WHERE server_id = ?1", params![server_id])?;
            tx.execute("DELETE FROM album WHERE server_id = ?1", params![server_id])?;
            tx.execute(
                "DELETE FROM artist WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM sync_state WHERE server_id = ?1",
                params![server_id],
            )?;
            if include_offline {
                tx.execute(
                    "DELETE FROM track_offline WHERE server_id = ?1",
                    params![server_id],
                )?;
            }
            tx.commit()?;

            report.tracks_deleted = track_count.max(0) as u32;
            report.albums_deleted = album_count.max(0) as u32;
            report.artists_deleted = artist_count.max(0) as u32;
            report.offline_rows_deleted = if include_offline {
                offline_count.max(0) as u32
            } else {
                0
            };
            report.bytes_freed = if include_offline {
                offline_bytes.unwrap_or(0).max(0)
            } else {
                0
            };
            Ok(())
        })
        .map_err(|e| e.to_string())?;

    Ok(report)
}

#[tauri::command]
#[specta::specta]
pub fn library_migrate_server_index_keys(
    _runtime: State<'_, LibraryRuntime>,
    mappings: Vec<LibraryServerKeyMigrationDto>,
) -> Result<(), String> {
    for mapping in mappings {
        let _ = (mapping.legacy_id, mapping.index_key);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn library_delete_server_data(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<(), String> {
    library_purge_server(runtime, server_id, Some(false), Some(true))
        .await
        .map(|_| ())
}

// ── helpers ──────────────────────────────────────────────────────────

fn load_capability_flags(
    runtime: &LibraryRuntime,
    server_id: &str,
    library_scope: &str,
) -> Result<CapabilityFlags, String> {
    let bits = SyncStateRepository::new(&runtime.store)
        .get_capability_flags(server_id, library_scope)?
        .unwrap_or(0);
    Ok(CapabilityFlags::new(bits))
}

fn compute_tombstone_budget(
    store: &crate::store::LibraryStore,
    server_id: &str,
    library_scope: &str,
) -> u32 {
    let sync_state = SyncStateRepository::new(store);
    let local = sync_state
        .get_local_track_count(server_id, library_scope)
        .ok()
        .flatten()
        .unwrap_or(0)
        .max(0) as u32;
    let server = sync_state
        .get_server_track_count(server_id, library_scope)
        .ok()
        .flatten()
        .unwrap_or(0)
        .max(0) as u32;
    if should_auto_reconcile_scope(
        library_scope,
        local,
        server,
        crate::sync::scheduler::DEFAULT_TOMBSTONE_THRESHOLD_PCT,
    ) {
        crate::sync::budget::RequestBudget::DELTA_MISMATCH_CAP
    } else {
        0
    }
}

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn valid_entity_user_rating_key(server_id: &str, entity_kind: &str, entity_id: &str) -> bool {
    !server_id.is_empty()
        && !entity_id.is_empty()
        && matches!(entity_kind, "track" | "album" | "artist")
}

fn get_entity_user_ratings(
    store: &LibraryStore,
    refs: &[EntityUserRatingRefDto],
) -> Result<Vec<EntityUserRatingDto>, String> {
    store.with_read_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT server_id, entity_kind, entity_id, rating, fetched_at
             FROM entity_user_rating
             WHERE server_id = ?1 AND entity_kind = ?2 AND entity_id = ?3",
        )?;
        let mut ratings = Vec::new();
        for reference in refs {
            let server_id = reference.server_id.trim();
            let entity_kind = reference.entity_kind.trim();
            let entity_id = reference.entity_id.trim();
            if !valid_entity_user_rating_key(server_id, entity_kind, entity_id) {
                continue;
            }
            if let Some(rating) = statement
                .query_row(params![server_id, entity_kind, entity_id], |row| {
                    Ok(EntityUserRatingDto {
                        server_id: row.get(0)?,
                        entity_kind: row.get(1)?,
                        entity_id: row.get(2)?,
                        rating: row.get(3)?,
                        fetched_at: row.get(4)?,
                    })
                })
                .optional()?
            {
                ratings.push(rating);
            }
        }
        Ok(ratings)
    })
}

fn put_entity_user_ratings(
    store: &LibraryStore,
    ratings: &[EntityUserRatingDto],
    now: i64,
) -> Result<(), String> {
    store.with_conn_mut("entity_user_rating.upsert_batch", |conn| {
        let transaction = conn.transaction()?;
        let mut statement = transaction.prepare(
            "INSERT INTO entity_user_rating (server_id, entity_kind, entity_id, rating, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(server_id, entity_kind, entity_id) DO UPDATE SET
               rating = excluded.rating,
               fetched_at = excluded.fetched_at",
        )?;
        for rating in ratings {
            let server_id = rating.server_id.trim();
            let entity_kind = rating.entity_kind.trim();
            let entity_id = rating.entity_id.trim();
            if !valid_entity_user_rating_key(server_id, entity_kind, entity_id) {
                continue;
            }
            statement.execute(params![
                server_id,
                entity_kind,
                entity_id,
                rating.rating,
                rating.fetched_at.max(now),
            ])?;
        }
        drop(statement);
        transaction.commit()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::TrackRow;
    use crate::store::LibraryStore;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn make_row(server: &str, id: &str, album_id: &str, track_no: i64) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: format!("Track {id}"),
            title_sort: None,
            artist: Some("A".into()),
            artist_id: Some("ar1".into()),
            album: "Album".into(),
            album_id: Some(album_id.into()),
            album_artist: Some("A".into()),
            duration_sec: 240,
            track_number: Some(track_no),
            disc_number: Some(1),
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: Some(format!("/path/{id}.flac")),
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: Some(format!("hash-{id}")),
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    // The command functions take `tauri::State` which we can't easily
    // construct in unit tests without a Tauri runtime. The tests below
    // exercise the *underlying* logic by calling the equivalent
    // `LibraryRuntime` + repo paths directly. Integration coverage with
    // a real Tauri app lives outside this crate (PR-5c devtools test).

    fn runtime(store: Arc<LibraryStore>) -> LibraryRuntime {
        LibraryRuntime::new(store)
    }

    fn populate_server_scoped_tables(store: &LibraryStore, server_id: &str) {
        let canonical_id = format!("canonical-{server_id}");
        let artist_id = format!("artist-{server_id}");
        let album_id = format!("album-{server_id}");
        let track_id = format!("track-{server_id}");
        store
            .with_conn("test.populate_server_scopes", |conn| {
                conn.execute_batch(&format!(
                    "INSERT INTO canonical_track(id, created_at, updated_at) VALUES ('{canonical_id}', 1, 1);
                     INSERT INTO sync_state(server_id, library_scope) VALUES ('{server_id}', '');
                     INSERT INTO artist(server_id, id, name, synced_at) VALUES ('{server_id}', '{artist_id}', 'Artist', 1);
                     INSERT INTO album(server_id, id, name, synced_at) VALUES ('{server_id}', '{album_id}', 'Album', 1);
                     INSERT INTO track(server_id, id, title, album, duration_sec, synced_at, raw_json)
                       VALUES ('{server_id}', '{track_id}', 'Track', 'Album', 1, 1, '{{}}');
                     INSERT INTO track_extension(server_id, track_id, kind, payload, updated_at)
                       VALUES ('{server_id}', '{track_id}', 'waveform', X'01', 1);
                     INSERT INTO track_fact(server_id, track_id, fact_kind, source_kind, source_id, fetched_at)
                       VALUES ('{server_id}', '{track_id}', 'bpm', 'server', 'source', 1);
                     INSERT INTO track_artifact(server_id, track_id, artifact_kind, format, source_kind, source_id, fetched_at)
                       VALUES ('{server_id}', '{track_id}', 'lyrics', 'text', 'server', 'source', 1);
                     INSERT INTO track_canonical_link(server_id, track_id, canonical_id, match_method, confidence, linked_at)
                       VALUES ('{server_id}', '{track_id}', '{canonical_id}', 'isrc', 1.0, 1);
                     INSERT INTO track_id_history(server_id, old_id, new_id, remapped_at)
                       VALUES ('{server_id}', 'old-{track_id}', '{track_id}', 1);
                     INSERT INTO play_session(server_id, track_id, started_at_ms, listened_sec, position_max_sec, completion, end_reason)
                       VALUES ('{server_id}', '{track_id}', 1, 1.0, 1.0, 'full', 'ended');
                     INSERT INTO track_offline(server_id, track_id, local_path, cached_at)
                       VALUES ('{server_id}', '{track_id}', '/tmp/{track_id}', 1);
                     INSERT INTO track_genre(server_id, track_id, genre, album_id)
                       VALUES ('{server_id}', '{track_id}', 'Rock', '{album_id}');
                     INSERT INTO artist_artwork_lookup(server_id, artist_id, surface_kind, status, updated_at)
                       VALUES ('{server_id}', '{artist_id}', 'fanart', 'hit', 1);
                      INSERT INTO library_tag_state(server_id, folders_hash, completed_at)
                        VALUES ('{server_id}', 'hash', 1);
                      INSERT INTO library_tag_cursor(server_id, folders_hash, next_folder_id, updated_at)
                        VALUES ('{server_id}', 'hash', 'folder-1', 1);
                     INSERT INTO entity_user_rating(server_id, entity_kind, entity_id, rating, fetched_at)
                       VALUES ('{server_id}', 'track', '{track_id}', 5, 1);
                     INSERT INTO album_browse_projection(
                       server_id, library_id, album_id, name, song_count, duration_sec, synced_at, representative_track_id
                     ) VALUES ('{server_id}', '', '{album_id}', 'Album', 1, 1, 1, '{track_id}');
                     INSERT INTO canonical_enrichment_link(
                       canonical_id, enrichment_kind, owner_server_id, owner_track_id, linked_at
                     ) VALUES ('{canonical_id}', 'lyrics', '{server_id}', '{track_id}', 1);"
                ))?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn get_status_returns_defaults_when_no_row_exists() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = runtime(store);
        // Simulate command body — same logic as `library_get_status`.
        let local_max = local_tracks_max_updated_ms(&rt.store, "s1").unwrap();
        assert!(local_max.is_none());
    }

    #[test]
    fn library_track_dto_from_row_preserves_hot_columns() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al_1", 5)])
            .unwrap();
        let found = TrackRepository::new(&store)
            .find_one("s1", "tr_1")
            .unwrap()
            .unwrap();
        let dto = LibraryTrackDto::from_row(&found);
        assert_eq!(dto.id, "tr_1");
        assert_eq!(dto.album_id.as_deref(), Some("al_1"));
        assert_eq!(dto.track_number, Some(5));
    }

    #[test]
    fn api_song_upsert_stamps_epoch_milliseconds() {
        let store = LibraryStore::open_in_memory();
        let before = now_unix_ms();
        let inserted = upsert_songs_from_api(
            &store,
            "s1",
            vec![serde_json::json!({
                "id": "tr_1",
                "title": "Track",
                "album": "Album",
                "albumId": "al_1",
                "duration": 120
            })],
        )
        .unwrap();
        let after = now_unix_ms();

        let synced_at: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT synced_at FROM track WHERE server_id = 's1' AND id = 'tr_1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(inserted, 1);
        assert!(synced_at >= before && synced_at <= after);
        assert!(
            synced_at > 1_000_000_000_000,
            "timestamp must be milliseconds"
        );
    }

    #[test]
    fn patch_content_hash_sets_value_and_noops_on_absent_or_empty() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al_1", 1)])
            .unwrap();
        let rt = runtime(store.clone());

        let read = |store: &LibraryStore| -> Option<String> {
            store
                .with_conn("misc", |c| {
                    c.query_row(
                        "SELECT content_hash FROM track WHERE server_id='s1' AND id='tr_1'",
                        [],
                        |r| r.get(0),
                    )
                })
                .unwrap()
        };

        // No-ops leave the existing value untouched: empty md5, and a row that
        // doesn't exist (the absent-row case is how "index off" stays a no-op).
        patch_content_hash(&rt, "s1", "tr_1", "").unwrap();
        patch_content_hash(&rt, "s1", "missing", "deadbeef").unwrap();
        assert_eq!(read(&store).as_deref(), Some("hash-tr_1"));

        patch_content_hash(&rt, "s1", "tr_1", "md5-playback").unwrap();
        assert_eq!(read(&store).as_deref(), Some("md5-playback"));
    }

    #[test]
    fn apply_track_patch_sets_clears_and_leaves_fields() {
        // §6.5 patch-on-use: present value sets, explicit null clears, absent key
        // leaves the column untouched — so `unstar` ({starredAt:null}) actually
        // un-stars the local row.
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al_1", 1)])
            .unwrap();
        let rt = runtime(store.clone());
        let read = |store: &LibraryStore| -> (Option<i64>, Option<i64>) {
            store
                .with_conn("misc", |c| {
                    c.query_row(
                        "SELECT starred_at, user_rating FROM track WHERE server_id='s1' AND id='tr_1'",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                })
                .unwrap()
        };

        apply_track_patch(
            &rt,
            "s1",
            "tr_1",
            &serde_json::json!({ "starredAt": 1700, "userRating": 4 }),
        )
        .unwrap();
        assert_eq!(read(&store), (Some(1700), Some(4)));

        // Explicit null clears starred_at; absent userRating stays.
        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({ "starredAt": null })).unwrap();
        assert_eq!(
            read(&store),
            (None, Some(4)),
            "null clears, absent key untouched"
        );

        // Empty patch is a no-op.
        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({})).unwrap();
        assert_eq!(read(&store), (None, Some(4)));
    }

    #[test]
    fn find_by_album_orders_by_disc_then_track_then_id() {
        let store = Arc::new(LibraryStore::open_in_memory());
        // A missing disc number is treated as disc 1 (matching the album UI's
        // `discNumber ?? 1`), then track number, then a stable `id` tie-break for
        // duplicate disc/track positions.
        let with_disc = |id: &str, album: &str, disc: Option<i64>, trk: i64| {
            let mut r = make_row("s1", id, album, trk);
            r.disc_number = disc;
            r
        };
        TrackRepository::new(&store)
            .upsert_batch(&[
                with_disc("tr_dup_z", "al_1", Some(2), 2),
                with_disc("tr_a", "al_1", Some(1), 1),
                with_disc("tr_dup_b", "al_1", Some(2), 2),
                with_disc("tr_null", "al_1", None, 3),
                with_disc("tr_d2t1", "al_1", Some(2), 1),
                with_disc("tr_m", "al_1", Some(1), 2),
                make_row("s1", "tr_c", "al_2", 1),
            ])
            .unwrap();
        let album1 = TrackRepository::new(&store)
            .find_by_album("s1", "al_1")
            .unwrap();
        let ids: Vec<&str> = album1.iter().map(|r| r.id.as_str()).collect();
        // disc 1: tr_a (t1), tr_m (t2), tr_null (untagged -> disc 1, t3);
        // disc 2: tr_d2t1 (t1), then the tr_dup_b/tr_dup_z tie (t2) by id.
        assert_eq!(
            ids,
            vec!["tr_a", "tr_m", "tr_null", "tr_d2t1", "tr_dup_b", "tr_dup_z"]
        );
    }

    #[test]
    fn find_batch_preserves_input_order_and_drops_unknowns() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[
                make_row("s1", "tr_1", "al_1", 1),
                make_row("s1", "tr_2", "al_1", 2),
            ])
            .unwrap();
        let pairs = vec![
            ("s1".to_string(), "tr_2".to_string()),
            ("s1".to_string(), "tr_missing".to_string()),
            ("s1".to_string(), "tr_1".to_string()),
        ];
        let rows = TrackRepository::new(&store).find_batch(&pairs).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["tr_2", "tr_1"]);
    }

    #[test]
    fn batch_limit_constant_matches_spec_cap() {
        assert_eq!(TRACKS_BATCH_LIMIT, 100);
    }

    #[test]
    fn entity_user_rating_cache_is_owner_scoped_and_ignores_malformed_keys() {
        let store = LibraryStore::open_in_memory();
        let ratings = vec![
            EntityUserRatingDto {
                server_id: "s1".into(),
                entity_kind: "track".into(),
                entity_id: "same-id".into(),
                rating: 4,
                fetched_at: 10,
            },
            EntityUserRatingDto {
                server_id: "s2".into(),
                entity_kind: "track".into(),
                entity_id: "same-id".into(),
                rating: 2,
                fetched_at: 11,
            },
            EntityUserRatingDto {
                server_id: "s1".into(),
                entity_kind: "invalid".into(),
                entity_id: "ignored".into(),
                rating: 5,
                fetched_at: 12,
            },
        ];
        put_entity_user_ratings(&store, &ratings, 100).unwrap();

        let found = get_entity_user_ratings(
            &store,
            &[
                EntityUserRatingRefDto {
                    server_id: "s2".into(),
                    entity_kind: "track".into(),
                    entity_id: "same-id".into(),
                },
                EntityUserRatingRefDto {
                    server_id: "s1".into(),
                    entity_kind: "track".into(),
                    entity_id: "same-id".into(),
                },
                EntityUserRatingRefDto {
                    server_id: "".into(),
                    entity_kind: "track".into(),
                    entity_id: "same-id".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].rating, 2);
        assert_eq!(found[1].rating, 4);
        assert!(found.iter().all(|rating| rating.fetched_at >= 100));
    }

    #[test]
    fn entity_user_rating_cache_upsert_replaces_existing_owner_key() {
        let store = LibraryStore::open_in_memory();
        let rating = EntityUserRatingDto {
            server_id: "s1".into(),
            entity_kind: "album".into(),
            entity_id: "a1".into(),
            rating: 3,
            fetched_at: 101,
        };
        put_entity_user_ratings(&store, std::slice::from_ref(&rating), 100).unwrap();
        let mut updated = rating;
        updated.rating = 5;
        updated.fetched_at = 200;
        put_entity_user_ratings(&store, &[updated], 100).unwrap();

        let found = get_entity_user_ratings(
            &store,
            &[EntityUserRatingRefDto {
                server_id: "s1".into(),
                entity_kind: "album".into(),
                entity_id: "a1".into(),
            }],
        )
        .unwrap();
        assert_eq!(found[0].rating, 5);
        assert_eq!(found[0].fetched_at, 200);
    }

    #[test]
    fn entity_user_rating_batch_limit_matches_spec_cap() {
        assert_eq!(ENTITY_USER_RATINGS_BATCH_LIMIT, 300);
    }

    #[test]
    fn normalize_base_url_adds_scheme_and_strips_trailing_slash() {
        assert_eq!(
            normalize_base_url("nas.example.com"),
            "http://nas.example.com"
        );
        assert_eq!(
            normalize_base_url("nas.example.com/"),
            "http://nas.example.com"
        );
        assert_eq!(
            normalize_base_url("192.168.1.5:4533"),
            "http://192.168.1.5:4533"
        );
    }

    #[test]
    fn normalize_base_url_preserves_existing_scheme() {
        assert_eq!(
            normalize_base_url("https://nas.example.com"),
            "https://nas.example.com"
        );
        assert_eq!(
            normalize_base_url("https://nas.example.com/"),
            "https://nas.example.com"
        );
        assert_eq!(
            normalize_base_url("http://localhost:4533/"),
            "http://localhost:4533"
        );
    }

    #[test]
    fn normalize_base_url_trims_whitespace() {
        assert_eq!(
            normalize_base_url("  nas.example.com  "),
            "http://nas.example.com"
        );
    }

    #[test]
    fn scoped_verify_routes_through_scope_safe_full_resync() {
        assert_eq!(
            resolve_sync_job_kind("delta", "music-folder", true).unwrap(),
            "initial_sync"
        );
        assert_eq!(
            resolve_sync_job_kind("delta", "", true).unwrap(),
            "delta_sync"
        );
        assert_eq!(
            resolve_sync_job_kind("delta", "music-folder", false).unwrap(),
            "delta_sync"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_bind_probe_preserves_previous_session_and_is_bounded() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "token": "new-token",
                "userId": "u1"
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/ping.view"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(1)))
            .mount(&server)
            .await;

        let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
        let previous = SyncSession {
            server_id: "s1".into(),
            base_url: "https://old.example.com".into(),
            username: "old-user".into(),
            password: "old-password".into(),
            navidrome_token: Some("old-token".into()),
            library_scope: Some("old-scope".into()),
        };
        runtime.set_session(previous.clone()).unwrap();

        let error = tokio::time::timeout(
            Duration::from_millis(250),
            bind_sync_session_inner(
                &runtime,
                &ServerHttpRegistry::new(),
                BindSessionRequest {
                    server_id: "s1".into(),
                    base_url: server.uri(),
                    username: "new-user".into(),
                    password: "new-password".into(),
                    library_scope: Some("new-scope".into()),
                },
                BindSessionTimeouts {
                    token: Duration::from_millis(100),
                    probe: Duration::from_millis(20),
                },
            ),
        )
        .await
        .expect("bind exceeded its configured network bound")
        .unwrap_err();
        assert!(error.contains("timed out"));
        assert_eq!(runtime.get_session("s1"), Some(previous));
    }

    #[test]
    fn sync_outcome_treats_cancellation_as_silent_success() {
        // Cancellation (user cancel, or a newer sync_start superseding this
        // job) must not surface as a failure on the sync-idle event.
        assert!(sync_outcome_to_result::<()>(Ok(())).is_ok());
        assert!(sync_outcome_to_result::<()>(Err(SyncError::Cancelled)).is_ok());
        let err = sync_outcome_to_result::<()>(Err(SyncError::Transport("boom".into())));
        assert_eq!(err, Err("sync transport: boom".to_string()));
    }

    #[tokio::test]
    async fn clear_session_cancels_and_drains_target_before_removing_it() {
        let runtime = Arc::new(runtime(Arc::new(LibraryStore::open_in_memory())));
        for server_id in ["s1", "s2"] {
            runtime
                .set_session(SyncSession {
                    server_id: server_id.to_string(),
                    base_url: format!("https://{server_id}.example.com"),
                    username: "user".into(),
                    password: "password".into(),
                    navidrome_token: None,
                    library_scope: None,
                })
                .unwrap();
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(tokio::sync::Notify::new());
        runtime
            .install_current_job(CurrentJob {
                job_id: "target-job".into(),
                server_id: "s1".into(),
                kind: "delta_sync".into(),
                cancel: Arc::clone(&cancel),
                abort_handle: None,
                done: Arc::clone(&done),
            })
            .unwrap();

        let runtime_for_job = Arc::clone(&runtime);
        let cancel_for_job = Arc::clone(&cancel);
        let done_for_job = Arc::clone(&done);
        let job = tokio::spawn(async move {
            while !cancel_for_job.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
            runtime_for_job.complete_current_job("target-job", &done_for_job);
        });

        clear_sync_session(&runtime, "s1").await.unwrap();
        job.await.unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        assert!(runtime.get_session("s1").is_none());
        assert!(runtime.get_session("s2").is_some());
    }

    #[test]
    fn purge_removes_every_target_scope_and_preserves_optional_offline_rows() {
        let store = Arc::new(LibraryStore::open_in_memory());
        populate_server_scoped_tables(&store, "s1");
        populate_server_scoped_tables(&store, "s2");
        let runtime = runtime(Arc::clone(&store));

        let report = purge_server_data(&runtime, "s1", false).unwrap();
        assert_eq!(report.tracks_deleted, 1);
        assert_eq!(report.albums_deleted, 1);
        assert_eq!(report.artists_deleted, 1);
        assert_eq!(report.offline_rows_deleted, 0);

        let scopes = [
            ("track_extension", "server_id"),
            ("track_fact", "server_id"),
            ("track_artifact", "server_id"),
            ("track_canonical_link", "server_id"),
            ("track_id_history", "server_id"),
            ("play_session", "server_id"),
            ("track_genre", "server_id"),
            ("artist_artwork_lookup", "server_id"),
            ("library_tag_state", "server_id"),
            ("library_tag_cursor", "server_id"),
            ("entity_user_rating", "server_id"),
            ("album_browse_projection", "server_id"),
            ("canonical_enrichment_link", "owner_server_id"),
            ("track", "server_id"),
            ("album", "server_id"),
            ("artist", "server_id"),
            ("sync_state", "server_id"),
        ];
        store
            .with_conn("test.assert_purge_scopes", |conn| {
                for (table, column) in scopes {
                    let target: i64 = conn.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE {column} = 's1'"),
                        [],
                        |row| row.get(0),
                    )?;
                    let other: i64 = conn.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE {column} = 's2'"),
                        [],
                        |row| row.get(0),
                    )?;
                    assert_eq!(target, 0, "target rows remain in {table}.{column}");
                    assert_eq!(other, 1, "other-server row removed from {table}.{column}");
                }
                let preserved_offline: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM track_offline WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(preserved_offline, 1);
                let foreign_key_errors: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM pragma_foreign_key_check",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(foreign_key_errors, 0);
                Ok(())
            })
            .unwrap();

        let second = purge_server_data(&runtime, "s1", true).unwrap();
        assert_eq!(second.offline_rows_deleted, 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn purge_drains_http_waiting_job_before_deleting_rows() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/in-flight"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(200))
                    .set_body_string("ok"),
            )
            .mount(&server)
            .await;

        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "before", "al_1", 1)])
            .unwrap();
        let runtime = Arc::new(runtime(Arc::clone(&store)));
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(tokio::sync::Notify::new());
        let job_id = "http-writer".to_string();
        runtime
            .install_current_job(CurrentJob {
                job_id: job_id.clone(),
                server_id: "s1".into(),
                kind: "delta_sync".into(),
                cancel: Arc::clone(&cancel),
                abort_handle: None,
                done: Arc::clone(&done),
            })
            .unwrap();

        let runtime_for_job = Arc::clone(&runtime);
        let request_url = format!("{}/in-flight", server.uri());
        let writer = tokio::spawn(async move {
            reqwest::get(request_url)
                .await
                .unwrap()
                .error_for_status()
                .unwrap();
            // Model a response already in flight: even if cancellation was set,
            // this late write must finish before the purge transaction starts.
            TrackRepository::new(&runtime_for_job.store)
                .upsert_batch(&[make_row("s1", "late", "al_1", 2)])
                .unwrap();
            runtime_for_job.complete_current_job(&job_id, &done);
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if server
                    .received_requests()
                    .await
                    .expect("requests captured")
                    .is_empty()
                {
                    tokio::task::yield_now().await;
                } else {
                    break;
                }
            }
        })
        .await
        .expect("HTTP request did not start");

        let barrier = runtime
            .cancel_and_drain_sync(None, Some("s1"))
            .await
            .unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        let report = purge_server_data(&runtime, "s1", false).unwrap();
        drop(barrier);
        writer.await.unwrap();

        assert_eq!(report.tracks_deleted, 2);
        assert!(TrackRepository::new(&store)
            .find_one("s1", "late")
            .unwrap()
            .is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn navidrome_token_with_retry_returns_token_on_success() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "token": "nd-tok", "userId": "u1"
            })))
            .mount(&server)
            .await;
        let tok = navidrome_token_with_retry(None, &server.uri(), "user", "pw").await;
        assert_eq!(tok.as_deref(), Some("nd-tok"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn navidrome_token_with_retry_returns_none_after_exhausting_attempts() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        // No `token` field → navidrome_token errors on every attempt; after
        // the retries are exhausted the helper yields None (caller then falls
        // back to a cached bearer / Subsonic-only).
        Mock::given(method("POST"))
            .and(path("/auth/login"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&server)
            .await;
        let tok = navidrome_token_with_retry(None, &server.uri(), "user", "pw").await;
        assert!(tok.is_none());
    }
}

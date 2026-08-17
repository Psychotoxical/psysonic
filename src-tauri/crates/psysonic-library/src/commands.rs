//! Tauri commands — read-only surface for PR-5a (spec §7.1). Mutating
//! commands + sync lifecycle land in PR-5b. All commands take a
//! `State<LibraryRuntime>` so the top crate's `setup()` can wire one
//! shared `Arc<LibraryStore>` across the whole IPC surface.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use psysonic_core::server_http::ServerHttpRegistry;

use crate::advanced_search;
use crate::analysis_backfill::{self, LibraryAnalysisBackfillBatchDto, LibraryAnalysisProgressDto};
use crate::cover_resolve::CoverEntryDto;
use crate::cross_server;
use crate::dto::{
    local_tracks_max_updated_ms, ArtifactInputDto, EntityUserRatingDto, EntityUserRatingRefDto,
    FactInputDto, LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse,
    LibraryAlbumOverlayResolutionDto, LibraryCrossServerSearchResponse, LibraryEntitySourceDto,
    LibraryLiveSearchRequest, LibraryLiveSearchResponse, LibraryMainstageAlbumsRequest,
    LibraryMainstageAlbumsResponse, LibraryMostPlayedRequest, LibraryMostPlayedResponse,
    LibraryResolveAlbumOverlayRequest, LibraryResolveEntitySourcesRequest,
    LibraryScopeAlbumDetailRequest, LibraryScopeAlbumDetailResponse,
    LibraryScopeArtistDetailRequest, LibraryScopeArtistDetailResponse, LibraryScopeBrowseRequest,
    LibraryScopeBrowseResponse, LibraryScopeComposerDetailRequest,
    LibraryScopeComposerDetailResponse, LibraryScopeListRequest, LibraryScopeSearchRequest,
    LibraryStatisticsDto, LibraryStatisticsRequest, LibraryTrackDto, LibraryTracksEnvelope,
    OfflinePathDto, PlaySessionDayDetailDto, PlaySessionHeatmapDayDto, PlaySessionInputDto,
    PlaySessionRecentDayDto, PlaySessionRecentTrackDto, PlaySessionYearBoundsDto,
    PlaySessionYearSummaryDto, PurgeReportDto, SyncJobDto, SyncStateDto, TrackArtifactDto,
    TrackFactDto, TrackRefDto,
};
use crate::live_search;
use crate::repos::{PlaySessionRepository, SyncStateRepository, TrackRepository};
use crate::runtime::LibraryRuntime;
use crate::scope_merge;
use crate::search::search_tracks;
use crate::sync::bandwidth::PlaybackHint;

mod patch_support;
mod purge_capability_support;
mod rating_cache_support;
mod read_support;
mod sync_session_support;
#[cfg(test)]
mod test_support;

use patch_support::apply_track_patch;
pub use patch_support::patch_content_hash;
use purge_capability_support::purge_server_data;
use rating_cache_support::{
    get_entity_user_ratings, put_entity_user_ratings, ENTITY_USER_RATINGS_BATCH_LIMIT,
};
use read_support::{
    effective_library_scopes, hydrate_refs, parse_ingest_cursor, resolve_local_track_count,
    upsert_songs_from_api, SyncStateRow, TRACKS_BATCH_LIMIT,
};
use sync_session_support::{
    bind_sync_session_inner, clear_sync_session, library_sync_start_inner, BindSessionRequest,
    BIND_SESSION_TIMEOUTS,
};

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

const ANALYSIS_PROGRESS_CACHE_TTL: Duration = Duration::from_secs(30);

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

// ──────────────────────────────────────────────────────────────────────
//  PR-5b — session / lifecycle / mutate / purge
// ──────────────────────────────────────────────────────────────────────

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

#[tauri::command]
#[specta::specta]
pub async fn library_sync_clear_session(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<(), String> {
    clear_sync_session(&runtime, &server_id).await
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

fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

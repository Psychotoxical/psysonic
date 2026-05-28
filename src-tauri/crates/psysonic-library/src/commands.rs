//! Tauri commands — read-only surface for PR-5a (spec §7.1). Mutating
//! commands + sync lifecycle land in PR-5b. All commands take a
//! `State<LibraryRuntime>` so the top crate's `setup()` can wire one
//! shared `Arc<LibraryStore>` across the whole IPC surface.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use psysonic_integration::navidrome::navidrome_token;
use psysonic_integration::subsonic::SubsonicClient;

use crate::advanced_search;
use crate::analysis_backfill::{self, LibraryAnalysisBackfillBatchDto, LibraryAnalysisProgressDto};
use crate::cover_resolve::CoverEntryDto;
use crate::cross_server;
use crate::dto::{
    count_local_tracks, local_tracks_max_updated_ms, track_index_nonempty, ArtifactInputDto,
    FactInputDto, LibraryAdvancedSearchRequest, LibraryAdvancedSearchResponse,
    LibraryCrossServerSearchResponse, LibraryLiveSearchRequest, LibraryLiveSearchResponse, LibraryTrackDto,
    LibraryTracksEnvelope, OfflinePathDto, PlaySessionDayDetailDto, PlaySessionHeatmapDayDto,
    PlaySessionInputDto, PlaySessionRecentDayDto, PlaySessionYearBoundsDto, PlaySessionYearSummaryDto, PurgeReportDto, SyncJobDto, SyncStateDto,
    TrackArtifactDto, TrackFactDto, TrackRefDto,
};
use crate::live_search;
use crate::payload::LibrarySyncProgressPayload;
use crate::repos::{PlaySessionRepository, SyncStateRepository, TrackRepository};
use crate::runtime::{CurrentJob, LibraryRuntime, SyncSession};
use crate::search::search_tracks;
use crate::store::LibraryStore;
use crate::sync::bandwidth::PlaybackHint;
use crate::sync::bandwidth::ParallelismBudget;
use crate::sync::capability::{probe_and_persist, CapabilityFlags, NavidromeProbeCredentials};
use crate::sync::delta::DeltaSyncRunner;
use crate::sync::error::SyncError;
use crate::sync::initial::InitialSyncRunner;
use crate::sync::progress::{ChannelProgress, Progress, ProgressEvent};
use crate::sync::tombstone::should_auto_reconcile;

/// Cap for `library_get_tracks_batch` per spec §7.1 ("max 100 refs/call").
const TRACKS_BATCH_LIMIT: usize = 100;
const ANALYSIS_PROGRESS_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryServerKeyMigrationDto {
    pub legacy_id: String,
    pub index_key: String,
}

/// Resolve cover disk + fetch ids from the local library (`album` | `artist` | `track`).
#[tauri::command]
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
        other => Err(format!("unknown cover entity kind: `{other}` (expected album|artist|track)")),
    }
}

#[tauri::command]
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

#[tauri::command]
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
                 indexes_last_modified_ms, artists_last_modified_ms, local_track_count, \
                 server_track_count, last_error \
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
                        local_track_count: r.get(9)?,
                        server_track_count: r.get(10)?,
                        last_error: r.get(11)?,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| e.to_string())?;

    let local_tracks_max_updated_ms = if row.as_ref().is_some_and(|r| r.sync_phase == "initial_sync") {
        None
    } else {
        local_tracks_max_updated_ms(&runtime.store, &server_id)?
    };
    let has_local_tracks = track_index_nonempty(&runtime.store, &server_id).unwrap_or(false);
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
) -> Option<i64> {
    if row.sync_phase == "initial_sync" {
        let snapshot = row.local_track_count.unwrap_or(0);
        let cursor = cursor_ingested_count.map(i64::from).unwrap_or(0);
        let best = snapshot.max(cursor);
        return if best > 0 { Some(best) } else { row.local_track_count };
    }
    match row.local_track_count {
        Some(n) if n > 0 => Some(n),
        _ if has_local_tracks => count_local_tracks(store, server_id).ok(),
        _ => row.local_track_count,
    }
}

#[tauri::command]
pub async fn library_search(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
    library_scope: Option<String>,
) -> Result<LibraryTracksEnvelope, String> {
    let _ = library_scope; // PR-5a accepts the arg for forward-compat; filter is wired in §5.13
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0);
    // `search_tracks` returns lean `TrackHit` rows for FTS; PR-5a
    // re-fetches the full `TrackRow` per hit so the DTO carries every
    // hot column. Acceptable for `limit ≤ 100`; PR-5d wires a single-
    // statement SQL builder via the FilterRegistry.
    let hits = search_tracks(&runtime.store, &server_id, &query, limit as i64 + offset as i64)?;
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

#[tauri::command]
pub async fn library_get_tracks_by_album(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    album_id: String,
) -> Result<Vec<LibraryTrackDto>, String> {
    let rows = TrackRepository::new(&runtime.store).find_by_album(&server_id, &album_id)?;
    Ok(rows.iter().map(LibraryTrackDto::from_row).collect())
}

#[tauri::command]
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
pub async fn library_get_offline_path(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
) -> Result<OfflinePathDto, String> {
    let path = runtime
        .store
        .with_conn("misc", |conn| {
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

#[tauri::command]
pub async fn library_advanced_search(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryAdvancedSearchRequest,
) -> Result<LibraryAdvancedSearchResponse, String> {
    advanced_search::run_advanced_search(&runtime.store, &request)
}

#[tauri::command]
pub async fn library_list_lossless_albums(
    runtime: State<'_, LibraryRuntime>,
    request: crate::dto::LibraryLosslessAlbumsRequest,
) -> Result<crate::dto::LibraryLosslessAlbumsResponse, String> {
    crate::lossless_albums::list_lossless_albums(&runtime.store, &request)
}

#[tauri::command]
pub async fn library_get_artist_lossless_browse(
    runtime: State<'_, LibraryRuntime>,
    request: crate::dto::LibraryArtistLosslessBrowseRequest,
) -> Result<crate::dto::LibraryArtistLosslessBrowseResponse, String> {
    crate::artist_lossless_browse::get_artist_lossless_browse(&runtime.store, &request)
}

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

#[tauri::command]
pub async fn library_search_cross_server(
    runtime: State<'_, LibraryRuntime>,
    query: String,
    limit: Option<u32>,
    servers: Option<Vec<String>>,
) -> Result<LibraryCrossServerSearchResponse, String> {
    let limit = limit.unwrap_or(100);
    cross_server::run_cross_server_search(&runtime.store, &query, limit, servers.as_deref())
}

// ── helpers ──────────────────────────────────────────────────────────

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
    base_url: &str,
    username: &str,
    password: &str,
) -> Option<String> {
    const ATTEMPTS: u32 = 3;
    for attempt in 1..=ATTEMPTS {
        match navidrome_token(base_url, username, password).await {
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
pub async fn library_sync_bind_session(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    base_url: String,
    username: String,
    password: String,
    library_scope: Option<String>,
) -> Result<(), String> {
    let base_url = normalize_base_url(&base_url);
    // Prime the Navidrome native-API bearer at bind time (spec §6.1 + PR-5
    // kickoff Q5) so N1 probe / ingest works without every command passing a
    // token. `/auth/login` is flaky, so retry a few times; if it still fails,
    // keep a bearer cached from a prior bind rather than dropping to
    // Subsonic-only — a transient miss must not strip an N1-capable server
    // (R7-15 Q3). Non-Navidrome servers stay `None` and sync via Subsonic.
    let navidrome_token_cached = match navidrome_token_with_retry(&base_url, &username, &password)
        .await
    {
        Some(tok) => Some(tok),
        None => runtime.get_session(&server_id).and_then(|s| s.navidrome_token),
    };

    let session = SyncSession {
        server_id: server_id.clone(),
        base_url: base_url.clone(),
        username: username.clone(),
        password: password.clone(),
        navidrome_token: navidrome_token_cached.clone(),
        library_scope: library_scope.clone(),
    };
    runtime.set_session(session);

    // Run the probe + persist capability flags. Failure to probe is a
    // bind-time error — caller should fix credentials / URL.
    let subsonic = SubsonicClient::new(base_url, username, password);
    let navidrome_creds = navidrome_token_cached.map(|tok| NavidromeProbeCredentials {
        server_url: subsonic_base_url_from(&runtime, &server_id),
        bearer_token: tok,
    });
    let scope = library_scope.as_deref().unwrap_or_default();
    probe_and_persist(
        &runtime.store,
        &subsonic,
        navidrome_creds.as_ref(),
        &server_id,
        scope,
    )
    .await
    .map_err(|e| format!("bind probe failed: {e}"))?;
    Ok(())
}

fn subsonic_base_url_from(runtime: &LibraryRuntime, server_id: &str) -> String {
    runtime
        .get_session(server_id)
        .map(|s| s.base_url)
        .unwrap_or_default()
}

#[tauri::command]
pub fn library_sync_clear_session(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<(), String> {
    runtime.clear_session(&server_id);
    Ok(())
}

#[tauri::command]
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
pub fn library_get_playback_hint(runtime: State<'_, LibraryRuntime>) -> Result<String, String> {
    Ok(match runtime.current_playback_hint() {
        PlaybackHint::Idle => "idle".to_string(),
        PlaybackHint::Playing => "playing".to_string(),
        PlaybackHint::PrefetchActive => "prefetch_active".to_string(),
    })
}

#[tauri::command]
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
    let session = runtime.get_session(&server_id).ok_or_else(|| {
        format!("no bound session for server `{server_id}` — call library_sync_bind_session first")
    })?;
    let scope = library_scope.clone().or(session.library_scope.clone()).unwrap_or_default();
    let mut capability_flags = load_capability_flags(&runtime, &server_id, &scope)?;
    // N1 needs the Navidrome bearer. Without a cached token this run is
    // Subsonic-only even on an N1-capable server — mask the flag for *this*
    // run's strategy selection (R7-15 Q3 "proceed as Subsonic-only"). The
    // persisted server capability stays untouched, so a later bind that
    // recovers the token can use N1 again.
    if session.navidrome_token.is_none() {
        capability_flags.remove(CapabilityFlags::NAVIDROME_NATIVE_BULK);
    }

    let kind = match mode.as_str() {
        "full" => "initial_sync",
        "delta" => "delta_sync",
        other => return Err(format!("unknown sync mode: `{other}`")),
    };
    if let Some(existing) = runtime.current_job() {
        if existing.kind == "initial_sync" {
            match kind {
                "initial_sync" if existing.server_id == server_id => {
                    // Same-server full resync: cancel and drain the in-flight
                    // runner so its cursor writes can't race the replacement.
                    let done = Arc::clone(&existing.done);
                    existing
                        .cancel
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    drop(existing);
                    done.notified().await;
                }
                "initial_sync" => {
                    return Err(format!(
                        "initial sync already running for `{}` — wait for it to finish",
                        existing.server_id
                    ));
                }
                _ => {
                    return Err(format!(
                        "initial sync in progress for `{}` — try again later",
                        existing.server_id
                    ));
                }
            }
        }
    }
    let job_id = format!("{}_{}", server_id, now_unix_ms());
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(tokio::sync::Notify::new());
    let job = CurrentJob {
        job_id: job_id.clone(),
        server_id: server_id.clone(),
        kind: kind.to_string(),
        cancel: Arc::clone(&cancel),
        done: Arc::clone(&done),
    };
    runtime.set_current_job(job);

    // Spawn the runner in a detached task. Progress events flow
    // through an mpsc channel to the orchestrator that emits Tauri
    // events; the runner doesn't need an AppHandle.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ProgressEvent>();
    let progress: Arc<dyn Progress + Send + Sync> =
        Arc::new(ChannelProgress::new(tx));

    let store = Arc::clone(&runtime.store);
    let session_clone = session.clone();
    let scope_for_task = scope.clone();
    let kind_for_task = kind.to_string();
    let cancel_for_task = Arc::clone(&cancel);
    let job_id_for_task = job_id.clone();
    let parallelism = ParallelismBudget::resolve(runtime.current_playback_hint());

    let runner_handle: tokio::task::JoinHandle<Result<(), String>> = tokio::task::spawn(async move {
        let subsonic = SubsonicClient::new(
            session_clone.base_url.clone(),
            session_clone.username.clone(),
            session_clone.password.clone(),
        );
        let navidrome_creds = session_clone.navidrome_token.clone().map(|tok| {
            NavidromeProbeCredentials {
                server_url: session_clone.base_url.clone(),
                bearer_token: tok,
            }
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
            .with_parallelism_budget(parallelism);
            if let Some(creds) = navidrome_creds.clone() {
                runner = runner.with_navidrome_credentials(creds);
            }
            sync_outcome_to_result(runner.run().await)
        } else {
            // Delta — Mode A manual integrity uses the DeltaMismatch
            // budget for tombstones when the local/server count gap
            // is over threshold; otherwise a small budget keeps the
            // background-like pass cheap. Manual «Verify integrity»
            // forces the full budget regardless of threshold.
            let tombstone_budget = if force_full_tombstone {
                crate::sync::budget::RequestBudget::DELTA_MISMATCH_CAP
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
            .with_progress(Arc::clone(&progress));
            if tombstone_budget > 0 {
                runner = runner.with_tombstone_budget(tombstone_budget);
            }
            if let Some(creds) = navidrome_creds.clone() {
                runner = runner.with_navidrome_credentials(creds);
            }
            sync_outcome_to_result(runner.run().await)
        };

        // Closing the mpsc sender by dropping `progress` so the
        // orchestrator's drain loop terminates.
        drop(progress);
        let _ = job_id_for_task; // silence unused on Err
        result
    });

    // Orchestrator: drain progress + emit Tauri events, then emit
    // sync-idle when the runner exits.
    let app_for_emit = app.clone();
    let server_id_for_emit = server_id.clone();
    let scope_for_emit = scope.clone();
    let kind_for_emit = kind.to_string();
    let job_id_for_emit = job_id.clone();
    tokio::task::spawn(async move {
        // Drain progress events; loop ends when sender is dropped.
        while let Some(event) = rx.recv().await {
            let payload = LibrarySyncProgressPayload::from_event(
                &event,
                &server_id_for_emit,
                &scope_for_emit,
            );
            let _ = app_for_emit
                .emit(LibrarySyncProgressPayload::PROGRESS_EVENT_NAME, &payload);
        }
        // Wait for the runner to finish + emit sync-idle.
        let outcome = match runner_handle.await {
            Ok(Ok(())) => SyncIdleAck::ok(&server_id_for_emit, &scope_for_emit, &kind_for_emit),
            Ok(Err(msg)) => SyncIdleAck::err(&server_id_for_emit, &scope_for_emit, &kind_for_emit, &msg),
            Err(join_err) => SyncIdleAck::err(
                &server_id_for_emit,
                &scope_for_emit,
                &kind_for_emit,
                &format!("sync task panicked: {join_err}"),
            ),
        };
        if let Some(runtime) = app_for_emit.try_state::<LibraryRuntime>() {
            let _ = runtime.store.checkpoint_wal("sync.checkpoint");
        }
        let _ = app_for_emit.emit(LibrarySyncProgressPayload::IDLE_EVENT_NAME, &outcome);

        // Clear the slot only if it still names us — sync_start may
        // have already overwritten with a newer job.
        if let Some(state) = app_for_emit.try_state::<LibraryRuntime>() {
            if let Some(job) = state.current_job() {
                if job.job_id == job_id_for_emit {
                    job.done.notify_one();
                }
            }
            state.clear_current_job_if_matches(&job_id_for_emit);
        }
    });

    Ok(SyncJobDto {
        job_id,
        server_id,
        kind: kind.to_string(),
    })
}

/// Manual «Verify library integrity» — same dispatch shape as
/// `library_sync_start { mode: 'delta' }` but always sets the full
/// `DELTA_MISMATCH_CAP` tombstone budget regardless of the
/// local/server count gap. Per PR-5b review §5 note 2: spec §6.7
/// Mode A user-initiated full reconcile bypasses the threshold
/// check.
#[tauri::command]
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
pub fn library_sync_cancel(
    runtime: State<'_, LibraryRuntime>,
    job_id: Option<String>,
) -> Result<(), String> {
    // `job_id` is informational — there's at most one in-flight job
    // per `LibraryRuntime` at a time. If it's supplied and doesn't
    // match, treat as no-op (the named job already finished).
    if let Some(id) = &job_id {
        if runtime.current_job().is_none_or(|j| &j.job_id != id) {
            return Ok(());
        }
    }
    runtime.cancel_current_job();
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
        .with_conn("misc", |conn| {
            conn.execute(
                "UPDATE track SET content_hash = ?3 \
                 WHERE server_id = ?1 AND id = ?2",
                params![server_id, track_id, md5_16kb],
            )?;
            Ok(())
        })
        .map_err(|e| e.to_string())
}

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
        .with_conn("misc", |conn| {
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
pub fn library_put_fact(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    fact: FactInputDto,
) -> Result<(), String> {
    // E4: typed repo owns the upsert + the §5.12 user-override rule
    // (a `user` bpm fact also writes the hot `track.bpm` column).
    crate::repos::FactRepository::new(&runtime.store).put(&server_id, &track_id, &fact, now_unix_ms())
}

#[tauri::command]
pub fn library_record_play_session(
    runtime: State<'_, LibraryRuntime>,
    input: PlaySessionInputDto,
) -> Result<(), String> {
    PlaySessionRepository::new(&runtime.store).insert(&input)
}

#[tauri::command]
pub fn library_get_player_stats_year_summary(
    runtime: State<'_, LibraryRuntime>,
    year: i32,
) -> Result<PlaySessionYearSummaryDto, String> {
    PlaySessionRepository::new(&runtime.store).year_summary(year)
}

#[tauri::command]
pub fn library_get_player_stats_heatmap(
    runtime: State<'_, LibraryRuntime>,
    year: i32,
) -> Result<Vec<PlaySessionHeatmapDayDto>, String> {
    PlaySessionRepository::new(&runtime.store).heatmap(year)
}

#[tauri::command]
pub fn library_get_player_stats_day_detail(
    runtime: State<'_, LibraryRuntime>,
    date_iso: String,
) -> Result<PlaySessionDayDetailDto, String> {
    PlaySessionRepository::new(&runtime.store).day_detail(&date_iso)
}

#[tauri::command]
pub fn library_get_player_stats_year_bounds(
    runtime: State<'_, LibraryRuntime>,
) -> Result<PlaySessionYearBoundsDto, String> {
    PlaySessionRepository::new(&runtime.store).year_bounds()
}

#[tauri::command]
pub fn library_get_player_stats_recent_days(
    runtime: State<'_, LibraryRuntime>,
    limit: Option<u32>,
) -> Result<Vec<PlaySessionRecentDayDto>, String> {
    PlaySessionRepository::new(&runtime.store).recent_days(limit.unwrap_or(30))
}

#[tauri::command]
pub fn library_purge_server(
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

    let mut report = PurgeReportDto::default();
    runtime
        .store
        .with_conn_mut("misc", |conn| {
            let tx = conn.transaction()?;
            let track_count: i64 =
                tx.query_row("SELECT COUNT(*) FROM track WHERE server_id = ?1", params![server_id], |r| r.get(0))?;
            let album_count: i64 =
                tx.query_row("SELECT COUNT(*) FROM album WHERE server_id = ?1", params![server_id], |r| r.get(0))?;
            let artist_count: i64 =
                tx.query_row("SELECT COUNT(*) FROM artist WHERE server_id = ?1", params![server_id], |r| r.get(0))?;
            let offline_count: i64 =
                tx.query_row("SELECT COUNT(*) FROM track_offline WHERE server_id = ?1", params![server_id], |r| r.get(0))?;
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
                "DELETE FROM track WHERE server_id = ?1",
                params![server_id],
            )?;
            tx.execute(
                "DELETE FROM album WHERE server_id = ?1",
                params![server_id],
            )?;
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

    // Drop any bound session / current job for this server — credentials
    // out of memory, ongoing job cancelled.
    runtime.clear_session(&server_id);
    if let Some(job) = runtime.current_job() {
        if job.server_id == server_id {
            job.cancel.store(true, Ordering::SeqCst);
        }
    }
    Ok(report)
}

#[tauri::command]
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
pub fn library_delete_server_data(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<(), String> {
    library_purge_server(runtime, server_id, Some(false), Some(true)).map(|_| ())
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
    if should_auto_reconcile(local, server, crate::sync::scheduler::DEFAULT_TOMBSTONE_THRESHOLD_PCT) {
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncIdleAck {
    server_id: String,
    library_scope: String,
    kind: String,
    ok: bool,
    error: Option<String>,
}

impl SyncIdleAck {
    fn ok(server_id: &str, scope: &str, kind: &str) -> Self {
        Self {
            server_id: server_id.to_string(),
            library_scope: scope.to_string(),
            kind: kind.to_string(),
            ok: true,
            error: None,
        }
    }
    fn err(server_id: &str, scope: &str, kind: &str, message: &str) -> Self {
        Self {
            server_id: server_id.to_string(),
            library_scope: scope.to_string(),
            kind: kind.to_string(),
            ok: false,
            error: Some(message.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::TrackRow;
    use crate::store::LibraryStore;
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
        let found = TrackRepository::new(&store).find_one("s1", "tr_1").unwrap().unwrap();
        let dto = LibraryTrackDto::from_row(&found);
        assert_eq!(dto.id, "tr_1");
        assert_eq!(dto.album_id.as_deref(), Some("al_1"));
        assert_eq!(dto.track_number, Some(5));
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

        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({ "starredAt": 1700, "userRating": 4 }))
            .unwrap();
        assert_eq!(read(&store), (Some(1700), Some(4)));

        // Explicit null clears starred_at; absent userRating stays.
        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({ "starredAt": null })).unwrap();
        assert_eq!(read(&store), (None, Some(4)), "null clears, absent key untouched");

        // Empty patch is a no-op.
        apply_track_patch(&rt, "s1", "tr_1", &serde_json::json!({})).unwrap();
        assert_eq!(read(&store), (None, Some(4)));
    }

    #[test]
    fn find_by_album_orders_by_disc_then_track_then_id() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[
                make_row("s1", "tr_b", "al_1", 2),
                make_row("s1", "tr_a", "al_1", 1),
                make_row("s1", "tr_c", "al_2", 1),
            ])
            .unwrap();
        let album1 = TrackRepository::new(&store).find_by_album("s1", "al_1").unwrap();
        let ids: Vec<&str> = album1.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["tr_a", "tr_b"]);
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
    fn normalize_base_url_adds_scheme_and_strips_trailing_slash() {
        assert_eq!(normalize_base_url("nas.example.com"), "http://nas.example.com");
        assert_eq!(normalize_base_url("nas.example.com/"), "http://nas.example.com");
        assert_eq!(normalize_base_url("192.168.1.5:4533"), "http://192.168.1.5:4533");
    }

    #[test]
    fn normalize_base_url_preserves_existing_scheme() {
        assert_eq!(normalize_base_url("https://nas.example.com"), "https://nas.example.com");
        assert_eq!(normalize_base_url("https://nas.example.com/"), "https://nas.example.com");
        assert_eq!(normalize_base_url("http://localhost:4533/"), "http://localhost:4533");
    }

    #[test]
    fn normalize_base_url_trims_whitespace() {
        assert_eq!(normalize_base_url("  nas.example.com  "), "http://nas.example.com");
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
        let tok = navidrome_token_with_retry(&server.uri(), "user", "pw").await;
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
        let tok = navidrome_token_with_retry(&server.uri(), "user", "pw").await;
        assert!(tok.is_none());
    }
}

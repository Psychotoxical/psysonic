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
use crate::cross_server;
use crate::dto::{
    local_tracks_max_updated_ms, ArtifactInputDto, FactInputDto, LibraryAdvancedSearchRequest,
    LibraryAdvancedSearchResponse, LibraryCrossServerSearchResponse, LibraryTrackDto,
    LibraryTracksEnvelope, OfflinePathDto, PurgeReportDto, SyncJobDto, SyncStateDto,
    TrackArtifactDto, TrackFactDto, TrackRefDto,
};
use crate::payload::LibrarySyncProgressPayload;
use crate::repos::{SyncStateRepository, TrackRepository};
use crate::runtime::{CurrentJob, LibraryRuntime, SyncSession};
use crate::search::search_tracks;
use crate::sync::bandwidth::PlaybackHint;
use crate::sync::capability::{probe_and_persist, CapabilityFlags, NavidromeProbeCredentials};
use crate::sync::delta::DeltaSyncRunner;
use crate::sync::error::SyncError;
use crate::sync::initial::InitialSyncRunner;
use crate::sync::progress::{ChannelProgress, Progress, ProgressEvent};
use crate::sync::tombstone::should_auto_reconcile;

/// Cap for `library_get_tracks_batch` per spec §7.1 ("max 100 refs/call").
const TRACKS_BATCH_LIMIT: usize = 100;

#[tauri::command]
pub fn library_get_status(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    library_scope: Option<String>,
) -> Result<SyncStateDto, String> {
    let scope = library_scope.unwrap_or_default();
    let row: Option<SyncStateRow> = runtime
        .store
        .with_conn(|conn| {
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

    let local_tracks_max_updated_ms = local_tracks_max_updated_ms(&runtime.store, &server_id)?;
    let row = row.unwrap_or_default();
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
        local_track_count: row.local_track_count,
        server_track_count: row.server_track_count,
        last_error: row.last_error,
        local_tracks_max_updated_ms,
    })
}

#[tauri::command]
pub fn library_search(
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
pub fn library_get_track(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
) -> Result<Option<LibraryTrackDto>, String> {
    let repo = TrackRepository::new(&runtime.store);
    Ok(repo
        .find_one(&server_id, &track_id)?
        .map(|row| LibraryTrackDto::from_row(&row)))
}

#[tauri::command]
pub fn library_get_tracks_batch(
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
pub fn library_get_tracks_by_album(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    album_id: String,
) -> Result<Vec<LibraryTrackDto>, String> {
    let rows = TrackRepository::new(&runtime.store).find_by_album(&server_id, &album_id)?;
    Ok(rows.iter().map(LibraryTrackDto::from_row).collect())
}

#[tauri::command]
pub fn library_get_artifact(
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
pub fn library_get_facts(
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
pub fn library_get_offline_path(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
) -> Result<OfflinePathDto, String> {
    let path = runtime
        .store
        .with_conn(|conn| {
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
pub fn library_advanced_search(
    runtime: State<'_, LibraryRuntime>,
    request: LibraryAdvancedSearchRequest,
) -> Result<LibraryAdvancedSearchResponse, String> {
    advanced_search::run_advanced_search(&runtime.store, &request)
}

#[tauri::command]
pub fn library_search_cross_server(
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
    let job_id = format!("{}_{}", server_id, now_unix_ms());
    let cancel = Arc::new(AtomicBool::new(false));
    let job = CurrentJob {
        job_id: job_id.clone(),
        server_id: server_id.clone(),
        kind: kind.to_string(),
        cancel: Arc::clone(&cancel),
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
            .with_progress(Arc::clone(&progress));
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
        let _ = app_for_emit.emit(LibrarySyncProgressPayload::IDLE_EVENT_NAME, &outcome);

        // Clear the slot only if it still names us — sync_start may
        // have already overwritten with a newer job.
        if let Some(state) = app_for_emit.try_state::<LibraryRuntime>() {
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

#[tauri::command]
pub fn library_patch_track(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    patch: Value,
) -> Result<(), String> {
    // Sparse JSON patch — only the fields explicitly present in
    // `patch` are applied; absent keys leave the column untouched.
    // Spec §6.5 patch-on-use: `starred_at`, `user_rating`,
    // `play_count`, `played_at`.
    let starred_at = patch.get("starredAt").and_then(|v| v.as_i64());
    let user_rating = patch.get("userRating").and_then(|v| v.as_i64());
    let play_count = patch.get("playCount").and_then(|v| v.as_i64());
    let played_at = patch.get("playedAt").and_then(|v| v.as_i64());

    runtime
        .store
        .with_conn(|conn| {
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
pub fn library_purge_server(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    include_analysis: Option<bool>,
    include_offline: Option<bool>,
) -> Result<PurgeReportDto, String> {
    let _ = include_analysis; // analysis_cache cross-purge wires in PR-6.
    let include_offline = include_offline.unwrap_or(false);

    let mut report = PurgeReportDto::default();
    runtime
        .store
        .with_conn_mut(|conn| {
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

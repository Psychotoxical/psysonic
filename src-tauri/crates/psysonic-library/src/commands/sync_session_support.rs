use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use psysonic_core::server_http::ServerHttpRegistry;
use psysonic_integration::navidrome::navidrome_token_with_registry;
use psysonic_integration::subsonic::subsonic_client_with_registry;

use super::purge_capability_support::{compute_tombstone_budget, load_capability_flags};
use crate::dto::SyncJobDto;
use crate::payload::{LibrarySyncIdlePayload, LibrarySyncProgressPayload};
use crate::runtime::{CurrentJob, LibraryRuntime, SyncSession};
use crate::sync::bandwidth::ParallelismBudget;
use crate::sync::capability::{
    probe_and_persist_with_timeout, CapabilityFlags, NavidromeProbeCredentials,
};
use crate::sync::delta::DeltaSyncRunner;
use crate::sync::error::SyncError;
use crate::sync::initial::InitialSyncRunner;
use crate::sync::library_tag::run_tag_pass_best_effort;
use crate::sync::progress::{ChannelProgress, Progress, ProgressEvent};

static NEXT_SYNC_JOB_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy)]
pub(super) struct BindSessionTimeouts {
    pub(super) token: Duration,
    pub(super) probe: Duration,
}

pub(super) struct BindSessionRequest {
    pub(super) server_id: String,
    pub(super) base_url: String,
    pub(super) username: String,
    pub(super) password: String,
    pub(super) library_scope: Option<String>,
}

pub(super) const BIND_SESSION_TIMEOUTS: BindSessionTimeouts = BindSessionTimeouts {
    token: Duration::from_secs(10),
    probe: Duration::from_secs(30),
};

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

pub(super) async fn bind_sync_session_inner(
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

pub(super) async fn clear_sync_session(
    runtime: &LibraryRuntime,
    server_id: &str,
) -> Result<(), String> {
    let _barrier = runtime.cancel_and_drain_sync(None, Some(server_id)).await?;
    runtime.clear_session(server_id);
    Ok(())
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

pub(super) async fn library_sync_start_inner(
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
        super::now_unix_ms(),
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
            Ok(Ok(())) => LibrarySyncIdlePayload::ok(
                &server_id_for_emit,
                &scope_for_emit,
                &kind_for_emit,
                "foreground",
            )
            .with_job_id(&job_id_for_emit),
            Ok(Err(msg)) => LibrarySyncIdlePayload::err(
                &server_id_for_emit,
                &scope_for_emit,
                &kind_for_emit,
                "foreground",
                &msg,
            )
            .with_job_id(&job_id_for_emit),
            Err(join_err) if join_err.is_cancelled() => LibrarySyncIdlePayload::ok(
                &server_id_for_emit,
                &scope_for_emit,
                &kind_for_emit,
                "foreground",
            )
            .with_job_id(&job_id_for_emit),
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
                if let Err(error) = super::library_spawn_blocking(move || {
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

#[cfg(test)]
mod tests;

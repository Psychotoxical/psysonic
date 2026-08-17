use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use tauri::{Emitter, Manager};

const MAX_BACKGROUND_SCHEDULER_CONCURRENCY: usize = 2;
const BACKGROUND_SCHEDULER_TICK_TIMEOUT: Duration = Duration::from_secs(120);

async fn run_bounded_scheduler_sessions<I, F, Fut>(sessions: I, run: F)
where
    I: IntoIterator,
    F: FnMut(I::Item) -> Fut,
    Fut: Future<Output = ()>,
{
    stream::iter(sessions)
        .for_each_concurrent(MAX_BACKGROUND_SCHEDULER_CONCURRENCY, run)
        .await;
}

fn foreground_blocks_scheduler_session(
    job: Option<&psysonic_library::runtime::CurrentJob>,
    server_id: &str,
) -> bool {
    job.is_some_and(|job| job.kind == "initial_sync" || job.server_id == server_id)
}

fn scheduler_session_still_current(
    runtime: &psysonic_library::LibraryRuntime,
    snapshot: &psysonic_library::runtime::SyncSession,
) -> bool {
    runtime.get_session(&snapshot.server_id).as_ref() == Some(snapshot)
}

fn scheduler_idle_payload(
    report: &psysonic_library::sync::scheduler::SchedulerTickReport,
    server_id: &str,
    library_scope: &str,
) -> Option<psysonic_library::LibrarySyncIdlePayload> {
    // The census is the half that runs when the delta has nothing to report:
    // server-side deletion never appears in a changed-list.
    (report
        .delta
        .as_ref()
        .is_some_and(|delta| !delta.deferred_scanning && !delta.up_to_date)
        || report.census_changed_index)
        .then(|| {
            psysonic_library::LibrarySyncIdlePayload::ok(
                server_id,
                library_scope,
                "delta_sync",
                "background",
            )
        })
}

pub(super) fn spawn(app_for_sched: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        use std::sync::atomic::Ordering;
        use tokio::time::MissedTickBehavior;

        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(state) = app_for_sched.try_state::<psysonic_library::LibraryRuntime>() else {
                break;
            };
            if state.scheduler_cancel.load(Ordering::SeqCst) {
                break;
            }
            let sessions = state.snapshot_sessions();
            if sessions.is_empty() {
                continue;
            }
            let hint = state.current_playback_hint();
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
                .unwrap_or(0);
            let runtime = state.inner();
            let registry = Arc::clone(
                app_for_sched
                    .state::<Arc<psysonic_core::server_http::ServerHttpRegistry>>()
                    .inner(),
            );
            run_bounded_scheduler_sessions(sessions, |session| {
                let registry = Arc::clone(&registry);
                let app_for_session = app_for_sched.clone();
                async move {
                    let _sync_activity = runtime.sync_activity_guard().await;
                    if runtime.scheduler_cancel.load(Ordering::SeqCst)
                        || !scheduler_session_still_current(runtime, &session)
                    {
                        return;
                    }
                    let foreground_active = foreground_blocks_scheduler_session(
                        runtime.current_job().as_ref(),
                        &session.server_id,
                    );
                    let scope = session.library_scope.clone().unwrap_or_default();
                    let flags_bits = psysonic_library::repos::SyncStateRepository::new(
                        &runtime.store,
                    )
                    .get_capability_flags(&session.server_id, &scope)
                    .ok()
                    .flatten()
                    .unwrap_or(0);
                    let flags =
                        psysonic_library::sync::capability::CapabilityFlags::new(flags_bits);
                    let subsonic =
                        psysonic_integration::subsonic::subsonic_client_with_registry(
                            Some(registry.as_ref()),
                            &session.server_id,
                            session.base_url.clone(),
                            session.username.clone(),
                            session.password.clone(),
                        );
                    let mut sched =
                        psysonic_library::sync::scheduler::BackgroundScheduler::new(
                            &runtime.store,
                            &subsonic,
                            session.server_id.clone(),
                            scope.clone(),
                            flags,
                        )
                        .with_playback_hint(hint)
                        .with_http_registry(Some(Arc::clone(&registry)))
                        .with_cancellation(Arc::clone(&runtime.scheduler_cancel));
                    if let Some(tok) = session.navidrome_token.clone() {
                        sched = sched.with_navidrome_credentials(
                            psysonic_library::sync::capability::NavidromeProbeCredentials {
                                server_url: session.base_url.clone(),
                                bearer_token: tok,
                            },
                        );
                    }
                    if foreground_active {
                        sched = sched.with_foreground_sync_job_active(true);
                    }
                    match sched
                        .tick_with_timeout(now_ms, BACKGROUND_SCHEDULER_TICK_TIMEOUT)
                        .await
                    {
                        Ok(report) => {
                            let identity_store = Arc::clone(&runtime.store);
                            let identity_server_id = session.server_id.clone();
                            let identity_error = match tokio::task::spawn_blocking(move || {
                                psysonic_library::identity::ensure_cluster_keys_built(
                                    &identity_store,
                                    &identity_server_id,
                                )
                            })
                            .await
                            {
                                Ok(Ok(_)) => None,
                                Ok(Err(error)) => {
                                    crate::app_eprintln!(
                                        "[library-cluster] background maintenance failed server_id={}: {}",
                                        session.server_id,
                                        error
                                    );
                                    Some(error)
                                }
                                Err(error) => {
                                    crate::app_eprintln!(
                                        "[library-cluster] background maintenance task failed server_id={}: {}",
                                        session.server_id,
                                        error
                                    );
                                    Some(error.to_string())
                                }
                            };
                            if let Some(mut payload) =
                                scheduler_idle_payload(&report, &session.server_id, &scope)
                            {
                                if let Some(error) = identity_error {
                                    payload.mark_failed(format!(
                                        "identity maintenance failed: {error}"
                                    ));
                                }
                                let _ = app_for_session.emit(
                                    psysonic_library::LibrarySyncProgressPayload::IDLE_EVENT_NAME,
                                    &payload,
                                );
                            }
                        }
                        Err(err) => crate::app_deprintln!(
                            "[library-sync] scheduler recorded server failure server_id={}: {}",
                            session.server_id,
                            err
                        ),
                    }
                }
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::sync::{Notify, Semaphore};

    fn foreground_job(server_id: &str, kind: &str) -> psysonic_library::runtime::CurrentJob {
        psysonic_library::runtime::CurrentJob {
            job_id: format!("{server_id}-{kind}"),
            server_id: server_id.to_string(),
            kind: kind.to_string(),
            cancel: Arc::new(AtomicBool::new(false)),
            abort_handle: None,
            done: Arc::new(Notify::new()),
        }
    }

    #[test]
    fn initial_sync_blocks_all_servers_but_delta_only_blocks_its_server() {
        let initial = foreground_job("s1", "initial_sync");
        assert!(foreground_blocks_scheduler_session(Some(&initial), "s1"));
        assert!(foreground_blocks_scheduler_session(Some(&initial), "s2"));

        let delta = foreground_job("s1", "delta_sync");
        assert!(foreground_blocks_scheduler_session(Some(&delta), "s1"));
        assert!(!foreground_blocks_scheduler_session(Some(&delta), "s2"));
        assert!(!foreground_blocks_scheduler_session(None, "s1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slow_session_does_not_block_an_independent_session() {
        let slow_started = Arc::new(Notify::new());
        let release_slow = Arc::new(Notify::new());
        let fast_finished = Arc::new(AtomicBool::new(false));

        let slow_started_for_task = Arc::clone(&slow_started);
        let release_slow_for_task = Arc::clone(&release_slow);
        let fast_finished_for_task = Arc::clone(&fast_finished);
        let driver = tokio::spawn(async move {
            run_bounded_scheduler_sessions(["slow", "fast"], |session| {
                let slow_started = Arc::clone(&slow_started_for_task);
                let release_slow = Arc::clone(&release_slow_for_task);
                let fast_finished = Arc::clone(&fast_finished_for_task);
                async move {
                    if session == "slow" {
                        slow_started.notify_one();
                        release_slow.notified().await;
                    } else {
                        fast_finished.store(true, Ordering::SeqCst);
                    }
                }
            })
            .await;
        });

        tokio::time::timeout(Duration::from_secs(1), slow_started.notified())
            .await
            .expect("slow session did not start");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !fast_finished.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fast session was suppressed by slow session");

        release_slow.notify_one();
        driver.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queued_writer_preempts_remaining_batch_and_stale_session_stays_skipped() {
        let runtime = Arc::new(psysonic_library::LibraryRuntime::new(Arc::new(
            psysonic_library::LibraryStore::open_in_memory(),
        )));
        let session = |server_id: &str| psysonic_library::runtime::SyncSession {
            server_id: server_id.into(),
            base_url: format!("https://{server_id}.example.com"),
            username: "u".into(),
            password: "p".into(),
            navidrome_token: None,
            library_scope: None,
        };
        for server_id in ["s1", "s2", "s3"] {
            runtime.set_session(session(server_id)).unwrap();
        }

        let started = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Semaphore::new(0));
        let runtime_for_driver = Arc::clone(&runtime);
        let started_for_driver = Arc::clone(&started);
        let release_for_driver = Arc::clone(&release);
        let driver = tokio::spawn(async move {
            run_bounded_scheduler_sessions(["s1", "s2", "s3"], |server_id| {
                let runtime = Arc::clone(&runtime_for_driver);
                let started = Arc::clone(&started_for_driver);
                let release = Arc::clone(&release_for_driver);
                async move {
                    let snapshot = runtime.get_session(server_id).unwrap();
                    let _activity = runtime.sync_activity_guard().await;
                    if !scheduler_session_still_current(&runtime, &snapshot) {
                        return;
                    }
                    let ordinal = started.fetch_add(1, Ordering::SeqCst);
                    if ordinal < 2 {
                        release.acquire().await.unwrap().forget();
                    }
                }
            })
            .await;
        });

        tokio::time::timeout(Duration::from_secs(1), async {
            while started.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("first scheduler slots did not start");

        let runtime_for_writer = Arc::clone(&runtime);
        let writer = tokio::spawn(async move {
            runtime_for_writer
                .cancel_and_drain_sync(None, None)
                .await
                .unwrap()
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        release.add_permits(2);
        let barrier = tokio::time::timeout(Duration::from_secs(1), writer)
            .await
            .expect("writer waited for the full scheduler batch")
            .unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 2);

        runtime.clear_session("s3");
        drop(barrier);
        driver.await.unwrap();
        assert_eq!(started.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stale_scheduler_session_is_rejected_after_clear_or_rebind() {
        let runtime = psysonic_library::LibraryRuntime::new(Arc::new(
            psysonic_library::LibraryStore::open_in_memory(),
        ));
        let session = psysonic_library::runtime::SyncSession {
            server_id: "s1".into(),
            base_url: "https://one.example.com".into(),
            username: "u".into(),
            password: "p".into(),
            navidrome_token: None,
            library_scope: None,
        };
        runtime.set_session(session.clone()).unwrap();
        assert!(scheduler_session_still_current(&runtime, &session));

        let mut rebound = session.clone();
        rebound.base_url = "https://two.example.com".into();
        runtime.set_session(rebound).unwrap();
        assert!(!scheduler_session_still_current(&runtime, &session));

        runtime.clear_session("s1");
        assert!(!scheduler_session_still_current(&runtime, &session));
    }

    #[test]
    fn scheduler_idle_payload_only_follows_refreshable_delta() {
        let skipped = psysonic_library::sync::scheduler::SchedulerTickReport {
            skipped_not_due: true,
            skipped_bulk_paused: false,
            skipped_sync_pass_active: false,
            delta: None,
            census_changed_index: false,
            next_poll_at_ms: 1,
        };
        assert!(scheduler_idle_payload(&skipped, "s1", "").is_none());

        let up_to_date = psysonic_library::sync::scheduler::SchedulerTickReport {
            skipped_not_due: false,
            skipped_bulk_paused: false,
            skipped_sync_pass_active: false,
            delta: Some(psysonic_library::sync::delta::DeltaSyncReport {
                up_to_date: true,
                ..Default::default()
            }),
            census_changed_index: false,
            next_poll_at_ms: 1,
        };
        assert!(scheduler_idle_payload(&up_to_date, "s1", "").is_none());

        let completed = psysonic_library::sync::scheduler::SchedulerTickReport {
            skipped_not_due: false,
            skipped_bulk_paused: false,
            skipped_sync_pass_active: false,
            delta: Some(psysonic_library::sync::delta::DeltaSyncReport {
                changed_count: 1,
                ..Default::default()
            }),
            census_changed_index: false,
            next_poll_at_ms: 1,
        };
        let payload = scheduler_idle_payload(&completed, "s1", "scope").unwrap();
        assert!(payload.ok);
        assert_eq!(payload.server_id, "s1");
        assert_eq!(payload.library_scope, "scope");
        assert_eq!(payload.source, "background");

        let deferred = psysonic_library::sync::scheduler::SchedulerTickReport {
            delta: Some(psysonic_library::sync::delta::DeltaSyncReport {
                deferred_scanning: true,
                ..Default::default()
            }),
            ..completed
        };
        assert!(scheduler_idle_payload(&deferred, "s1", "").is_none());

        let census_only = psysonic_library::sync::scheduler::SchedulerTickReport {
            census_changed_index: true,
            delta: Some(psysonic_library::sync::delta::DeltaSyncReport {
                up_to_date: true,
                ..Default::default()
            }),
            ..skipped
        };
        assert!(scheduler_idle_payload(&census_only, "s1", "").is_some());
    }
}

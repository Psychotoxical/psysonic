use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use psysonic_core::database_pair_admission::database_pair_read_scope;
use tauri::{AppHandle, State};

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisMigrationBatchRequest {
    pub generation: u64,
    pub server_id: String,
    pub step: psysonic_analysis::analysis_cache::AnalysisMigrationStep,
    pub cursor_rowid: i64,
    pub upper_rowid: i64,
    pub limit: Option<u32>,
}

const ANALYSIS_MIGRATION_ADMISSION_TIMEOUT: Duration = Duration::from_secs(120);

/// Canonical migration lock order:
/// 1. library migration admission and generation state;
/// 2. activated library write generation;
/// 3. acquired filesystem migration writer;
/// 4. exclusive analysis admission (bounded);
/// 5. cover hold and queue/cache drains.
///
/// Filesystem work may need ordinary analysis admission while it still holds a
/// filesystem reader, so analysis exclusivity must never precede step 3.
async fn acquire_filesystem_then_analysis<Acquire, AcquireFuture, Guard>(
    generation: u64,
    filesystem_active: &AtomicBool,
    acquire_analysis: Acquire,
) -> Result<Guard, String>
where
    Acquire: FnOnce(Duration) -> AcquireFuture,
    AcquireFuture: Future<Output = Result<Guard, String>>,
{
    psysonic_syncfs::activate_filesystem_migration_generation(generation).await?;
    filesystem_active.store(true, Ordering::Release);
    acquire_analysis(ANALYSIS_MIGRATION_ADMISSION_TIMEOUT).await
}

async fn begin_migration_generation_serialized<Activate, ActivateFuture, Rollback, RollbackFuture>(
    runtime: &psysonic_library::LibraryRuntime,
    server_ids: Vec<String>,
    activate: Activate,
    rollback: Rollback,
) -> Result<psysonic_library::runtime::MigrationBeginResultDto, String>
where
    Activate: FnOnce(u64) -> ActivateFuture,
    ActivateFuture: Future<Output = Result<(), String>>,
    Rollback: FnOnce(u64) -> RollbackFuture,
    RollbackFuture: Future<Output = Result<(), String>>,
{
    let _admission = runtime.migration_admission_guard().await;
    let result = runtime.begin_migration_generation(server_ids).await?;
    let generation = result.generation;
    if let Err(error) = activate(generation).await {
        if result.created {
            if let Err(rollback_error) = rollback(generation).await {
                return Err(format!(
                    "{error}; migration activation rollback failed: {rollback_error}"
                ));
            }
        }
        return Err(error);
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn library_migration_begin(
    app: AppHandle,
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    server_ids: Vec<String>,
) -> Result<psysonic_library::runtime::MigrationBeginResultDto, String> {
    let filesystem_active = Arc::new(AtomicBool::new(false));
    let cover_hold_active = Arc::new(AtomicBool::new(false));
    let filesystem_active_for_activation = Arc::clone(&filesystem_active);
    let cover_hold_for_activation = Arc::clone(&cover_hold_active);
    let app_for_activation = &app;
    let analysis_cache_for_activation = &analysis_cache;
    let app_for_rollback = &app;
    let runtime_for_rollback = &runtime;
    begin_migration_generation_serialized(
        &runtime,
        server_ids,
        move |generation| async move {
            let _analysis_admission = acquire_filesystem_then_analysis(
                generation,
                &filesystem_active_for_activation,
                |timeout| {
                    psysonic_analysis::analysis_runtime::analysis_migration_admission_guard(
                        timeout,
                    )
                },
            )
            .await?;
            crate::cli::clear_identity_cli_exchange_files();
            cover_hold_for_activation.store(true, Ordering::Release);
            crate::cover_cache::quiesce_for_migration(
                app_for_activation,
                Duration::from_secs(120),
            )
            .await?;
            analysis_cache_for_activation.drain_migration_writes(generation)?;
            psysonic_analysis::analysis_runtime::quiesce_analysis_for_migration(
                Duration::from_secs(120),
            )
            .await?;
            analysis_cache_for_activation.drain_migration_writes(generation)?;
            Ok(())
        },
        move |generation| async move {
            let filesystem_release_error = if filesystem_active.load(Ordering::Acquire) {
                psysonic_syncfs::deactivate_filesystem_migration_generation(generation).err()
            } else {
                None
            };
            if let Err(error) =
                runtime_for_rollback.rollback_migration_generation_start(generation)
            {
                if filesystem_release_error.is_none()
                    && filesystem_active.load(Ordering::Acquire)
                {
                    if let Err(restore_error) =
                        psysonic_syncfs::activate_filesystem_migration_generation(generation).await
                    {
                        return Err(format!(
                            "{error}; failed to restore filesystem migration barrier: {restore_error}"
                        ));
                    }
                }
                return match filesystem_release_error {
                    Some(release_error) => Err(format!(
                        "{error}; failed to release filesystem migration barrier: {release_error}"
                    )),
                    None => Err(error),
                };
            }
            if cover_hold_active.load(Ordering::Acquire) {
                crate::cover_cache::release_migration_hold(app_for_rollback);
            }
            match filesystem_release_error {
                Some(error) => Err(format!(
                    "library generation rolled back but filesystem migration barrier release failed: {error}"
                )),
                None => Ok(()),
            }
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn library_migration_release(
    app: AppHandle,
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    generation: u64,
) -> Result<(), String> {
    let _admission = runtime.migration_admission_guard().await;
    runtime.ensure_migration_generation_releasable(generation)?;
    psysonic_syncfs::deactivate_filesystem_migration_generation(generation)?;
    if let Err(error) = runtime.release_migration_generation(generation) {
        return match psysonic_syncfs::activate_filesystem_migration_generation(generation).await {
            Ok(()) => Err(error),
            Err(restore_error) => Err(format!(
                "{error}; failed to restore filesystem migration barrier: {restore_error}"
            )),
        };
    }
    crate::cover_cache::release_migration_hold(&app);
    Ok(())
}

#[tauri::command]
pub fn library_migration_write_device_manifest(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    generation: u64,
    server_id: String,
    dest_dir: String,
    sources: serde_json::Value,
) -> Result<bool, String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Frontend,
    )?;
    let target = std::path::Path::new(&dest_dir);
    if !target.exists() || !psysonic_syncfs::sync::device::is_path_on_mounted_volume(target) {
        return Ok(false);
    }
    psysonic_syncfs::sync::device::write_device_manifest_for_migration(
        dest_dir,
        server_id.to_string(),
        sources,
        Some(1),
    )?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_analysis_upper_rowid(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    generation: u64,
    server_id: String,
    step: psysonic_analysis::analysis_cache::AnalysisMigrationStep,
) -> Result<i64, String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Analysis,
    )?;
    analysis_cache.migration_upper_rowid(server_id, step)
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_analysis_batch(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    request: AnalysisMigrationBatchRequest,
) -> Result<psysonic_analysis::analysis_cache::AnalysisMigrationBatchDto, String> {
    let server_id = request.server_id.trim();
    runtime.ensure_migration_phase(
        request.generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Analysis,
    )?;
    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
        request.generation,
        || {
            analysis_cache.migration_run_batch(
                server_id,
                request.step,
                request.cursor_rowid,
                request.upper_rowid,
                request.limit.unwrap_or(2_000),
            )
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_analysis_finalize(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    generation: u64,
    server_id: String,
) -> Result<psysonic_analysis::analysis_cache::AnalysisMigrationFinalizeDto, String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Analysis,
    )?;
    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
        generation,
        || analysis_cache.migration_finalize(server_id),
    )
}

#[tauri::command]
#[specta::specta]
pub fn library_migration_verify(
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    generation: u64,
    server_id: String,
) -> Result<(), String> {
    let server_id = server_id.trim();
    runtime.ensure_migration_phase(
        generation,
        server_id,
        psysonic_library::runtime::MigrationPhase::Cleanup,
    )?;
    let _pair_scope = database_pair_read_scope();
    psysonic_library::navidrome_native_migration::verify(&runtime.store, server_id)?;
    analysis_cache.migration_verify(server_id)
}

#[tauri::command]
#[specta::specta]
pub async fn library_migration_inventory(
    app: AppHandle,
    runtime: State<'_, psysonic_library::LibraryRuntime>,
    analysis_cache: State<'_, psysonic_analysis::analysis_cache::AnalysisCache>,
    server_id: String,
    server_index_key: String,
    custom_offline_dir: Option<String>,
    custom_hot_cache_dir: Option<String>,
) -> Result<(), String> {
    let server_id = server_id.trim();
    let server_index_key = server_index_key.trim();
    {
        let _pair_scope = database_pair_read_scope();
        psysonic_library::navidrome_native_migration::verify(&runtime.store, server_id)?;
        analysis_cache.migration_verify(server_id)?;
    }
    crate::cover_cache::verify_navidrome_cover_ids(&app, server_index_key).await?;
    psysonic_syncfs::cache::id_migration::verify_navidrome_filesystem_ids(
        &app,
        runtime.store.clone(),
        server_id,
        server_index_key,
        custom_offline_dir,
        custom_hot_cache_dir,
    )
    .await
}

#[cfg(test)]
mod tests {
    use tokio::sync::{mpsc, oneshot, Notify, RwLock};

    use super::*;
    use psysonic_library::runtime::{MigrationGenerationSnapshotDto, MigrationPhase};
    use psysonic_library::{LibraryRuntime, LibraryStore};

    #[tokio::test(flavor = "multi_thread")]
    async fn filesystem_holder_can_finish_analysis_admission_before_migration_exclusive() {
        let filesystem_reader = psysonic_syncfs::filesystem_write_guard().await.unwrap();
        let filesystem_active = Arc::new(AtomicBool::new(false));
        let analysis = Arc::new(RwLock::new(()));
        let filesystem_active_for_migration = Arc::clone(&filesystem_active);
        let analysis_for_migration = Arc::clone(&analysis);
        let migration = tokio::spawn(async move {
            acquire_filesystem_then_analysis(
                41,
                &filesystem_active_for_migration,
                move |timeout| async move {
                    tokio::time::timeout(timeout, analysis_for_migration.write_owned())
                        .await
                        .map_err(|_| "test analysis writer timed out".to_string())
                },
            )
            .await
        });

        loop {
            match psysonic_syncfs::filesystem_write_guard().await {
                Ok(guard) => {
                    drop(guard);
                    tokio::task::yield_now().await;
                }
                Err(error) if error.contains("migration generation 41") => break,
                Err(error) => panic!("unexpected filesystem admission error: {error}"),
            }
        }

        // This models an in-flight filesystem operation that discovers it must
        // enqueue enrichment after migration begin has started.
        let analysis_reader = tokio::time::timeout(
            Duration::from_secs(1),
            analysis.clone().read_owned(),
        )
        .await
        .expect("filesystem holder must reach ordinary analysis admission");
        drop(filesystem_reader);

        tokio::pin!(migration);
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut migration)
            .await
            .is_err());
        drop(analysis_reader);
        let analysis_writer = migration.await.unwrap().unwrap();
        drop(analysis_writer);
        psysonic_syncfs::deactivate_filesystem_migration_generation(41).unwrap();
    }

    #[tokio::test]
    async fn filesystem_activation_failure_rolls_back_created_library_generation() {
        let runtime = Arc::new(LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory())));
        let runtime_for_rollback = Arc::clone(&runtime);

        let error = begin_migration_generation_serialized(
            &runtime,
            vec!["s1".into()],
            |_| async { Err("filesystem migration guard lock poisoned".to_string()) },
            move |generation| async move {
                runtime_for_rollback.rollback_migration_generation_start(generation)
            },
        )
        .await
        .unwrap_err();

        assert!(error.contains("filesystem migration guard lock poisoned"));
        assert_eq!(
            runtime.inspect_migration_generation().unwrap(),
            MigrationGenerationSnapshotDto::Inactive { last_generation: 1 }
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_begins_wait_for_complete_activation() {
        let runtime = Arc::new(LibraryRuntime::new(
            Arc::new(LibraryStore::open_in_memory()),
        ));
        let continue_first = Arc::new(Notify::new());
        let (first_started_tx, first_started_rx) = oneshot::channel();
        let runtime_for_first = Arc::clone(&runtime);
        let continue_first_task = Arc::clone(&continue_first);
        let first = tokio::spawn(async move {
            begin_migration_generation_serialized(
                &runtime_for_first,
                vec!["s1".into()],
                move |generation| async move {
                    first_started_tx.send(generation).unwrap();
                    continue_first_task.notified().await;
                    Ok(())
                },
                |_| async { Ok(()) },
            )
            .await
        });
        let first_generation = first_started_rx.await.unwrap();

        let (second_started_tx, mut second_started_rx) = oneshot::channel();
        let runtime_for_second = Arc::clone(&runtime);
        let second = tokio::spawn(async move {
            begin_migration_generation_serialized(
                &runtime_for_second,
                vec!["s2".into()],
                move |generation| async move {
                    second_started_tx.send(generation).unwrap();
                    Ok(())
                },
                |_| async { Ok(()) },
            )
            .await
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut second_started_rx)
                .await
                .is_err()
        );
        continue_first.notify_one();

        let first_result = first.await.unwrap().unwrap();
        assert_eq!(first_result.generation, first_generation);
        assert!(first_result.created);
        assert_eq!(second_started_rx.await.unwrap(), first_generation);
        let second_result = second.await.unwrap().unwrap();
        assert_eq!(second_result.generation, first_generation);
        assert!(!second_result.created);
        assert_eq!(
            second_result.servers,
            vec![psysonic_library::runtime::MigrationBeginServerDto {
                server_id: "s2".into(),
                previous_phase: None,
            }]
        );
        assert!(matches!(
            runtime.inspect_migration_generation().unwrap(),
            MigrationGenerationSnapshotDto::Active { generation, servers }
                if generation == first_generation && servers.len() == 2
        ));

        runtime
            .finish_migration_server(first_generation, "s1", MigrationPhase::Ready)
            .unwrap();
        runtime
            .finish_migration_server(first_generation, "s2", MigrationPhase::Ready)
            .unwrap();
        runtime
            .release_migration_generation(first_generation)
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_activation_rolls_back_before_next_begin_is_admitted() {
        let runtime = Arc::new(LibraryRuntime::new(
            Arc::new(LibraryStore::open_in_memory()),
        ));
        let continue_first = Arc::new(Notify::new());
        let (first_started_tx, first_started_rx) = oneshot::channel();
        let (events_tx, mut events_rx) = mpsc::unbounded_channel();
        let runtime_for_first = Arc::clone(&runtime);
        let runtime_for_rollback = Arc::clone(&runtime);
        let continue_first_task = Arc::clone(&continue_first);
        let rollback_events = events_tx.clone();
        let first = tokio::spawn(async move {
            begin_migration_generation_serialized(
                &runtime_for_first,
                vec!["s1".into()],
                move |generation| async move {
                    first_started_tx.send(generation).unwrap();
                    continue_first_task.notified().await;
                    Err("injected activation failure".to_string())
                },
                move |generation| async move {
                    runtime_for_rollback.rollback_migration_generation_start(generation)?;
                    rollback_events.send("rollback").unwrap();
                    Ok(())
                },
            )
            .await
        });
        let first_generation = first_started_rx.await.unwrap();

        let runtime_for_second = Arc::clone(&runtime);
        let second_events = events_tx;
        let second = tokio::spawn(async move {
            begin_migration_generation_serialized(
                &runtime_for_second,
                vec!["s2".into()],
                move |_| async move {
                    second_events.send("second").unwrap();
                    Ok(())
                },
                |_| async { Ok(()) },
            )
            .await
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(50), events_rx.recv())
                .await
                .is_err()
        );
        continue_first.notify_one();

        assert!(first
            .await
            .unwrap()
            .unwrap_err()
            .contains("injected activation failure"));
        assert_eq!(events_rx.recv().await, Some("rollback"));
        assert_eq!(events_rx.recv().await, Some("second"));
        let second_generation = second.await.unwrap().unwrap().generation;
        assert_eq!(second_generation, first_generation + 1);
        assert!(matches!(
            runtime.inspect_migration_generation().unwrap(),
            MigrationGenerationSnapshotDto::Active { generation, servers }
                if generation == second_generation
                    && servers.len() == 1
                    && servers[0].server_id == "s2"
        ));

        runtime
            .finish_migration_server(second_generation, "s2", MigrationPhase::Ready)
            .unwrap();
        runtime
            .release_migration_generation(second_generation)
            .unwrap();
    }

    #[tokio::test]
    async fn failed_activation_does_not_rollback_an_existing_generation() {
        let runtime = LibraryRuntime::new(Arc::new(LibraryStore::open_in_memory()));
        let generation = runtime
            .begin_migration_generation(["s1"])
            .await
            .unwrap()
            .generation;
        let rollback_called = Arc::new(AtomicBool::new(false));
        let rollback_called_by_closure = Arc::clone(&rollback_called);

        let error = begin_migration_generation_serialized(
            &runtime,
            vec!["s2".into()],
            |_| async { Err("injected activation failure".to_string()) },
            move |_| async move {
                rollback_called_by_closure.store(true, Ordering::Release);
                Ok(())
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error, "injected activation failure");
        assert!(!rollback_called.load(Ordering::Acquire));
        assert!(matches!(
            runtime.inspect_migration_generation().unwrap(),
            MigrationGenerationSnapshotDto::Active {
                generation: active_generation,
                servers,
            } if active_generation == generation && servers.len() == 2
        ));

        runtime
            .finish_migration_server(generation, "s1", MigrationPhase::Ready)
            .unwrap();
        runtime
            .finish_migration_server(generation, "s2", MigrationPhase::Ready)
            .unwrap();
        runtime.release_migration_generation(generation).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn release_waits_for_inflight_activation() {
        let runtime = Arc::new(LibraryRuntime::new(
            Arc::new(LibraryStore::open_in_memory()),
        ));
        let continue_activation = Arc::new(Notify::new());
        let (activation_started_tx, activation_started_rx) = oneshot::channel();
        let runtime_for_begin = Arc::clone(&runtime);
        let continue_activation_task = Arc::clone(&continue_activation);
        let begin = tokio::spawn(async move {
            begin_migration_generation_serialized(
                &runtime_for_begin,
                vec!["s1".into()],
                move |generation| async move {
                    activation_started_tx.send(generation).unwrap();
                    continue_activation_task.notified().await;
                    Ok(())
                },
                |_| async { Ok(()) },
            )
            .await
        });
        let generation = activation_started_rx.await.unwrap();
        runtime
            .finish_migration_server(generation, "s1", MigrationPhase::Ready)
            .unwrap();

        let (release_started_tx, mut release_started_rx) = oneshot::channel();
        let runtime_for_release = Arc::clone(&runtime);
        let release = tokio::spawn(async move {
            let _admission = runtime_for_release.migration_admission_guard().await;
            release_started_tx.send(()).unwrap();
            runtime_for_release.ensure_migration_generation_releasable(generation)?;
            runtime_for_release.release_migration_generation(generation)
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut release_started_rx)
                .await
                .is_err()
        );
        assert!(matches!(
            runtime.inspect_migration_generation().unwrap(),
            MigrationGenerationSnapshotDto::Active {
                generation: active_generation,
                ..
            } if active_generation == generation
        ));

        continue_activation.notify_one();
        assert_eq!(begin.await.unwrap().unwrap().generation, generation);
        release_started_rx.await.unwrap();
        release.await.unwrap().unwrap();
        assert_eq!(
            runtime.inspect_migration_generation().unwrap(),
            MigrationGenerationSnapshotDto::Inactive {
                last_generation: generation,
            }
        );
    }
}

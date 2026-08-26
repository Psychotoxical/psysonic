use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use psysonic_core::database_pair_admission::database_pair_read_scope;
use serde_json::Value;
use tauri::{AppHandle, Manager};

mod archive;
mod database;

use archive::{
    extract_databases_archive, extract_full_archive, write_databases_archive, write_full_archive,
    FullBackupPayload, FULL_ARCHIVE_VERSION,
};
use database::{
    analysis_db_path, cleanup_database_paths, commit_imported_databases,
    finalize_full_import_recovery_for_app, import_databases_from_sqlite,
    inspect_full_import_recovery_for_app, library_db_path, recover_full_import_databases,
    remove_db_with_sidecars, remove_if_exists, restore_database_pair, vacuum_copy,
    validate_import_database, FullImportRecoveryStatusDto,
};

const ANALYSIS_DB_MIN_COMPATIBLE_VERSION: i64 = 1;

async fn acquire_sync_drain_barrier(
    app: &AppHandle,
) -> Result<psysonic_library::runtime::SyncDrainBarrier, String> {
    let runtime = app
        .try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?;
    runtime.ensure_external_write_allowed()?;
    runtime.cancel_and_drain_sync(None, None).await
}

async fn acquire_import_barrier(
    app: &AppHandle,
    migration_generation: u64,
) -> Result<(), String> {
    let runtime = app
        .try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?;
    match runtime.inspect_migration_generation()? {
        psysonic_library::runtime::MigrationGenerationSnapshotDto::Active {
            generation: active,
            ..
        } if active == migration_generation => Ok(()),
        _ => Err(format!(
            "migration generation {migration_generation} is not active"
        )),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_export_library_db(
    app: AppHandle,
    destination_path: String,
) -> Result<(), String> {
    let _barrier = acquire_sync_drain_barrier(&app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_export_library_db_blocking(&app, destination_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_export_library_db_blocking(
    app: &AppHandle,
    destination_path: String,
) -> Result<(), String> {
    let _pair_scope = database_pair_read_scope();
    let destination = PathBuf::from(destination_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let source_library = library_db_path(app)?;
    let source_analysis = analysis_db_path(app)?;
    if !source_library.exists() {
        return Err("library database does not exist".to_string());
    }
    if !source_analysis.exists() {
        return Err("analysis database does not exist".to_string());
    }
    remove_if_exists(&destination)?;

    let snapshot_library_tmp = source_library.with_file_name("library-export.sqlite");
    let snapshot_analysis_tmp = source_analysis.with_file_name("audio-analysis-export.sqlite");
    remove_db_with_sidecars(&snapshot_library_tmp)?;
    remove_db_with_sidecars(&snapshot_analysis_tmp)?;
    vacuum_copy(&source_library, &snapshot_library_tmp)?;
    vacuum_copy(&source_analysis, &snapshot_analysis_tmp)?;
    let result =
        write_databases_archive(&snapshot_library_tmp, &snapshot_analysis_tmp, &destination);
    remove_db_with_sidecars(&snapshot_library_tmp).ok();
    remove_db_with_sidecars(&snapshot_analysis_tmp).ok();
    result
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_import_library_db(
    app: AppHandle,
    source_path: String,
    canonical_server_ids: Vec<String>,
    migration_generation: u64,
    durable_full_import_recovery: bool,
) -> Result<(), String> {
    acquire_import_barrier(&app, migration_generation).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_import_library_db_blocking(
            &app,
            source_path,
            canonical_server_ids,
            migration_generation,
            durable_full_import_recovery,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_import_library_db_blocking(
    app: &AppHandle,
    source_path: String,
    canonical_server_ids: Vec<String>,
    migration_generation: u64,
    durable_full_import_recovery: bool,
) -> Result<(), String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err("backup file not found".to_string());
    }

    let active_library = library_db_path(app)?;
    let active_analysis = analysis_db_path(app)?;
    let import_library_tmp = active_library.with_file_name("library-import.sqlite");
    let import_analysis_tmp = active_analysis.with_file_name("audio-analysis-import.sqlite");
    remove_db_with_sidecars(&import_library_tmp)?;
    remove_db_with_sidecars(&import_analysis_tmp)?;
    extract_databases_archive(&source, &import_library_tmp, &import_analysis_tmp)?;
    validate_import_database(
        &import_library_tmp,
        "library",
        psysonic_library::store::LIBRARY_DB_MIN_COMPATIBLE_VERSION,
        psysonic_library::LIBRARY_DB_SCHEMA_VERSION,
    )?;
    validate_import_database(
        &import_analysis_tmp,
        "analysis",
        ANALYSIS_DB_MIN_COMPATIBLE_VERSION,
        psysonic_analysis::analysis_cache::ANALYSIS_DB_SCHEMA_VERSION,
    )?;
    let activate = || {
        import_databases_from_sqlite(
            app,
            &import_library_tmp,
            &import_analysis_tmp,
            durable_full_import_recovery,
            migration_generation,
        )
    };
    if let Err(error) = canonicalize_staged_databases(
        &import_library_tmp,
        &import_analysis_tmp,
        canonical_server_ids,
    ) {
        return match cleanup_database_paths(&[&import_library_tmp, &import_analysis_tmp]) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; staged database cleanup failed: {cleanup_error}"
            )),
        };
    }
    psysonic_library::store::LibraryStore::scope_migration_write_generation_sync(
        migration_generation,
        || {
            psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
                migration_generation,
                activate,
            )
        },
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) fn backup_inspect_full_import_recovery(
    app: AppHandle,
) -> Result<Option<FullImportRecoveryStatusDto>, String> {
    inspect_full_import_recovery_for_app(&app)
}

async fn acquire_full_import_recovery_barrier(
    app: &AppHandle,
    migration_generation: u64,
) -> Result<
    (
        Option<psysonic_library::runtime::SyncDrainBarrier>,
        Option<u64>,
    ),
    String,
> {
    let runtime = app
        .try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?;
    match runtime.inspect_migration_generation()? {
        psysonic_library::runtime::MigrationGenerationSnapshotDto::Active {
            generation,
            ..
        } if generation == migration_generation => Ok((None, Some(generation))),
        psysonic_library::runtime::MigrationGenerationSnapshotDto::Inactive { .. } => {
            Ok((Some(acquire_sync_drain_barrier(app).await?), None))
        }
        psysonic_library::runtime::MigrationGenerationSnapshotDto::Active {
            generation,
            ..
        } => Err(format!(
            "full import recovery generation mismatch: marker={migration_generation}, active={generation}"
        )),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_recover_full_import_databases(app: AppHandle) -> Result<(), String> {
    let status = inspect_full_import_recovery_for_app(&app)?
        .ok_or_else(|| "full import recovery marker is missing".to_string())?;
    let (_barrier, active_generation) =
        acquire_full_import_recovery_barrier(&app, status.migration_generation).await?;
    tauri::async_runtime::spawn_blocking(move || match active_generation {
        Some(generation) => {
            psysonic_library::store::LibraryStore::scope_migration_write_generation_sync(
                generation,
                || {
                    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
                        generation,
                        || recover_full_import_databases(&app),
                    )
                },
            )
        }
        None => recover_full_import_databases(&app),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
#[specta::specta]
pub(crate) fn backup_finalize_full_import_recovery(app: AppHandle) -> Result<(), String> {
    finalize_full_import_recovery_for_app(&app)
}

fn canonicalize_staged_databases(
    library_path: &std::path::Path,
    analysis_path: &std::path::Path,
    server_ids: Vec<String>,
) -> Result<(), String> {
    let library = psysonic_library::store::LibraryStore::open_staged_path(library_path)?;
    let analysis =
        psysonic_analysis::analysis_cache::AnalysisCache::open_staged_path(analysis_path)?;
    let mut seen = HashSet::new();
    for server_id in server_ids {
        let server_id = server_id.trim();
        if server_id.is_empty() || !seen.insert(server_id.to_string()) {
            continue;
        }
        psysonic_library::navidrome_native_migration::preflight(&library, server_id)?;
        for step in [
            psysonic_library::navidrome_native_migration::NavidromeNativeMigrationStep::Artist,
            psysonic_library::navidrome_native_migration::NavidromeNativeMigrationStep::Album,
            psysonic_library::navidrome_native_migration::NavidromeNativeMigrationStep::Track,
        ] {
            let upper =
                psysonic_library::navidrome_native_migration::upper_rowid(&library, server_id, step)?;
            let mut cursor = 0;
            while cursor < upper {
                let batch = psysonic_library::navidrome_native_migration::run_batch(
                    &library, server_id, step, cursor, upper, 2_000,
                )?;
                if batch.cursor_rowid <= cursor {
                    return Err(format!(
                        "staged library migration made no progress for {server_id}"
                    ));
                }
                cursor = batch.cursor_rowid;
            }
        }
        psysonic_library::navidrome_native_migration::finalize(&library, server_id)?;

        for step in [
            psysonic_analysis::analysis_cache::AnalysisMigrationStep::AnalysisTrack,
            psysonic_analysis::analysis_cache::AnalysisMigrationStep::WaveformCache,
            psysonic_analysis::analysis_cache::AnalysisMigrationStep::LoudnessCache,
        ] {
            let upper = analysis.migration_upper_rowid(server_id, step)?;
            let mut cursor = 0;
            while cursor < upper {
                let batch = analysis.migration_run_batch(server_id, step, cursor, upper, 2_000)?;
                if batch.cursor_rowid <= cursor {
                    return Err(format!(
                        "staged analysis migration made no progress for {server_id}"
                    ));
                }
                cursor = batch.cursor_rowid;
            }
        }
        analysis.migration_finalize(server_id)?;
        psysonic_library::navidrome_native_migration::verify(&library, server_id)?;
        analysis.migration_verify(server_id)?;
    }
    library.checkpoint_wal("staged-import")?;
    analysis.checkpoint_wal("staged-import")?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn backup_export_full(
    app: AppHandle,
    destination_path: String,
    stores: Value,
    app_version: String,
) -> Result<(), String> {
    let _barrier = acquire_sync_drain_barrier(&app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_export_full_blocking(&app, destination_path, stores, app_version)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_export_full_blocking(
    app: &AppHandle,
    destination_path: String,
    stores: Value,
    app_version: String,
) -> Result<(), String> {
    let _pair_scope = database_pair_read_scope();
    if !stores.is_object() {
        return Err("stores payload must be an object".to_string());
    }
    let destination = PathBuf::from(destination_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    remove_if_exists(&destination)?;

    let source_library = library_db_path(app)?;
    let source_analysis = analysis_db_path(app)?;
    if !source_library.exists() {
        return Err("library database does not exist".to_string());
    }
    if !source_analysis.exists() {
        return Err("analysis database does not exist".to_string());
    }
    let snapshot_library_tmp = source_library.with_file_name("library-export.sqlite");
    let snapshot_analysis_tmp = source_analysis.with_file_name("audio-analysis-export.sqlite");
    remove_db_with_sidecars(&snapshot_library_tmp)?;
    remove_db_with_sidecars(&snapshot_analysis_tmp)?;
    vacuum_copy(&source_library, &snapshot_library_tmp)?;
    vacuum_copy(&source_analysis, &snapshot_analysis_tmp)?;

    let payload = FullBackupPayload {
        version: FULL_ARCHIVE_VERSION,
        app_version,
        stores,
    };
    let result = write_full_archive(
        &snapshot_library_tmp,
        &snapshot_analysis_tmp,
        &destination,
        &payload,
    );
    remove_db_with_sidecars(&snapshot_library_tmp).ok();
    remove_db_with_sidecars(&snapshot_analysis_tmp).ok();
    result
}

#[tauri::command]
pub(crate) async fn backup_import_full(
    app: AppHandle,
    source_path: String,
) -> Result<Value, String> {
    let _barrier = acquire_sync_drain_barrier(&app).await?;
    tauri::async_runtime::spawn_blocking(move || backup_import_full_blocking(&app, source_path))
        .await
        .map_err(|e| e.to_string())?
}

fn backup_import_full_blocking(app: &AppHandle, source_path: String) -> Result<Value, String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err("backup file not found".to_string());
    }

    let active_library = library_db_path(app)?;
    let active_analysis = analysis_db_path(app)?;
    let import_library_tmp = active_library.with_file_name("library-import.sqlite");
    let import_analysis_tmp = active_analysis.with_file_name("audio-analysis-import.sqlite");
    remove_db_with_sidecars(&import_library_tmp)?;
    remove_db_with_sidecars(&import_analysis_tmp)?;
    let payload = extract_full_archive(&source, &import_library_tmp, &import_analysis_tmp)?;
    validate_import_database(
        &import_library_tmp,
        "library",
        psysonic_library::store::LIBRARY_DB_MIN_COMPATIBLE_VERSION,
        psysonic_library::LIBRARY_DB_SCHEMA_VERSION,
    )?;
    validate_import_database(
        &import_analysis_tmp,
        "analysis",
        ANALYSIS_DB_MIN_COMPATIBLE_VERSION,
        psysonic_analysis::analysis_cache::ANALYSIS_DB_SCHEMA_VERSION,
    )?;
    let stores = payload.stores;
    if !stores.is_object() {
        return match cleanup_database_paths(&[&import_library_tmp, &import_analysis_tmp]) {
            Ok(()) => Err("backup payload stores must be an object".to_string()),
            Err(cleanup_error) => Err(format!(
                "backup payload stores must be an object; staged database cleanup failed: {cleanup_error}"
            )),
        };
    }

    cleanup_database_paths(&[&import_library_tmp, &import_analysis_tmp])?;
    Ok(stores)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_rollback_imported_databases(
    app: AppHandle,
    migration_generation: u64,
) -> Result<(), String> {
    acquire_import_barrier(&app, migration_generation).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_rollback_imported_databases_blocking(&app, migration_generation)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn backup_rollback_imported_databases_blocking(
    app: &AppHandle,
    migration_generation: u64,
) -> Result<(), String> {
    let active_library = library_db_path(app)?;
    let active_analysis = analysis_db_path(app)?;
    let library_backup = active_library.with_file_name("library.sqlite.import.bak");
    let analysis_backup = active_analysis.with_file_name("audio-analysis.sqlite.import.bak");
    if !library_backup.exists() || !analysis_backup.exists() {
        return Err("import rollback backup pair is incomplete".to_string());
    }
    let runtime = app
        .try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?;
    let cache = app
        .try_state::<psysonic_analysis::analysis_cache::AnalysisCache>()
        .ok_or_else(|| "analysis runtime unavailable".to_string())?;
    let rollback = || {
        restore_database_pair(
            &runtime,
            &cache,
            &[library_backup.as_path()],
            &[analysis_backup.as_path()],
            &active_library,
            &active_analysis,
        )
    };
    psysonic_library::store::LibraryStore::scope_migration_write_generation_sync(
        migration_generation,
        || {
            psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
                migration_generation,
                rollback,
            )
        },
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) fn backup_commit_imported_databases(app: AppHandle) -> Result<(), String> {
    commit_imported_databases(&app)
}

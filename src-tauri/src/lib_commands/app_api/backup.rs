use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, Manager};

mod archive;
mod database;

use archive::{
    extract_databases_archive, extract_full_archive, write_databases_archive, write_full_archive,
    FullBackupPayload, FULL_ARCHIVE_VERSION,
};
use database::{
    analysis_db_path, import_databases_from_sqlite, library_db_path, remove_db_with_sidecars,
    remove_if_exists, vacuum_copy, validate_import_database,
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
    migration_generation: Option<u64>,
) -> Result<Option<psysonic_library::runtime::SyncDrainBarrier>, String> {
    let Some(generation) = migration_generation else {
        return acquire_sync_drain_barrier(app).await.map(Some);
    };
    let runtime = app
        .try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?;
    match runtime.inspect_migration_generation()? {
        psysonic_library::runtime::MigrationGenerationSnapshotDto::Active {
            generation: active,
            ..
        } if active == generation => Ok(None),
        _ => Err(format!("migration generation {generation} is not active")),
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
    migration_generation: Option<u64>,
) -> Result<(), String> {
    let _barrier = acquire_import_barrier(&app, migration_generation).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_import_library_db_blocking(
            &app,
            source_path,
            canonical_server_ids,
            migration_generation,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_import_library_db_blocking(
    app: &AppHandle,
    source_path: String,
    canonical_server_ids: Vec<String>,
    migration_generation: Option<u64>,
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
    let activate = || import_databases_from_sqlite(app, &import_library_tmp, &import_analysis_tmp);
    let result = canonicalize_staged_databases(
        &import_library_tmp,
        &import_analysis_tmp,
        canonical_server_ids,
    )
    .and_then(|_| match migration_generation {
        Some(generation) => {
            psysonic_library::store::LibraryStore::scope_migration_write_generation_sync(
                generation,
                || {
                    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
                        generation,
                        activate,
                    )
                },
            )
        }
        None => activate(),
    });
    if result.is_err() {
        remove_db_with_sidecars(&import_library_tmp).ok();
        remove_db_with_sidecars(&import_analysis_tmp).ok();
    }
    result
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
        remove_db_with_sidecars(&import_library_tmp).ok();
        remove_db_with_sidecars(&import_analysis_tmp).ok();
        return Err("backup payload stores must be an object".to_string());
    }

    remove_db_with_sidecars(&import_library_tmp).ok();
    remove_db_with_sidecars(&import_analysis_tmp).ok();
    Ok(stores)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_rollback_imported_databases(
    app: AppHandle,
    migration_generation: Option<u64>,
) -> Result<(), String> {
    let _barrier = acquire_import_barrier(&app, migration_generation).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_rollback_imported_databases_blocking(&app, migration_generation)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn backup_rollback_imported_databases_blocking(
    app: &AppHandle,
    migration_generation: Option<u64>,
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
        cache.restore_database_backup(&analysis_backup, &active_analysis)?;
        runtime
            .store
            .restore_database_backup(&library_backup, &active_library)?;
        runtime.store.verify_operational_schema()?;
        cache.verify_operational_schema()
    };
    match migration_generation {
        Some(generation) => {
            psysonic_library::store::LibraryStore::scope_migration_write_generation_sync(
                generation,
                || {
                    psysonic_analysis::analysis_cache::AnalysisCache::scope_migration_write_generation_sync(
                        generation,
                        rollback,
                    )
                },
            )
        }
        None => rollback(),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn backup_commit_imported_databases(app: AppHandle) -> Result<(), String> {
    let active_library = library_db_path(&app)?;
    let active_analysis = analysis_db_path(&app)?;
    remove_db_with_sidecars(&active_library.with_file_name("library.sqlite.import.bak"))?;
    remove_db_with_sidecars(
        &active_analysis.with_file_name("audio-analysis.sqlite.import.bak"),
    )
}

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
    app.try_state::<psysonic_library::LibraryRuntime>()
        .ok_or_else(|| "library runtime unavailable".to_string())?
        .cancel_and_drain_sync(None, None)
        .await
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
) -> Result<(), String> {
    let _barrier = acquire_sync_drain_barrier(&app).await?;
    tauri::async_runtime::spawn_blocking(move || {
        backup_import_library_db_blocking(&app, source_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_import_library_db_blocking(app: &AppHandle, source_path: String) -> Result<(), String> {
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
    import_databases_from_sqlite(app, &import_library_tmp, &import_analysis_tmp)
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

    import_databases_from_sqlite(app, &import_library_tmp, &import_analysis_tmp)?;
    Ok(stores)
}

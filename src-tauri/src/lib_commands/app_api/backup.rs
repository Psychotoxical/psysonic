use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const LIBRARY_ARCHIVE_ENTRY: &str = "library.sqlite";
const ANALYSIS_ARCHIVE_ENTRY: &str = "audio-analysis.sqlite";
const FULL_ARCHIVE_SETTINGS_ENTRY: &str = "settings.json";
const FULL_ARCHIVE_VERSION: u64 = 1;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct FullBackupPayload {
    version: u64,
    app_version: String,
    stores: Value,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_export_library_db(
    app: AppHandle,
    destination_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup_export_library_db_blocking(&app, destination_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn backup_export_library_db_blocking(app: &AppHandle, destination_path: String) -> Result<(), String> {
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
    let result = write_databases_archive(
        &snapshot_library_tmp,
        &snapshot_analysis_tmp,
        &destination,
    );
    remove_db_with_sidecars(&snapshot_library_tmp).ok();
    remove_db_with_sidecars(&snapshot_analysis_tmp).ok();
    result
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn backup_import_library_db(app: AppHandle, source_path: String) -> Result<(), String> {
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
    validate_sqlite_file(&import_library_tmp)?;
    validate_sqlite_file(&import_analysis_tmp)?;
    import_databases_from_sqlite(app, &import_library_tmp, &import_analysis_tmp)
}

#[tauri::command]
pub(crate) async fn backup_export_full(
    app: AppHandle,
    destination_path: String,
    stores: Value,
    app_version: String,
) -> Result<(), String> {
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
pub(crate) async fn backup_import_full(app: AppHandle, source_path: String) -> Result<Value, String> {
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
    validate_sqlite_file(&import_library_tmp)?;
    validate_sqlite_file(&import_analysis_tmp)?;
    let stores = payload.stores;
    if !stores.is_object() {
        remove_db_with_sidecars(&import_library_tmp).ok();
        remove_db_with_sidecars(&import_analysis_tmp).ok();
        return Err("backup payload stores must be an object".to_string());
    }

    import_databases_from_sqlite(app, &import_library_tmp, &import_analysis_tmp)?;
    Ok(stores)
}

fn library_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("databases").join("library");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.sqlite"))
}

fn analysis_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("databases").join("analysis");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("audio-analysis.sqlite"))
}

fn vacuum_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let escaped = destination.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{escaped}';");
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

fn write_databases_archive(
    library_snapshot: &Path,
    analysis_snapshot: &Path,
    destination_archive: &Path,
) -> Result<(), String> {
    let file = fs::File::create(destination_archive).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.start_file(LIBRARY_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut src = fs::File::open(library_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;
    zip.start_file(ANALYSIS_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut analysis_src = fs::File::open(analysis_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut analysis_src, &mut zip).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn write_full_archive(
    library_snapshot: &Path,
    analysis_snapshot: &Path,
    destination_archive: &Path,
    payload: &FullBackupPayload,
) -> Result<(), String> {
    let file = fs::File::create(destination_archive).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options =
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file(FULL_ARCHIVE_SETTINGS_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let settings = serde_json::to_vec_pretty(payload).map_err(|e| e.to_string())?;
    zip.write_all(&settings).map_err(|e| e.to_string())?;

    zip.start_file(LIBRARY_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut src = fs::File::open(library_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;

    zip.start_file(ANALYSIS_ARCHIVE_ENTRY, options)
        .map_err(|e| e.to_string())?;
    let mut analysis_src = fs::File::open(analysis_snapshot).map_err(|e| e.to_string())?;
    io::copy(&mut analysis_src, &mut zip).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_databases_archive(
    source_archive: &Path,
    library_destination_sqlite: &Path,
    analysis_destination_sqlite: &Path,
) -> Result<(), String> {
    let file = fs::File::open(source_archive).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    let library_target_index = archive
        .file_names()
        .enumerate()
        .find_map(|(i, name)| (name == LIBRARY_ARCHIVE_ENTRY).then_some(i))
        .ok_or_else(|| "archive does not contain library.sqlite".to_string())?;
    let analysis_target_index = archive
        .file_names()
        .enumerate()
        .find_map(|(i, name)| (name == ANALYSIS_ARCHIVE_ENTRY).then_some(i))
        .ok_or_else(|| "archive does not contain audio-analysis.sqlite".to_string())?;

    if let Some(parent) = library_destination_sqlite.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    {
        let mut library_entry = archive.by_index(library_target_index).map_err(|e| e.to_string())?;
        let mut out = fs::File::create(library_destination_sqlite).map_err(|e| e.to_string())?;
        io::copy(&mut library_entry, &mut out).map_err(|e| e.to_string())?;
    }

    if let Some(parent) = analysis_destination_sqlite.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    {
        let mut analysis_entry = archive.by_index(analysis_target_index).map_err(|e| e.to_string())?;
        let mut analysis_out = fs::File::create(analysis_destination_sqlite).map_err(|e| e.to_string())?;
        io::copy(&mut analysis_entry, &mut analysis_out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_full_archive(
    source_archive: &Path,
    library_destination_sqlite: &Path,
    analysis_destination_sqlite: &Path,
) -> Result<FullBackupPayload, String> {
    let file = fs::File::open(source_archive).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;

    let payload = {
        let mut entry = archive
            .by_name(FULL_ARCHIVE_SETTINGS_ENTRY)
            .map_err(|_| "archive does not contain settings.json".to_string())?;
        let mut buf = Vec::new();
        io::copy(&mut entry, &mut buf).map_err(|e| e.to_string())?;
        serde_json::from_slice::<FullBackupPayload>(&buf).map_err(|e| e.to_string())?
    };
    if payload.version != FULL_ARCHIVE_VERSION {
        return Err("unsupported full backup version".to_string());
    }

    extract_databases_archive(
        source_archive,
        library_destination_sqlite,
        analysis_destination_sqlite,
    )?;
    Ok(payload)
}

fn validate_sqlite_file(path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if integrity != "ok" {
        return Err("backup file integrity check failed".to_string());
    }
    Ok(())
}

fn library_health_check(active_path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(active_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM track", [], |_row| Ok(()))
        .map_err(|e| e.to_string())
}

fn analysis_health_check(active_path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(active_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM analysis_track", [], |_row| Ok(()))
        .map_err(|e| e.to_string())
}

fn import_databases_from_sqlite(
    app: &AppHandle,
    import_library_tmp: &Path,
    import_analysis_tmp: &Path,
) -> Result<(), String> {
    let active_path = library_db_path(app)?;
    let analysis_active_path = analysis_db_path(app)?;
    let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() else {
        remove_db_with_sidecars(import_library_tmp).ok();
        remove_db_with_sidecars(import_analysis_tmp).ok();
        return Err("library runtime unavailable".to_string());
    };
    let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() else {
        remove_db_with_sidecars(import_library_tmp).ok();
        remove_db_with_sidecars(import_analysis_tmp).ok();
        return Err("analysis runtime unavailable".to_string());
    };

    let library_backup = runtime
        .store
        .swap_database_file(&active_path, import_library_tmp)?
        .ok_or_else(|| "import switch failed".to_string())?;
    let analysis_backup = match cache.swap_database_file(&analysis_active_path, import_analysis_tmp) {
        Ok(Some(backup)) => backup,
        Ok(None) => {
            let _ = runtime.store.restore_database_backup(&library_backup, &active_path);
            let _ = remove_db_with_sidecars(&library_backup);
            let _ = remove_db_with_sidecars(import_library_tmp);
            let _ = remove_db_with_sidecars(import_analysis_tmp);
            return Err("analysis import switch failed".to_string());
        }
        Err(err) => {
            let _ = runtime.store.restore_database_backup(&library_backup, &active_path);
            let _ = remove_db_with_sidecars(&library_backup);
            let _ = remove_db_with_sidecars(import_library_tmp);
            let _ = remove_db_with_sidecars(import_analysis_tmp);
            return Err(err);
        }
    };

    if let Err(err) = library_health_check(&active_path)
        .and_then(|_| analysis_health_check(&analysis_active_path))
    {
        let _ = runtime.store.restore_database_backup(&library_backup, &active_path);
        let _ = cache.restore_database_backup(&analysis_backup, &analysis_active_path);
        let _ = remove_db_with_sidecars(&library_backup);
        let _ = remove_db_with_sidecars(&analysis_backup);
        let _ = remove_db_with_sidecars(import_library_tmp);
        let _ = remove_db_with_sidecars(import_analysis_tmp);
        return Err(err);
    }

    let library_bak_path = active_path.with_file_name("library.sqlite.import.bak");
    remove_db_with_sidecars(&library_bak_path).ok();
    if library_backup.exists() {
        fs::rename(&library_backup, &library_bak_path).map_err(|e| e.to_string())?;
        move_sidecar(&library_backup, &library_bak_path, "-wal")?;
        move_sidecar(&library_backup, &library_bak_path, "-shm")?;
    }

    let analysis_bak_path = analysis_active_path.with_file_name("audio-analysis.sqlite.import.bak");
    remove_db_with_sidecars(&analysis_bak_path).ok();
    if analysis_backup.exists() {
        fs::rename(&analysis_backup, &analysis_bak_path).map_err(|e| e.to_string())?;
        move_sidecar(&analysis_backup, &analysis_bak_path, "-wal")?;
        move_sidecar(&analysis_backup, &analysis_bak_path, "-shm")?;
    }

    remove_db_with_sidecars(import_library_tmp).ok();
    remove_db_with_sidecars(import_analysis_tmp).ok();
    Ok(())
}

fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    remove_if_exists(path)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.to_string_lossy(), suffix));
        remove_if_exists(&sidecar)?;
    }
    Ok(())
}

fn move_sidecar(from_base: &Path, to_base: &Path, suffix: &str) -> Result<(), String> {
    let from = PathBuf::from(format!("{}{}", from_base.display(), suffix));
    if !from.exists() {
        return Ok(());
    }
    let to = PathBuf::from(format!("{}{}", to_base.display(), suffix));
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

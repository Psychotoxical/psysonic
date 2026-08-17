use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

pub(super) fn library_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("databases").join("library");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.sqlite"))
}

pub(super) fn analysis_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("databases").join("analysis");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("audio-analysis.sqlite"))
}

pub(super) fn vacuum_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    let escaped = destination.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{escaped}';");
    conn.execute_batch(&sql).map_err(|e| e.to_string())
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

fn migration_head(path: &Path, database_name: &str) -> Result<i64, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("{database_name} database open failed: {e}"))?;
    conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
        row.get::<_, Option<i64>>(0)
    })
    .map_err(|e| format!("{database_name} migration history unavailable: {e}"))?
    .ok_or_else(|| format!("{database_name} migration history is empty"))
}

pub(super) fn validate_import_database(
    path: &Path,
    database_name: &str,
    minimum_compatible_version: i64,
    current_version: i64,
) -> Result<(), String> {
    validate_sqlite_file(path)?;
    let head = migration_head(path, database_name)?;
    if head < minimum_compatible_version {
        return Err(format!(
            "{database_name} backup schema {head} is older than minimum compatible schema {minimum_compatible_version}"
        ));
    }
    if head > current_version {
        return Err(format!(
            "{database_name} backup schema {head} is newer than supported schema {current_version}"
        ));
    }
    Ok(())
}

pub(super) fn import_databases_from_sqlite(
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
    let analysis_backup = match cache.swap_database_file(&analysis_active_path, import_analysis_tmp)
    {
        Ok(Some(backup)) => backup,
        Ok(None) => {
            rollback_after_analysis_switch_failure(
                &runtime,
                &cache,
                &library_backup,
                &active_path,
            )?;
            let _ = remove_db_with_sidecars(&library_backup);
            let _ = remove_db_with_sidecars(import_library_tmp);
            let _ = remove_db_with_sidecars(import_analysis_tmp);
            return Err("analysis import switch failed".to_string());
        }
        Err(err) => {
            rollback_after_analysis_switch_failure(
                &runtime,
                &cache,
                &library_backup,
                &active_path,
            )?;
            let _ = remove_db_with_sidecars(&library_backup);
            let _ = remove_db_with_sidecars(import_library_tmp);
            let _ = remove_db_with_sidecars(import_analysis_tmp);
            return Err(err);
        }
    };

    let reopened_health = runtime
        .store
        .verify_operational_schema()
        .and_then(|_| cache.verify_operational_schema());
    if let Err(err) = reopened_health {
        let _ = runtime
            .store
            .restore_database_backup(&library_backup, &active_path);
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

fn rollback_after_analysis_switch_failure(
    runtime: &psysonic_library::LibraryRuntime,
    cache: &psysonic_analysis::analysis_cache::AnalysisCache,
    library_backup: &Path,
    active_library: &Path,
) -> Result<(), String> {
    let library_result = runtime
        .store
        .restore_database_backup(library_backup, active_library)
        .and_then(|_| runtime.store.verify_operational_schema());
    let analysis_result = cache
        .verify_operational_schema()
        .map_err(|error| format!("analysis rollback after switch failed: {error}"));
    match (library_result, analysis_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(library_error), Ok(())) => Err(format!(
            "library rollback after analysis switch failed: {library_error}"
        )),
        (Ok(()), Err(analysis_error)) => Err(analysis_error),
        (Err(library_error), Err(analysis_error)) => Err(format!(
            "library rollback after analysis switch failed: {library_error}; {analysis_error}"
        )),
    }
}

pub(super) fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
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

pub(super) fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;

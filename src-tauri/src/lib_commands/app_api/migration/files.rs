use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use tauri::{AppHandle, Manager};

pub(super) struct MigrationPaths {
    pub(super) library_active: PathBuf,
    pub(super) library_v2: PathBuf,
    pub(super) analysis_active: PathBuf,
    pub(super) analysis_v2: PathBuf,
}

pub(super) fn open_readonly(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())
}

pub(super) fn vacuum_copy(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(source).map_err(|e| e.to_string())?;
    let sql = format!(
        "VACUUM INTO '{}';",
        destination.to_string_lossy().replace('\'', "''")
    );
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

pub(super) fn switch_file(active: &Path, destination: &Path) -> Result<PathBuf, String> {
    let backup = active.with_file_name(format!(
        "{}.backup-pre-indexkey",
        active
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("db.sqlite")
    ));
    remove_db_with_sidecars(&backup).ok();
    let mut active_backed_up = false;
    if active.exists() {
        fs::rename(active, &backup).map_err(|e| e.to_string())?;
        active_backed_up = true;
    }
    if let Err(error) = fs::rename(destination, active) {
        if active_backed_up {
            fs::rename(&backup, active).map_err(|rollback| {
                format!("database switch failed: {error}; rollback failed: {rollback}")
            })?;
        }
        return Err(error.to_string());
    }
    Ok(backup)
}

pub(super) fn restore_backup(backup: &Path, active: &Path) -> Result<(), String> {
    if active.exists() {
        fs::remove_file(active).map_err(|e| e.to_string())?;
    }
    if backup.exists() {
        fs::rename(backup, active).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn health_check(
    app: &AppHandle,
    library_active: &Path,
    analysis_active: &Path,
) -> Result<(), String> {
    if library_active.exists() {
        if let Some(runtime) = app.try_state::<psysonic_library::LibraryRuntime>() {
            runtime.store.verify_operational_schema()?;
        } else {
            let conn = open_readonly(library_active)?;
            conn.query_row("SELECT COUNT(*) FROM track", [], |_row| Ok(()))
                .map_err(|e| e.to_string())?;
        }
    }
    if analysis_active.exists() {
        if let Some(cache) = app.try_state::<psysonic_analysis::analysis_cache::AnalysisCache>() {
            cache.verify_operational_schema()?;
        } else {
            let conn = open_readonly(analysis_active)?;
            conn.query_row("SELECT COUNT(*) FROM analysis_track", [], |_row| Ok(()))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    remove_if_exists(path)?;
    let wal = PathBuf::from(format!("{}-wal", path.to_string_lossy()));
    let shm = PathBuf::from(format!("{}-shm", path.to_string_lossy()));
    remove_if_exists(&wal)?;
    remove_if_exists(&shm)?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn migration_paths(app: &AppHandle) -> Result<MigrationPaths, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let library_dir = base.join("databases").join("library");
    let analysis_dir = base.join("databases").join("analysis");
    fs::create_dir_all(&library_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&analysis_dir).map_err(|e| e.to_string())?;
    Ok(MigrationPaths {
        library_active: library_dir.join("library.sqlite"),
        library_v2: library_dir.join("library-v2.sqlite"),
        analysis_active: analysis_dir.join("audio-analysis.sqlite"),
        analysis_v2: analysis_dir.join("analysis-v2.sqlite"),
    })
}

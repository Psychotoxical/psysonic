use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::Manager;

pub(super) fn library_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_dir = base.join("databases").join("library");
    let db_path = db_dir.join("library.sqlite");
    let legacy = base.join("library.sqlite");
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if db_path.exists() {
        cleanup_legacy_db_if_present(&legacy, &db_path)?;
        return Ok(db_path);
    }

    if legacy.exists() {
        migrate_db_file(&legacy, &db_path).map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy, &db_path, "-wal").map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy, &db_path, "-shm").map_err(|e| e.to_string())?;
    }
    cleanup_legacy_db_if_present(&legacy, &db_path)?;

    Ok(db_path)
}

fn cleanup_legacy_db_if_present(legacy_path: &Path, active_path: &Path) -> Result<(), String> {
    if legacy_path == active_path {
        return Ok(());
    }
    remove_db_with_sidecars(legacy_path)
}

fn migrate_db_file(from: &Path, to: &Path) -> io::Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(from, to)?;
            fs::remove_file(from)?;
            Ok(())
        }
    }
}

fn migrate_db_sidecar(from: &Path, to: &Path, suffix: &str) -> io::Result<()> {
    let from_path = PathBuf::from(format!("{}{}", from.display(), suffix));
    if !from_path.exists() {
        return Ok(());
    }
    let to_path = PathBuf::from(format!("{}{}", to.display(), suffix));
    if let Some(parent) = to_path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(&from_path, &to_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(&from_path, &to_path)?;
            fs::remove_file(&from_path)?;
            Ok(())
        }
    }
}

pub(super) fn move_sidecar(from_base: &Path, to_base: &Path, suffix: &str) -> Result<(), String> {
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

pub(super) fn remove_db_with_sidecars(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = PathBuf::from(format!("{}{}", path.display(), suffix));
        if sidecar.exists() {
            fs::remove_file(sidecar).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

use std::io;
use std::path::{Path, PathBuf};
use std::{fs, mem};

use rusqlite::Connection;
use tauri::Manager;

use super::migrations::{backup_before_pending_migration, run_migrations};
use super::schema::verify_operational_schema_conn;
use super::AnalysisCache;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SwapDatabaseStage {
    BackupActive,
    ActivateDestination,
    Open,
    Configure,
    Migrate,
}

impl AnalysisCache {
    pub fn init<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Self, String> {
        let db_path = analysis_db_path(app)?;
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        backup_before_pending_migration(&db_path)?;
        let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        configure_connection(&conn).map_err(|e| e.to_string())?;
        run_migrations(&mut conn).map_err(|e| e.to_string())?;
        verify_operational_schema_conn(&conn)?;
        checkpoint_wal_conn(&conn, "open").map_err(|e| e.to_string())?;
        Ok(Self {
            conn: std::sync::Mutex::new(conn),
        })
    }

    /// Builds an in-memory SQLite database with the production schema applied.
    /// Intended for tests in this crate and any downstream crate that needs an
    /// `AnalysisCache` without an `AppHandle`. WAL pragma is skipped — `:memory:`
    /// databases don't support journal-mode changes; the test surface doesn't
    /// need durability.
    ///
    /// Lives outside `#[cfg(test)]` so cross-crate test harnesses can call it
    /// without a `test-support` Cargo feature dance. Production code does not
    /// use it.
    pub fn open_in_memory() -> Self {
        let mut conn = Connection::open_in_memory().expect("in-memory connection");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("pragma foreign_keys");
        run_migrations(&mut conn).expect("schema migration");
        verify_operational_schema_conn(&conn).expect("operational schema");
        let _ = checkpoint_wal_conn(&conn, "open");
        Self {
            conn: std::sync::Mutex::new(conn),
        }
    }

    pub fn checkpoint_wal(&self, op: &'static str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        checkpoint_wal_conn(&conn, op).map_err(|e| e.to_string())
    }

    /// Atomically switch analysis sqlite file while replacing the held
    /// connection so runtime writers cannot continue on the old inode.
    pub fn swap_database_file(
        &self,
        active_path: &Path,
        destination_path: &Path,
    ) -> Result<Option<PathBuf>, String> {
        self.swap_database_file_with(active_path, destination_path, |_| Ok(()))
    }

    pub(super) fn swap_database_file_with(
        &self,
        active_path: &Path,
        destination_path: &Path,
        mut before_stage: impl FnMut(SwapDatabaseStage) -> Result<(), String>,
    ) -> Result<Option<PathBuf>, String> {
        if !destination_path.exists() {
            return Ok(None);
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        checkpoint_wal_conn(&conn, "pre-swap").map_err(|e| e.to_string())?;
        let old_conn = mem::replace(&mut *conn, tmp);
        drop(old_conn);

        let backup = active_path.with_file_name(format!(
            "{}.backup-pre-indexkey",
            active_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("audio-analysis.sqlite")
        ));
        let mut active_backed_up = false;
        let mut destination_activated = false;
        let swap_result = (|| {
            remove_db_with_sidecars(&backup)?;
            if active_path.exists() {
                before_stage(SwapDatabaseStage::BackupActive)?;
                fs::rename(active_path, &backup).map_err(|e| e.to_string())?;
                active_backed_up = true;
                move_sidecar(active_path, &backup, "-wal")?;
                move_sidecar(active_path, &backup, "-shm")?;
            }
            before_stage(SwapDatabaseStage::ActivateDestination)?;
            fs::rename(destination_path, active_path).map_err(|e| e.to_string())?;
            destination_activated = true;
            move_sidecar(destination_path, active_path, "-wal")?;
            move_sidecar(destination_path, active_path, "-shm")?;

            before_stage(SwapDatabaseStage::Open)?;
            let mut reopened = Connection::open(active_path).map_err(|e| e.to_string())?;
            before_stage(SwapDatabaseStage::Configure)?;
            configure_connection(&reopened).map_err(|e| e.to_string())?;
            before_stage(SwapDatabaseStage::Migrate)?;
            run_migrations(&mut reopened).map_err(|e| e.to_string())?;
            verify_operational_schema_conn(&reopened)?;
            checkpoint_wal_conn(&reopened, "swap").map_err(|e| e.to_string())?;
            Ok(reopened)
        })();

        match swap_result {
            Ok(reopened) => {
                *conn = reopened;
                Ok(Some(backup))
            }
            Err(error) => match recover_failed_swap(
                active_path,
                destination_path,
                &backup,
                active_backed_up,
                destination_activated,
            ) {
                Ok(reopened) => {
                    *conn = reopened;
                    Err(error)
                }
                Err(rollback_error) => Err(format!(
                    "analysis database swap failed: {error}; rollback failed: {rollback_error}"
                )),
            },
        }
    }

    pub fn restore_database_backup(
        &self,
        backup_path: &Path,
        active_path: &Path,
    ) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "analysis_cache lock poisoned".to_string())?;
        let tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_conn = mem::replace(&mut *conn, tmp);
        drop(old_conn);

        if active_path.exists() {
            remove_db_with_sidecars(active_path)?;
        }
        if backup_path.exists() {
            fs::rename(backup_path, active_path).map_err(|e| e.to_string())?;
            move_sidecar(backup_path, active_path, "-wal")?;
            move_sidecar(backup_path, active_path, "-shm")?;
        }
        let mut reopened = Connection::open(active_path).map_err(|e| e.to_string())?;
        configure_connection(&reopened).map_err(|e| e.to_string())?;
        run_migrations(&mut reopened).map_err(|e| e.to_string())?;
        verify_operational_schema_conn(&reopened)?;
        *conn = reopened;
        Ok(())
    }
}

fn analysis_db_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_dir = base.join("databases").join("analysis");
    let db_path = db_dir.join("audio-analysis.sqlite");
    let legacy_data = base.join("audio-analysis.sqlite");
    let legacy_config = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("audio-analysis.sqlite");
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if db_path.exists() {
        cleanup_legacy_db_if_present(&legacy_data, &db_path)?;
        cleanup_legacy_db_if_present(&legacy_config, &db_path)?;
        return Ok(db_path);
    }

    if legacy_data.exists() {
        migrate_db_file(&legacy_data, &db_path).map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_data, &db_path, "-wal").map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_data, &db_path, "-shm").map_err(|e| e.to_string())?;
    } else if legacy_config.exists() {
        migrate_db_file(&legacy_config, &db_path).map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_config, &db_path, "-wal").map_err(|e| e.to_string())?;
        migrate_db_sidecar(&legacy_config, &db_path, "-shm").map_err(|e| e.to_string())?;
    }
    cleanup_legacy_db_if_present(&legacy_data, &db_path)?;
    cleanup_legacy_db_if_present(&legacy_config, &db_path)?;

    Ok(db_path)
}

pub(super) fn cleanup_legacy_db_if_present(
    legacy_path: &Path,
    active_path: &Path,
) -> Result<(), String> {
    if legacy_path == active_path {
        return Ok(());
    }
    remove_db_with_sidecars(legacy_path)
}

pub(super) fn checkpoint_wal_conn(conn: &Connection, op: &str) -> rusqlite::Result<()> {
    let (busy, log, checkpointed): (i32, i32, i32) =
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    if busy != 0 {
        crate::app_eprintln!(
            "[analysis-db] wal checkpoint busy op={op} busy={busy} log={log} checkpointed={checkpointed}"
        );
    }
    Ok(())
}

pub(super) fn migrate_db_file(from: &Path, to: &Path) -> io::Result<()> {
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

pub(super) fn migrate_db_sidecar(from: &Path, to: &Path, suffix: &str) -> io::Result<()> {
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

fn recover_failed_swap(
    active_path: &Path,
    destination_path: &Path,
    backup_path: &Path,
    active_backed_up: bool,
    destination_activated: bool,
) -> Result<Connection, String> {
    if destination_activated && active_path.exists() {
        let _ = remove_db_with_sidecars(destination_path);
        if fs::rename(active_path, destination_path).is_ok() {
            let _ = move_sidecar(active_path, destination_path, "-wal");
            let _ = move_sidecar(active_path, destination_path, "-shm");
        } else {
            let _ = remove_db_with_sidecars(active_path);
        }
    }
    if active_backed_up {
        remove_db_with_sidecars(active_path)?;
        fs::rename(backup_path, active_path).map_err(|e| e.to_string())?;
        move_sidecar(backup_path, active_path, "-wal")?;
        move_sidecar(backup_path, active_path, "-shm")?;
    }

    let mut reopened = Connection::open(active_path).map_err(|e| e.to_string())?;
    configure_connection(&reopened).map_err(|e| e.to_string())?;
    run_migrations(&mut reopened).map_err(|e| e.to_string())?;
    verify_operational_schema_conn(&reopened)?;
    checkpoint_wal_conn(&reopened, "swap-rollback").map_err(|e| e.to_string())?;
    Ok(reopened)
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

pub(super) fn configure_connection(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

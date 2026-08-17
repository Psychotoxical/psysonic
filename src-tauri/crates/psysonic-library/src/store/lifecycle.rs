use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use rusqlite::Connection;

use super::filesystem::{move_sidecar, remove_db_with_sidecars};
use super::open::open_database_connections;
use super::LibraryStore;

impl LibraryStore {
    /// Atomically switch the active sqlite file while replacing long-lived
    /// write/read connections. Other threads see `library database swap in
    /// progress` while the file is offline instead of touching placeholder DBs.
    pub fn swap_database_file(
        &self,
        active_path: &Path,
        destination_path: &Path,
    ) -> Result<Option<PathBuf>, String> {
        if !destination_path.exists() {
            return Ok(None);
        }

        let mut swap_guard = SwapInProgressGuard::new(self);
        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database swap".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database swap".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database swap".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database swap".to_string()
        })?;

        let write_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let mainstage_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let scope_detail_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_write = std::mem::replace(&mut *write_conn, write_tmp);
        let old_read = std::mem::replace(&mut *read_conn, read_tmp);
        let old_mainstage_read = std::mem::replace(&mut *mainstage_read_conn, mainstage_read_tmp);
        let old_scope_detail_read =
            std::mem::replace(&mut *scope_detail_read_conn, scope_detail_read_tmp);
        drop(old_write);
        drop(old_read);
        drop(old_mainstage_read);
        drop(old_scope_detail_read);

        let backup = active_path.with_file_name(format!(
            "{}.backup-pre-indexkey",
            active_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("library.sqlite")
        ));
        remove_db_with_sidecars(&backup).ok();
        if active_path.exists() {
            fs::rename(active_path, &backup).map_err(|e| e.to_string())?;
            move_sidecar(active_path, &backup, "-wal")?;
            move_sidecar(active_path, &backup, "-shm")?;
        }
        if let Err(err) = fs::rename(destination_path, active_path) {
            if backup.exists() {
                let _ = fs::rename(&backup, active_path);
                let _ = move_sidecar(&backup, active_path, "-wal");
                let _ = move_sidecar(&backup, active_path, "-shm");
            }
            drop(read_conn);
            drop(mainstage_read_conn);
            drop(scope_detail_read_conn);
            drop(write_conn);
            let (
                reopened_write,
                reopened_read,
                reopened_mainstage_read,
                reopened_scope_detail_read,
            ) = open_database_connections(active_path)
                .map_err(|e| format!("library swap reopen failed after rename error: {e}"))?;
            let mut write_conn = self.write_conn.lock().map_err(|_| {
                "library store write lock poisoned during database swap".to_string()
            })?;
            let mut read_conn = self
                .read_conn
                .lock()
                .map_err(|_| "library store read lock poisoned during database swap".to_string())?;
            let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
                "library store mainstage read lock poisoned during database swap".to_string()
            })?;
            let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
                "library store scope detail read lock poisoned during database swap".to_string()
            })?;
            *write_conn = reopened_write;
            *read_conn = reopened_read;
            *mainstage_read_conn = reopened_mainstage_read;
            *scope_detail_read_conn = reopened_scope_detail_read;
            swap_guard.release();
            return Err(err.to_string());
        }

        drop(read_conn);
        drop(mainstage_read_conn);
        drop(scope_detail_read_conn);
        drop(write_conn);

        // The freshly-installed library file has different track ids; the
        // fixed-name identity sidecar in this dir is now stale (its norm_version
        // + key count still satisfy the rebuild gate, so nothing else triggers a
        // rebuild). Delete it so the reopen recreates it empty and keys rebuild
        // lazily against the new content.
        crate::identity::remove_cluster_files_for_library(active_path);

        let reopen = open_database_connections(active_path);

        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database swap".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database swap".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database swap".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database swap".to_string()
        })?;

        match reopen {
            Ok((
                reopened_write,
                reopened_read,
                reopened_mainstage_read,
                reopened_scope_detail_read,
            )) => {
                *write_conn = reopened_write;
                *read_conn = reopened_read;
                *mainstage_read_conn = reopened_mainstage_read;
                *scope_detail_read_conn = reopened_scope_detail_read;
                swap_guard.release();
                Ok(Some(backup))
            }
            Err(open_err) => {
                if backup.exists() {
                    if active_path.exists() {
                        remove_db_with_sidecars(active_path).ok();
                    }
                    let _ = fs::rename(&backup, active_path);
                    let _ = move_sidecar(&backup, active_path, "-wal");
                    let _ = move_sidecar(&backup, active_path, "-shm");
                }
                let (
                    reopened_write,
                    reopened_read,
                    reopened_mainstage_read,
                    reopened_scope_detail_read,
                ) = open_database_connections(active_path)
                    .map_err(|e| format!("library swap reopen failed after revert: {e}"))?;
                *write_conn = reopened_write;
                *read_conn = reopened_read;
                *mainstage_read_conn = reopened_mainstage_read;
                *scope_detail_read_conn = reopened_scope_detail_read;
                swap_guard.release();
                Err(format!("library swap failed: {open_err}"))
            }
        }
    }

    pub fn restore_database_backup(
        &self,
        backup_path: &Path,
        active_path: &Path,
    ) -> Result<(), String> {
        let mut swap_guard = SwapInProgressGuard::new(self);
        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database restore".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database restore".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database restore".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database restore".to_string()
        })?;

        let write_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let mainstage_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let scope_detail_read_tmp = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let old_write = std::mem::replace(&mut *write_conn, write_tmp);
        let old_read = std::mem::replace(&mut *read_conn, read_tmp);
        let old_mainstage_read = std::mem::replace(&mut *mainstage_read_conn, mainstage_read_tmp);
        let old_scope_detail_read =
            std::mem::replace(&mut *scope_detail_read_conn, scope_detail_read_tmp);
        drop(old_write);
        drop(old_read);
        drop(old_mainstage_read);
        drop(old_scope_detail_read);

        if active_path.exists() {
            remove_db_with_sidecars(active_path)?;
        }
        if backup_path.exists() {
            fs::rename(backup_path, active_path).map_err(|e| e.to_string())?;
            move_sidecar(backup_path, active_path, "-wal")?;
            move_sidecar(backup_path, active_path, "-shm")?;
        }

        drop(read_conn);
        drop(mainstage_read_conn);
        drop(scope_detail_read_conn);
        drop(write_conn);

        // Restored library file → the fixed-name identity sidecar is stale; drop
        // it so keys rebuild lazily against the restored content (see swap).
        crate::identity::remove_cluster_files_for_library(active_path);

        let (reopened_write, reopened_read, reopened_mainstage_read, reopened_scope_detail_read) =
            open_database_connections(active_path).map_err(|e| e.to_string())?;

        let mut write_conn = self
            .write_conn
            .lock()
            .map_err(|_| "library store write lock poisoned during database restore".to_string())?;
        let mut read_conn = self
            .read_conn
            .lock()
            .map_err(|_| "library store read lock poisoned during database restore".to_string())?;
        let mut mainstage_read_conn = self.mainstage_read_conn.lock().map_err(|_| {
            "library store mainstage read lock poisoned during database restore".to_string()
        })?;
        let mut scope_detail_read_conn = self.scope_detail_read_conn.lock().map_err(|_| {
            "library store scope detail read lock poisoned during database restore".to_string()
        })?;
        *write_conn = reopened_write;
        *read_conn = reopened_read;
        *mainstage_read_conn = reopened_mainstage_read;
        *scope_detail_read_conn = reopened_scope_detail_read;
        swap_guard.release();
        Ok(())
    }
}

struct SwapInProgressGuard<'a> {
    store: &'a LibraryStore,
    released: bool,
}

impl<'a> SwapInProgressGuard<'a> {
    fn new(store: &'a LibraryStore) -> Self {
        store.swap_in_progress.store(true, Ordering::Release);
        Self {
            store,
            released: false,
        }
    }

    fn release(&mut self) {
        if !self.released {
            self.store.swap_in_progress.store(false, Ordering::Release);
            self.released = true;
        }
    }
}

impl Drop for SwapInProgressGuard<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

mod capability;
mod cursor_state;
mod phase;
mod scheduling;
mod watermark_count;

#[cfg(test)]
mod tests;

use rusqlite::params;

use crate::store::LibraryStore;

/// Repository over the `sync_state` row identified by `(server_id, library_scope)`.
/// PR-1b exposes just enough of the row to drive resumable initial sync — the
/// orchestrator-side helpers (poll stats, phase transitions, …) land with
/// PR-3 when there's actual sync code to consume them.
pub struct SyncStateRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> SyncStateRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Read-only queries — must not take the write mutex (ingest holds it for
    /// long stretches during IS-3).
    fn read<R>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<R>,
    ) -> Result<R, String> {
        self.store.with_read_conn(f)
    }

    /// Insert a default-valued row for this `(server_id, library_scope)` pair
    /// if none exists. All non-PK columns fall back to their schema DEFAULTs
    /// (`sync_phase='idle'`, `initial_sync_cursor_json='{}'`, …).
    pub fn ensure(&self, server_id: &str, library_scope: &str) -> Result<(), String> {
        self.store.with_conn("sync_state.ensure", |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO sync_state (server_id, library_scope) VALUES (?1, ?2)",
                params![server_id, library_scope],
            )?;
            Ok(())
        })
    }
}

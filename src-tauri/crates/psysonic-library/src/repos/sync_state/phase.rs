use rusqlite::{params, OptionalExtension};

use super::SyncStateRepository;

impl<'a> SyncStateRepository<'a> {
    /// Read `sync_phase` (state-machine values per spec §6.2:
    /// `idle` / `probing` / `initial_sync` / `ready` / `error`).
    /// Returns `None` when the row doesn't exist; SQL DEFAULT is
    /// `'idle'` so a freshly-ensured row reads back as `Some("idle")`.
    pub fn get_sync_phase(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<String>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT sync_phase FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
    }

    /// Write `sync_phase`. Upsert scoped to that one column.
    pub fn set_sync_phase(
        &self,
        server_id: &str,
        library_scope: &str,
        phase: &str,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_sync_phase", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, sync_phase) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   sync_phase = excluded.sync_phase",
                params![server_id, library_scope, phase],
            )?;
            Ok(())
        })
    }

    /// Change `sync_phase` only when it still matches `expected_phase`.
    /// Returns `false` when another writer advanced the state first.
    pub(crate) fn set_sync_phase_if(
        &self,
        server_id: &str,
        library_scope: &str,
        expected_phase: &str,
        phase: &str,
    ) -> Result<bool, String> {
        self.store
            .with_conn("sync_state.set_sync_phase_if", |conn| {
                let changed = conn.execute(
                    "UPDATE sync_state SET sync_phase = ?3 \
                 WHERE server_id = ?1 AND library_scope = ?2 AND sync_phase = ?4",
                    params![server_id, library_scope, phase, expected_phase],
                )?;
                Ok(changed == 1)
            })
    }
}

use rusqlite::{params, OptionalExtension};

use super::SyncStateRepository;

impl<'a> SyncStateRepository<'a> {
    /// Read `capability_flags` (spec §6.1.1). Returns `None` when the
    /// row doesn't exist; SQL DEFAULT is 0 so a freshly-ensured row
    /// reads back as `Some(0)`.
    pub fn get_capability_flags(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<u32>, String> {
        let raw: Option<i64> = self.read(|conn| {
            conn.query_row(
                "SELECT capability_flags FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get(0),
            )
            .optional()
        })?;
        Ok(raw.map(|v| v.max(0) as u32))
    }

    /// Write `capability_flags`. Upsert scoped to that one column.
    pub fn set_capability_flags(
        &self,
        server_id: &str,
        library_scope: &str,
        flags: u32,
    ) -> Result<(), String> {
        self.store
            .with_conn("sync_state.set_capability_flags", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, capability_flags) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   capability_flags = excluded.capability_flags",
                    params![server_id, library_scope, flags as i64],
                )?;
                Ok(())
            })
    }

    /// Read `n1_bulk_unreliable` — per-server learned flag (R7-15). When
    /// set, the strategy selector stops choosing N1 for this server (the
    /// native `/api/song` endpoint 500'd beyond a deep offset). Returns
    /// `None` when the row doesn't exist; SQL DEFAULT is 0 so a
    /// freshly-ensured row reads back as `Some(false)`.
    pub fn get_n1_bulk_unreliable(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<bool>, String> {
        let raw: Option<i64> = self.read(|conn| {
            conn.query_row(
                "SELECT n1_bulk_unreliable FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get(0),
            )
            .optional()
        })?;
        Ok(raw.map(|v| v != 0))
    }

    /// Write `n1_bulk_unreliable`. Upsert scoped to that one column.
    pub fn set_n1_bulk_unreliable(
        &self,
        server_id: &str,
        library_scope: &str,
        unreliable: bool,
    ) -> Result<(), String> {
        self.store
            .with_conn("sync_state.set_n1_bulk_unreliable", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, n1_bulk_unreliable) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   n1_bulk_unreliable = excluded.n1_bulk_unreliable",
                    params![server_id, library_scope, unreliable as i64],
                )?;
                Ok(())
            })
    }
}

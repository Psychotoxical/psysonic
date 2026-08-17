use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::SyncStateRepository;

impl<'a> SyncStateRepository<'a> {
    /// Read `library_tier`. Returns `None` when row missing. DS-0
    /// picks between `getArtists` (small/medium) and `getScanStatus`
    /// (huge) based on this.
    pub fn get_library_tier(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<String>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT library_tier FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
    }

    /// Write `library_tier` (spec §6.2.2 — `small` / `medium` / `huge`
    /// / `unknown`). Drives the adaptive poll interval; PR-3d wires
    /// the EWMA loop that picks this.
    pub fn set_library_tier(
        &self,
        server_id: &str,
        library_scope: &str,
        tier: &str,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_library_tier", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, library_tier) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   library_tier = excluded.library_tier",
                params![server_id, library_scope, tier],
            )?;
            Ok(())
        })
    }

    /// Read `next_poll_at` — epoch ms scheduling target. `None` when
    /// the row is missing or the column is `NULL` (no schedule yet).
    pub fn get_next_poll_at(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<i64>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT next_poll_at FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
        })
        .map(|opt| opt.flatten())
    }

    /// Write `next_poll_at`. Upsert scoped to that one column.
    pub fn set_next_poll_at(
        &self,
        server_id: &str,
        library_scope: &str,
        epoch_ms: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_next_poll_at", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, next_poll_at) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   next_poll_at = excluded.next_poll_at",
                params![server_id, library_scope, epoch_ms],
            )?;
            Ok(())
        })
    }

    /// Read `poll_stats_json`. Returns `Some(Value)` for an existing
    /// row (SQL DEFAULT is `'{}'`, so a freshly-ensured row reads
    /// back as `Some(Object({}))`), `None` when the row is absent.
    pub fn get_poll_stats_json(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<Value>, String> {
        let raw: Option<String> = self.read(|conn| {
            conn.query_row(
                "SELECT poll_stats_json FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get(0),
            )
            .optional()
        })?;
        match raw {
            None => Ok(None),
            Some(s) => serde_json::from_str(&s)
                .map(Some)
                .map_err(|e| format!("invalid poll_stats_json: {e}")),
        }
    }

    /// Write `poll_stats_json`. Upsert scoped to that one column.
    pub fn set_poll_stats_json(
        &self,
        server_id: &str,
        library_scope: &str,
        stats: &Value,
    ) -> Result<(), String> {
        let json = serde_json::to_string(stats).map_err(|e| e.to_string())?;
        self.store
            .with_conn("sync_state.set_poll_stats_json", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, poll_stats_json) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   poll_stats_json = excluded.poll_stats_json",
                    params![server_id, library_scope, json],
                )?;
                Ok(())
            })
    }
}

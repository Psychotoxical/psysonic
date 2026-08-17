use rusqlite::{params, OptionalExtension};
use serde_json::Value;

use super::SyncStateRepository;

impl<'a> SyncStateRepository<'a> {
    /// Read `initial_sync_cursor_json`. Returns `None` when the row doesn't
    /// exist yet, `Some(Value)` otherwise (the schema DEFAULT is `'{}'`, so
    /// a freshly-ensured row reads back as `Some(Object({}))`).
    pub fn get_initial_sync_cursor(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<Value>, String> {
        let raw: Option<String> = self.read(|conn| {
            conn.query_row(
                "SELECT initial_sync_cursor_json FROM sync_state \
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
                .map_err(|e| format!("invalid initial_sync_cursor_json: {e}")),
        }
    }

    /// Write `initial_sync_cursor_json`. Creates the row if needed; only the
    /// cursor column is touched, all other columns keep their current values
    /// (or their DEFAULTs on first insert).
    pub fn set_initial_sync_cursor(
        &self,
        server_id: &str,
        library_scope: &str,
        cursor: &Value,
    ) -> Result<(), String> {
        let json = serde_json::to_string(cursor).map_err(|e| e.to_string())?;
        self.store
            .with_conn("sync_state.set_initial_sync_cursor", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, initial_sync_cursor_json) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   initial_sync_cursor_json = excluded.initial_sync_cursor_json",
                    params![server_id, library_scope, json],
                )?;
                Ok(())
            })
    }

    /// Single write-lock acquisition for cursor + local count during ingest.
    pub fn set_initial_sync_cursor_and_local_track_count(
        &self,
        server_id: &str,
        library_scope: &str,
        cursor: &Value,
        local_track_count: i64,
    ) -> Result<(), String> {
        let json = serde_json::to_string(cursor).map_err(|e| e.to_string())?;
        self.store.with_conn("sync_state.persist_cursor", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, initial_sync_cursor_json, local_track_count) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   initial_sync_cursor_json = excluded.initial_sync_cursor_json, \
                   local_track_count = excluded.local_track_count",
                params![server_id, library_scope, json, local_track_count],
            )?;
            Ok(())
        })
    }

    /// Atomically publish a completed initial sync. Keeping the cursor clear,
    /// count snapshot, timestamp, and ready phase in one statement prevents a
    /// crash from exposing `ready` with an ingest cursor still present.
    pub fn complete_initial_sync(
        &self,
        server_id: &str,
        library_scope: &str,
        local_track_count: i64,
        finished_at: i64,
    ) -> Result<(), String> {
        self.store
            .with_conn("sync_state.complete_initial_sync", |conn| {
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope, local_track_count, \
                 last_full_sync_at, initial_sync_cursor_json, sync_phase, last_error) \
                 VALUES (?1, ?2, ?3, ?4, '{}', 'ready', NULL) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   local_track_count = excluded.local_track_count, \
                   last_full_sync_at = excluded.last_full_sync_at, \
                   initial_sync_cursor_json = '{}', \
                   sync_phase = 'ready', \
                   last_error = NULL",
                    params![server_id, library_scope, local_track_count, finished_at],
                )?;
                Ok(())
            })
    }
}

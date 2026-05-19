use rusqlite::{params, OptionalExtension};
use serde_json::Value;

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

    /// Insert a default-valued row for this `(server_id, library_scope)` pair
    /// if none exists. All non-PK columns fall back to their schema DEFAULTs
    /// (`sync_phase='idle'`, `initial_sync_cursor_json='{}'`, …).
    pub fn ensure(&self, server_id: &str, library_scope: &str) -> Result<(), String> {
        self.store.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO sync_state (server_id, library_scope) VALUES (?1, ?2)",
                params![server_id, library_scope],
            )?;
            Ok(())
        })
    }

    /// Read `initial_sync_cursor_json`. Returns `None` when the row doesn't
    /// exist yet, `Some(Value)` otherwise (the schema DEFAULT is `'{}'`, so
    /// a freshly-ensured row reads back as `Some(Object({}))`).
    pub fn get_initial_sync_cursor(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<Value>, String> {
        let raw: Option<String> = self.store.with_conn(|conn| {
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
        self.store.with_conn(|conn| {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ensure_creates_row_with_default_cursor() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.ensure("s1", "").unwrap();

        let cursor = repo.get_initial_sync_cursor("s1", "").unwrap();
        assert_eq!(cursor, Some(json!({})), "DEFAULT must read back as empty object");
    }

    #[test]
    fn ensure_is_idempotent() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.ensure("s1", "").unwrap();
        repo.ensure("s1", "").unwrap();

        let count: i64 = store
            .with_conn(|c| c.query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn get_returns_none_for_missing_row() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        assert_eq!(repo.get_initial_sync_cursor("absent", "").unwrap(), None);
    }

    #[test]
    fn set_roundtrips_nested_cursor_value() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        let cursor = json!({
            "phase": "ingest_tracks",
            "offset": 12_500,
            "last_seen_id": "tr_abc",
            "filters": { "library_id": "lib-1" },
        });
        repo.set_initial_sync_cursor("s1", "", &cursor).unwrap();
        let got = repo.get_initial_sync_cursor("s1", "").unwrap();
        assert_eq!(got, Some(cursor));
    }

    #[test]
    fn set_overwrites_prior_cursor() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_initial_sync_cursor("s1", "", &json!({"offset": 1})).unwrap();
        repo.set_initial_sync_cursor("s1", "", &json!({"offset": 2})).unwrap();
        let got = repo.get_initial_sync_cursor("s1", "").unwrap();
        assert_eq!(got, Some(json!({"offset": 2})));
    }

    #[test]
    fn set_preserves_other_columns_on_upsert() {
        // The ON CONFLICT clause must only touch the cursor column. Other
        // DEFAULT-backed fields stay at their initial values across upserts.
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_initial_sync_cursor("s1", "", &json!({"x": 1})).unwrap();

        // Mutate a sibling column out-of-band to detect any accidental reset.
        store
            .with_conn(|c| {
                c.execute(
                    "UPDATE sync_state SET sync_phase = 'ingesting' WHERE server_id = 's1'",
                    [],
                )
            })
            .unwrap();

        // Second cursor write must not touch sync_phase.
        repo.set_initial_sync_cursor("s1", "", &json!({"x": 2})).unwrap();
        let phase: String = store
            .with_conn(|c| {
                c.query_row(
                    "SELECT sync_phase FROM sync_state WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(phase, "ingesting");
    }

    #[test]
    fn library_scope_separates_rows_per_server() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_initial_sync_cursor("s1", "", &json!({"all": true})).unwrap();
        repo.set_initial_sync_cursor("s1", "lib-1", &json!({"lib": "one"})).unwrap();

        assert_eq!(
            repo.get_initial_sync_cursor("s1", "").unwrap(),
            Some(json!({"all": true}))
        );
        assert_eq!(
            repo.get_initial_sync_cursor("s1", "lib-1").unwrap(),
            Some(json!({"lib": "one"}))
        );
    }
}

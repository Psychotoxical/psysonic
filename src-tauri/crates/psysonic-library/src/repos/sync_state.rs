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
        self.store.with_conn("sync_state.set_initial_sync_cursor", |conn| {
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
        self.store.with_conn("sync_state.set_capability_flags", |conn| {
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

    /// True when a full sync has completed at least once.
    pub fn has_last_full_sync_at(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<bool, String> {
        self.read(|conn| {
            let ts: Option<Option<i64>> = conn
                .query_row(
                    "SELECT last_full_sync_at FROM sync_state \
                     WHERE server_id = ?1 AND library_scope = ?2",
                    params![server_id, library_scope],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(ts.flatten().is_some())
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

    /// Write `server_last_scan_iso` — server-reported timestamp of the
    /// last completed scan, captured from `getScanStatus.lastScan`.
    pub fn set_server_last_scan_iso(
        &self,
        server_id: &str,
        library_scope: &str,
        last_scan_iso: Option<&str>,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_server_last_scan_iso", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, server_last_scan_iso) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   server_last_scan_iso = excluded.server_last_scan_iso",
                params![server_id, library_scope, last_scan_iso],
            )?;
            Ok(())
        })
    }

    /// Write `indexes_last_modified_ms` — watermark for the file-tree
    /// browse path (`getIndexes.lastModified`).
    pub fn set_indexes_last_modified_ms(
        &self,
        server_id: &str,
        library_scope: &str,
        last_modified_ms: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_indexes_last_modified_ms", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, indexes_last_modified_ms) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   indexes_last_modified_ms = excluded.indexes_last_modified_ms",
                params![server_id, library_scope, last_modified_ms],
            )?;
            Ok(())
        })
    }

    /// Read `artists_last_modified_ms`. Returns `None` when the row
    /// doesn't exist or the column is `NULL`. DS-2 in §6.4 compares
    /// the live `getArtists.lastModified` against this to decide
    /// whether a delta pass is needed.
    pub fn get_artists_last_modified_ms(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<i64>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT artists_last_modified_ms FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
        })
        .map(|opt| opt.flatten())
    }

    /// Read `server_last_scan_iso`. Returns `None` when row missing
    /// or column null. DS-2 uses this against `getScanStatus.lastScan`
    /// for the Huge-tier short-circuit.
    pub fn get_server_last_scan_iso(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<String>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT server_last_scan_iso FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
        })
        .map(|opt| opt.flatten())
    }

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
        self.store.with_conn("sync_state.set_poll_stats_json", |conn| {
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

    /// Read `local_track_count` snapshot (counts kept in sync by C8 /
    /// PR-3d2 scheduler ticks). Returns `None` when unset.
    pub fn get_local_track_count(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<i64>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT local_track_count FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
        })
        .map(|opt| opt.flatten())
    }

    pub fn set_local_track_count(
        &self,
        server_id: &str,
        library_scope: &str,
        count: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_local_track_count", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, local_track_count) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   local_track_count = excluded.local_track_count",
                params![server_id, library_scope, count],
            )?;
            Ok(())
        })
    }

    pub fn get_server_track_count(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<i64>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT server_track_count FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
        })
        .map(|opt| opt.flatten())
    }

    pub fn set_server_track_count(
        &self,
        server_id: &str,
        library_scope: &str,
        count: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_server_track_count", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, server_track_count) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   server_track_count = excluded.server_track_count",
                params![server_id, library_scope, count],
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
        self.store.with_conn("sync_state.set_n1_bulk_unreliable", |conn| {
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

    /// Stamp `last_full_sync_at = now` (epoch ms). Called by IS-6 when
    /// the initial full ingest completes successfully.
    pub fn set_last_full_sync_at(
        &self,
        server_id: &str,
        library_scope: &str,
        epoch_ms: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_last_full_sync_at", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, last_full_sync_at) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   last_full_sync_at = excluded.last_full_sync_at",
                params![server_id, library_scope, epoch_ms],
            )?;
            Ok(())
        })
    }

    /// Stamp `last_delta_sync_at = now` (epoch ms). Called by DS-9 at
    /// the end of every successful delta pass.
    pub fn set_last_delta_sync_at(
        &self,
        server_id: &str,
        library_scope: &str,
        epoch_ms: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_last_delta_sync_at", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, last_delta_sync_at) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   last_delta_sync_at = excluded.last_delta_sync_at",
                params![server_id, library_scope, epoch_ms],
            )?;
            Ok(())
        })
    }

    /// Write `artists_last_modified_ms` — watermark for the ID3 path
    /// (`getArtists.lastModified`); §2.2.1 background poll keys off
    /// this.
    pub fn set_artists_last_modified_ms(
        &self,
        server_id: &str,
        library_scope: &str,
        last_modified_ms: i64,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_artists_last_modified_ms", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, artists_last_modified_ms) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   artists_last_modified_ms = excluded.artists_last_modified_ms",
                params![server_id, library_scope, last_modified_ms],
            )?;
            Ok(())
        })
    }

    /// Read `ignored_articles` from the last `getArtists` pass (Navidrome
    /// `IgnoredArticles` string — space-separated article tokens).
    pub fn get_ignored_articles(
        &self,
        server_id: &str,
        library_scope: &str,
    ) -> Result<Option<String>, String> {
        self.read(|conn| {
            conn.query_row(
                "SELECT ignored_articles FROM sync_state \
                 WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, library_scope],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
        })
        .map(|opt| opt.flatten())
    }

    /// Persist server `ignoredArticles` for local artist sort-key computation.
    pub fn set_ignored_articles(
        &self,
        server_id: &str,
        library_scope: &str,
        ignored_articles: &str,
    ) -> Result<(), String> {
        self.store.with_conn("sync_state.set_ignored_articles", |conn| {
            conn.execute(
                "INSERT INTO sync_state (server_id, library_scope, ignored_articles) \
                 VALUES (?1, ?2, ?3) \
                 ON CONFLICT(server_id, library_scope) DO UPDATE SET \
                   ignored_articles = excluded.ignored_articles",
                params![server_id, library_scope, ignored_articles],
            )?;
            Ok(())
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
            .with_conn("misc", |c| c.query_row("SELECT COUNT(*) FROM sync_state", [], |r| r.get(0)))
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
            .with_conn("misc", |c| {
                c.execute(
                    "UPDATE sync_state SET sync_phase = 'ingesting' WHERE server_id = 's1'",
                    [],
                )
            })
            .unwrap();

        // Second cursor write must not touch sync_phase.
        repo.set_initial_sync_cursor("s1", "", &json!({"x": 2})).unwrap();
        let phase: String = store
            .with_conn("misc", |c| {
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

    // ── PR-3a: capability_flags, sync_phase, watermarks, library_tier ────

    #[test]
    fn capability_flags_roundtrip() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.ensure("s1", "").unwrap();
        assert_eq!(repo.get_capability_flags("s1", "").unwrap(), Some(0));
        repo.set_capability_flags("s1", "", 0x002 | 0x010).unwrap();
        assert_eq!(repo.get_capability_flags("s1", "").unwrap(), Some(0x012));
    }

    #[test]
    fn capability_flags_returns_none_for_missing_row() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        assert_eq!(repo.get_capability_flags("absent", "").unwrap(), None);
    }

    #[test]
    fn capability_flags_set_creates_row_with_other_defaults() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_capability_flags("s1", "", 0x008).unwrap();
        // sync_phase defaulted to 'idle' on the implicit insert.
        assert_eq!(repo.get_sync_phase("s1", "").unwrap().as_deref(), Some("idle"));
    }

    #[test]
    fn sync_phase_default_is_idle_after_ensure() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.ensure("s1", "").unwrap();
        assert_eq!(repo.get_sync_phase("s1", "").unwrap().as_deref(), Some("idle"));
    }

    #[test]
    fn sync_phase_transitions_through_state_machine_values() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        for phase in ["probing", "initial_sync", "ready", "error", "idle"] {
            repo.set_sync_phase("s1", "", phase).unwrap();
            assert_eq!(
                repo.get_sync_phase("s1", "").unwrap().as_deref(),
                Some(phase)
            );
        }
    }

    #[test]
    fn watermark_setters_preserve_each_other() {
        // Each setter must scope its `ON CONFLICT … DO UPDATE` to its own
        // column. Set three and read all three back unchanged.
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_server_last_scan_iso("s1", "", Some("2026-05-01T12:00:00Z")).unwrap();
        repo.set_indexes_last_modified_ms("s1", "", 1_700_000_000_000).unwrap();
        repo.set_artists_last_modified_ms("s1", "", 1_700_000_500_000).unwrap();

        let (iso, idx_ms, art_ms): (Option<String>, Option<i64>, Option<i64>) = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT server_last_scan_iso, indexes_last_modified_ms, artists_last_modified_ms \
                     FROM sync_state WHERE server_id = 's1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .unwrap();
        assert_eq!(iso.as_deref(), Some("2026-05-01T12:00:00Z"));
        assert_eq!(idx_ms, Some(1_700_000_000_000));
        assert_eq!(art_ms, Some(1_700_000_500_000));
    }

    #[test]
    fn library_tier_roundtrip() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_library_tier("s1", "", "huge").unwrap();
        let tier: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT library_tier FROM sync_state WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(tier, "huge");
    }

    #[test]
    fn n1_bulk_unreliable_defaults_false_and_roundtrips() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.ensure("s1", "").unwrap();
        // DEFAULT 0 reads back as Some(false); existing servers stay N1-eligible.
        assert_eq!(repo.get_n1_bulk_unreliable("s1", "").unwrap(), Some(false));
        assert_eq!(repo.get_n1_bulk_unreliable("absent", "").unwrap(), None);

        repo.set_n1_bulk_unreliable("s1", "", true).unwrap();
        assert_eq!(repo.get_n1_bulk_unreliable("s1", "").unwrap(), Some(true));
        repo.set_n1_bulk_unreliable("s1", "", false).unwrap();
        assert_eq!(repo.get_n1_bulk_unreliable("s1", "").unwrap(), Some(false));
    }

    #[test]
    fn n1_bulk_unreliable_set_does_not_clobber_cursor() {
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_initial_sync_cursor("s1", "", &json!({"offset": 7})).unwrap();
        repo.set_n1_bulk_unreliable("s1", "", true).unwrap();
        assert_eq!(
            repo.get_initial_sync_cursor("s1", "").unwrap(),
            Some(json!({"offset": 7}))
        );
    }

    #[test]
    fn capability_flags_set_does_not_clobber_cursor() {
        // Cross-check: setting flags must not reset
        // `initial_sync_cursor_json` back to '{}'.
        let store = LibraryStore::open_in_memory();
        let repo = SyncStateRepository::new(&store);
        repo.set_initial_sync_cursor("s1", "", &json!({"offset": 42})).unwrap();
        repo.set_capability_flags("s1", "", 0x002).unwrap();
        assert_eq!(
            repo.get_initial_sync_cursor("s1", "").unwrap(),
            Some(json!({"offset": 42}))
        );
    }
}

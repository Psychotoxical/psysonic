//! Read-side helper for `track_id_history`. Writes live inside the
//! upsert transaction in `TrackRepository::upsert_batch_with_remap`
//! (spec §6.9) — keeping them there avoids splitting the remap across
//! two SQLite transactions, which would leave a window where child
//! tables point at a removed track id.

use rusqlite::{params, OptionalExtension};

use crate::store::LibraryStore;

pub struct TrackIdHistoryRepository<'a> {
    store: &'a LibraryStore,
}

impl<'a> TrackIdHistoryRepository<'a> {
    pub fn new(store: &'a LibraryStore) -> Self {
        Self { store }
    }

    /// Resolve a remapped id forward to the current server id, if a
    /// remap was recorded. Returns `None` when no row exists. Analysis
    /// cache lookups (Phase E) go through this so cached waveform /
    /// loudness rows stay reachable after the server's id space shifts.
    pub fn lookup_new_id(
        &self,
        server_id: &str,
        old_id: &str,
    ) -> Result<Option<String>, String> {
        self.store.with_conn("misc", |conn| {
            conn.query_row(
                "SELECT new_id FROM track_id_history \
                 WHERE server_id = ?1 AND old_id = ?2",
                params![server_id, old_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
    }

    /// Count the rows recorded for this server — used by tests and by
    /// post-sync diagnostics (Settings „Library index" panel later).
    pub fn count_for_server(&self, server_id: &str) -> Result<i64, String> {
        self.store.with_conn("misc", |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM track_id_history WHERE server_id = ?1",
                params![server_id],
                |row| row.get(0),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn seed_history(store: &LibraryStore, rows: &[(&str, &str, &str)]) {
        store
            .with_conn("misc", |c| {
                for (server, old, new) in rows {
                    c.execute(
                        "INSERT INTO track_id_history \
                         (server_id, old_id, new_id, content_hash, server_path, remapped_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![server, old, new, "hash", "path", 1_700_000_000_i64],
                    )?;
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn lookup_returns_none_when_no_remap_recorded() {
        let store = LibraryStore::open_in_memory();
        let repo = TrackIdHistoryRepository::new(&store);
        assert_eq!(repo.lookup_new_id("s1", "tr_old").unwrap(), None);
    }

    #[test]
    fn lookup_finds_new_id_for_recorded_remap() {
        let store = LibraryStore::open_in_memory();
        seed_history(&store, &[("s1", "tr_old", "tr_new")]);
        let repo = TrackIdHistoryRepository::new(&store);
        assert_eq!(
            repo.lookup_new_id("s1", "tr_old").unwrap().as_deref(),
            Some("tr_new")
        );
    }

    #[test]
    fn lookup_scopes_by_server_id() {
        let store = LibraryStore::open_in_memory();
        seed_history(&store, &[("s1", "tr_x", "tr_new1"), ("s2", "tr_x", "tr_new2")]);
        let repo = TrackIdHistoryRepository::new(&store);
        assert_eq!(
            repo.lookup_new_id("s1", "tr_x").unwrap().as_deref(),
            Some("tr_new1")
        );
        assert_eq!(
            repo.lookup_new_id("s2", "tr_x").unwrap().as_deref(),
            Some("tr_new2")
        );
    }

    #[test]
    fn count_for_server_scopes_correctly() {
        let store = LibraryStore::open_in_memory();
        seed_history(
            &store,
            &[
                ("s1", "a", "b"),
                ("s1", "c", "d"),
                ("s2", "e", "f"),
            ],
        );
        let repo = TrackIdHistoryRepository::new(&store);
        assert_eq!(repo.count_for_server("s1").unwrap(), 2);
        assert_eq!(repo.count_for_server("s2").unwrap(), 1);
        assert_eq!(repo.count_for_server("absent").unwrap(), 0);
    }
}

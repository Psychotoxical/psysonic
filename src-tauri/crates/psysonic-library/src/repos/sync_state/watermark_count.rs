use rusqlite::{params, OptionalExtension};

use super::SyncStateRepository;

impl<'a> SyncStateRepository<'a> {
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

    /// Write `server_last_scan_iso` — server-reported timestamp of the
    /// last completed scan, captured from `getScanStatus.lastScan`.
    pub fn set_server_last_scan_iso(
        &self,
        server_id: &str,
        library_scope: &str,
        last_scan_iso: Option<&str>,
    ) -> Result<(), String> {
        self.store
            .with_conn("sync_state.set_server_last_scan_iso", |conn| {
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
        self.store
            .with_conn("sync_state.set_indexes_last_modified_ms", |conn| {
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
        self.store
            .with_conn("sync_state.set_local_track_count", |conn| {
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
        self.store
            .with_conn("sync_state.set_server_track_count", |conn| {
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

    /// Stamp `last_full_sync_at = now` (epoch ms). Called by IS-6 when
    /// the initial full ingest completes successfully.
    pub fn set_last_full_sync_at(
        &self,
        server_id: &str,
        library_scope: &str,
        epoch_ms: i64,
    ) -> Result<(), String> {
        self.store
            .with_conn("sync_state.set_last_full_sync_at", |conn| {
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
        self.store
            .with_conn("sync_state.set_last_delta_sync_at", |conn| {
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
        self.store
            .with_conn("sync_state.set_artists_last_modified_ms", |conn| {
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
        self.store
            .with_conn("sync_state.set_ignored_articles", |conn| {
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
}

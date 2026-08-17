use crate::bulk_ingest::{
    refresh_track_planner_stats, restore_track_secondary_indexes, suspend_track_secondary_indexes,
};
use crate::store::LibraryStore;
use crate::sync::error::SyncError;
use crate::track_fts::{
    rebuild_track_fts_from_content, restore_track_fts_triggers, suspend_track_fts_triggers,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct BulkIngestPragmas {
    pub(super) synchronous: i64,
    pub(super) wal_autocheckpoint: i64,
    pub(super) cache_size: i64,
}

impl BulkIngestPragmas {
    pub(super) fn capture(conn: &rusqlite::Connection) -> rusqlite::Result<Self> {
        Ok(Self {
            synchronous: conn.pragma_query_value(None, "synchronous", |row| row.get(0))?,
            wal_autocheckpoint: conn
                .pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))?,
            cache_size: conn.pragma_query_value(None, "cache_size", |row| row.get(0))?,
        })
    }
}

fn remember_first_error(first_error: &mut Option<rusqlite::Error>, result: rusqlite::Result<()>) {
    if first_error.is_none() {
        if let Err(error) = result {
            *first_error = Some(error);
        }
    }
}

/// Suspends FTS + write-heavy secondary indexes for IS-3. Successful runs must
/// call `finish`; `Drop` only retries cleanup after cancellation or failure.
pub(super) struct BulkIngestGuard<'a> {
    store: &'a LibraryStore,
    pragmas: BulkIngestPragmas,
    finalized: bool,
}

impl<'a> BulkIngestGuard<'a> {
    pub(super) fn begin(store: &'a LibraryStore) -> Result<Self, SyncError> {
        let pragmas = store
            .with_conn("bulk.capture_pragmas", BulkIngestPragmas::capture)
            .map_err(SyncError::Storage)?;
        store.set_bulk_ingest_active(true);
        let guard = Self {
            store,
            pragmas,
            finalized: false,
        };

        store
            .with_conn_mut("bulk.begin", |conn| {
                let tx = conn.unchecked_transaction()?;
                suspend_track_fts_triggers(&tx)?;
                suspend_track_secondary_indexes(&tx)?;
                tx.commit()?;

                conn.pragma_update(None, "synchronous", "OFF")?;
                conn.pragma_update(None, "wal_autocheckpoint", 0)?;
                conn.pragma_update(None, "cache_size", -128_000)?;
                Ok(())
            })
            .map_err(SyncError::Storage)?;

        Ok(guard)
    }

    fn finalize_inner(&self) -> Result<(), String> {
        self.store.with_conn_mut("bulk.finalize", |conn| {
            let mut first_error = None;
            remember_first_error(
                &mut first_error,
                conn.pragma_update(None, "synchronous", self.pragmas.synchronous),
            );
            remember_first_error(
                &mut first_error,
                conn.pragma_update(None, "wal_autocheckpoint", self.pragmas.wal_autocheckpoint),
            );
            remember_first_error(
                &mut first_error,
                (|| {
                    let tx = conn.unchecked_transaction()?;
                    restore_track_secondary_indexes(&tx)?;
                    rebuild_track_fts_from_content(&tx)?;
                    restore_track_fts_triggers(&tx)?;
                    refresh_track_planner_stats(&tx)?;
                    tx.commit()
                })(),
            );
            remember_first_error(
                &mut first_error,
                conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    let _: (i32, i32, i32) = (row.get(0)?, row.get(1)?, row.get(2)?);
                    Ok(())
                }),
            );
            remember_first_error(
                &mut first_error,
                conn.pragma_update(None, "cache_size", self.pragmas.cache_size),
            );

            match first_error {
                Some(error) => Err(error),
                None => Ok(()),
            }
        })
    }

    pub(super) fn finish(mut self) -> Result<(), String> {
        let start = std::time::Instant::now();
        self.finalize_inner()?;
        self.finalized = true;
        self.store.set_bulk_ingest_active(false);
        crate::app_eprintln!(
            "[library-sync] bulk ingest finalized in {}ms (indexes + WAL + FTS)",
            start.elapsed().as_millis()
        );
        Ok(())
    }
}

impl Drop for BulkIngestGuard<'_> {
    fn drop(&mut self) {
        if self.finalized {
            return;
        }
        let start = std::time::Instant::now();
        match self.finalize_inner() {
            Ok(()) => {
                self.store.set_bulk_ingest_active(false);
                crate::app_eprintln!(
                    "[library-sync] emergency bulk ingest cleanup finished in {}ms",
                    start.elapsed().as_millis()
                );
            }
            Err(e) => {
                crate::app_eprintln!("[library-sync] emergency bulk ingest cleanup failed: {e}")
            }
        }
    }
}

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{LibraryBackfillStep, LibraryStore};
use crate::sync::mapping::{navidrome_isrc_from_raw, navidrome_mbid_recording_from_raw};

/// One-time repair for libraries whose native Navidrome ingest never filled
/// `isrc` / `mbid_recording`: the mapper read `mbzTrackId`, `musicBrainzId` and
/// a top-level `isrc`, names the native `/api/song` payload does not carry
/// (`mbzRecordingID`, `tags.isrc`). With both columns NULL the canonical layer
/// had nothing to link (issue #1434).
///
/// The pass fills empty columns from `raw_json` — hot columns win over
/// `raw_json` (ADR-7), so a populated column is never rewritten — and links
/// every live keyed row that has no `track_canonical_link` row yet. The second
/// half also covers libraries whose initial sync predates the bulk link pass.
pub(crate) const NATIVE_STRONG_KEYS_BACKFILL_RECONCILE_ID: &str = "native_strong_keys_backfill_v1";
const NATIVE_STRONG_KEYS_BACKFILL_BATCH_SIZE: i64 = 1_000;

fn native_strong_keys_backfill_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![NATIVE_STRONG_KEYS_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

struct BackfillRow {
    rowid: i64,
    server_id: String,
    track_id: String,
    isrc: Option<String>,
    mbid_recording: Option<String>,
    raw_json: String,
    linked: bool,
}

/// Blank column values count as absent, like the canonical layer treats them.
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn reconcile_native_strong_keys_backfill_batch(
    conn: &Connection,
) -> rusqlite::Result<LibraryBackfillStep> {
    if native_strong_keys_backfill_completed(conn)? {
        return Ok(LibraryBackfillStep::Complete);
    }
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
         VALUES (?1, 0, strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET \
           started_at = COALESCE(library_data_migration.started_at, excluded.started_at)",
        params![NATIVE_STRONG_KEYS_BACKFILL_RECONCILE_ID],
    )?;

    let cursor: i64 = conn.query_row(
        "SELECT cursor_rowid FROM library_data_migration WHERE id = ?1",
        params![NATIVE_STRONG_KEYS_BACKFILL_RECONCILE_ID],
        |row| row.get(0),
    )?;
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT t.rowid, t.server_id, t.id, t.isrc, t.mbid_recording, t.raw_json, \
                    l.track_id IS NOT NULL \
             FROM track t \
             LEFT JOIN track_canonical_link l \
               ON l.server_id = t.server_id AND l.track_id = t.id \
             WHERE t.rowid > ?1 AND t.deleted = 0 \
             ORDER BY t.rowid LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(
                params![cursor, NATIVE_STRONG_KEYS_BACKFILL_BATCH_SIZE],
                |row| {
                    Ok(BackfillRow {
                        rowid: row.get(0)?,
                        server_id: row.get(1)?,
                        track_id: row.get(2)?,
                        isrc: row.get(3)?,
                        mbid_recording: row.get(4)?,
                        raw_json: row.get(5)?,
                        linked: row.get(6)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let Some(last_rowid) = rows.last().map(|row| row.rowid) else {
        conn.execute(
            "UPDATE library_data_migration \
             SET completed_at = strftime('%s','now') WHERE id = ?1",
            params![NATIVE_STRONG_KEYS_BACKFILL_RECONCILE_ID],
        )?;
        return Ok(LibraryBackfillStep::Complete);
    };

    let now = now_unix_ms();
    let tx = conn.unchecked_transaction()?;
    for row in rows {
        let stored_isrc = non_empty(row.isrc);
        let stored_mbid = non_empty(row.mbid_recording);
        // Only a row with a gap needs its JSON parsed; fully keyed rows are
        // either already linked or linked from the columns alone.
        let raw = if stored_isrc.is_some() && stored_mbid.is_some() {
            None
        } else {
            serde_json::from_str::<Value>(&row.raw_json).ok()
        };
        let isrc = stored_isrc
            .clone()
            .or_else(|| raw.as_ref().and_then(navidrome_isrc_from_raw));
        let mbid = stored_mbid
            .clone()
            .or_else(|| raw.as_ref().and_then(navidrome_mbid_recording_from_raw));
        let filled =
            (isrc.is_some() && stored_isrc.is_none()) || (mbid.is_some() && stored_mbid.is_none());
        if filled {
            tx.execute(
                "UPDATE track SET \
                   isrc = COALESCE(?2, isrc), \
                   mbid_recording = COALESCE(?3, mbid_recording) \
                 WHERE rowid = ?1",
                params![row.rowid, isrc, mbid],
            )?;
        }
        if (isrc.is_some() || mbid.is_some()) && (filled || !row.linked) {
            crate::canonical::link_track(
                &tx,
                &row.server_id,
                &row.track_id,
                isrc.as_deref(),
                mbid.as_deref(),
                now,
            )?;
        }
    }
    tx.execute(
        "UPDATE library_data_migration SET cursor_rowid = ?2 WHERE id = ?1",
        params![NATIVE_STRONG_KEYS_BACKFILL_RECONCILE_ID, last_rowid],
    )?;
    tx.commit()?;
    Ok(LibraryBackfillStep::Pending)
}

impl LibraryStore {
    /// Fill one physical-row batch of strong-key columns from `raw_json` and
    /// link the rows the canonical layer missed. The background scheduler calls
    /// this only while idle.
    pub fn run_native_strong_keys_backfill_batch(&self) -> Result<LibraryBackfillStep, String> {
        if self.bulk_ingest_active() {
            return Ok(LibraryBackfillStep::Deferred);
        }
        self.with_conn("native_strong_keys_reconcile.batch", |conn| {
            if self.bulk_ingest_active() {
                return Ok(LibraryBackfillStep::Deferred);
            }
            reconcile_native_strong_keys_backfill_batch(conn)
        })
    }
}

/// Test helper that drains every batch without scheduler delays.
#[cfg(test)]
pub(super) fn maybe_reconcile_native_strong_keys_backfill(
    conn: &Connection,
) -> rusqlite::Result<()> {
    loop {
        if reconcile_native_strong_keys_backfill_batch(conn)? == LibraryBackfillStep::Complete {
            return Ok(());
        }
    }
}

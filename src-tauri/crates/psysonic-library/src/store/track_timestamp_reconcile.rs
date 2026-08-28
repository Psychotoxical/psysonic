use rusqlite::{params, Connection, OptionalExtension};

use super::LibraryStore;

/// One-time repair of server timestamp columns lost when negative UTC offsets
/// failed to parse, or shifted when positive offsets were treated as UTC wall time.
pub(crate) const TRACK_TIMESTAMP_BACKFILL_RECONCILE_ID: &str = "track_timestamp_backfill_v1";
const TRACK_TIMESTAMP_BACKFILL_BATCH_SIZE: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackTimestampBackfillStep {
    Deferred,
    Pending,
    Complete,
}

fn track_timestamp_backfill_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![TRACK_TIMESTAMP_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn timestamp_field<'a>(raw: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(value) = raw.get(*key) {
            return value.as_str();
        }
    }
    None
}

/// Reproduce the old parser result only far enough to identify rows that the
/// offset fix must repair. Negative offsets failed entirely; positive offsets
/// were stored as UTC wall time without applying the offset.
fn parse_iso_ms_before_offset_fix(timestamp: &str) -> Option<i64> {
    let trimmed = timestamp.trim();
    let Some(time_index) = trimmed.find('T') else {
        return crate::sync::mapping::parse_iso_ms_str(trimmed);
    };
    let timezone_index = trimmed[time_index + 1..]
        .find(['Z', '+', '-'])
        .map(|offset| time_index + 1 + offset);
    match timezone_index.and_then(|index| trimmed.as_bytes().get(index).copied()) {
        Some(b'-') => None,
        Some(b'+') => {
            let index = timezone_index?;
            let wall_time = format!("{}Z", &trimmed[..index]);
            crate::sync::mapping::parse_iso_ms_str(&wall_time)
        }
        _ => crate::sync::mapping::parse_iso_ms_str(trimmed),
    }
}

fn repaired_offset_timestamp(current: Option<i64>, timestamp: Option<&str>) -> Option<i64> {
    let timestamp = timestamp?;
    let corrected = crate::sync::mapping::parse_iso_ms_str(timestamp)?;
    let previous = parse_iso_ms_before_offset_fix(timestamp);
    if previous == Some(corrected) || current.is_some_and(|value| Some(value) != previous) {
        return None;
    }
    Some(corrected)
}

fn reconcile_track_timestamp_backfill_batch(
    conn: &Connection,
) -> rusqlite::Result<TrackTimestampBackfillStep> {
    if track_timestamp_backfill_completed(conn)? {
        return Ok(TrackTimestampBackfillStep::Complete);
    }
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
         VALUES (?1, 0, strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET \
           started_at = COALESCE(library_data_migration.started_at, excluded.started_at)",
        params![TRACK_TIMESTAMP_BACKFILL_RECONCILE_ID],
    )?;

    let cursor: i64 = conn.query_row(
        "SELECT cursor_rowid FROM library_data_migration WHERE id = ?1",
        params![TRACK_TIMESTAMP_BACKFILL_RECONCILE_ID],
        |row| row.get(0),
    )?;
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT rowid, raw_json, server_created_at, server_updated_at \
             FROM track WHERE rowid > ?1 ORDER BY rowid LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(
                params![cursor, TRACK_TIMESTAMP_BACKFILL_BATCH_SIZE],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let Some(last_rowid) = rows.last().map(|row| row.0) else {
        conn.execute(
            "UPDATE library_data_migration \
             SET completed_at = strftime('%s','now') WHERE id = ?1",
            params![TRACK_TIMESTAMP_BACKFILL_RECONCILE_ID],
        )?;
        return Ok(TrackTimestampBackfillStep::Complete);
    };

    let tx = conn.unchecked_transaction()?;
    for (rowid, raw_json, server_created_at, server_updated_at) in rows {
        let Ok(raw) = serde_json::from_str::<serde_json::Value>(&raw_json) else {
            continue;
        };
        // `createdAt` is the current Navidrome field. If it is present but
        // empty/null, do not fall back to an older `created` alias retained
        // by a prior sparse JSON merge.
        let repaired_created = repaired_offset_timestamp(
            server_created_at,
            timestamp_field(&raw, &["createdAt", "created"]),
        );
        let repaired_updated =
            repaired_offset_timestamp(server_updated_at, timestamp_field(&raw, &["updatedAt"]));
        if repaired_created.is_some() || repaired_updated.is_some() {
            tx.execute(
                "UPDATE track SET \
                   server_created_at = COALESCE(?2, server_created_at), \
                   server_updated_at = COALESCE(?3, server_updated_at) \
                 WHERE rowid = ?1",
                params![rowid, repaired_created, repaired_updated],
            )?;
        }
    }
    tx.execute(
        "UPDATE library_data_migration SET cursor_rowid = ?2 WHERE id = ?1",
        params![TRACK_TIMESTAMP_BACKFILL_RECONCILE_ID, last_rowid],
    )?;
    tx.commit()?;
    Ok(TrackTimestampBackfillStep::Pending)
}

impl LibraryStore {
    /// Restore one physical-row batch of server timestamps affected by the old
    /// offset parser. The background scheduler calls this only while idle.
    pub fn run_track_timestamp_backfill_batch(
        &self,
    ) -> Result<TrackTimestampBackfillStep, String> {
        if self.bulk_ingest_active() {
            return Ok(TrackTimestampBackfillStep::Deferred);
        }
        self.with_conn("track_timestamp_reconcile.batch", |conn| {
            if self.bulk_ingest_active() {
                return Ok(TrackTimestampBackfillStep::Deferred);
            }
            reconcile_track_timestamp_backfill_batch(conn)
        })
    }
}

/// Test helper that drains every batch without scheduler delays.
#[cfg(test)]
pub(super) fn maybe_reconcile_track_timestamp_backfill(conn: &Connection) -> rusqlite::Result<()> {
    loop {
        if reconcile_track_timestamp_backfill_batch(conn)? == TrackTimestampBackfillStep::Complete {
            return Ok(());
        }
    }
}

use rusqlite::{params, Connection, OptionalExtension};

/// One-time data repair after migration 014 (`artist.name_sort`).
pub(crate) const ARTIST_NAME_SORT_RECONCILE_ID: &str = "artist_name_sort_reconcile_v1";
pub(crate) const ARTIST_NAME_FOLD_RECONCILE_ID: &str = "artist_name_fold_reconcile_v1";

/// One-time backfill after migration 015 (`track.replay_gain_peak`).
pub(crate) const REPLAY_GAIN_PEAK_RECONCILE_ID: &str = "replay_gain_peak_reconcile_v1";

/// One-time backfill after migration 016 (`track.library_id` from `raw_json`).
pub(crate) const LIBRARY_ID_BACKFILL_RECONCILE_ID: &str = "library_id_backfill_reconcile_v1";

/// One-time cleanup of `artist` browse rows orphaned by pre-fix syncs
/// (server-side renames left ghosts that opened to "not found"). Ongoing syncs
/// prune these inline; this clears already-accumulated rows at first open.
pub(crate) const ORPHAN_BROWSE_RECONCILE_ID: &str = "orphan_browse_rows_reconcile_v1";

/// One-time repair of Navidrome decimal durations stored as zero before the
/// native mapper began rounding them to whole seconds.
pub(crate) const DURATION_SEC_BACKFILL_RECONCILE_ID: &str = "duration_sec_decimal_backfill_v1";
const DURATION_SEC_BACKFILL_BATCH_SIZE: i64 = 1_000;

pub(super) fn reconcile_ready_rows_with_ingest_cursors(conn: &Connection) -> rusqlite::Result<()> {
    let candidates = {
        let mut stmt = conn.prepare(
            "SELECT server_id, library_scope, initial_sync_cursor_json \
             FROM sync_state WHERE sync_phase = 'ready'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let tx = conn.unchecked_transaction()?;
    for (server_id, library_scope, raw_cursor) in candidates {
        let has_ingest_cursor =
            raw_cursor.as_deref().is_some_and(|raw| {
                match serde_json::from_str::<serde_json::Value>(raw) {
                    Ok(serde_json::Value::Object(cursor)) => !cursor.is_empty(),
                    Ok(serde_json::Value::Null) => false,
                    Ok(_) | Err(_) => true,
                }
            });
        if !has_ingest_cursor {
            continue;
        }
        let local_track_count: i64 = if library_scope.is_empty() {
            tx.query_row(
                "SELECT COUNT(*) FROM track WHERE server_id = ?1 AND deleted = 0",
                [&server_id],
                |row| row.get(0),
            )?
        } else {
            tx.query_row(
                "SELECT COUNT(*) FROM track \
                 WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0",
                params![server_id, library_scope],
                |row| row.get(0),
            )?
        };
        tx.execute(
            "UPDATE sync_state SET initial_sync_cursor_json = '{}', local_track_count = ?3 \
             WHERE server_id = ?1 AND library_scope = ?2 AND sync_phase = 'ready'",
            params![server_id, library_scope, local_track_count],
        )?;
    }
    tx.commit()
}

pub(super) fn artist_name_sort_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('artist') WHERE name = 'name_sort'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

pub(super) fn artist_name_fold_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('artist') WHERE name = 'name_fold'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

pub(super) fn sync_state_ignored_articles_column_exists(
    conn: &Connection,
) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('sync_state') WHERE name = 'ignored_articles'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

pub(super) fn finish_migration_14_reconcile(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_sort_reconcile_completed(conn)? {
        repair_artist_name_sort_keys(conn)?;
        mark_artist_name_sort_reconcile_completed(conn)?;
    }
    Ok(())
}

fn artist_name_sort_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![ARTIST_NAME_SORT_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_artist_name_sort_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![ARTIST_NAME_SORT_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time reconcile after schema 014 — not on every open (avoids long write locks at startup).
pub(super) fn maybe_reconcile_artist_name_sort(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_sort_column_exists(conn)? {
        return Ok(());
    }
    if artist_name_sort_reconcile_completed(conn)? {
        return Ok(());
    }
    repair_artist_name_sort_keys(conn)?;
    mark_artist_name_sort_reconcile_completed(conn)?;
    Ok(())
}

/// Reconcile `artist.name_sort` with display `name` (upgrade / stale rows).
fn repair_artist_name_sort_keys(conn: &Connection) -> rusqlite::Result<()> {
    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'artist'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if table_exists == 0 {
        return Ok(());
    }
    if !artist_name_sort_column_exists(conn)? {
        return Ok(());
    }
    let ignored = crate::artist_sort::DEFAULT_IGNORED_ARTICLES;
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("SELECT server_id, id, name, name_sort FROM artist")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let server_id: String = row.get(0)?;
            let id: String = row.get(1)?;
            let name: String = row.get(2)?;
            let current: Option<String> = row.get(3)?;
            let expected = crate::artist_sort::sort_key_for_display_name(&name, ignored);
            if current.as_deref() == Some(&expected) {
                continue;
            }
            tx.execute(
                "UPDATE artist SET name_sort = ?1 WHERE server_id = ?2 AND id = ?3",
                rusqlite::params![expected, server_id, id],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn artist_name_fold_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![ARTIST_NAME_FOLD_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

pub(super) fn maybe_reconcile_artist_name_fold(conn: &Connection) -> rusqlite::Result<()> {
    if !artist_name_fold_column_exists(conn)? || artist_name_fold_reconcile_completed(conn)? {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("SELECT server_id, id, name, name_fold FROM artist")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let server_id: String = row.get(0)?;
            let id: String = row.get(1)?;
            let name: String = row.get(2)?;
            let current: Option<String> = row.get(3)?;
            let expected = name.trim().to_lowercase();
            if current.as_deref() == Some(&expected) {
                continue;
            }
            tx.execute(
                "UPDATE artist SET name_fold = ?1 WHERE server_id = ?2 AND id = ?3",
                params![expected, server_id, id],
            )?;
        }
    }
    tx.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![ARTIST_NAME_FOLD_RECONCILE_ID],
    )?;
    tx.commit()
}

fn replay_gain_peak_column_exists(conn: &Connection) -> rusqlite::Result<bool> {
    let column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('track') WHERE name = 'replay_gain_peak'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(column_exists > 0)
}

fn replay_gain_peak_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![REPLAY_GAIN_PEAK_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_replay_gain_peak_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![REPLAY_GAIN_PEAK_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time backfill after schema 015 — project peak from stored `raw_json`.
fn repair_replay_gain_peak_from_raw_json(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE track SET replay_gain_peak = json_extract(raw_json, '$.replayGain.trackPeak') \
         WHERE replay_gain_peak IS NULL \
           AND json_type(json_extract(raw_json, '$.replayGain.trackPeak')) = 'real'",
        [],
    )?;
    conn.execute(
        "UPDATE track SET replay_gain_peak = json_extract(raw_json, '$.rgTrackPeak') \
         WHERE replay_gain_peak IS NULL \
           AND json_type(json_extract(raw_json, '$.rgTrackPeak')) = 'real'",
        [],
    )?;
    Ok(())
}

/// One-time reconcile after schema 015 — not on every open.
pub(super) fn maybe_reconcile_replay_gain_peak(conn: &Connection) -> rusqlite::Result<()> {
    if !replay_gain_peak_column_exists(conn)? {
        return Ok(());
    }
    if replay_gain_peak_reconcile_completed(conn)? {
        return Ok(());
    }
    repair_replay_gain_peak_from_raw_json(conn)?;
    mark_replay_gain_peak_reconcile_completed(conn)?;
    Ok(())
}

fn library_id_backfill_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_library_id_backfill_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![LIBRARY_ID_BACKFILL_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time backfill after schema 016 — project `library_id` from stored `raw_json`.
fn repair_library_id_from_raw_json(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE track SET library_id = COALESCE( \
           CAST(json_extract(raw_json, '$.libraryId') AS TEXT), \
           CAST(json_extract(raw_json, '$.library_id') AS TEXT), \
           CAST(json_extract(raw_json, '$.musicFolderId') AS TEXT) \
         ) \
         WHERE (library_id IS NULL OR library_id = '') \
           AND COALESCE( \
             CAST(json_extract(raw_json, '$.libraryId') AS TEXT), \
             CAST(json_extract(raw_json, '$.library_id') AS TEXT), \
             CAST(json_extract(raw_json, '$.musicFolderId') AS TEXT) \
           ) IS NOT NULL",
        [],
    )?;
    // Only `track` (and its indexes) changed here, so a table-scoped ANALYZE is
    // enough to refresh the planner stats — cheaper than a whole-DB ANALYZE on a
    // large library at first open.
    conn.execute_batch("ANALYZE track;")?;
    Ok(())
}

/// One-time reconcile after schema 016 — not on every open.
pub(super) fn maybe_reconcile_library_id_backfill(conn: &Connection) -> rusqlite::Result<()> {
    if library_id_backfill_reconcile_completed(conn)? {
        return Ok(());
    }
    repair_library_id_from_raw_json(conn)?;
    mark_library_id_backfill_reconcile_completed(conn)?;
    Ok(())
}

fn duration_sec_backfill_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

/// Restore zeroed decimal durations from `raw_json` in bounded transactions.
/// `cursor_rowid` lets an interrupted startup continue from the last batch.
pub(super) fn maybe_reconcile_duration_sec_backfill(conn: &Connection) -> rusqlite::Result<()> {
    if duration_sec_backfill_completed(conn)? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
         VALUES (?1, 0, strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET \
           started_at = COALESCE(library_data_migration.started_at, excluded.started_at)",
        params![DURATION_SEC_BACKFILL_RECONCILE_ID],
    )?;

    loop {
        let cursor: i64 = conn.query_row(
            "SELECT cursor_rowid FROM library_data_migration WHERE id = ?1",
            params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            |row| row.get(0),
        )?;
        let last_rowid: Option<i64> = conn.query_row(
            "SELECT MAX(rowid) FROM ( \
               SELECT rowid FROM track \
               WHERE rowid > ?1 \
                 AND duration_sec = 0 \
                 AND json_valid(raw_json) \
                 AND json_type(raw_json, '$.duration') IN ('integer', 'real') \
                 AND CAST(json_extract(raw_json, '$.duration') AS REAL) > 0 \
               ORDER BY rowid LIMIT ?2 \
             )",
            params![cursor, DURATION_SEC_BACKFILL_BATCH_SIZE],
            |row| row.get(0),
        )?;
        let Some(last_rowid) = last_rowid else {
            conn.execute(
                "UPDATE library_data_migration \
                 SET completed_at = strftime('%s','now') WHERE id = ?1",
                params![DURATION_SEC_BACKFILL_RECONCILE_ID],
            )?;
            return Ok(());
        };

        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE track \
             SET duration_sec = CAST(ROUND(CAST(json_extract(raw_json, '$.duration') AS REAL)) AS INTEGER) \
             WHERE rowid > ?1 AND rowid <= ?2 \
               AND duration_sec = 0 \
               AND json_valid(raw_json) \
               AND json_type(raw_json, '$.duration') IN ('integer', 'real') \
               AND CAST(json_extract(raw_json, '$.duration') AS REAL) > 0",
            params![cursor, last_rowid],
        )?;
        tx.execute(
            "UPDATE library_data_migration SET cursor_rowid = ?2 WHERE id = ?1",
            params![DURATION_SEC_BACKFILL_RECONCILE_ID, last_rowid],
        )?;
        tx.commit()?;
    }
}

fn orphan_browse_reconcile_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![ORPHAN_BROWSE_RECONCILE_ID],
            |row| row.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn mark_orphan_browse_reconcile_completed(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
         VALUES (?1, 0, strftime('%s','now'), strftime('%s','now')) \
         ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
        params![ORPHAN_BROWSE_RECONCILE_ID],
    )?;
    Ok(())
}

/// One-time cleanup of orphaned `artist` browse rows for existing DBs — clears
/// ghosts left by server-side renames before inline pruning landed. Runs once
/// (guarded by `library_data_migration`); ongoing syncs prune inline.
pub(super) fn maybe_reconcile_orphan_browse_rows(conn: &Connection) -> rusqlite::Result<()> {
    if orphan_browse_reconcile_completed(conn)? {
        return Ok(());
    }
    crate::orphan_cleanup::prune_orphan_artists_all(conn)?;
    mark_orphan_browse_reconcile_completed(conn)?;
    Ok(())
}

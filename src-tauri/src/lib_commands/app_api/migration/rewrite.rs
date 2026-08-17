use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params_from_iter, Connection};

use super::files::open_readonly;
use super::{ScopedTable, ServerIndexMapping};

pub(super) fn normalize_mappings(mappings: Vec<ServerIndexMapping>) -> Vec<ServerIndexMapping> {
    let mut out: Vec<ServerIndexMapping> = Vec::new();
    for mapping in mappings {
        let legacy_id = mapping.legacy_id.trim().to_string();
        let index_key = mapping.index_key.trim().to_string();
        if legacy_id.is_empty() || index_key.is_empty() {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|v| v.legacy_id == legacy_id) {
            existing.index_key = index_key;
        } else {
            out.push(ServerIndexMapping {
                legacy_id,
                index_key,
            });
        }
    }
    out
}

pub(super) fn rewrite_scoped_tables(
    conn: &Connection,
    tables: &[ScopedTable],
    mappings: &[ServerIndexMapping],
    empty_bucket_index_key: Option<&str>,
    mut table_completed: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let legacy_ids: Vec<String> = mappings.iter().map(|m| m.legacy_id.clone()).collect();
    let index_keys: Vec<String> = mappings.iter().map(|m| m.index_key.clone()).collect();
    for table in tables {
        purge_unknown_rows(conn, *table, &legacy_ids, &index_keys)?;
        for mapping in mappings {
            conn.execute(
                &format!(
                    "UPDATE OR REPLACE {} SET {} = ?2 WHERE {} = ?1",
                    table.table, table.column, table.column
                ),
                [&mapping.legacy_id, &mapping.index_key],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(index_key) = empty_bucket_index_key {
            conn.execute(
                &format!(
                    "UPDATE OR REPLACE {} SET {} = ?2 WHERE {} = ?1",
                    table.table, table.column, table.column
                ),
                ["", index_key],
            )
            .map_err(|e| e.to_string())?;
        }
        table_completed(table.table)?;
    }
    Ok(())
}

pub(super) fn inspect_tables(
    db_path: &Path,
    tables: &[ScopedTable],
    legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<(HashMap<String, u64>, u64, u64), String> {
    let mut counts = HashMap::new();
    if !db_path.exists() {
        return Ok((counts, 0, 0));
    }
    let conn = open_readonly(db_path)?;
    let mut total = 0_u64;
    let mut skipped_unknown_server_rows = 0_u64;
    for table in tables {
        let count = count_rows_in(&conn, *table, legacy_ids)? as u64;
        if count > 0 {
            counts.insert(table.table.to_string(), count);
            total = total.saturating_add(count);
        }
        let unknown = count_unknown_rows(&conn, *table, legacy_ids, known_index_keys)? as u64;
        skipped_unknown_server_rows = skipped_unknown_server_rows.saturating_add(unknown);
    }
    Ok((counts, total, skipped_unknown_server_rows))
}

pub(super) fn count_rows_in(
    conn: &Connection,
    table: ScopedTable,
    values: &[String],
) -> Result<i64, String> {
    if values.is_empty() {
        return Ok(0);
    }
    let placeholders = std::iter::repeat_n("?", values.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT COUNT(*) FROM {} WHERE {} IN ({placeholders})",
        table.table, table.column
    );
    conn.query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))
        .map_err(|e| e.to_string())
}

pub(super) fn count_rows_eq(
    conn: &Connection,
    table: ScopedTable,
    value: &str,
) -> Result<i64, String> {
    conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM {} WHERE {} = ?1",
            table.table, table.column
        ),
        [&value],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub(super) fn count_unknown_rows(
    conn: &Connection,
    table: ScopedTable,
    known_legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<i64, String> {
    let known = known_server_ids(known_legacy_ids, known_index_keys);
    if known.is_empty() {
        return conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE {} <> ''",
                    table.table, table.column
                ),
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string());
    }
    let placeholders = std::iter::repeat_n("?", known.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT COUNT(*) FROM {} WHERE {} <> '' AND {} NOT IN ({placeholders})",
        table.table, table.column, table.column
    );
    conn.query_row(&sql, params_from_iter(known.iter()), |row| row.get(0))
        .map_err(|e| e.to_string())
}

pub(super) fn purge_unknown_rows(
    conn: &Connection,
    table: ScopedTable,
    known_legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<(), String> {
    let known = known_server_ids(known_legacy_ids, known_index_keys);
    if known.is_empty() {
        conn.execute(
            &format!("DELETE FROM {} WHERE {} <> ''", table.table, table.column),
            [],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let placeholders = std::iter::repeat_n("?", known.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "DELETE FROM {} WHERE {} <> '' AND {} NOT IN ({placeholders})",
        table.table, table.column, table.column
    );
    conn.execute(&sql, params_from_iter(known.iter()))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn known_server_ids(known_legacy_ids: &[String], known_index_keys: &[String]) -> Vec<String> {
    let mut known: Vec<String> = Vec::new();
    known.extend(known_legacy_ids.iter().cloned());
    known.extend(known_index_keys.iter().cloned());
    known.sort();
    known.dedup();
    known
}

pub(super) fn sum_table_rows(conn: &Connection, tables: &[ScopedTable]) -> Result<u64, String> {
    let mut total = 0_u64;
    for table in tables {
        let rows: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {}", table.table),
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        total = total.saturating_add(rows.max(0) as u64);
    }
    Ok(total)
}

pub(super) fn sum_unknown_rows(
    conn: &Connection,
    tables: &[ScopedTable],
    known_legacy_ids: &[String],
    known_index_keys: &[String],
) -> Result<u64, String> {
    let mut total = 0_u64;
    for table in tables {
        let rows = count_unknown_rows(conn, *table, known_legacy_ids, known_index_keys)?;
        total = total.saturating_add(rows.max(0) as u64);
    }
    Ok(total)
}

pub(super) fn with_foreign_keys_disabled<T>(
    conn: &Connection,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;")
        .map_err(|e| e.to_string())?;
    let result = operation();
    match result {
        Ok(value) => {
            if let Err(err) = conn
                .execute_batch("COMMIT; PRAGMA foreign_keys = ON;")
                .map_err(|e| e.to_string())
            {
                let _ = conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
                return Err(err);
            }
            ensure_foreign_keys_clean(conn)?;
            Ok(value)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK; PRAGMA foreign_keys = ON;");
            Err(err)
        }
    }
}

pub(super) fn ensure_foreign_keys_clean(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let table: String = row.get(0).map_err(|e| e.to_string())?;
        let rowid: i64 = row.get(1).map_err(|e| e.to_string())?;
        let parent: String = row.get(2).map_err(|e| e.to_string())?;
        let fkid: i64 = row.get(3).map_err(|e| e.to_string())?;
        return Err(format!(
            "foreign key check failed table={table} rowid={rowid} parent={parent} fkid={fkid}"
        ));
    }
    Ok(())
}

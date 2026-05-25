//! Library cursor scan for background cover disk warm-up.

use crate::store::LibraryStore;

const DEFAULT_BATCH: u32 = 16;
const MAX_BATCH: u32 = 32;
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverBackfillBatchDto {
    pub cover_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub exhausted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverProgressDto {
    pub total_distinct: i64,
    pub pending: i64,
    pub done: i64,
}

pub fn collect_cover_backfill_batch(
    store: &LibraryStore,
    library_server_id: &str,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<LibraryCoverBackfillBatchDto, String> {
    let want = limit.unwrap_or(DEFAULT_BATCH).min(MAX_BATCH) as i64;
    let after = cursor.unwrap_or("");

    let rows: Vec<String> = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT cover_art_id FROM album \
             WHERE server_id = ?1 AND cover_art_id IS NOT NULL AND cover_art_id > '' \
             AND cover_art_id > ?2 \
             ORDER BY cover_art_id ASC LIMIT ?3",
        )?;
        let ids = stmt
            .query_map(rusqlite::params![library_server_id, after, want], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    })?;

    let exhausted = (rows.len() as i64) < want;
    let next_cursor = rows.last().cloned();
    Ok(LibraryCoverBackfillBatchDto {
        cover_ids: rows,
        next_cursor: if exhausted { None } else { next_cursor },
        exhausted,
    })
}

pub fn collect_cover_progress(
    store: &LibraryStore,
    library_server_id: &str,
) -> Result<LibraryCoverProgressDto, String> {
    let total: i64 = store.with_read_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(DISTINCT cover_art_id) FROM album \
             WHERE server_id = ?1 AND cover_art_id IS NOT NULL AND cover_art_id > ''",
            rusqlite::params![library_server_id],
            |row| row.get(0),
        )
    })?;
    Ok(LibraryCoverProgressDto {
        total_distinct: total,
        pending: total,
        done: 0,
    })
}

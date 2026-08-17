use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, OptionalExtension};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use super::common::{
    keyed_detail_track_source, plain_track_columns_sql, scope_cte_sql, TRACK_DEDUP_KEY,
};
use crate::dto::{LibraryScopePair, LibraryTrackDto};
use crate::repos::row_to_track_row;
use crate::search::aliased_track_columns;

pub(super) fn fetch_scope_deduped_tracks_for_artist_key(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
    top_tracks_limit: Option<u32>,
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let order_and_limit = if top_tracks_limit.is_some() {
        "ORDER BY play_count DESC NULLS LAST, played_at DESC NULLS LAST, title COLLATE NOCASE ASC LIMIT ?"
    } else {
        "ORDER BY album COLLATE NOCASE ASC, track_number ASC NULLS LAST, title COLLATE NOCASE ASC"
    };
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, {priority} AS pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY {priority} ASC, t.id ASC) AS rn \
           {scoped} AND t.artist_id IS NOT NULL {key_filter} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 {order_and_limit}",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    if let Some(limit) = top_tracks_limit {
        binds.push(SqlValue::Integer(i64::from(limit.clamp(1, 50))));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(binds.iter()), |r| {
            Ok(LibraryTrackDto::from_row(&row_to_track_row(r)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(super) fn fetch_top_tracks_server_id(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<Option<String>> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, priority) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let sql = format!(
        "{cte}, \
         server_counts AS ( \
           SELECT t.server_id, COUNT(DISTINCT {TRACK_DEDUP_KEY}) AS track_count, \
                  MIN({priority}) AS best_pr \
           {scoped} AND t.artist_id IS NOT NULL {key_filter} \
           GROUP BY t.server_id \
         ) \
         SELECT server_id FROM server_counts \
         ORDER BY track_count DESC, best_pr ASC, server_id ASC LIMIT 1",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    conn.query_row(&sql, params_from_iter(binds.iter()), |row| row.get(0))
        .optional()
}

pub(super) fn fetch_top_tracks_fingerprint(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
    artist_key: Option<&str>,
    anchor_server: &str,
    anchor_artist_id: &str,
) -> rusqlite::Result<String> {
    let (scope_cte, scope_binds) = scope_cte_sql(scopes);
    let (cte, scoped, key_filter, _) = keyed_detail_track_source(
        scope_cte,
        artist_key.map(|_| "artist_key"),
        "AND t.server_id = ? AND t.artist_id = ? AND ck.artist_key IS NULL",
    );
    let sql = format!(
        "{cte} \
         SELECT t.server_id, t.id, t.library_id, t.title, t.album_id, t.duration_sec \
         {scoped} AND t.artist_id IS NOT NULL {key_filter} \
         ORDER BY t.server_id ASC, t.id ASC, t.library_id ASC",
        scoped = scoped,
    );
    let mut binds = scope_binds;
    if let Some(key) = artist_key {
        binds.push(SqlValue::Text(key.to_string()));
    } else {
        binds.push(SqlValue::Text(anchor_server.to_string()));
        binds.push(SqlValue::Text(anchor_artist_id.to_string()));
    }
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    let mut hasher = DefaultHasher::new();
    for row in rows {
        row?.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

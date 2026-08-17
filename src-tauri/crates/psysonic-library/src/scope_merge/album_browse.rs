use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;

use super::common::{
    album_row_to_dto, append_extra_where, finish_scope_album_list, map_album_list_row, merge_binds,
    non_empty_scopes, scope_cte_sql, scoped_track_join, ALBUM_DEDUP_KEY, ALBUM_PICK_KEY,
    TRACK_DEDUP_KEY,
};
use crate::dto::{LibraryAlbumDto, LibraryScopePair};
use crate::store::LibraryStore;

/// Layer-1 scoped album browse: sargable `library_id` join, no cluster on single-library
/// scopes; two-stage per-library → `album_key` merge when multiple libraries share a server.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_albums_layer1_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    // `GROUP BY t.album_id` shapes. A sort key that is a plain identifier may be
    // passed as-is (SQLite resolves it to the `MAX(...) AS x` result alias), but a
    // key that wraps the name in an expression — our display-artist `CASE` — must
    // carry the aggregates itself, or the name resolves to the table column and is
    // read from an arbitrary row of the group.
    grouped_order_sql: &str,
    // Dedup shape: the outer select projects plain columns, so plain names are right.
    deduped_order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    merge_by_album_key: bool,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    if scopes.len() == 1 {
        let pair = &scopes[0];
        let mut where_parts = vec![
            "t.deleted = 0".to_string(),
            "t.server_id = ?".to_string(),
            "t.library_id = ?".to_string(),
            "t.album_id IS NOT NULL AND t.album_id != ''".to_string(),
        ];
        if !extra_where.trim().is_empty() {
            where_parts.push(extra_where.to_string());
        }
        let where_sql = where_parts.join(" AND ");
        let mut params = vec![
            SqlValue::Text(pair.server_id.clone()),
            SqlValue::Text(pair.library_id.clone().unwrap_or_default()),
        ];
        params.extend_from_slice(extra_params);

        let count_sql = format!("SELECT COUNT(DISTINCT t.album_id) FROM track t WHERE {where_sql}");
        // Grouped shape: the ORDER BY must carry the aggregates itself. Aliasing the
        // sort columns is not enough — SQLite substitutes a result alias only when the
        // whole ORDER BY term is a plain identifier, so a bare name inside the
        // display-artist CASE would resolve to the table column and be read from an
        // arbitrary row of the group.
        let sql = format!(
            "SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                    MAX(t.artist_id), MAX(t.album_artist) AS album_artist, COUNT(*), \
                    SUM(t.duration_sec), MAX(t.year) AS year, MAX(t.genre), \
                    MAX(t.cover_art_id), MAX(t.starred_at), MAX(t.synced_at) \
             FROM track t WHERE {where_sql} \
             GROUP BY t.album_id \
             {grouped_order_sql} \
             LIMIT ? OFFSET ?"
        );
        let total = if skip_totals {
            0u32
        } else {
            store.with_read_conn(|conn| {
                let n: i64 =
                    conn.query_row(&count_sql, params_from_iter(params.iter()), |r| r.get(0))?;
                Ok(n.max(0) as u32)
            })?
        };
        if limit == 0 {
            return Ok((Vec::new(), total));
        }
        params.push(SqlValue::Integer(i64::from(limit)));
        params.push(SqlValue::Integer(i64::from(offset)));
        let albums = store.with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(params.iter()), map_album_list_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().map(album_row_to_dto).collect())
        })?;
        return finish_scope_album_list(store, albums, total);
    }

    if !merge_by_album_key && extra_where.trim().is_empty() {
        let server_id = &scopes[0].server_id;
        if scopes.iter().all(|p| &p.server_id == server_id) {
            let in_clause = scopes.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
            let where_sql = format!(
                "t.deleted = 0 AND t.server_id = ? AND t.library_id IN ({in_clause}) \
                 AND t.album_id IS NOT NULL AND t.album_id != ''"
            );
            let mut params = vec![SqlValue::Text(server_id.clone())];
            for p in scopes {
                params.push(SqlValue::Text(p.library_id.clone().unwrap_or_default()));
            }
            let count_sql =
                format!("SELECT COUNT(DISTINCT t.album_id) FROM track t WHERE {where_sql}");
            // Grouped shape — same reasoning as the single-scope branch above.
            let sql = format!(
                "SELECT t.server_id, t.album_id, MAX(t.album) AS album, MAX(t.artist) AS artist, \
                        MAX(t.artist_id), MAX(t.album_artist) AS album_artist, COUNT(*), \
                        SUM(t.duration_sec), MAX(t.year) AS year, MAX(t.genre), \
                        MAX(t.cover_art_id), MAX(t.starred_at), MAX(t.synced_at) \
                 FROM track t WHERE {where_sql} \
                 GROUP BY t.album_id \
                 {grouped_order_sql} \
                 LIMIT ? OFFSET ?"
            );
            let total = if skip_totals {
                0u32
            } else {
                store.with_read_conn(|conn| {
                    let n: i64 =
                        conn.query_row(&count_sql, params_from_iter(params.iter()), |r| r.get(0))?;
                    Ok(n.max(0) as u32)
                })?
            };
            if limit == 0 {
                return Ok((Vec::new(), total));
            }
            params.push(SqlValue::Integer(i64::from(limit)));
            params.push(SqlValue::Integer(i64::from(offset)));
            let albums = store.with_read_conn(|conn| {
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params_from_iter(params.iter()), map_album_list_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.into_iter().map(album_row_to_dto).collect())
            })?;
            return finish_scope_album_list(store, albums, total);
        }
    }

    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped = scoped_track_join();
    let base_where = append_extra_where(
        &format!("{scoped} AND t.album_id IS NOT NULL AND t.album_id != ''"),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let (count_sql, sql) = (
        format!(
            "{cte}, \
             per_lib AS ( \
               SELECT t.server_id, t.album_id, s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, \
                      MIN({ALBUM_PICK_KEY}) AS _pick \
               {base_where} \
               GROUP BY album_dedup, t.server_id, t.album_id, s.pr \
             ) \
             SELECT COUNT(DISTINCT album_dedup) FROM per_lib"
        ),
        format!(
            "{cte}, \
             base AS ( \
                SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                       t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, \
                       t.duration_sec, t.id, s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, \
                       {TRACK_DEDUP_KEY} AS track_dedup \
                {base_where} \
             ), \
             track_winners AS ( \
               SELECT * FROM ( \
                 SELECT base.*, ROW_NUMBER() OVER ( \
                   PARTITION BY album_dedup, track_dedup \
                   ORDER BY pr, server_id, album_id, id \
                 ) AS track_rank \
                 FROM base \
               ) WHERE track_rank = 1 \
             ) \
             SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                    song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
             FROM ( \
                SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                       year, genre, cover_art_id, starred_at, synced_at, \
                       COUNT(*) AS song_count, SUM(duration_sec) AS duration_total, \
                       MIN(_pick) AS _pick \
                FROM ( \
                  SELECT track_winners.*, {ALBUM_PICK_KEY} AS _pick \
                  FROM track_winners \
                ) GROUP BY album_dedup \
             ) \
             {deduped_order_sql} \
             LIMIT ? OFFSET ?"
        ),
    );

    let total = if skip_totals {
        0u32
    } else {
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };
    if limit == 0 {
        return Ok((Vec::new(), total));
    }

    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let albums = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_album_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(album_row_to_dto).collect())
    })?;
    finish_scope_album_list(store, albums, total)
}

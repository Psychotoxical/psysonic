use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;

use super::browse_lists::{artist_row_to_dto, map_artist_list_row};
use super::common::{
    append_extra_where, ensure_cluster_keys_for_scopes, merge_binds, non_empty_scopes,
    scope_cte_sql, scoped_track_join, scoped_track_join_layer1, ARTIST_DEDUP_KEY, ARTIST_PICK_KEY,
};
use crate::dto::{LibraryArtistDto, LibraryScopePair};
use crate::store::LibraryStore;

/// Layer-1 scoped artist browse — sargable scope join; two-stage merge when `scopes.len() > 1`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_artists_layer1_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    ensure_cluster_keys_for_scopes(store, scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped = if scopes.len() == 1 {
        scoped_track_join_layer1()
    } else {
        scoped_track_join()
    };
    let base_where = append_extra_where(
        &format!("{scoped} AND t.artist_id IS NOT NULL AND t.artist_id != ''"),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let (count_sql, sql) = if scopes.len() == 1 {
        (
            format!("{cte} SELECT COUNT(DISTINCT t.artist_id) {base_where}"),
            format!(
                "{cte} \
                 SELECT t.server_id, t.artist_id, MAX(t.artist), COUNT(DISTINCT t.album_id), MAX(t.synced_at) \
                 {base_where} \
                 GROUP BY t.artist_id \
                 {order_sql} \
                 LIMIT ? OFFSET ?"
            ),
        )
    } else {
        (
            format!(
                "{cte}, \
                 per_lib AS ( \
                   SELECT t.server_id, t.artist_id, s.pr, {ARTIST_DEDUP_KEY} AS artist_dedup, \
                          MIN({ARTIST_PICK_KEY}) AS _pick \
                   {base_where} \
                   GROUP BY artist_dedup, t.server_id, t.artist_id, s.pr \
                 ) \
                 SELECT COUNT(DISTINCT artist_dedup) FROM per_lib"
            ),
            format!(
                "{cte}, \
                 per_lib AS ( \
                   SELECT t.server_id, t.artist_id, t.artist, t.album_id, t.synced_at, s.pr, \
                          {ARTIST_DEDUP_KEY} AS artist_dedup, MIN({ARTIST_PICK_KEY}) AS _pick \
                   {base_where} \
                   GROUP BY artist_dedup, t.server_id, t.artist_id, s.pr \
                 ) \
                 SELECT server_id, artist_id, artist, album_count, synced_at \
                 FROM ( \
                   SELECT server_id, artist_id, artist, synced_at, \
                          COUNT(DISTINCT album_id) AS album_count, MIN(_pick) AS _pick \
                   FROM per_lib GROUP BY artist_dedup \
                 ) \
                 {order_sql} \
                 LIMIT ? OFFSET ?"
            ),
        )
    };

    let total = if skip_totals {
        0u32
    } else {
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };

    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let artists = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })?;
    Ok((artists, total))
}

/// Layer-1 scoped browse over the `artist` table (#1209) — drive from the scoped
/// track set (sargable `scope` CTE join), then join `artist` rows. Avoids a
/// correlated EXISTS over the full server-wide `artist` table.
///
/// The `CROSS JOIN` in `scoped_ids` is what makes that description true rather
/// than merely intended. `album_scoped` is a CTE, so SQLite has no row estimate
/// for it, and the only thing tying `artist` to it is a function call
/// (`psysonic_lower_name`) — not a column it can index on. Left as a plain
/// `INNER JOIN` the planner drove from `artist` instead and re-scanned the whole
/// CTE per artist row: on a 172k-track library that is 4.9k × 11.2k rows and the
/// query never returns. `CROSS JOIN` fixes the order; the `INDEXED BY` then
/// guarantees the inner lookup uses `(server_id, name_fold)` and fails loudly if
/// that index is ever dropped.
///
/// The multi-scope sibling does not need this: its join carries
/// `ar.server_id = ac.server_id`, a real column equality the planner can cost.
///
/// Held as a constant so a test can assert the two keywords are still there —
/// dropping either one produces a query that is correct and never returns, which
/// no result-based test can catch.
pub(crate) const LAYER1_ARTIST_CREDIT_JOIN_SQL: &str =
    "CROSS JOIN artist ar INDEXED BY idx_artist_name_fold \
       ON ar.server_id = ? AND ar.album_count IS NOT NULL \
       AND ar.name_fold = psysonic_lower_name(ac.credit_name)";

#[allow(clippy::too_many_arguments)]
pub(crate) fn list_index_artists_layer1_filtered(
    store: &LibraryStore,
    server_id: &str,
    scopes: &[LibraryScopePair],
    album_artists_only: bool,
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    ensure_cluster_keys_for_scopes(store, scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let scoped_from = "FROM scope s \
         CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id";
    let credited_cte = if album_artists_only {
        // #1209: album credit = one row per album-level credit in scope, not every
        // track performer with a server-wide `album_count` index row.
        format!(
            "{cte}, \
             album_scoped AS ( \
                 SELECT t.album_id, \
                        COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
               {scoped_from} \
               WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
               GROUP BY t.album_id \
             ), \
             scoped_ids AS ( \
               SELECT DISTINCT ar.id \
               FROM album_scoped ac \
                {LAYER1_ARTIST_CREDIT_JOIN_SQL} \
             )"
        )
    } else {
        format!(
            "{cte}, \
             scoped_ids AS ( \
               SELECT DISTINCT t.artist_id AS id \
               {scoped_from} \
               WHERE t.deleted = 0 AND t.artist_id IS NOT NULL AND t.artist_id != '' \
             )"
        )
    };
    let mut ar_where = "FROM artist ar \
         INNER JOIN scoped_ids si ON si.id = ar.id \
         WHERE ar.server_id = ?"
        .to_string();
    if album_artists_only {
        ar_where.push_str(" AND ar.album_count IS NOT NULL");
    }
    if !extra_where.trim().is_empty() {
        ar_where = append_extra_where(&ar_where, extra_where);
    }

    let count_sql = format!("{credited_cte} SELECT COUNT(*) {ar_where}");
    let select_sql = format!(
        "{credited_cte} SELECT ar.server_id, ar.id, ar.name, ar.album_count, ar.synced_at \
         {ar_where} {order_sql} LIMIT ? OFFSET ?"
    );

    let mut binds = scope_binds;
    if album_artists_only {
        binds.push(SqlValue::Text(server_id.to_string()));
    }
    binds.push(SqlValue::Text(server_id.to_string()));
    binds.extend_from_slice(extra_params);

    let total = if skip_totals {
        0u32
    } else {
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };

    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    let artists = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&select_sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })?;
    Ok((artists, total))
}

/// Multi-server Album artists browse. Album credits can differ from every track
/// performer, so derive them from `album_artist` and resolve the matching indexed
/// artist row by its persisted Unicode fold before priority-deduplicating names.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_index_artists_multi_scope_album_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryArtistDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let artist_where = if extra_where.trim().is_empty() {
        "ar.album_count IS NOT NULL".to_string()
    } else {
        format!("ar.album_count IS NOT NULL AND {extra_where}")
    };
    let credits_cte = format!(
        "{cte}, \
         album_credits AS ( \
           SELECT t.server_id, t.album_id, s.pr, \
                  COALESCE(NULLIF(MAX(trim(t.album_artist)), ''), MIN(t.artist)) AS credit_name \
           FROM scope s \
           CROSS JOIN track t ON t.server_id = s.server_id AND t.library_id = s.library_id \
           WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
           GROUP BY t.server_id, t.album_id, s.pr \
         ), \
         matched AS ( \
           SELECT ar.server_id, ar.id AS artist_id, ar.name AS artist, ar.name_fold, \
                  ac.album_id, ac.pr, ar.synced_at \
           FROM album_credits ac \
           INNER JOIN artist ar ON ar.server_id = ac.server_id \
             AND ar.name_fold = psysonic_lower_name(ac.credit_name) \
           WHERE {artist_where} \
         ), \
         deduped AS ( \
           SELECT server_id, artist_id, artist, synced_at, \
                  COUNT(DISTINCT server_id || ':' || album_id) AS album_count, \
                  MIN(printf('%08d|%s|%s', pr, server_id, artist_id)) AS _pick \
           FROM matched GROUP BY name_fold \
         )"
    );
    let count_sql = format!("{credits_cte} SELECT COUNT(*) FROM deduped");
    let select_sql = format!(
        "{credits_cte} SELECT server_id, artist_id, artist, album_count, synced_at \
         FROM deduped {order_sql} LIMIT ? OFFSET ?"
    );
    let mut binds = merge_binds(scope_binds, extra_params);
    let total = if skip_totals {
        0
    } else {
        store.with_read_conn(|conn| {
            let count: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |row| row.get(0))?;
            Ok(count.max(0) as u32)
        })?
    };
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));
    let artists = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&select_sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })?;
    Ok((artists, total))
}

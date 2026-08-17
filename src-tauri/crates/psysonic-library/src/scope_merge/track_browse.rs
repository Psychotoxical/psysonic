use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;

use super::browse_lists::{artist_row_to_dto, map_artist_list_row};
use super::common::{
    album_row_to_dto, append_extra_where, ensure_cluster_keys_for_all_scopes,
    finish_scope_album_list, map_album_list_row, merge_binds, non_empty_scopes,
    plain_track_columns_sql, random_window_offset, scope_cte_sql, scoped_track_join,
    scoped_track_join_layer1, ALBUM_DEDUP_KEY, ALBUM_PICK_KEY, ARTIST_DEDUP_KEY, ARTIST_PICK_KEY,
    TRACK_DEDUP_KEY, TRACK_FTS_BM25_RANK,
};
use crate::dto::{LibraryAlbumDto, LibraryArtistDto, LibraryScopePair, LibraryTrackDto};
use crate::repos::row_to_track_row;
use crate::search::{aliased_track_columns, PAGE_LIMIT_MAX};
use crate::store::LibraryStore;

/// Layer-1 scoped track browse — sargable join, no cross-library dedup window.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_tracks_layer1_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    bpm_resolved: bool,
    random_window: bool,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(scoped_track_join_layer1(), extra_where);
    let mut binds = merge_binds(scope_binds, extra_params);

    let cols = if bpm_resolved {
        crate::search::aliased_track_columns_resolved_bpm("t")
    } else {
        aliased_track_columns("t")
    };

    let matching_total = if skip_totals && !random_window {
        0u32
    } else {
        let count_sql = format!("{cte} SELECT COUNT(*) {base_where}");
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };

    let total = if skip_totals { 0 } else { matching_total };
    let page_offset = if random_window {
        random_window_offset(matching_total, limit)
    } else {
        offset
    };
    let page_order = if random_window { "" } else { order_sql };

    let sql = format!("{cte} SELECT {cols} {base_where} {page_order} LIMIT ? OFFSET ?");
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(page_offset)));

    let tracks = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                if bpm_resolved {
                    crate::search::row_to_track_dto_resolved_bpm(r)
                } else {
                    row_to_track_row(r).map(|tr| LibraryTrackDto::from_row(&tr))
                }
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    Ok((tracks, total))
}

/// Multi-scope album browse with track-level filters (advanced search / genre).
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_albums_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryAlbumDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(
        &format!(
            "{scoped} AND t.album_id IS NOT NULL AND t.album_id != ''",
            scoped = scoped_track_join()
        ),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let total = if skip_totals {
        0u32
    } else {
        let count_sql = format!(
            "{cte} \
             SELECT COUNT(DISTINCT {ALBUM_DEDUP_KEY}) \
             {base_where}"
        );
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };
    if limit == 0 {
        return Ok((Vec::new(), total));
    }

    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                  s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
           {base_where} \
         ) \
         SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                song_count, duration_total, year, genre, cover_art_id, starred_at, synced_at \
         FROM ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, \
                  COUNT(DISTINCT track_dedup) AS song_count, SUM(duration_sec) AS duration_total, \
                  MIN({ALBUM_PICK_KEY}) AS _pick \
           FROM base GROUP BY album_dedup \
         ) \
         {order_sql} \
         LIMIT ? OFFSET ?"
    );
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

/// Multi-scope artist browse with track-level filters (advanced search).
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_artists_filtered(
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
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(
        &format!(
            "{scoped} AND t.artist_id IS NOT NULL AND t.artist_id != ''",
            scoped = scoped_track_join()
        ),
        extra_where,
    );
    let mut binds = merge_binds(scope_binds, extra_params);

    let total = if skip_totals {
        0u32
    } else {
        let count_sql = format!(
            "{cte} \
             SELECT COUNT(DISTINCT {ARTIST_DEDUP_KEY}) \
             {base_where}"
        );
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };

    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.artist_id, t.artist, t.album_id, t.synced_at, s.pr, \
                  {ARTIST_DEDUP_KEY} AS artist_dedup \
           {base_where} \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at \
         FROM ( \
           SELECT server_id, artist_id, artist, synced_at, \
                  COUNT(DISTINCT album_id) AS album_count, \
                  MIN({ARTIST_PICK_KEY}) AS _pick \
           FROM base GROUP BY artist_dedup \
         ) \
         {order_sql} \
         LIMIT ? OFFSET ?",
    );
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

/// Multi-scope track browse (no FTS) with track-level filters.
#[allow(clippy::too_many_arguments)]
pub(crate) fn list_tracks_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
    order_sql: &str,
    limit: u32,
    offset: u32,
    skip_totals: bool,
    bpm_resolved: bool,
    random_window: bool,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let base_where = append_extra_where(scoped_track_join(), extra_where);
    let mut binds = merge_binds(scope_binds, extra_params);

    let cols = if bpm_resolved {
        crate::search::aliased_track_columns_resolved_bpm("t")
    } else {
        aliased_track_columns("t")
    };
    let plain_cols = plain_track_columns_sql();

    let matching_total = if skip_totals && !random_window {
        0u32
    } else {
        let count_sql = format!(
            "{cte} \
             SELECT COUNT(DISTINCT {TRACK_DEDUP_KEY}) \
             {base_where}"
        );
        store.with_read_conn(|conn| {
            let n: i64 =
                conn.query_row(&count_sql, params_from_iter(binds.iter()), |r| r.get(0))?;
            Ok(n.max(0) as u32)
        })?
    };

    let total = if skip_totals { 0 } else { matching_total };
    let page_offset = if random_window {
        random_window_offset(matching_total, limit)
    } else {
        offset
    };
    let page_order = if random_window { "" } else { order_sql };

    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT {cols}, s.pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY s.pr ASC, t.id ASC) AS rn \
           {base_where} \
         ) \
         SELECT {plain_cols} FROM ranked WHERE rn = 1 \
         {page_order} \
         LIMIT ? OFFSET ?",
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(page_offset)));

    let tracks = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), |r| {
                if bpm_resolved {
                    crate::search::row_to_track_dto_resolved_bpm(r)
                } else {
                    row_to_track_row(r).map(|tr| LibraryTrackDto::from_row(&tr))
                }
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;
    Ok((tracks, total))
}

pub(crate) fn collect_scope_fts_rowids(
    conn: &rusqlite::Connection,
    fts: &str,
    scopes: &[LibraryScopePair],
    limit: i64,
) -> rusqlite::Result<Vec<i64>> {
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte} \
         SELECT f.rowid FROM track_fts f \
         WHERE track_fts MATCH ? \
           AND EXISTS ( \
             SELECT 1 FROM track c \
             INNER JOIN scope sc ON c.server_id = sc.server_id AND c.library_id = sc.library_id \
             WHERE c.rowid = f.rowid AND c.deleted = 0 \
           ) \
         ORDER BY {TRACK_FTS_BM25_RANK} LIMIT ?",
    );
    let mut binds = scope_binds;
    binds.push(SqlValue::Text(fts.to_string()));
    binds.push(SqlValue::Integer(limit));
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<i64> = stmt
        .query_map(params_from_iter(binds.iter()), |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn row_to_track_row_at(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<crate::repos::track::TrackRow> {
    Ok(crate::repos::track::TrackRow {
        server_id: row.get(offset)?,
        id: row.get(offset + 1)?,
        title: row.get(offset + 2)?,
        title_sort: row.get(offset + 3)?,
        artist: row.get(offset + 4)?,
        artist_id: row.get(offset + 5)?,
        album: row.get(offset + 6)?,
        album_id: row.get(offset + 7)?,
        album_artist: row.get(offset + 8)?,
        duration_sec: row.get(offset + 9)?,
        track_number: row.get(offset + 10)?,
        disc_number: row.get(offset + 11)?,
        year: row.get(offset + 12)?,
        genre: row.get(offset + 13)?,
        suffix: row.get(offset + 14)?,
        bit_rate: row.get(offset + 15)?,
        size_bytes: row.get(offset + 16)?,
        cover_art_id: row.get(offset + 17)?,
        starred_at: row.get(offset + 18)?,
        user_rating: row.get(offset + 19)?,
        play_count: row.get(offset + 20)?,
        played_at: row.get(offset + 21)?,
        server_path: row.get(offset + 22)?,
        library_id: row.get(offset + 23)?,
        isrc: row.get(offset + 24)?,
        mbid_recording: row.get(offset + 25)?,
        bpm: row.get(offset + 26)?,
        replay_gain_track_db: row.get(offset + 27)?,
        replay_gain_album_db: row.get(offset + 28)?,
        replay_gain_peak: row.get(offset + 29)?,
        content_hash: row.get(offset + 30)?,
        server_updated_at: row.get(offset + 31)?,
        server_created_at: row.get(offset + 32)?,
        deleted: row.get::<_, i64>(offset + 33)? != 0,
        synced_at: row.get(offset + 34)?,
        raw_json: row.get(offset + 35)?,
    })
}

pub(super) fn fetch_deduped_tracks_by_rowids(
    conn: &rusqlite::Connection,
    rowids: &[i64],
    scopes: &[LibraryScopePair],
    extra_where: &str,
    extra_params: &[SqlValue],
) -> rusqlite::Result<Vec<LibraryTrackDto>> {
    if rowids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (0..rowids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let (cte, scope_binds) = scope_cte_sql(scopes);
    let cols = aliased_track_columns("t");
    let plain_cols = plain_track_columns_sql();
    let base_where = append_extra_where(
        &format!(
            "{scoped} AND t.rowid IN ({placeholders})",
            scoped = scoped_track_join()
        ),
        extra_where,
    );
    let sql = format!(
        "{cte}, \
         ranked AS ( \
           SELECT t.rowid AS fts_rowid, {cols}, s.pr, {TRACK_DEDUP_KEY} AS track_dedup, \
                  ROW_NUMBER() OVER (PARTITION BY {TRACK_DEDUP_KEY} ORDER BY s.pr ASC, t.id ASC) AS rn \
           {base_where} \
         ) \
         SELECT fts_rowid, {plain_cols} FROM ranked WHERE rn = 1",
    );
    let mut binds: Vec<SqlValue> = scope_binds;
    binds.extend(rowids.iter().copied().map(SqlValue::Integer));
    binds.extend_from_slice(extra_params);

    let mut stmt = conn.prepare(&sql)?;
    let mut by_rowid: std::collections::HashMap<i64, LibraryTrackDto> =
        std::collections::HashMap::new();
    for row in stmt.query_map(params_from_iter(binds.iter()), |r| {
        let fts_rowid: i64 = r.get(0)?;
        let track_row = row_to_track_row_at(r, 1)?;
        Ok((fts_rowid, LibraryTrackDto::from_row(&track_row)))
    })? {
        let (rowid, dto) = row?;
        by_rowid.insert(rowid, dto);
    }
    Ok(rowids
        .iter()
        .filter_map(|rid| by_rowid.get(rid).cloned())
        .collect())
}

/// FTS-first multi-scope track search with optional scalar filters.
pub(crate) fn search_tracks_filtered(
    store: &LibraryStore,
    scopes: &[LibraryScopePair],
    fts_match: &str,
    extra_where: &str,
    extra_params: &[SqlValue],
    limit: u32,
    skip_totals: bool,
) -> Result<(Vec<LibraryTrackDto>, u32), String> {
    let scopes = non_empty_scopes(scopes)?;
    let pool = (i64::from(limit) * 4).clamp(64, i64::from(PAGE_LIMIT_MAX) * 4);

    store.with_read_conn(|conn| {
        let rowids = collect_scope_fts_rowids(conn, fts_match, scopes, pool)?;
        let mut tracks =
            fetch_deduped_tracks_by_rowids(conn, &rowids, scopes, extra_where, extra_params)?;
        let total = if skip_totals {
            0u32
        } else {
            tracks.len() as u32
        };
        tracks.truncate(limit as usize);
        Ok((tracks, total))
    })
}

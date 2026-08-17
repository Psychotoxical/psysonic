use rusqlite::params_from_iter;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use super::album_browse::list_albums_layer1_filtered;
use super::common::{
    album_order_sql, album_row_to_dto, artist_order_sql, clamp_limit, clamp_offset,
    ensure_cluster_keys_for_all_scopes, ensure_cluster_keys_for_scopes, map_album_list_row,
    non_empty_scopes, scope_cte_sql, scoped_track_join, ALBUM_DEDUP_KEY, ALBUM_PICK_KEY,
    ARTIST_DEDUP_KEY, ARTIST_PICK_KEY, TRACK_DEDUP_KEY,
};
use crate::artist_sort::{sort_key_for_display_name, DEFAULT_IGNORED_ARTICLES};
use crate::browse_support::{overlay_album_artist_links, overlay_album_starred_at_rows};
use crate::dto::{LibraryAlbumDto, LibraryArtistDto, LibraryScopeListRequest};
use crate::store::LibraryStore;

pub fn list_albums(
    store: &LibraryStore,
    request: &LibraryScopeListRequest,
) -> Result<Vec<LibraryAlbumDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_scopes(store, scopes)?;
    let order = album_order_sql(request.sort.as_deref());
    let limit = clamp_limit(request.limit);
    let offset = clamp_offset(request.offset);
    if crate::dto::scoped_layer1_eligible(scopes) {
        // Plain-identifier keys (`ORDER BY artist COLLATE NOCASE`), which SQLite
        // resolves to the `MAX(...) AS x` aliases in the grouped shape and to the
        // projected columns in the dedup shape — correct either way, so one string
        // serves both.
        let (albums, _) = list_albums_layer1_filtered(
            store,
            scopes,
            "",
            &[],
            &order,
            &order,
            limit,
            offset,
            true,
            true,
        )?;
        return Ok(albums);
    }

    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.duration_sec, t.id, \
                  s.pr, {ALBUM_DEDUP_KEY} AS album_dedup, {TRACK_DEDUP_KEY} AS track_dedup \
           {scoped} AND t.album_id IS NOT NULL AND t.album_id != '' \
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
         {order} \
         LIMIT ? OFFSET ?",
        scoped = scoped_track_join(),
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_album_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut albums: Vec<LibraryAlbumDto> = rows.into_iter().map(album_row_to_dto).collect();
        overlay_album_starred_at_rows(conn, &mut albums);
        overlay_album_artist_links(conn, &mut albums);
        Ok(albums)
    })
}

pub(super) type ArtistListRow = (String, String, String, i64, i64);

pub(super) fn map_artist_list_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ArtistListRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

pub(super) fn artist_row_to_dto(row: ArtistListRow) -> LibraryArtistDto {
    let (server_id, id, name, album_count, synced_at) = row;
    LibraryArtistDto {
        server_id,
        id,
        name: name.clone(),
        name_sort: Some(sort_key_for_display_name(&name, DEFAULT_IGNORED_ARTICLES)),
        album_count: Some(album_count),
        synced_at,
        raw_json: Value::Null,
    }
}

/// `library_scope_list_artists` — dedup by `artist_key`, priority winner metadata.
pub fn list_artists(
    store: &LibraryStore,
    request: &LibraryScopeListRequest,
) -> Result<Vec<LibraryArtistDto>, String> {
    let scopes = non_empty_scopes(&request.scopes)?;
    ensure_cluster_keys_for_all_scopes(store, scopes)?;
    let limit = clamp_limit(request.limit);
    let offset = clamp_offset(request.offset);
    let order = artist_order_sql(request.sort.as_deref());

    let (cte, mut binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte}, \
         base AS ( \
           SELECT t.server_id, t.artist_id, t.artist, t.album_id, t.synced_at, s.pr, \
                  {ARTIST_DEDUP_KEY} AS artist_dedup \
           {scoped} AND t.artist_id IS NOT NULL AND t.artist_id != '' \
         ) \
         SELECT server_id, artist_id, artist, album_count, synced_at \
         FROM ( \
           SELECT server_id, artist_id, artist, synced_at, \
                  COUNT(DISTINCT album_id) AS album_count, \
                  MIN({ARTIST_PICK_KEY}) AS _pick \
           FROM base GROUP BY artist_dedup \
         ) \
         {order} \
         LIMIT ? OFFSET ?",
        scoped = scoped_track_join(),
    );
    binds.push(SqlValue::Integer(i64::from(limit)));
    binds.push(SqlValue::Integer(i64::from(offset)));

    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(binds.iter()), map_artist_list_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(artist_row_to_dto).collect())
    })
}

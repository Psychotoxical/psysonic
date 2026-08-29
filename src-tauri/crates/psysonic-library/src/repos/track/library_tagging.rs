use std::collections::HashSet;

use psysonic_integration::subsonic::AlbumSummary;
use rusqlite::{params, params_from_iter, Transaction};

use super::TrackRepository;

fn album_summary_version(album: &AlbumSummary) -> Option<&str> {
    album
        .version
        .as_deref()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .or_else(|| {
            album.tags.as_ref().and_then(|tags| {
                tags.albumversion
                    .iter()
                    .map(String::as_str)
                    .map(str::trim)
                    .find(|version| !version.is_empty())
            })
        })
}

fn normalize_page_tag_versions(
    tx: &Transaction<'_>,
    server_id: &str,
    albums: &[AlbumSummary],
) -> rusqlite::Result<()> {
    const CHUNK: usize = 400;
    for chunk in albums.chunks(CHUNK) {
        let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
        let mut values = vec![rusqlite::types::Value::Text(server_id.to_string())];
        values.extend(
            chunk
                .iter()
                .map(|album| rusqlite::types::Value::Text(album.id.clone())),
        );
        for (table, id_column, version_path, live_filter) in [
            ("track", "album_id", "$.albumVersion", "AND deleted = 0"),
            ("album", "id", "$.version", ""),
        ] {
            let sql = format!(
                "UPDATE {table} SET raw_json = json_set( \
                   raw_json, '{version_path}', COALESCE( \
                     CASE WHEN json_type( \
                       raw_json, '$.tags.albumversion' \
                     ) = 'text' THEN NULLIF(TRIM(json_extract( \
                       raw_json, '$.tags.albumversion' \
                     )), '') END, \
                     (SELECT TRIM(tag.value) \
                      FROM json_each( \
                        CASE WHEN json_type( \
                          raw_json, '$.tags.albumversion' \
                        ) = 'array' THEN raw_json ELSE '{{}}' END, \
                        '$.tags.albumversion' \
                      ) AS tag \
                      WHERE tag.type = 'text' \
                        AND NULLIF(TRIM(tag.value), '') IS NOT NULL \
                      LIMIT 1) \
                   ) \
                 ) WHERE server_id = ? AND {id_column} IN ({placeholders}) \
                   {live_filter} \
                   AND json_valid(raw_json) \
                   AND json_type(raw_json, '$') = 'object' \
                   AND NULLIF(TRIM(json_extract(raw_json, '{version_path}')), '') IS NULL \
                   AND ( \
                     (json_type(raw_json, '$.tags.albumversion') = 'text' \
                      AND NULLIF(TRIM(json_extract( \
                        raw_json, '$.tags.albumversion' \
                      )), '') IS NOT NULL) \
                     OR EXISTS ( \
                       SELECT 1 FROM json_each( \
                         CASE WHEN json_type( \
                           raw_json, '$.tags.albumversion' \
                         ) = 'array' THEN raw_json ELSE '{{}}' END, \
                         '$.tags.albumversion' \
                       ) AS tag \
                       WHERE tag.type = 'text' \
                         AND NULLIF(TRIM(tag.value), '') IS NOT NULL \
                     ) \
                   )"
            );
            tx.execute(&sql, params_from_iter(values.iter()))?;
        }
    }
    Ok(())
}

impl TrackRepository<'_> {
    /// Live tracks with no `library_id` hot column (multi-library scope gap).
    pub fn count_untagged_tracks(&self, server_id: &str) -> Result<u64, String> {
        self.store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM track \
                 WHERE server_id = ?1 AND deleted = 0 \
                   AND (library_id IS NULL OR library_id = '')",
                    params![server_id],
                    |row| row.get::<_, i64>(0),
                )
            })
            .map(|n| n.max(0) as u64)
            .map_err(|e| e.to_string())
    }

    /// Apply one `getAlbumList2` page to tracks from a bulk song ingest.
    /// Library ids only fill empty rows; album versions enrich raw metadata
    /// and durably invalidate affected album identities in the same transaction.
    pub fn apply_album_list_page(
        &self,
        server_id: &str,
        library_id: &str,
        albums: &[AlbumSummary],
    ) -> Result<u64, String> {
        if albums.is_empty() {
            return Ok(0);
        }
        const CHUNK: usize = 400;
        let mut total = 0u64;
        self.store
            .with_conn_mut("track.apply_album_list_page", |conn| {
                let tx = conn.transaction()?;
                let mut version_changed_albums = HashSet::new();
                normalize_page_tag_versions(&tx, server_id, albums)?;
                for album in albums {
                    let Some(version) = album_summary_version(album) else {
                        continue;
                    };
                    let track_changes = tx
                        .prepare_cached(
                        "UPDATE track SET raw_json = json_set( \
                           json_remove( \
                             CASE WHEN json_valid(raw_json) THEN \
                               CASE WHEN json_type(raw_json, '$') = 'object' \
                                    THEN raw_json ELSE '{}' END \
                             ELSE '{}' END, \
                             '$.tags.albumversion', \
                             '$._psysonicAlbumVersionNeedsListRefresh' \
                           ), \
                           '$.albumVersion', ?3, \
                           '$._psysonicAlbumVersionFromList', json('true') \
                          ) \
                          WHERE server_id = ?1 AND album_id = ?2 AND deleted = 0 \
                            AND ( \
                              COALESCE( \
                                CASE WHEN json_valid(raw_json) \
                                           AND json_type(raw_json, '$.albumVersion') = 'text' \
                                     THEN NULLIF(TRIM(json_extract( \
                                       raw_json, '$.albumVersion' \
                                     )), '') END, \
                                CASE WHEN json_valid(raw_json) \
                                           AND json_type( \
                                             raw_json, '$.tags.albumversion[0]' \
                                           ) = 'text' \
                                     THEN NULLIF(TRIM(json_extract( \
                                       raw_json, '$.tags.albumversion[0]' \
                                     )), '') END \
                              ) IS NOT ?3 \
                              OR COALESCE(CASE WHEN json_valid(raw_json) \
                                THEN json_extract( \
                                  raw_json, '$._psysonicAlbumVersionNeedsListRefresh' \
                                ) = 1 END, 0) \
                            ) \
                            AND ( \
                              COALESCE( \
                                CASE WHEN json_valid(raw_json) \
                                           AND json_type(raw_json, '$.albumVersion') = 'text' \
                                     THEN NULLIF(TRIM(json_extract( \
                                       raw_json, '$.albumVersion' \
                                     )), '') END, \
                                CASE WHEN json_valid(raw_json) \
                                           AND json_type( \
                                             raw_json, '$.tags.albumversion[0]' \
                                           ) = 'text' \
                                     THEN NULLIF(TRIM(json_extract( \
                                       raw_json, '$.tags.albumversion[0]' \
                                     )), '') END \
                              ) IS NULL \
                              OR COALESCE(CASE WHEN json_valid(raw_json) \
                                THEN json_extract( \
                                  raw_json, '$._psysonicAlbumVersionFromList' \
                                ) = 1 END, 0) \
                              OR COALESCE(CASE WHEN json_valid(raw_json) \
                                THEN json_extract( \
                                  raw_json, '$._psysonicAlbumVersionNeedsListRefresh' \
                                ) = 1 END, 0) \
                            ) \
                            AND NOT EXISTS ( \
                              SELECT 1 FROM album a \
                              WHERE a.server_id = track.server_id AND a.id = track.album_id \
                                AND json_valid(a.raw_json) \
                                AND COALESCE( \
                                  CASE WHEN json_type(a.raw_json, '$.version') = 'text' \
                                       THEN NULLIF(TRIM(json_extract( \
                                         a.raw_json, '$.version' \
                                       )), '') END, \
                                  CASE WHEN json_type( \
                                               a.raw_json, '$.tags.albumversion[0]' \
                                             ) = 'text' \
                                       THEN NULLIF(TRIM(json_extract( \
                                         a.raw_json, '$.tags.albumversion[0]' \
                                       )), '') END \
                                ) IS NOT NULL \
                                AND NOT COALESCE(CASE WHEN json_valid(a.raw_json) \
                                  THEN json_extract( \
                                    a.raw_json, '$._psysonicAlbumVersionFromList' \
                                  ) = 1 END, 0) \
                            )",
                        )?
                        .execute(params![server_id, album.id, version])?;
                    let album_changes = tx
                        .prepare_cached(
                        "UPDATE album SET raw_json = json_set( \
                           json_remove( \
                             CASE WHEN json_valid(raw_json) THEN \
                               CASE WHEN json_type(raw_json, '$') = 'object' \
                                    THEN raw_json ELSE '{}' END \
                             ELSE '{}' END, \
                             '$.tags.albumversion' \
                           ), \
                           '$.version', ?3, \
                           '$._psysonicAlbumVersionFromList', json('true') \
                          ) \
                          WHERE server_id = ?1 AND id = ?2 \
                            AND COALESCE( \
                              CASE WHEN json_valid(raw_json) \
                                         AND json_type(raw_json, '$.version') = 'text' \
                                   THEN NULLIF(TRIM(json_extract( \
                                     raw_json, '$.version' \
                                   )), '') END, \
                              CASE WHEN json_valid(raw_json) \
                                         AND json_type( \
                                           raw_json, '$.tags.albumversion[0]' \
                                         ) = 'text' \
                                   THEN NULLIF(TRIM(json_extract( \
                                     raw_json, '$.tags.albumversion[0]' \
                                   )), '') END \
                            ) IS NOT ?3 \
                            AND ( \
                              COALESCE( \
                                CASE WHEN json_valid(raw_json) \
                                           AND json_type(raw_json, '$.version') = 'text' \
                                     THEN NULLIF(TRIM(json_extract( \
                                       raw_json, '$.version' \
                                     )), '') END, \
                                CASE WHEN json_valid(raw_json) \
                                           AND json_type( \
                                             raw_json, '$.tags.albumversion[0]' \
                                           ) = 'text' \
                                     THEN NULLIF(TRIM(json_extract( \
                                       raw_json, '$.tags.albumversion[0]' \
                                     )), '') END \
                              ) IS NULL \
                              OR COALESCE(CASE WHEN json_valid(raw_json) \
                                THEN json_extract( \
                                  raw_json, '$._psysonicAlbumVersionFromList' \
                                ) = 1 END, 0) \
                            )",
                        )?
                        .execute(params![server_id, album.id, version])?;
                    let changed = track_changes + album_changes;
                    if changed > 0 {
                        version_changed_albums.insert(album.id.clone());
                    }
                }

                for chunk in albums
                    .iter()
                    .filter(|album| album_summary_version(album).is_none())
                    .collect::<Vec<_>>()
                    .chunks(CHUNK)
                {
                    let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
                    let mut lookup_params = vec![rusqlite::types::Value::Text(server_id.to_string())];
                    lookup_params.extend(
                        chunk
                            .iter()
                            .map(|album| rusqlite::types::Value::Text(album.id.clone())),
                    );
                    let changed_ids = {
                        let sql = format!(
                            "SELECT DISTINCT album_id FROM track \
                             WHERE server_id = ? AND album_id IN ({placeholders}) \
                                AND deleted = 0 AND json_valid(raw_json) \
                                AND ( \
                                  COALESCE(json_extract( \
                                    raw_json, '$._psysonicAlbumVersionFromList' \
                                  ) = 1, 0) \
                                  OR COALESCE(json_extract( \
                                    raw_json, \
                                    '$._psysonicAlbumVersionNeedsListRefresh' \
                                  ) = 1, 0) \
                                ) \
                              UNION \
                              SELECT id FROM album \
                              WHERE server_id = ? AND id IN ({placeholders}) \
                                AND json_valid(raw_json) \
                                AND COALESCE(json_extract( \
                                  raw_json, '$._psysonicAlbumVersionFromList' \
                                ) = 1, 0)"
                        );
                        let mut both_params = lookup_params.clone();
                        both_params.extend(lookup_params.iter().cloned());
                        let mut statement = tx.prepare(&sql)?;
                        let ids = statement
                            .query_map(params_from_iter(both_params.iter()), |row| row.get(0))?
                            .collect::<rusqlite::Result<Vec<String>>>()?;
                        ids
                    };
                    if changed_ids.is_empty() {
                        continue;
                    }
                    let changed_placeholders = (0..changed_ids.len())
                        .map(|_| "?")
                        .collect::<Vec<_>>()
                        .join(", ");
                    let mut changed_params =
                        vec![rusqlite::types::Value::Text(server_id.to_string())];
                    changed_params.extend(changed_ids.iter().cloned().map(Into::into));
                    tx.execute(
                        &format!(
                            "UPDATE track SET raw_json = json_remove( \
                               raw_json, \
                               '$.albumVersion', \
                               '$.tags.albumversion', \
                               '$._psysonicAlbumVersionFromList', \
                               '$._psysonicAlbumVersionNeedsListRefresh' \
                              ) WHERE server_id = ? AND album_id IN ({changed_placeholders}) \
                                AND deleted = 0 AND json_valid(raw_json) \
                                AND ( \
                                  COALESCE(json_extract( \
                                    raw_json, '$._psysonicAlbumVersionFromList' \
                                  ) = 1, 0) \
                                  OR COALESCE(json_extract( \
                                    raw_json, \
                                    '$._psysonicAlbumVersionNeedsListRefresh' \
                                  ) = 1, 0) \
                                )"
                        ),
                        params_from_iter(changed_params.iter()),
                    )?;
                    tx.execute(
                        &format!(
                            "UPDATE album SET raw_json = json_remove( \
                               raw_json, \
                               '$.version', \
                               '$.tags.albumversion', \
                               '$._psysonicAlbumVersionFromList' \
                              ) WHERE server_id = ? AND id IN ({changed_placeholders}) \
                                AND json_valid(raw_json) \
                                AND COALESCE(json_extract( \
                                  raw_json, '$._psysonicAlbumVersionFromList' \
                                ) = 1, 0)"
                        ),
                        params_from_iter(changed_params.iter()),
                    )?;
                    version_changed_albums.extend(changed_ids);
                }
                crate::identity::record_albums(
                    &tx,
                    version_changed_albums
                        .iter()
                        .map(|album_id| (server_id, album_id.as_str())),
                )?;

                if library_id.is_empty() {
                    tx.commit()?;
                    return Ok(total);
                }
                for chunk in albums.chunks(CHUNK) {
                    let album_ids = chunk.iter().map(|album| &album.id).collect::<Vec<_>>();
                    let placeholders = (0..chunk.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
                    let changed_album_sql = format!(
                        "SELECT DISTINCT album_id FROM track \
                         WHERE server_id = ? AND deleted = 0 \
                           AND album_id IN ({placeholders}) \
                           AND (library_id IS NULL OR library_id = '')"
                    );
                    let mut changed_params: Vec<rusqlite::types::Value> =
                        vec![rusqlite::types::Value::Text(server_id.to_string())];
                    changed_params.extend(album_ids.iter().map(|id| (*id).clone().into()));
                    let changed_album_ids = {
                        let mut statement = tx.prepare(&changed_album_sql)?;
                        let rows = statement
                            .query_map(params_from_iter(changed_params.iter()), |row| row.get(0))?
                            .collect::<rusqlite::Result<Vec<String>>>()?;
                        rows
                    };
                    if changed_album_ids.is_empty() {
                        continue;
                    }
                    let changed_placeholders = (0..changed_album_ids.len())
                        .map(|_| "?")
                        .collect::<Vec<_>>()
                        .join(", ");
                    let sql = format!(
                        "UPDATE track SET library_id = ?1 \
                     WHERE server_id = ?2 AND deleted = 0 \
                       AND album_id IN ({changed_placeholders}) \
                       AND (library_id IS NULL OR library_id = '')"
                    );
                    let mut params: Vec<rusqlite::types::Value> = vec![
                        rusqlite::types::Value::Text(library_id.to_string()),
                        rusqlite::types::Value::Text(server_id.to_string()),
                    ];
                    params.extend(changed_album_ids.iter().cloned().map(Into::into));
                    let n = tx.execute(&sql, params_from_iter(params.iter()))?;
                    total += n as u64;
                    tx.execute(
                        &format!(
                            "UPDATE track_genre SET library_id = ?1 \
                         WHERE server_id = ?2 AND track_id IN ( \
                            SELECT id FROM track WHERE server_id = ?2 \
                              AND album_id IN ({changed_placeholders}) AND library_id = ?1 \
                         ) AND COALESCE(library_id, '') != ?1"
                        ),
                        params_from_iter(params.iter()),
                    )?;
                    crate::identity::refresh_library_ids_for_albums(
                        &tx,
                        server_id,
                        &changed_album_ids,
                    )?;
                    crate::browse_projection::refresh_library_tagged_albums(
                        &tx,
                        server_id,
                        library_id,
                        &changed_album_ids,
                    )?;
                }
                tx.commit()?;
                Ok(total)
            })
    }
}

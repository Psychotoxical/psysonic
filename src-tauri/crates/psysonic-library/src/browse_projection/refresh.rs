use super::*;

pub(super) fn add_scope(
    scopes: &mut HashSet<AlbumScope>,
    server_id: &str,
    library_id: Option<String>,
    album_id: Option<String>,
) {
    let Some(album_id) = album_id.filter(|id| !id.is_empty()) else {
        return;
    };
    scopes.insert((
        server_id.to_string(),
        library_id.unwrap_or_default(),
        album_id,
    ));
}

pub(crate) fn collect_album_scopes_for_track_ids(
    tx: &Transaction<'_>,
    server_id: &str,
    track_ids: &[String],
) -> rusqlite::Result<HashSet<AlbumScope>> {
    let mut scopes = HashSet::new();
    let mut statement = tx.prepare_cached(
        "SELECT library_id, album_id FROM track WHERE server_id = ?1 AND id = ?2",
    )?;
    for track_id in track_ids {
        if let Some((library_id, album_id)) = statement
            .query_row(params![server_id, track_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?
        {
            add_scope(&mut scopes, server_id, library_id, album_id);
        }
    }
    Ok(scopes)
}

pub(crate) fn refresh_library_tagged_albums(
    tx: &Transaction<'_>,
    server_id: &str,
    library_id: &str,
    album_ids: &[String],
) -> rusqlite::Result<()> {
    let mut scopes = HashSet::new();
    for album_id in album_ids {
        add_scope(
            &mut scopes,
            server_id,
            Some(String::new()),
            Some(album_id.clone()),
        );
        add_scope(
            &mut scopes,
            server_id,
            Some(library_id.to_string()),
            Some(album_id.clone()),
        );
    }
    refresh_album_scopes(tx, scopes)
}

/// Capture old and incoming album owners before a track batch changes them.
pub(crate) fn collect_affected_album_scopes(
    tx: &Transaction<'_>,
    rows: &[TrackRow],
) -> rusqlite::Result<HashSet<AlbumScope>> {
    let mut scopes = HashSet::new();
    let mut previous = tx.prepare_cached(
        "SELECT library_id, album_id FROM track WHERE server_id = ?1 AND id = ?2",
    )?;
    for row in rows {
        if let Some((library_id, album_id)) = previous
            .query_row(params![row.server_id, row.id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
        {
            add_scope(&mut scopes, &row.server_id, library_id, album_id);
        }
        add_scope(
            &mut scopes,
            &row.server_id,
            row.library_id.clone(),
            row.album_id.clone(),
        );
    }
    Ok(scopes)
}

/// Recompute only albums affected by a single track ingest transaction.
pub(crate) fn refresh_album_scopes(
    tx: &Transaction<'_>,
    scopes: HashSet<AlbumScope>,
) -> rusqlite::Result<()> {
    let mut delete = tx.prepare_cached(
        "DELETE FROM album_browse_projection \
         WHERE server_id = ?1 AND library_id = ?2 AND album_id = ?3",
    )?;
    let mut insert = tx.prepare_cached(
        "INSERT INTO album_browse_projection ( \
           server_id, library_id, album_id, name, artist, artist_id, song_count, \
           duration_sec, year, genre, cover_art_id, starred_at, synced_at, representative_track_id \
         ) \
         SELECT t.server_id, COALESCE(t.library_id, ''), t.album_id, MAX(t.album), \
                MAX(COALESCE(NULLIF(TRIM(t.album_artist), ''), t.artist)), MAX(t.artist_id), \
                COUNT(*), SUM(t.duration_sec), MAX(t.year), MAX(t.genre), MAX(t.cover_art_id), \
                MAX(t.starred_at), MAX(t.synced_at), MIN(t.id) \
         FROM track t \
         WHERE t.server_id = ?1 AND COALESCE(t.library_id, '') = ?2 AND t.album_id = ?3 \
           AND t.deleted = 0 \
         GROUP BY t.server_id, COALESCE(t.library_id, ''), t.album_id",
    )?;
    let mut update_identity = tx.prepare_cached(
        "UPDATE album_browse_projection SET identity_key = ?4 \
         WHERE server_id = ?1 AND library_id = ?2 AND album_id = ?3",
    )?;
    for (server_id, library_id, album_id) in &scopes {
        delete.execute(params![server_id, library_id, album_id])?;
        insert.execute(params![server_id, library_id, album_id])?;
        let identity_key = crate::identity::concrete_physical_album_key(server_id, album_id);
        update_identity.execute(params![server_id, library_id, album_id, identity_key])?;
    }
    crate::composer_projection::refresh_album_scopes(tx, &scopes)?;
    Ok(())
}

/// Full resync can tombstone arbitrary old rows, so rebuild one server's compact
/// projection after its orphan sweep instead of leaving deleted albums visible.
pub(crate) fn rebuild_server(tx: &Transaction<'_>, server_id: &str) -> rusqlite::Result<()> {
    tx.execute(
        "DELETE FROM album_browse_projection WHERE server_id = ?1",
        params![server_id],
    )?;
    tx.execute(
        "INSERT INTO album_browse_projection ( \
           server_id, library_id, album_id, name, artist, artist_id, song_count, \
           duration_sec, year, genre, cover_art_id, starred_at, synced_at, representative_track_id \
         ) \
         SELECT t.server_id, COALESCE(t.library_id, ''), t.album_id, MAX(t.album), \
                MAX(COALESCE(NULLIF(TRIM(t.album_artist), ''), t.artist)), MAX(t.artist_id), \
                COUNT(*), SUM(t.duration_sec), MAX(t.year), MAX(t.genre), MAX(t.cover_art_id), \
                MAX(t.starred_at), MAX(t.synced_at), MIN(t.id) \
         FROM track t \
         WHERE t.server_id = ?1 AND t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
         GROUP BY t.server_id, COALESCE(t.library_id, ''), t.album_id",
        params![server_id],
    )?;
    let mut stmt = tx
        .prepare("SELECT library_id, album_id FROM album_browse_projection WHERE server_id = ?1")?;
    let rows = stmt
        .query_map(params![server_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    let mut update = tx.prepare_cached(
        "UPDATE album_browse_projection SET identity_key = ?4 \
         WHERE server_id = ?1 AND library_id = ?2 AND album_id = ?3",
    )?;
    for (library_id, album_id) in rows {
        let identity_key = crate::identity::concrete_physical_album_key(server_id, &album_id);
        update.execute(params![server_id, library_id, album_id, identity_key])?;
    }
    crate::composer_projection::rebuild_scope(tx, server_id, "")?;
    Ok(())
}

/// Keep materialized album browse partitions aligned with the cluster sidecar.
/// Every physical album gets one unanimous cluster key or a server-qualified fallback.
pub(crate) fn reconcile_identity_keys(
    tx: &Transaction<'_>,
    server_id: Option<&str>,
) -> rusqlite::Result<()> {
    let server_filter = if server_id.is_some() {
        " AND ap.server_id = ?1"
    } else {
        ""
    };
    let sql = format!(
        "WITH resolved AS MATERIALIZED ( \
           SELECT ap.server_id, ap.library_id, ap.album_id, \
                  COALESCE(( \
                    SELECT CASE \
                      WHEN COUNT(*) > 0 \
                       AND COUNT(*) = COUNT(ck.album_key) \
                       AND COUNT(DISTINCT ck.album_key) = 1 \
                      THEN MAX(ck.album_key) \
                    END \
                    FROM track t \
                    LEFT JOIN cluster.track_cluster_key ck \
                      ON ck.server_id = t.server_id AND ck.track_id = t.id \
                    WHERE t.server_id = ap.server_id \
                      AND t.album_id = ap.album_id AND t.deleted = 0 \
                  ), 'physical:' || length(ap.server_id) || ':' || ap.server_id || ':' || ap.album_id) \
                    AS identity_key \
           FROM album_browse_projection ap \
           WHERE EXISTS ( \
             SELECT 1 FROM track t \
             WHERE t.server_id = ap.server_id AND t.album_id = ap.album_id AND t.deleted = 0 \
           ){server_filter} \
         ) \
         UPDATE album_browse_projection AS ap \
         SET identity_key = resolved.identity_key \
         FROM resolved \
         WHERE ap.server_id = resolved.server_id \
           AND ap.library_id = resolved.library_id \
           AND ap.album_id = resolved.album_id \
           AND ap.identity_key IS NOT resolved.identity_key"
    );
    match server_id {
        Some(server_id) => tx.execute(&sql, params![server_id])?,
        None => tx.execute(&sql, [])?,
    };
    Ok(())
}

/// Refresh only physical albums named by the durable identity invalidation journal.
/// Artist invalidations expand to every physical album that currently references
/// that artist because canonical album identity depends on unanimous artist ids.
pub(crate) fn reconcile_invalidated_identity_keys(
    tx: &Transaction<'_>,
    server_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "WITH invalidated_artist AS MATERIALIZED ( \
           SELECT entity_id FROM identity_invalidation \
           WHERE server_id = ?1 AND kind = 'artist' \
         ), \
         invalidated_album AS MATERIALIZED ( \
           SELECT entity_id FROM identity_invalidation \
           WHERE server_id = ?1 AND kind = 'album' \
           UNION \
           SELECT DISTINCT t.album_id FROM track t \
           JOIN invalidated_artist ia ON ia.entity_id = t.artist_id \
           WHERE t.server_id = ?1 AND t.deleted = 0 \
             AND t.album_id IS NOT NULL AND t.album_id != '' \
         ), \
         resolved AS MATERIALIZED ( \
           SELECT ap.server_id, ap.library_id, ap.album_id, \
                  COALESCE(( \
                    SELECT CASE \
                      WHEN COUNT(*) > 0 \
                       AND COUNT(*) = COUNT(ck.album_key) \
                       AND COUNT(DISTINCT ck.album_key) = 1 \
                      THEN MAX(ck.album_key) \
                    END \
                    FROM track t \
                    LEFT JOIN cluster.track_cluster_key ck \
                      ON ck.server_id = t.server_id AND ck.track_id = t.id \
                    WHERE t.server_id = ap.server_id \
                      AND t.album_id = ap.album_id AND t.deleted = 0 \
                  ), 'physical:' || length(ap.server_id) || ':' || ap.server_id || ':' || ap.album_id) \
                    AS identity_key \
           FROM album_browse_projection ap \
           JOIN invalidated_album ia ON ia.entity_id = ap.album_id \
           WHERE ap.server_id = ?1 \
         ) \
         UPDATE album_browse_projection AS ap \
         SET identity_key = resolved.identity_key \
         FROM resolved \
         WHERE ap.server_id = resolved.server_id \
           AND ap.library_id = resolved.library_id \
           AND ap.album_id = resolved.album_id \
           AND ap.identity_key IS NOT resolved.identity_key",
        params![server_id],
    )?;
    Ok(())
}

/// Rebuild the projection rows affected by an authoritative scope mutation.
/// Empty scope means every library on the server; non-empty scope is exact.
pub(crate) fn rebuild_scope(
    tx: &Transaction<'_>,
    server_id: &str,
    library_scope: &str,
) -> rusqlite::Result<()> {
    if library_scope.is_empty() {
        return super::rebuild_server(tx, server_id);
    }
    let mut scopes = HashSet::new();
    for sql in [
        "SELECT album_id FROM album_browse_projection \
         WHERE server_id = ?1 AND library_id = ?2",
        "SELECT DISTINCT album_id FROM track \
         WHERE server_id = ?1 AND library_id = ?2 AND deleted = 0 \
            AND album_id IS NOT NULL AND album_id != ''",
        "SELECT DISTINCT album_id FROM composer_album_projection \
         WHERE server_id = ?1 AND library_id = ?2",
    ] {
        let mut statement = tx.prepare(sql)?;
        let album_ids = statement
            .query_map(params![server_id, library_scope], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for album_id in album_ids {
            add_scope(
                &mut scopes,
                server_id,
                Some(library_scope.to_string()),
                Some(album_id),
            );
        }
    }
    refresh_album_scopes(tx, scopes)
}

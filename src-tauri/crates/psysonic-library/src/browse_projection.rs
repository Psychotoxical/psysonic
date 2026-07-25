//! Materialized browse rows maintained alongside track ingest.
//!
//! The `track` catalog remains authoritative. These compact rows avoid grouping
//! every track in a selected library before the first All Albums page can render.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use tauri::{AppHandle, Emitter};

use crate::repos::TrackRow;
use crate::store::LibraryStore;

pub(crate) type AlbumScope = (String, String, String);
pub const MIGRATION_ID: &str = "scope_browse_album_projection_v1";
const BACKFILL_BATCH_SIZE: i64 = 10_000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeBrowseProjectionInspectDto {
    pub needed: bool,
    pub total_tracks: u64,
    pub done_tracks: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeBrowseProjectionProgressEvent {
    pub done: u64,
    pub total: u64,
}

fn add_scope(
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
    let mut stmt = tx.prepare(
        "SELECT library_id, album_id FROM album_browse_projection WHERE server_id = ?1",
    )?;
    let rows = stmt
        .query_map(params![server_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
            ))
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
        return rebuild_server(tx, server_id);
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

fn migration_completed(conn: &Connection) -> rusqlite::Result<bool> {
    let completed: Option<Option<i64>> = conn
        .query_row(
            "SELECT completed_at FROM library_data_migration WHERE id = ?1",
            params![MIGRATION_ID],
            |r| r.get(0),
        )
        .optional()?;
    Ok(completed.flatten().is_some())
}

fn cursor_rowid(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT cursor_rowid FROM library_data_migration WHERE id = ?1",
        params![MIGRATION_ID],
        |r| r.get(0),
    )
    .optional()
    .map(|cursor| cursor.unwrap_or(0))
}

fn inspect_album(store: &LibraryStore) -> Result<ScopeBrowseProjectionInspectDto, String> {
    store
        .with_read_conn(|conn| {
            let total: i64 =
                conn.query_row("SELECT COUNT(*) FROM track WHERE deleted = 0", [], |r| {
                    r.get(0)
                })?;
            if total == 0 || migration_completed(conn)? {
                return Ok(ScopeBrowseProjectionInspectDto {
                    needed: false,
                    total_tracks: total.max(0) as u64,
                    done_tracks: total.max(0) as u64,
                });
            }
            let cursor = cursor_rowid(conn)?;
            let done: i64 = conn.query_row(
                "SELECT COUNT(*) FROM track WHERE deleted = 0 AND rowid <= ?1",
                params![cursor],
                |r| r.get(0),
            )?;
            Ok(ScopeBrowseProjectionInspectDto {
                needed: true,
                total_tracks: total.max(0) as u64,
                done_tracks: done.max(0) as u64,
            })
        })
        .map_err(|error| error.to_string())
}

pub fn inspect(store: &LibraryStore) -> Result<ScopeBrowseProjectionInspectDto, String> {
    let album = inspect_album(store)?;
    let composer = crate::composer_projection::inspect(store)?;
    let identity_needed = crate::identity::identity_maintenance_needed(store)?;
    let pending = [album.clone(), composer.clone()]
        .into_iter()
        .filter(|item| item.needed)
        .collect::<Vec<_>>();
    if pending.is_empty() && !identity_needed {
        return Ok(ScopeBrowseProjectionInspectDto {
            needed: false,
            total_tracks: album.total_tracks.max(composer.total_tracks),
            done_tracks: album.done_tracks.max(composer.done_tracks),
        });
    }
    Ok(ScopeBrowseProjectionInspectDto {
        needed: true,
        total_tracks: pending
            .iter()
            .map(|item| item.total_tracks)
            .max()
            .unwrap_or_else(|| album.total_tracks.max(composer.total_tracks)),
        done_tracks: if identity_needed {
            0
        } else {
            pending.iter().map(|item| item.done_tracks).min().unwrap_or(0)
        },
    })
}

pub fn is_ready(store: &LibraryStore) -> Result<bool, String> {
    store
        .with_read_conn(|conn| {
            if migration_completed(conn)? {
                return Ok(true);
            }
            conn.query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM track WHERE deleted = 0)",
                [],
                |r| r.get(0),
            )
        })
        .map_err(|error| error.to_string())
}

pub fn run_backfill(store: &LibraryStore, app: &AppHandle) -> Result<(), String> {
    run_backfill_impl(store, Some(app))
}

fn run_backfill_impl(store: &LibraryStore, app: Option<&AppHandle>) -> Result<(), String> {
    // Projection batches intentionally write physical fallback identities. Persist
    // a server rebuild request first so a crash can never leave a completed
    // projection marker without a later canonical reconcile.
    store.with_conn_mut("browse_projection.mark_identity_dirty", |conn| {
        let server_ids = {
            let mut statement = conn.prepare(
                "SELECT DISTINCT server_id FROM track WHERE deleted = 0 ORDER BY server_id",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let tx = conn.transaction()?;
        crate::identity::mark_cluster_keys_dirty(&tx, server_ids.iter().map(String::as_str))?;
        tx.commit()
    })?;
    run_album_backfill_impl(store, app)?;
    crate::composer_projection::run_backfill(store, app)?;
    crate::identity::ensure_pending_cluster_keys(store)?;
    Ok(())
}

fn run_album_backfill_impl(store: &LibraryStore, app: Option<&AppHandle>) -> Result<(), String> {
    let inspect_result = inspect_album(store)?;
    if !inspect_result.needed {
        return Ok(());
    }
    loop {
        let (done, finished) = store.with_conn_mut("browse_projection.backfill", |conn| {
            if migration_completed(conn)? {
                return Ok((inspect_result.total_tracks, true));
            }
            conn.execute(
                "INSERT INTO library_data_migration (id, cursor_rowid, started_at) \
                 VALUES (?1, 0, strftime('%s','now')) \
                 ON CONFLICT(id) DO NOTHING",
                params![MIGRATION_ID],
            )?;
            let cursor = cursor_rowid(conn)?;
            let tx = conn.transaction()?;
            let rows = {
                let mut stmt = tx.prepare(
                    "SELECT rowid, server_id, COALESCE(library_id, ''), album_id \
                     FROM track WHERE deleted = 0 AND rowid > ?1 \
                     ORDER BY rowid LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![cursor, BACKFILL_BATCH_SIZE], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if let Some(last_rowid) = rows.last().map(|row| row.0) {
                let mut scopes = HashSet::new();
                for (_, server_id, library_id, album_id) in rows {
                    add_scope(&mut scopes, &server_id, Some(library_id), album_id);
                }
                let server_ids = scopes
                    .iter()
                    .map(|(server_id, _, _)| server_id.clone())
                    .collect::<HashSet<_>>();
                refresh_album_scopes(&tx, scopes)?;
                // Keep the reconcile request atomic with every physical-key batch.
                // An unrelated read may drain an earlier request while migration runs.
                crate::identity::mark_cluster_keys_dirty(
                    &tx,
                    server_ids.iter().map(String::as_str),
                )?;
                tx.execute(
                    "UPDATE library_data_migration SET cursor_rowid = ?2 WHERE id = ?1",
                    params![MIGRATION_ID, last_rowid],
                )?;
                tx.commit()?;
                let done: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM track WHERE deleted = 0 AND rowid <= ?1",
                    params![last_rowid],
                    |r| r.get(0),
                )?;
                Ok((done.max(0) as u64, false))
            } else {
                tx.execute(
                    "UPDATE library_data_migration SET completed_at = strftime('%s','now') WHERE id = ?1",
                    params![MIGRATION_ID],
                )?;
                tx.commit()?;
                Ok((inspect_result.total_tracks, true))
            }
        })?;
        if let Some(app) = app {
            app.emit(
                "scope_browse_projection:progress",
                ScopeBrowseProjectionProgressEvent {
                    done,
                    total: inspect_result.total_tracks,
                },
            )
            .map_err(|error| error.to_string())?;
        }
        if finished {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{
        LibraryScopeBrowseEntity, LibraryScopeBrowseRequest, LibraryScopePair, LibrarySortClause,
        SortDir,
    };
    use crate::repos::{TrackRepository, TrackRow};

    fn track(id: &str, album_id: &str, album: &str, library_id: &str) -> TrackRow {
        TrackRow {
            server_id: "s1".into(),
            id: id.into(),
            title: id.into(),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: Some("artist".into()),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some("Artist".into()),
            duration_sec: 120,
            track_number: None,
            disc_number: None,
            year: Some(2024),
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at: None,
            user_rating: None,
            play_count: None,
            played_at: None,
            server_path: None,
            library_id: Some(library_id.into()),
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            replay_gain_peak: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn album_track(
        server_id: &str,
        id: &str,
        artist: &str,
        artist_id: &str,
        album_id: &str,
        album: &str,
        album_artist: &str,
        library_id: &str,
    ) -> TrackRow {
        let mut row = track(id, album_id, album, library_id);
        row.server_id = server_id.into();
        row.artist = Some(artist.into());
        row.artist_id = Some(artist_id.into());
        row.album_artist = Some(album_artist.into());
        row
    }

    fn insert_artist(store: &LibraryStore, server_id: &str, artist_id: &str, name: &str) {
        store
            .with_conn_mut("test.browse_projection.artist", |conn| {
                conn.execute(
                    "INSERT INTO artist(server_id, id, name, synced_at) VALUES (?1, ?2, ?3, 1)",
                    params![server_id, artist_id, name],
                )?;
                Ok(())
            })
            .unwrap();
    }

    fn browse_albums(
        store: &LibraryStore,
        scopes: Vec<LibraryScopePair>,
    ) -> Vec<crate::dto::LibraryAlbumDto> {
        crate::scope_browse::browse(
            store,
            &LibraryScopeBrowseRequest {
                entity: LibraryScopeBrowseEntity::Album,
                scopes,
                sort: vec![LibrarySortClause {
                    field: "name".into(),
                    dir: SortDir::Asc,
                }],
                limit: 20,
                cursor: None,
            },
        )
        .unwrap()
        .albums
    }

    #[test]
    fn ingest_refreshes_only_affected_album_projection() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("t1", "a1", "Album One", "lib")])
            .unwrap();
        let name: String = store.with_read_conn(|conn| conn.query_row(
            "SELECT name FROM album_browse_projection WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'a1'",
            [], |row| row.get(0),
        )).unwrap();
        assert_eq!(name, "Album One");

        TrackRepository::new(&store)
            .upsert_batch(&[track("t1", "a1", "Album Renamed", "lib")])
            .unwrap();
        let name: String = store.with_read_conn(|conn| conn.query_row(
            "SELECT name FROM album_browse_projection WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'a1'",
            [], |row| row.get(0),
        )).unwrap();
        assert_eq!(name, "Album Renamed");
    }

    #[test]
    fn backfill_processes_tracks_without_album_ids_before_advancing_cursor() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("no-album", "", "Ignored", "lib"),
                track("t1", "a1", "Album One", "lib"),
            ])
            .unwrap();
        store
            .with_conn_mut("test.clear_projection_marker", |conn| {
                conn.execute("DELETE FROM album_browse_projection", [])?;
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![MIGRATION_ID],
                )?;
                Ok(())
            })
            .unwrap();

        run_backfill_impl(&store, None).unwrap();
        assert!(is_ready(&store).unwrap());
        let count: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM album_browse_projection WHERE album_id = 'a1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn partial_incremental_projection_does_not_imply_completion() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("t1", "a1", "Album One", "lib"),
                track("t2", "a2", "Album Two", "lib"),
            ])
            .unwrap();
        store
            .with_conn_mut("test.partial_projection", |conn| {
                conn.execute(
                    "DELETE FROM album_browse_projection WHERE album_id = 'a2'",
                    [],
                )?;
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![MIGRATION_ID],
                )?;
                Ok(())
            })
            .unwrap();

        let status = inspect_album(&store).unwrap();
        assert!(status.needed);
        assert_eq!(status.total_tracks, 2);
        assert_eq!(status.done_tracks, 0);
        assert!(!is_ready(&store).unwrap());

        run_backfill_impl(&store, None).unwrap();
        assert!(is_ready(&store).unwrap());
        let count: i64 = store
            .with_read_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM album_browse_projection", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn ordinary_browse_links_a_compilation_card_to_the_album_artist() {
        // The ordinary All Albums page reads this projection, which stores the display
        // credit ("Various Artists") next to `MAX(t.artist_id)` — a guest performer. The
        // card must link to the album-artist entity instead, recovered from the album
        // even when the projection's representative track carries no `albumArtistId`.
        let store = LibraryStore::open_in_memory();
        insert_artist(&store, "s1", "va", "Various Artists");
        let mut representative = album_track(
            "s1", "t1", "Performer One", "perf1", "comp", "Comp", "Various Artists", "lib",
        );
        representative.raw_json = "{}".into();
        let mut sibling = album_track(
            "s1", "t2", "Performer Two", "perf2", "comp", "Comp", "Various Artists", "lib",
        );
        sibling.raw_json = r#"{"albumArtistId":"va"}"#.into();
        TrackRepository::new(&store)
            .upsert_batch(&[representative, sibling])
            .unwrap();

        let albums = browse_albums(
            &store,
            vec![LibraryScopePair {
                server_id: "s1".into(),
                library_id: Some("lib".into()),
            }],
        );
        let card = albums.iter().find(|album| album.id == "comp").expect("comp missing");
        assert_eq!(card.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            card.artist_id.as_deref(),
            Some("va"),
            "the All Albums card must open the album artist, not a track performer"
        );
    }

    #[test]
    fn ordinary_browse_reconciles_partial_keys_to_one_canonical_album_partition() {
        let store = LibraryStore::open_in_memory();
        insert_artist(&store, "s1", "artist-1", "Metallica");
        insert_artist(&store, "s2", "artist-2", "Metallica");
        TrackRepository::new(&store)
            .upsert_batch(&[album_track(
                "s1",
                "t1",
                "Metallica",
                "artist-1",
                "album-1",
                "S&M2",
                "Metallica & San Francisco Symphony",
                "lib-a",
            )])
            .unwrap();
        crate::identity::rebuild_cluster_keys(&store, None).unwrap();

        TrackRepository::new(&store)
            .upsert_batch(&[
                album_track(
                    "s1", "t2", "Metallica", "artist-1", "album-1", "S&M2",
                    "Metallica", "lib-b",
                ),
                album_track(
                    "s2", "t3", "Metallica", "artist-2", "album-2", "S&M2",
                    "Metallica", "lib-c",
                ),
            ])
            .unwrap();

        let albums = browse_albums(
            &store,
            vec![
                LibraryScopePair {
                    server_id: "s1".into(),
                    library_id: Some("lib-a".into()),
                },
                LibraryScopePair {
                    server_id: "s1".into(),
                    library_id: Some("lib-b".into()),
                },
                LibraryScopePair {
                    server_id: "s2".into(),
                    library_id: Some("lib-c".into()),
                },
            ],
        );
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].server_id, "s1");
        assert_eq!(albums[0].id, "album-1");

        let keys = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT identity_key FROM album_browse_projection \
                     WHERE album_id IN ('album-1', 'album-2')",
                )?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(keys.len(), 1);
    }

    #[test]
    fn completed_backfill_reconciles_physical_projection_keys_before_readiness() {
        let store = LibraryStore::open_in_memory();
        insert_artist(&store, "s1", "artist-1", "Artist");
        insert_artist(&store, "s2", "artist-2", "Artist");
        TrackRepository::new(&store)
            .upsert_batch(&[
                album_track(
                    "s1", "t1", "Artist", "artist-1", "album-1", "Shared", "Artist", "lib-a",
                ),
                album_track(
                    "s2", "t2", "Artist", "artist-2", "album-2", "Shared", "Artist", "lib-b",
                ),
            ])
            .unwrap();
        crate::identity::rebuild_cluster_keys(&store, None).unwrap();
        store
            .with_conn_mut("test.reset_projection", |conn| {
                conn.execute("DELETE FROM album_browse_projection", [])?;
                conn.execute(
                    "DELETE FROM library_data_migration WHERE id = ?1",
                    params![MIGRATION_ID],
                )?;
                Ok(())
            })
            .unwrap();

        run_backfill_impl(&store, None).unwrap();

        assert!(is_ready(&store).unwrap());
        let keys = store
            .with_read_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT DISTINCT identity_key FROM album_browse_projection ORDER BY identity_key",
                )?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(keys.len(), 1);
        assert!(!keys[0].starts_with("physical:"));
    }

    #[test]
    fn ordinary_browse_keeps_ambiguous_physical_albums_separate() {
        let store = LibraryStore::open_in_memory();
        for (server, artist_id, name) in [
            ("s1", "s1-a", "Artist A"),
            ("s1", "s1-b", "Artist B"),
            ("s2", "s2-a", "Artist A"),
            ("s2", "s2-b", "Artist B"),
        ] {
            insert_artist(&store, server, artist_id, name);
        }
        TrackRepository::new(&store)
            .upsert_batch(&[
                album_track(
                    "s1", "s1-t1", "Artist A", "s1-a", "s1-album", "Split",
                    "Various Artists", "lib-a",
                ),
                album_track(
                    "s1", "s1-t2", "Artist B", "s1-b", "s1-album", "Split",
                    "Various Artists", "lib-a",
                ),
                album_track(
                    "s2", "s2-t1", "Artist A", "s2-a", "s2-album", "Split",
                    "Various Artists", "lib-b",
                ),
                album_track(
                    "s2", "s2-t2", "Artist B", "s2-b", "s2-album", "Split",
                    "Various Artists", "lib-b",
                ),
            ])
            .unwrap();

        let albums = browse_albums(
            &store,
            vec![
                LibraryScopePair {
                    server_id: "s1".into(),
                    library_id: Some("lib-a".into()),
                },
                LibraryScopePair {
                    server_id: "s2".into(),
                    library_id: Some("lib-b".into()),
                },
            ],
        );
        assert_eq!(albums.len(), 2);
        assert_eq!(
            albums
                .iter()
                .map(|album| album.id.as_str())
                .collect::<Vec<_>>(),
            vec!["s1-album", "s2-album"]
        );
    }
}

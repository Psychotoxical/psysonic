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

mod refresh;

use refresh::add_scope;
pub(crate) use refresh::{
    collect_affected_album_scopes, collect_album_scopes_for_track_ids, rebuild_scope,
    rebuild_server, reconcile_identity_keys, reconcile_invalidated_identity_keys,
    refresh_album_scopes, refresh_library_tagged_albums,
};

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
            pending
                .iter()
                .map(|item| item.done_tracks)
                .min()
                .unwrap_or(0)
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
#[path = "browse_projection/tests.rs"]
mod tests;

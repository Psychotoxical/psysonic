use std::collections::HashSet;

use rusqlite::{params, Connection, Transaction};

use crate::browse_projection::AlbumScope;

pub(crate) const SERVER_KIND: &str = "server";
pub(crate) const TRACK_KIND: &str = "track";
pub(crate) const ALBUM_KIND: &str = "album";
pub(crate) const ARTIST_KIND: &str = "artist";

fn record<'a>(
    tx: &Transaction<'_>,
    kind: &str,
    entities: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> rusqlite::Result<()> {
    let mut seen = HashSet::new();
    let mut statement = tx.prepare_cached(
        "INSERT OR IGNORE INTO identity_invalidation(server_id, kind, entity_id) \
         VALUES (?1, ?2, ?3)",
    )?;
    for (server_id, entity_id) in entities {
        if seen.insert((server_id, entity_id)) {
            statement.execute(params![server_id, kind, entity_id])?;
        }
    }
    Ok(())
}

pub(crate) fn record_servers<'a>(
    tx: &Transaction<'_>,
    server_ids: impl IntoIterator<Item = &'a str>,
) -> rusqlite::Result<()> {
    record(tx, SERVER_KIND, server_ids.into_iter().map(|id| (id, "")))
}

pub(crate) fn record_tracks<'a>(
    tx: &Transaction<'_>,
    tracks: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> rusqlite::Result<()> {
    record(tx, TRACK_KIND, tracks)
}

pub(crate) fn record_albums<'a>(
    tx: &Transaction<'_>,
    albums: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> rusqlite::Result<()> {
    record(tx, ALBUM_KIND, albums)
}

pub(crate) fn record_album_scopes(
    tx: &Transaction<'_>,
    scopes: &HashSet<AlbumScope>,
) -> rusqlite::Result<()> {
    record(
        tx,
        ALBUM_KIND,
        scopes
            .iter()
            .map(|(server_id, _, album_id)| (server_id.as_str(), album_id.as_str())),
    )
}

pub(crate) fn record_artists<'a>(
    tx: &Transaction<'_>,
    server_id: &'a str,
    artist_ids: impl IntoIterator<Item = &'a str>,
) -> rusqlite::Result<()> {
    record(
        tx,
        ARTIST_KIND,
        artist_ids.into_iter().map(|artist_id| (server_id, artist_id)),
    )
}

pub(crate) fn has_server_invalidation(
    conn: &Connection,
    server_id: &str,
) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS( \
           SELECT 1 FROM identity_invalidation \
           WHERE server_id = ?1 AND kind = 'server' \
         )",
        params![server_id],
        |row| row.get(0),
    )
}

pub(crate) fn has_any(conn: &Connection, server_id: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM identity_invalidation WHERE server_id = ?1)",
        params![server_id],
        |row| row.get(0),
    )
}

pub(crate) fn clear(tx: &Transaction<'_>, server_id: Option<&str>) -> rusqlite::Result<()> {
    match server_id {
        Some(server_id) => {
            tx.execute(
                "DELETE FROM identity_invalidation WHERE server_id = ?1",
                params![server_id],
            )?;
        }
        None => {
            tx.execute("DELETE FROM identity_invalidation", [])?;
        }
    }
    Ok(())
}

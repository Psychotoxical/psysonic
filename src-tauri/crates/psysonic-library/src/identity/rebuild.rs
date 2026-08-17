//! Batch rebuild of `cluster.track_cluster_key` from live `track` rows.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};

use crate::store::LibraryStore;

use super::attach::CLUSTER_SCHEMA;
use super::norm::NORM_VERSION;

mod pipeline;
mod ranks;

#[cfg(test)]
use pipeline::rebuild_cluster_keys_on_conn;
#[cfg(test)]
use ranks::CAPTURE_INVALIDATED_RANK_PARTITIONS_SQL;

const DIRTY_META_PREFIX: &str = "dirty_server:";

fn dirty_meta_key(server_id: &str) -> String {
    format!("{DIRTY_META_PREFIX}{server_id}")
}

pub(crate) fn mark_cluster_keys_dirty<'a>(
    tx: &Transaction<'_>,
    server_ids: impl IntoIterator<Item = &'a str>,
) -> rusqlite::Result<()> {
    super::invalidation::record_servers(tx, server_ids)
}

pub(crate) fn prune_cluster_keys_for_scope(
    tx: &Transaction<'_>,
    server_id: &str,
    library_scope: &str,
) -> rusqlite::Result<()> {
    if library_scope.is_empty() {
        tx.execute(
            "DELETE FROM cluster.track_cluster_key \
             WHERE server_id = ?1 AND NOT EXISTS ( \
               SELECT 1 FROM track t \
               WHERE t.server_id = ?1 AND t.id = cluster.track_cluster_key.track_id \
                 AND t.deleted = 0 \
             )",
            params![server_id],
        )?;
    } else {
        tx.execute(
            "DELETE FROM cluster.track_cluster_key \
             WHERE server_id = ?1 AND library_id = ?2 AND NOT EXISTS ( \
               SELECT 1 FROM track t \
               WHERE t.server_id = ?1 AND t.id = cluster.track_cluster_key.track_id \
                 AND t.library_id = ?2 AND t.deleted = 0 \
             )",
            params![server_id, library_scope],
        )?;
    }
    Ok(())
}

/// Library tagging only changes `track.library_id`; identity keys stay valid.
/// Refresh existing sidecar rows from the authoritative track rows in one batch.
pub(crate) fn refresh_library_ids_for_albums(
    tx: &Transaction<'_>,
    server_id: &str,
    album_ids: &[String],
) -> rusqlite::Result<()> {
    if album_ids.is_empty() {
        return Ok(());
    }
    let placeholders = (0..album_ids.len())
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE cluster.track_cluster_key AS ck \
         SET library_id = COALESCE(( \
           SELECT t.library_id FROM track t \
           WHERE t.server_id = ck.server_id AND t.id = ck.track_id \
         ), '') \
         WHERE ck.server_id = ? \
           AND ck.track_id IN ( \
             SELECT id FROM track WHERE server_id = ? AND album_id IN ({placeholders}) \
           )"
    );
    let mut values: Vec<rusqlite::types::Value> =
        vec![server_id.to_string().into(), server_id.to_string().into()];
    values.extend(album_ids.iter().cloned().map(Into::into));
    tx.execute(&sql, params_from_iter(values.iter()))?;
    Ok(())
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `true` when `cluster_meta.norm_version` is missing or differs from [`NORM_VERSION`].
pub fn cluster_rebuild_needed(conn: &Connection) -> rusqlite::Result<bool> {
    let stored: Option<String> = conn
        .query_row(
            &format!("SELECT value FROM {CLUSTER_SCHEMA}.cluster_meta WHERE key = 'norm_version'"),
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(stored.as_deref() != Some(NORM_VERSION))
}

pub fn identity_maintenance_needed(store: &LibraryStore) -> Result<bool, String> {
    store.with_read_conn(|conn| {
        let has_sources: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM track WHERE deleted = 0) \
             OR EXISTS(SELECT 1 FROM identity_invalidation)",
            [],
            |row| row.get(0),
        )?;
        if !has_sources {
            return Ok(false);
        }
        if cluster_rebuild_needed(conn)? {
            return Ok(true);
        }
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM identity_invalidation) \
             OR EXISTS(SELECT 1 FROM cluster.cluster_meta WHERE key LIKE ?1)",
            params![format!("{DIRTY_META_PREFIX}%")],
            |row| row.get(0),
        )
    })
}

fn set_cluster_meta(conn: &Connection) -> rusqlite::Result<()> {
    let now = now_unix().to_string();
    conn.execute(
        &format!(
            "INSERT INTO {CLUSTER_SCHEMA}.cluster_meta(key, value) VALUES ('norm_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ),
        params![NORM_VERSION],
    )?;
    conn.execute(
        &format!(
            "INSERT INTO {CLUSTER_SCHEMA}.cluster_meta(key, value) VALUES ('build_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ),
        params![now],
    )?;
    Ok(())
}

pub(crate) fn concrete_physical_album_key(server_id: &str, album_id: &str) -> String {
    format!("physical:{}:{server_id}:{album_id}", server_id.len())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingRebuild<'a> {
    All,
    ServerFull(&'a str),
    ServerIncremental(&'a str),
}

impl<'a> PendingRebuild<'a> {
    fn server_id(self) -> Option<&'a str> {
        match self {
            Self::All => None,
            Self::ServerFull(server_id) | Self::ServerIncremental(server_id) => Some(server_id),
        }
    }
}

fn pending_rebuild<'a>(
    conn: &Connection,
    server_id: &'a str,
) -> rusqlite::Result<Option<PendingRebuild<'a>>> {
    if cluster_rebuild_needed(conn)? {
        return Ok(Some(PendingRebuild::All));
    }
    let legacy_dirty: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM cluster.cluster_meta WHERE key = ?1)",
        params![dirty_meta_key(server_id)],
        |row| row.get(0),
    )?;
    if legacy_dirty || super::invalidation::has_server_invalidation(conn, server_id)? {
        return Ok(Some(PendingRebuild::ServerFull(server_id)));
    }
    if super::invalidation::has_any(conn, server_id)? {
        return Ok(Some(PendingRebuild::ServerIncremental(server_id)));
    }
    Ok(None)
}

/// Rebuild identity keys for one server or all servers. Returns rows upserted.
pub fn rebuild_cluster_keys(store: &LibraryStore, server_id: Option<&str>) -> Result<u64, String> {
    store.with_conn_mut("identity.rebuild_cluster_keys", |conn| {
        // `norm_version` is global. A stale per-server request must rebuild every
        // server before stamping the new version, otherwise untouched keys would
        // be stranded under the new global marker.
        let server_id = if server_id.is_some() && cluster_rebuild_needed(conn)? {
            None
        } else {
            server_id
        };
        pipeline::rebuild_cluster_keys_on_conn(conn, server_id)
    })
}

/// Build cluster keys before a multi-library read. Rebuilds when either:
/// - the stored `norm_version` differs from [`NORM_VERSION`] (normalization rules
///   changed) — then **all** servers are rebuilt, because [`rebuild_cluster_keys`]
///   stamps a single global `norm_version`; a per-server rebuild would flip the
///   gate and strand every other server's stale keys; or
/// - durable invalidations are pending for this server. Initial/resync ingestion
///   records a server invalidation; ordinary mutations record exact entities.
pub fn ensure_cluster_keys_built(store: &LibraryStore, server_id: &str) -> Result<u64, String> {
    let pending = match store.with_read_conn(|conn| Ok(pending_rebuild(conn, server_id)?.is_some()))
    {
        Ok(pending) => pending,
        // Shared-cache in-memory tests and a busy sidecar can briefly reject a
        // read while another owner commits cluster metadata. Serialize through
        // the writer and re-check instead of surfacing a maintenance failure.
        Err(error) if error.contains("locked") => true,
        Err(error) => return Err(error),
    };
    if !pending {
        return Ok(0);
    }
    store.with_conn_mut("identity.ensure_cluster_keys_built", |conn| {
        // Re-check under the writer lock because another maintenance owner may
        // have drained the journal after the read-only preflight.
        let Some(pending) = pending_rebuild(conn, server_id)? else {
            return Ok(0);
        };
        match pending {
            PendingRebuild::All | PendingRebuild::ServerFull(_) => {
                pipeline::rebuild_cluster_keys_on_conn(conn, pending.server_id())
            }
            PendingRebuild::ServerIncremental(server_id) => {
                pipeline::apply_identity_invalidations_on_conn(conn, server_id)
            }
        }
    })
}

fn pending_identity_server_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "WITH RECURSIVE track_server(server_id) AS ( \
           SELECT MIN(server_id) FROM track INDEXED BY idx_track_album WHERE deleted = 0 \
           UNION ALL \
           SELECT ( \
             SELECT MIN(server_id) FROM track INDEXED BY idx_track_album \
             WHERE deleted = 0 AND server_id > track_server.server_id \
           ) FROM track_server WHERE server_id IS NOT NULL \
         ) \
         SELECT server_id FROM track_server WHERE server_id IS NOT NULL \
         UNION SELECT server_id FROM sync_state \
         UNION SELECT server_id FROM identity_invalidation \
         UNION SELECT substr(key, length(?1) + 1) FROM cluster.cluster_meta \
               WHERE key LIKE ?2 \
         ORDER BY server_id",
    )?;
    let server_ids = statement
        .query_map(
            params![DIRTY_META_PREFIX, format!("{DIRTY_META_PREFIX}%")],
            |row| row.get::<_, String>(0),
        )?
        .collect();
    server_ids
}

/// Drain persisted invalidations at process start. This runs off the Tauri main
/// thread; normal healthy starts use prefix seeks over the track index plus
/// compact metadata tables, then perform O(1) journal checks per server.
pub fn ensure_pending_cluster_keys(store: &LibraryStore) -> Result<u64, String> {
    let server_ids = store
        .with_read_conn(pending_identity_server_ids)
        .map_err(|error| error.to_string())?;
    let mut refreshed = 0u64;
    for server_id in server_ids {
        refreshed = refreshed.saturating_add(ensure_cluster_keys_built(store, &server_id)?);
    }
    Ok(refreshed)
}

/// Test helper: read one row from the attached `cluster` schema on any connection.
#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(crate) fn read_cluster_row(
    conn: &Connection,
    server_id: &str,
    track_id: &str,
) -> rusqlite::Result<Option<(Option<String>, Option<String>, Option<String>, i64)>> {
    conn.query_row(
        "SELECT cluster_key, album_key, artist_key, duration_sec \
         FROM cluster.track_cluster_key WHERE server_id = ?1 AND track_id = ?2",
        params![server_id, track_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
}

#[cfg(test)]
mod tests;

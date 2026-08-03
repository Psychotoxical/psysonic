//! Batch rebuild of `cluster.track_cluster_key` from live `track` rows.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};

use crate::store::LibraryStore;

use super::attach::CLUSTER_SCHEMA;
use super::keys::{build_album_key, build_track_cluster_keys};
use super::norm::{norm_part, NORM_VERSION};

const UPSERT_CLUSTER_KEY_SQL: &str = "
INSERT INTO cluster.track_cluster_key (
  server_id, library_id, track_id, cluster_key, album_key, artist_key, duration_sec
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(server_id, track_id) DO UPDATE SET
  library_id   = excluded.library_id,
  cluster_key  = excluded.cluster_key,
  album_key    = excluded.album_key,
  artist_key   = excluded.artist_key,
  duration_sec = excluded.duration_sec
WHERE track_cluster_key.library_id IS NOT excluded.library_id
   OR track_cluster_key.cluster_key IS NOT excluded.cluster_key
   OR track_cluster_key.album_key IS NOT excluded.album_key
   OR track_cluster_key.artist_key IS NOT excluded.artist_key
   OR track_cluster_key.duration_sec IS NOT excluded.duration_sec
";

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

type SourceTrackRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

pub(crate) fn concrete_physical_album_key(server_id: &str, album_id: &str) -> String {
    format!("physical:{}:{server_id}:{album_id}", server_id.len())
}

fn occurrence_rank_order_sql() -> &'static str {
    "CASE WHEN t.disc_number IS NULL THEN 1 ELSE 0 END, t.disc_number, \
     CASE WHEN t.track_number IS NULL THEN 1 ELSE 0 END, t.track_number, \
     COALESCE(t.server_path, ''), ck.track_id"
}

fn recompute_all_occurrence_ranks(
    tx: &Transaction<'_>,
    server_id: Option<&str>,
) -> rusqlite::Result<()> {
    let server_filter = if server_id.is_some() {
        " AND ck.server_id = ?1"
    } else {
        ""
    };
    let sql = format!(
        "WITH ranked AS MATERIALIZED ( \
           SELECT ck.server_id, ck.track_id, \
                  ROW_NUMBER() OVER ( \
                    PARTITION BY ck.server_id, ck.cluster_key, ck.duration_sec / 5 \
                    ORDER BY {} \
                  ) - 1 AS occurrence_rank \
           FROM cluster.track_cluster_key ck \
           INNER JOIN track t ON t.server_id = ck.server_id AND t.id = ck.track_id \
           WHERE t.deleted = 0 AND ck.cluster_key IS NOT NULL{server_filter} \
         ) \
         UPDATE cluster.track_cluster_key AS ck \
         SET occurrence_rank = ranked.occurrence_rank \
         FROM ranked \
         WHERE ck.server_id = ranked.server_id AND ck.track_id = ranked.track_id \
           AND ck.occurrence_rank IS NOT ranked.occurrence_rank",
        occurrence_rank_order_sql(),
    );
    match server_id {
        Some(server_id) => {
            tx.execute(&sql, params![server_id])?;
            tx.execute(
                "UPDATE cluster.track_cluster_key SET occurrence_rank = 0 \
                 WHERE server_id = ?1 AND cluster_key IS NULL AND occurrence_rank != 0",
                params![server_id],
            )?;
        }
        None => {
            tx.execute(&sql, [])?;
            tx.execute(
                "UPDATE cluster.track_cluster_key SET occurrence_rank = 0 \
                 WHERE cluster_key IS NULL AND occurrence_rank != 0",
                [],
            )?;
        }
    }
    Ok(())
}

fn reset_affected_rank_partitions(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS identity_rank_partition ( \
           cluster_key TEXT NOT NULL, \
           duration_bucket INTEGER NOT NULL, \
           PRIMARY KEY (cluster_key, duration_bucket) \
         ) WITHOUT ROWID; \
         DELETE FROM temp.identity_rank_partition;",
    )
}

const CAPTURE_INVALIDATED_RANK_PARTITIONS_SQL: &str = "WITH invalidated_artist AS MATERIALIZED ( \
       SELECT entity_id FROM identity_invalidation \
       WHERE server_id = ?1 AND kind = 'artist' \
     ), \
     invalidated_album AS MATERIALIZED ( \
       SELECT entity_id FROM identity_invalidation \
       WHERE server_id = ?1 AND kind = 'album' \
       UNION \
       SELECT DISTINCT t.album_id FROM invalidated_artist ia \
       CROSS JOIN track t INDEXED BY idx_track_artist \
       WHERE t.server_id = ?1 AND t.deleted = 0 AND t.artist_id = ia.entity_id \
         AND t.album_id IS NOT NULL AND t.album_id != '' \
     ), \
     candidate_track AS MATERIALIZED ( \
       SELECT entity_id FROM identity_invalidation \
       WHERE server_id = ?1 AND kind = 'track' \
       UNION \
       SELECT t.id FROM invalidated_album ia \
       CROSS JOIN track t INDEXED BY idx_track_album \
       WHERE t.server_id = ?1 AND t.deleted = 0 AND t.album_id = ia.entity_id \
       UNION \
       SELECT t.id FROM invalidated_artist ia \
       CROSS JOIN track t INDEXED BY idx_track_artist \
       WHERE t.server_id = ?1 AND t.deleted = 0 AND t.artist_id = ia.entity_id \
     ) \
     INSERT OR IGNORE INTO temp.identity_rank_partition(cluster_key, duration_bucket) \
     SELECT ck.cluster_key, ck.duration_sec / 5 \
     FROM candidate_track candidate \
     INNER JOIN cluster.track_cluster_key ck \
       ON ck.server_id = ?1 AND ck.track_id = candidate.entity_id \
     WHERE ck.cluster_key IS NOT NULL";

fn capture_invalidated_rank_partitions(
    tx: &Transaction<'_>,
    server_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(CAPTURE_INVALIDATED_RANK_PARTITIONS_SQL, params![server_id])?;
    Ok(())
}

fn recompute_affected_occurrence_ranks(
    tx: &Transaction<'_>,
    server_id: &str,
) -> rusqlite::Result<()> {
    let sql = format!(
        "WITH ranked AS MATERIALIZED ( \
           SELECT ck.server_id, ck.track_id, \
                  ROW_NUMBER() OVER ( \
                    PARTITION BY ck.server_id, ck.cluster_key, ck.duration_sec / 5 \
                    ORDER BY {} \
                  ) - 1 AS occurrence_rank \
           FROM temp.identity_rank_partition affected \
           CROSS JOIN cluster.track_cluster_key ck \
             ON ck.server_id = ?1 AND ck.cluster_key = affected.cluster_key \
            AND ck.duration_sec / 5 = affected.duration_bucket \
           INNER JOIN track t ON t.server_id = ck.server_id AND t.id = ck.track_id \
           WHERE t.deleted = 0 \
         ) \
         UPDATE cluster.track_cluster_key AS ck \
         SET occurrence_rank = ranked.occurrence_rank \
         FROM ranked \
         WHERE ck.server_id = ranked.server_id AND ck.track_id = ranked.track_id \
           AND ck.occurrence_rank IS NOT ranked.occurrence_rank",
        occurrence_rank_order_sql(),
    );
    tx.execute(&sql, params![server_id])?;
    tx.execute(
        "UPDATE cluster.track_cluster_key SET occurrence_rank = 0 \
         WHERE server_id = ?1 AND cluster_key IS NULL AND track_id IN ( \
           SELECT entity_id FROM identity_invalidation \
           WHERE server_id = ?1 AND kind = 'track' \
         )",
        params![server_id],
    )?;
    tx.execute("DELETE FROM temp.identity_rank_partition", [])?;
    Ok(())
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

fn upsert_source_track(
    source: SourceTrackRow,
    upsert: &mut rusqlite::Statement<'_>,
) -> rusqlite::Result<()> {
    let (
        server_id,
        library_id,
        track_id,
        artist,
        canonical_artist,
        title,
        album_artist,
        album,
        album_id,
        canonical_album_artist,
        canonical_album,
        duration_sec,
    ) = source;
    let mut keys = build_track_cluster_keys(
        artist.as_deref(),
        &title,
        &album,
        album_artist.as_deref(),
    );
    keys.artist_key = canonical_artist
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .or(artist.as_deref())
        .and_then(norm_part);
    if let Some(album_id) = album_id.as_deref().filter(|id| !id.trim().is_empty()) {
        keys.album_key = canonical_album_artist
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .and_then(|name| {
                build_album_key(Some(name), canonical_album.as_deref().unwrap_or(&album))
            })
            .or_else(|| Some(concrete_physical_album_key(&server_id, album_id)));
    }
    upsert.execute(params![
        server_id,
        library_id,
        track_id,
        keys.cluster_key,
        keys.album_key,
        keys.artist_key,
        duration_sec,
    ])?;
    Ok(())
}

fn rebuild_cluster_keys_on_conn(
    conn: &mut Connection,
    server_id: Option<&str>,
) -> rusqlite::Result<u64> {
    let tx = conn.transaction()?;
    let album_server_filter = if server_id.is_some() {
        " AND source.server_id = ?1"
    } else {
        ""
    };
    let track_server_filter = if server_id.is_some() {
        " AND t.server_id = ?1"
    } else {
        ""
    };
    // The identity-grade test, not the browse filter: a credit that passes here
    // becomes half of an album key, so `Various` and `Soundtrack` have to fall
    // out too, not just the one spelling the filter happens to match.
    let va_credit =
        crate::album_compilation_filter::collection_credit_sql("MAX(source.album_artist)");
    let select = format!(
        "WITH physical_album AS MATERIALIZED ( \
           SELECT source.server_id, source.album_id, \
                  COALESCE( \
                    /* First choice stays the canonical artist entity: it is the \
                       one that follows a rename, which a stored tag string does \
                       not. \
                       Second choice is the album's own credit, when every track \
                       agrees on one AND that credit actually performs on the \
                       album. That is the album carrying a correctly tagged \
                       guest: its track artists are no longer uniform, so the \
                       entity rule cannot fire, and without this the album lost \
                       its identity and could not merge with another copy of \
                       itself. The performing test is what keeps a label credit \
                       out — a various-artists label matches no track, so a \
                       compilation keeps its physical key and two unrelated \
                       compilations sharing a title cannot collapse into one. */ \
                    CASE WHEN COUNT(*) = COUNT(ar_source.id) \
                           AND COUNT(DISTINCT source.artist_id) = 1 \
                         THEN MAX(ar_source.name) END, \
                    CASE WHEN COUNT(NULLIF(TRIM(source.album_artist), '')) = COUNT(*) \
                           AND COUNT(DISTINCT NULLIF(TRIM(source.album_artist), '')) = 1 \
                           AND NOT ({va_credit}) \
                           AND SUM(CASE WHEN lower(TRIM(source.album_artist)) \
                                           = lower(TRIM(source.artist)) \
                                        THEN 1 ELSE 0 END) > 0 \
                         THEN MAX(NULLIF(TRIM(source.album_artist), '')) END \
                  ) AS canonical_album_artist, \
                  MAX(source.album) AS canonical_album \
           FROM track source \
           LEFT JOIN artist ar_source \
             ON ar_source.server_id = source.server_id AND ar_source.id = source.artist_id \
           WHERE source.deleted = 0 \
             AND source.album_id IS NOT NULL AND source.album_id != ''{album_server_filter} \
           GROUP BY source.server_id, source.album_id \
         ) \
         SELECT t.server_id, COALESCE(t.library_id, ''), t.id, t.artist, ar.name, t.title, \
                t.album_artist, t.album, t.album_id, physical_album.canonical_album_artist, \
                physical_album.canonical_album, t.duration_sec \
         FROM track t \
         LEFT JOIN artist ar ON ar.server_id = t.server_id AND ar.id = t.artist_id \
         LEFT JOIN physical_album \
           ON physical_album.server_id = t.server_id AND physical_album.album_id = t.album_id \
         WHERE t.deleted = 0{track_server_filter}"
    );
    // Stream rows straight from the `track` SELECT into the sidecar UPSERT
    // (both statements borrow the same tx; the SELECT reads `track`, the
    // UPSERT writes the attached `cluster` table, so they don't contend).
    // Avoids materializing the whole track table (~60–70 MB on 212k rows)
    // before writing.
    let filter_params: Vec<&str> = server_id.into_iter().collect();
    let mut stmt = tx.prepare(&select)?;
    let mut upsert = tx.prepare_cached(UPSERT_CLUSTER_KEY_SQL)?;
    let mut upserted = 0u64;
    let mut rows = stmt.query(rusqlite::params_from_iter(filter_params.iter()))?;
    while let Some(row) = rows.next()? {
        upsert_source_track(map_source_track_row(row)?, &mut upsert)?;
        upserted = upserted.saturating_add(1);
    }
    drop(rows);
    drop(stmt);
    drop(upsert);
    // Prune keys whose track no longer exists (soft-deleted via tombstone, or
    // dropped when a server mints a fresh id on rename). The UPSERT above only
    // refreshes live rows; without this, orphaned keys accumulate forever and
    // are only reclaimed when the whole sidecar is dropped (swap/restore/import).
    // Reads join `cluster.track_cluster_key` against `track WHERE deleted = 0`,
    // so these rows are inert — this is bloat cleanup, scoped to the rebuilt
    // server(s) so a single-server rebuild never touches other servers' keys.
    if let Some(sid) = server_id {
        tx.execute(
            "DELETE FROM cluster.track_cluster_key \
             WHERE server_id = ?1 \
               AND track_id NOT IN (\
                 SELECT id FROM track WHERE deleted = 0 AND server_id = ?1\
               )",
            params![sid],
        )?;
    } else {
        tx.execute(
            "DELETE FROM cluster.track_cluster_key \
             WHERE (server_id, track_id) NOT IN (\
               SELECT server_id, id FROM track WHERE deleted = 0\
             )",
            [],
        )?;
    }
    recompute_all_occurrence_ranks(&tx, server_id)?;
    crate::browse_projection::reconcile_identity_keys(&tx, server_id)?;
    match server_id {
        Some(server_id) => {
            tx.execute(
                "DELETE FROM cluster.cluster_meta WHERE key = ?1",
                params![dirty_meta_key(server_id)],
            )?;
        }
        None => {
            tx.execute(
                "DELETE FROM cluster.cluster_meta WHERE key LIKE ?1",
                params![format!("{DIRTY_META_PREFIX}%")],
            )?;
        }
    }
    super::invalidation::clear(&tx, server_id)?;
    set_cluster_meta(&tx)?;
    tx.commit()?;
    Ok(upserted)
}

fn apply_identity_invalidations_on_conn(
    conn: &mut Connection,
    server_id: &str,
) -> rusqlite::Result<u64> {
    let tx = conn.transaction()?;
    reset_affected_rank_partitions(&tx)?;
    capture_invalidated_rank_partitions(&tx, server_id)?;
    // Same label test as the full rebuild — the two paths must derive identical
    // keys or an album's card merges or splits depending on which maintenance
    // pass ran last.
    let va_credit =
        crate::album_compilation_filter::collection_credit_sql("MAX(source.album_artist)");
    let select = &format!(
        "WITH invalidated_artist AS MATERIALIZED ( \
                    SELECT entity_id FROM identity_invalidation \
                    WHERE server_id = ?1 AND kind = 'artist' \
                  ), \
                  invalidated_album AS MATERIALIZED ( \
                    SELECT entity_id FROM identity_invalidation \
                    WHERE server_id = ?1 AND kind = 'album' \
                    UNION \
                    SELECT DISTINCT t.album_id FROM invalidated_artist ia \
                    CROSS JOIN track t INDEXED BY idx_track_artist \
                    WHERE t.server_id = ?1 AND t.artist_id = ia.entity_id AND t.deleted = 0 \
                      AND t.album_id IS NOT NULL AND t.album_id != '' \
                  ), \
                  candidate_track AS MATERIALIZED ( \
                    SELECT entity_id FROM identity_invalidation \
                    WHERE server_id = ?1 AND kind = 'track' \
                    UNION \
                    SELECT t.id FROM invalidated_album ia \
                    CROSS JOIN track t INDEXED BY idx_track_album \
                    WHERE t.server_id = ?1 AND t.album_id = ia.entity_id AND t.deleted = 0 \
                    UNION \
                    SELECT t.id FROM invalidated_artist ia \
                    CROSS JOIN track t INDEXED BY idx_track_artist \
                    WHERE t.server_id = ?1 AND t.artist_id = ia.entity_id AND t.deleted = 0 \
                  ), \
                  physical_album AS MATERIALIZED ( \
                    SELECT source.server_id, source.album_id, \
                            /* Same precedence as the full rebuild: canonical \
                               artist entity first, album credit fallback. */ \
                           COALESCE( \
                             CASE WHEN COUNT(*) = COUNT(ar_source.id) \
                                    AND COUNT(DISTINCT source.artist_id) = 1 \
                                  THEN MAX(ar_source.name) END, \
                             CASE WHEN COUNT(NULLIF(TRIM(source.album_artist), '')) = COUNT(*) \
                                    AND COUNT(DISTINCT NULLIF(TRIM(source.album_artist), '')) = 1 \
                                    AND NOT ({va_credit}) \
                                    AND SUM(CASE WHEN lower(TRIM(source.album_artist)) \
                                                    = lower(TRIM(source.artist)) \
                                                 THEN 1 ELSE 0 END) > 0 \
                                  THEN MAX(NULLIF(TRIM(source.album_artist), '')) END \
                           ) AS canonical_album_artist, \
                           MAX(source.album) AS canonical_album \
                    FROM invalidated_album ia \
                    CROSS JOIN track source INDEXED BY idx_track_album \
                    LEFT JOIN artist ar_source \
                      ON ar_source.server_id = source.server_id \
                     AND ar_source.id = source.artist_id \
                    WHERE source.server_id = ?1 AND source.album_id = ia.entity_id \
                      AND source.deleted = 0 \
                    GROUP BY source.server_id, source.album_id \
                  ) \
                  SELECT t.server_id, COALESCE(t.library_id, ''), t.id, t.artist, ar.name, \
                         t.title, t.album_artist, t.album, t.album_id, \
                         physical_album.canonical_album_artist, physical_album.canonical_album, \
                         t.duration_sec \
                  FROM candidate_track candidate \
                  CROSS JOIN track t INDEXED BY sqlite_autoindex_track_1 \
                  LEFT JOIN artist ar \
                    ON ar.server_id = t.server_id AND ar.id = t.artist_id \
                  LEFT JOIN physical_album \
                    ON physical_album.server_id = t.server_id \
                   AND physical_album.album_id = t.album_id \
                  WHERE t.server_id = ?1 AND t.id = candidate.entity_id AND t.deleted = 0"
    );
    let mut statement = tx.prepare(select)?;
    let mut upsert = tx.prepare_cached(UPSERT_CLUSTER_KEY_SQL)?;
    let mut rows = statement.query(params![server_id])?;
    let mut refreshed = 0u64;
    while let Some(row) = rows.next()? {
        upsert_source_track(map_source_track_row(row)?, &mut upsert)?;
        refreshed = refreshed.saturating_add(1);
    }
    drop(rows);
    drop(statement);
    drop(upsert);

    capture_invalidated_rank_partitions(&tx, server_id)?;

    tx.execute(
        "DELETE FROM cluster.track_cluster_key AS ck \
         WHERE ck.server_id = ?1 \
           AND ck.track_id IN ( \
             SELECT entity_id FROM identity_invalidation \
             WHERE server_id = ?1 AND kind = 'track' \
           ) \
           AND NOT EXISTS ( \
             SELECT 1 FROM track t \
             WHERE t.server_id = ck.server_id AND t.id = ck.track_id AND t.deleted = 0 \
           )",
        params![server_id],
    )?;
    recompute_affected_occurrence_ranks(&tx, server_id)?;
    set_cluster_meta(&tx)?;
    tx.commit()?;

    // A crash after the sidecar commit leaves the durable main-DB journal in
    // place, so the same idempotent key writes repeat on the next ensure. Keep
    // main projection writes + acknowledgement in their own atomic transaction
    // instead of paying a cross-database FULL-sync commit for every delta.
    let tx = conn.transaction()?;
    crate::browse_projection::reconcile_invalidated_identity_keys(&tx, server_id)?;
    super::invalidation::clear(&tx, Some(server_id))?;
    tx.commit()?;
    Ok(refreshed)
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
        rebuild_cluster_keys_on_conn(conn, server_id)
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
    let pending = match store
        .with_read_conn(|conn| Ok(pending_rebuild(conn, server_id)?.is_some()))
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
                rebuild_cluster_keys_on_conn(conn, pending.server_id())
            }
            PendingRebuild::ServerIncremental(server_id) => {
                apply_identity_invalidations_on_conn(conn, server_id)
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

fn map_source_track_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceTrackRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
    ))
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
mod tests {
    use super::*;
    use crate::identity::norm::{norm_part, NORM_VERSION};
    use crate::repos::artist::ArtistRepository;
    use crate::repos::track::{TrackRepository, TrackRow};
    use crate::store::LibraryStore;
    use psysonic_integration::subsonic::{ArtistIndex, ArtistRef, IndexBucket};

    #[allow(clippy::too_many_arguments)]
    fn track_row(
        server: &str,
        id: &str,
        title: &str,
        artist: Option<&str>,
        album: &str,
        album_artist: Option<&str>,
        duration: i64,
        library_id: &str,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: artist.map(str::to_string),
            artist_id: None,
            album: album.into(),
            album_id: None,
            album_artist: album_artist.map(str::to_string),
            duration_sec: duration,
            track_number: None,
            disc_number: None,
            year: None,
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
    fn physical_album_track_row(
        server: &str,
        id: &str,
        title: &str,
        artist: &str,
        artist_id: &str,
        album: &str,
        album_id: &str,
        album_artist: &str,
        library_id: &str,
    ) -> TrackRow {
        let mut row = track_row(
            server,
            id,
            title,
            Some(artist),
            album,
            Some(album_artist),
            200,
            library_id,
        );
        row.artist_id = Some(artist_id.into());
        row.album_id = Some(album_id.into());
        row
    }

    #[test]
    fn pending_identity_servers_include_indexed_tracks_and_compact_metadata() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.identity.pending_servers", |conn| {
                conn.execute(
                    "INSERT INTO track (server_id, id, title, album, synced_at, raw_json) \
                     VALUES ('track-server', 'track', 'Track', 'Album', 1, '{}'), \
                            ('deleted-server', 'deleted', 'Deleted', 'Album', 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "UPDATE track SET deleted = 1 WHERE server_id = 'deleted-server'",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO sync_state (server_id, library_scope) \
                     VALUES ('sync-server', ''), ('track-server', '')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO identity_invalidation (server_id, kind, entity_id) \
                     VALUES ('journal-server', 'server', '')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO cluster.cluster_meta (key, value) VALUES (?1, '1')",
                    params![dirty_meta_key("dirty-server")],
                )?;
                Ok(())
            })
            .unwrap();

        let server_ids = store.with_read_conn(pending_identity_server_ids).unwrap();
        assert_eq!(
            server_ids,
            vec!["dirty-server", "journal-server", "sync-server", "track-server"]
        );
    }

    #[test]
    fn rebuild_populates_keys_and_duration() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row(
                    "s1",
                    "t1",
                    "Café Song",
                    Some("Björk"),
                    "Homogenic",
                    Some("Björk"),
                    312,
                    "lib-a",
                ),
                track_row("s1", "t2", "No Artist", None, "Al", None, 100, "lib-a"),
            ])
            .unwrap();

        let n = rebuild_cluster_keys(&store, Some("s1")).unwrap();
        assert_eq!(n, 2);

        let row = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();
        let (cluster_key, album_key, artist_key, duration) = row;
        assert_eq!(duration, 312);
        assert_eq!(artist_key.as_deref(), norm_part("Björk").as_deref());
        assert!(cluster_key.is_some());
        assert!(album_key.is_some());

        let empty_artist = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t2"))
            .unwrap()
            .unwrap();
        assert!(empty_artist.0.is_none());
        assert!(empty_artist.2.is_none());
    }

    #[test]
    fn incremental_tombstone_reranks_remaining_track_occurrence() {
        let store = LibraryStore::open_in_memory();
        let mut first = track_row(
            "s1", "t1", "Tyrion", Some("Narrator"), "Book", Some("Narrator"), 300, "lib",
        );
        first.track_number = Some(1);
        let mut second = first.clone();
        second.id = "t2".into();
        second.track_number = Some(2);
        TrackRepository::new(&store)
            .upsert_batch(&[first, second])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        let before = store
            .with_read_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT track_id, occurrence_rank FROM cluster.track_cluster_key \
                     WHERE server_id = 's1' ORDER BY track_id",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(before, vec![("t1".into(), 0), ("t2".into(), 1)]);

        TrackRepository::new(&store)
            .apply_tombstone_results("s1", "", &[], &["t1".into()])
            .unwrap();
        ensure_cluster_keys_built(&store, "s1").unwrap();

        let after = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT track_id, occurrence_rank FROM cluster.track_cluster_key \
                     WHERE server_id = 's1'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
            })
            .unwrap();
        assert_eq!(after, ("t2".into(), 0));
    }

    #[test]
    fn invalidated_rank_partition_plan_uses_partial_track_indexes() {
        let store = LibraryStore::open_in_memory();
        let plan = store
            .with_conn_mut("test.invalidated_rank_partition_plan", |conn| {
                conn.execute_batch(
                    "CREATE TEMP TABLE IF NOT EXISTS identity_rank_partition ( \
                       cluster_key TEXT NOT NULL, \
                       duration_bucket INTEGER NOT NULL, \
                       PRIMARY KEY (cluster_key, duration_bucket) \
                     ) WITHOUT ROWID;",
                )?;
                let mut statement = conn.prepare(&format!(
                    "EXPLAIN QUERY PLAN {CAPTURE_INVALIDATED_RANK_PARTITIONS_SQL}"
                ))?;
                let plan = statement
                    .query_map(params!["s1"], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(plan)
            })
            .unwrap();

        assert!(
            plan.iter().any(|line| line.contains("idx_track_artist")),
            "artist invalidation did not use idx_track_artist: {plan:#?}"
        );
        assert!(
            plan.iter().any(|line| line.contains("idx_track_album")),
            "album invalidation did not use idx_track_album: {plan:#?}"
        );
    }

    #[test]
    fn rebuild_uses_canonical_artist_name_for_every_track_with_the_same_artist_id() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row(
                    "s1",
                    "t1",
                    "Song 1",
                    Some("Andromida • Daedric"),
                    "Album 1",
                    None,
                    200,
                    "lib-a",
                ),
                track_row(
                    "s1",
                    "t2",
                    "Song 2",
                    Some("Andromida • Nevertel"),
                    "Album 2",
                    None,
                    220,
                    "lib-a",
                ),
            ])
            .unwrap();
        store
            .with_conn_mut("test.canonical_artist_key", |conn| {
                conn.execute("UPDATE track SET artist_id = 'artist-1' WHERE server_id = 's1'", [])?;
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES ('s1', 'artist-1', 'Andromida', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        for track_id in ["t1", "t2"] {
            let row = store
                .with_read_conn(|conn| read_cluster_row(conn, "s1", track_id))
                .unwrap()
                .unwrap();
            assert_eq!(row.2.as_deref(), Some("andromida"));
        }
    }

    #[test]
    fn rebuild_canonicalizes_unambiguous_physical_album_artist() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[physical_album_track_row(
                "s1",
                "t1",
                "The Ecstasy of Gold",
                "Metallica",
                "artist-1",
                "S&M2",
                "album-1",
                "Metallica & San Francisco Symphony",
                "lib-a",
            )])
            .unwrap();
        store
            .with_conn_mut("test.canonical_album_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) \
                     VALUES ('s1', 'artist-1', 'Metallica', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();

        let row = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();
        assert_eq!(row.1, build_album_key(Some("Metallica"), "S&M2"));
    }

    /// An album credited to one artist that carries a correctly tagged guest on
    /// one track. Its track artists are no longer uniform, so the entity rule
    /// cannot fire — and before the album credit was consulted the album fell
    /// back to a physical key and could no longer merge with another copy of
    /// itself, which is how one retagged album turned into two cards.
    #[test]
    fn rebuild_keys_an_album_with_a_guest_track_by_its_own_credit() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                physical_album_track_row(
                    "s1", "t1", "One", "Main Act", "artist-main", "Record", "album-1", "Main Act",
                    "lib-a",
                ),
                physical_album_track_row(
                    "s1", "t2", "Two", "Guest Act", "artist-guest", "Record", "album-1",
                    "Main Act", "lib-a",
                ),
            ])
            .unwrap();
        store
            .with_conn_mut("test.guest_album_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES \
                     ('s1', 'artist-main', 'Main Act', 1), \
                     ('s1', 'artist-guest', 'Guest Act', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();

        let key = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap()
            .1
            .unwrap();
        assert_eq!(
            key,
            build_album_key(Some("Main Act"), "Record").unwrap(),
            "the credited artist performs on the album, so it keeps its identity"
        );
    }

    /// The credit-matches-a-performer test is not enough on its own: plenty of
    /// libraries tag compilation tracks with the label as the track artist too.
    /// Then the label matches, and two unrelated compilations sharing a title
    /// would collapse into one album — the exact failure the physical key
    /// exists to prevent.
    #[test]
    fn rebuild_keeps_a_various_artists_compilation_concrete() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                physical_album_track_row(
                    "s1", "t1", "One", "Various Artists", "artist-va", "Greatest", "album-1",
                    "Various Artists", "lib-a",
                ),
                physical_album_track_row(
                    "s1", "t2", "Two", "Some Band", "artist-band", "Greatest", "album-1",
                    "Various Artists", "lib-a",
                ),
            ])
            .unwrap();
        store
            .with_conn_mut("test.va_album_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES \
                     ('s1', 'artist-va', 'Various Artists', 1), \
                     ('s1', 'artist-band', 'Some Band', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();

        let key = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap()
            .1
            .unwrap();
        assert!(
            key.starts_with("physical:2:s1:album-1"),
            "a label credit must not become an identity, got {key}"
        );
    }

    /// `Various Artists` is one spelling of many. Libraries tag the same thing
    /// `Various`, `VA`, `Sampler`, `Soundtrack` — and where the browse filter
    /// missing a spelling only under-reports a compilation, missing one here
    /// mints an album key, so two unrelated records with the same title merge
    /// into one card and the user has no way to separate them again.
    #[test]
    fn rebuild_keeps_short_collection_labels_concrete() {
        for (index, label) in [
            "Various",
            "VA",
            "V.A",
            "Sampler",
            "Soundtrack",
            "Compilations",
            "Original Motion Picture Soundtrack",
            "Original Score",
            "Diversos Artistas",
            "Artistes Variés",
            "Vários Artistas",
            "Verschiedene Künstler",
        ]
        .into_iter()
        .enumerate()
        {
            let store = LibraryStore::open_in_memory();
            let artist_id = format!("artist-label-{index}");
            TrackRepository::new(&store)
                .upsert_batch(&[
                    // The performing test passes: this track's own artist string
                    // is the label, which is a common tagging style.
                    physical_album_track_row(
                        "s1", "t1", "One", label, &artist_id, "Greatest", "album-1", label, "lib-a",
                    ),
                    physical_album_track_row(
                        "s1", "t2", "Two", "Some Band", "artist-band", "Greatest", "album-1",
                        label, "lib-a",
                    ),
                ])
                .unwrap();
            store
                .with_conn_mut("test.label_album_artist", |conn| {
                    conn.execute(
                        "INSERT INTO artist (server_id, id, name, synced_at) VALUES \
                         ('s1', ?1, ?2, 1), ('s1', 'artist-band', 'Some Band', 1)",
                        rusqlite::params![artist_id, label],
                    )?;
                    Ok(())
                })
                .unwrap();

            rebuild_cluster_keys(&store, None).unwrap();

            let key = store
                .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
                .unwrap()
                .unwrap()
                .1
                .unwrap();
            assert!(
                key.starts_with("physical:2:s1:album-1"),
                "the label {label} must not become an identity, got {key}"
            );
        }
    }

    #[test]
    fn rebuild_keeps_ambiguous_physical_album_concrete() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                physical_album_track_row(
                    "s1",
                    "t1",
                    "One",
                    "Artist A",
                    "artist-a",
                    "Split",
                    "album-1",
                    "Various Artists",
                    "lib-a",
                ),
                physical_album_track_row(
                    "s1",
                    "t2",
                    "Two",
                    "Artist B",
                    "artist-b",
                    "Split",
                    "album-1",
                    "Various Artists",
                    "lib-a",
                ),
            ])
            .unwrap();
        store
            .with_conn_mut("test.ambiguous_album_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES \
                     ('s1', 'artist-a', 'Artist A', 1), \
                     ('s1', 'artist-b', 'Artist B', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();

        let first = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap()
            .1
            .unwrap();
        let second = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t2"))
            .unwrap()
            .unwrap()
            .1
            .unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("physical:2:s1:album-1"));
    }

    #[test]
    fn rebuild_is_idempotent() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track_row(
                "s1",
                "t1",
                "Title",
                Some("Artist"),
                "Album",
                None,
                200,
                "lib",
            )])
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();
        let first = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap();

        rebuild_cluster_keys(&store, None).unwrap();
        let second = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn rebuild_prunes_orphaned_cluster_keys() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T1", Some("A"), "Al", None, 100, "lib"),
                track_row("s1", "t2", "T2", Some("B"), "Al", None, 120, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();
        assert!(store
            .with_read_conn(|c| read_cluster_row(c, "s1", "t2"))
            .unwrap()
            .is_some());

        // Soft-delete t2 (tombstone) → its stale cluster key must be pruned on
        // the next rebuild, not linger forever.
        store
            .with_conn_mut("test.soft_delete", |c| {
                c.execute(
                    "UPDATE track SET deleted = 1 WHERE server_id = 's1' AND id = 't2'",
                    [],
                )
            })
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
                .unwrap()
                .is_some(),
            "live track key must remain"
        );
        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t2"))
                .unwrap()
                .is_none(),
            "orphaned cluster key must be pruned"
        );
    }

    #[test]
    fn global_rebuild_prunes_orphans_across_servers() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T1", Some("A"), "Al", None, 100, "lib"),
                track_row("s2", "t2", "T2", Some("B"), "Al", None, 120, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();
        assert!(store
            .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
            .unwrap()
            .is_some());
        assert!(store
            .with_read_conn(|c| read_cluster_row(c, "s2", "t2"))
            .unwrap()
            .is_some());

        // Both tracks go to tombstone; a global (server_id = None) rebuild must
        // prune the orphan on every server via the tuple-scoped DELETE branch.
        store
            .with_conn_mut("test.del", |c| {
                c.execute("UPDATE track SET deleted = 1 WHERE id IN ('t1', 't2')", [])
            })
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
                .unwrap()
                .is_none(),
            "global rebuild must prune s1 orphan"
        );
        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s2", "t2"))
                .unwrap()
                .is_none(),
            "global rebuild must prune s2 orphan"
        );
    }

    #[test]
    fn per_server_rebuild_leaves_other_server_keys() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T1", Some("A"), "Al", None, 100, "lib"),
                track_row("s2", "t2", "T2", Some("B"), "Al", None, 120, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        // Both tracks go to tombstone, but we rebuild only s1: s1's orphan is
        // pruned while s2's key is untouched (single global norm stamp, but the
        // prune is scoped to the rebuilt server).
        store
            .with_conn_mut("test.del", |c| {
                c.execute("UPDATE track SET deleted = 1 WHERE id IN ('t1', 't2')", [])
            })
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s1", "t1"))
                .unwrap()
                .is_none(),
            "rebuilt server's orphan must be pruned"
        );
        assert!(
            store
                .with_read_conn(|c| read_cluster_row(c, "s2", "t2"))
                .unwrap()
                .is_some(),
            "single-server rebuild must not prune another server's keys"
        );
    }

    #[test]
    fn norm_version_gate_and_bump() {
        let store = LibraryStore::open_in_memory();
        assert!(
            store.with_conn("misc", cluster_rebuild_needed).unwrap(),
            "fresh attach should need rebuild"
        );

        TrackRepository::new(&store)
            .upsert_batch(&[track_row("s1", "t1", "T", Some("A"), "Al", None, 1, "lib")])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        assert!(!store.with_conn("misc", cluster_rebuild_needed).unwrap());

        store
            .with_conn_mut("test.stale_norm", |conn| {
                conn.execute(
                    "UPDATE cluster.cluster_meta SET value = '0' WHERE key = 'norm_version'",
                    [],
                )
            })
            .unwrap();
        assert!(store.with_conn("misc", cluster_rebuild_needed).unwrap());

        rebuild_cluster_keys(&store, None).unwrap();
        let version: String = store
            .with_conn("misc", |conn| {
                conn.query_row(
                    "SELECT value FROM cluster.cluster_meta WHERE key = 'norm_version'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(version, NORM_VERSION);
    }

    #[test]
    fn ensure_cluster_keys_built_rebuilds_on_norm_version_mismatch() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "T", Some("A"), "Al", None, 1, "lib"),
                track_row("s2", "t2", "T2", Some("A2"), "Al2", None, 2, "lib"),
            ])
            .unwrap();
        // Build once (stamps the current NORM_VERSION), then simulate keys left
        // over from an older normalization by rewinding the stored version.
        rebuild_cluster_keys(&store, None).unwrap();
        store
            .with_conn_mut("test.stale_norm", |conn| {
                conn.execute(
                    "UPDATE cluster.cluster_meta SET value = 'stale' WHERE key = 'norm_version'",
                    [],
                )
            })
            .unwrap();
        assert!(store.with_conn("misc", cluster_rebuild_needed).unwrap());

        // The read path must notice the mismatch and rebuild even though keys exist.
        ensure_cluster_keys_built(&store, "s1").unwrap();

        assert!(
            !store.with_conn("misc", cluster_rebuild_needed).unwrap(),
            "version mismatch must be reconciled by the read path"
        );
        // All servers rebuilt, not just the one requested (single global stamp).
        let s2_keys: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key WHERE server_id = 's2'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(s2_keys, 1);
    }

    #[test]
    fn stale_per_server_rebuild_refreshes_all_servers_before_stamping_version() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_row("s1", "t1", "One", Some("A"), "Al", None, 1, "lib"),
                track_row("s2", "t2", "Two", Some("B"), "Al", None, 2, "lib"),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();
        store
            .with_conn_mut("test.stale_per_server", |conn| {
                conn.execute(
                    "UPDATE track SET title = 'Updated' WHERE server_id = 's2' AND id = 't2'",
                    [],
                )?;
                conn.execute(
                    "UPDATE cluster.cluster_meta SET value = 'stale' WHERE key = 'norm_version'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        let rebuilt = store
            .with_read_conn(|conn| read_cluster_row(conn, "s2", "t2"))
            .unwrap()
            .unwrap();
        assert_eq!(
            rebuilt.0,
            build_track_cluster_keys(Some("B"), "Updated", "Al", None).cluster_key
        );
        assert!(!store.with_read_conn(cluster_rebuild_needed).unwrap());
    }

    #[test]
    fn concurrent_ensures_rebuild_a_dirty_server_once() {
        use std::sync::{Arc, Barrier};

        let store = Arc::new(LibraryStore::open_in_memory());
        let rows = (0..2_000)
            .map(|index| {
                track_row(
                    "s1",
                    &format!("t{index}"),
                    &format!("Title {index}"),
                    Some("Artist"),
                    &format!("Album {}", index / 10),
                    None,
                    180,
                    "lib",
                )
            })
            .collect::<Vec<_>>();
        TrackRepository::new(&store).upsert_batch(&rows).unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        let mut changed = rows[0].clone();
        changed.title = "Updated title".into();
        TrackRepository::new(&store)
            .upsert_batch(&[changed])
            .unwrap();

        let worker_count = 6;
        let barrier = Arc::new(Barrier::new(worker_count));
        let workers = (0..worker_count)
            .map(|_| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    ensure_cluster_keys_built(&store, "s1").unwrap()
                })
            })
            .collect::<Vec<_>>();
        let rebuilt = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(rebuilt.iter().filter(|count| **count > 0).count(), 1);
        assert_eq!(rebuilt.into_iter().sum::<u64>(), 1);
    }

    #[test]
    fn clean_identity_ensure_does_not_wait_for_writer_lock() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[track_row(
                "s1",
                "t1",
                "Title",
                Some("Artist"),
                "Album",
                None,
                180,
                "lib",
            )])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();
        let (writer_started_tx, writer_started_rx) = mpsc::channel();
        let (release_writer_tx, release_writer_rx) = mpsc::channel();
        let writer_store = Arc::clone(&store);
        let writer = std::thread::spawn(move || {
            writer_store
                .with_conn_mut("test.hold_writer", |_conn| {
                    writer_started_tx.send(()).unwrap();
                    release_writer_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        writer_started_rx.recv().unwrap();

        let (ensure_tx, ensure_rx) = mpsc::channel();
        let ensure_store = Arc::clone(&store);
        let ensure = std::thread::spawn(move || {
            ensure_tx
                .send(ensure_cluster_keys_built(&ensure_store, "s1"))
                .unwrap();
        });
        let result = ensure_rx.recv_timeout(Duration::from_secs(2));
        release_writer_tx.send(()).unwrap();
        writer.join().unwrap();
        ensure.join().unwrap();

        assert_eq!(
            result
                .expect("clean identity preflight blocked on writer")
                .unwrap(),
            0
        );
    }

    #[test]
    fn repeated_forced_rebuild_skips_unchanged_derived_rows() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track_row(
                "s1",
                "t1",
                "Title",
                Some("Artist"),
                "Album",
                None,
                180,
                "lib",
            )])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        let changed = store
            .with_conn_mut("test.rebuild_noop_writes", |conn| {
                let before = conn.total_changes();
                assert_eq!(rebuild_cluster_keys_on_conn(conn, Some("s1"))?, 1);
                Ok(conn.total_changes().saturating_sub(before))
            })
            .unwrap();

        assert!(
            changed <= 2,
            "only the two cluster_meta stamps may change, got {changed} writes"
        );
    }

    #[test]
    fn incremental_track_change_refreshes_the_physical_album_closure_once() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist(server_id, id, name, synced_at) \
                     VALUES ('s1', 'artist-1', 'Canonical Artist', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let first = physical_album_track_row(
            "s1", "t1", "First", "Alias", "artist-1", "Album", "album-1", "Alias", "lib",
        );
        let second = physical_album_track_row(
            "s1", "t2", "Second", "Alias", "artist-1", "Album", "album-1", "Alias", "lib",
        );
        TrackRepository::new(&store)
            .upsert_batch(&[first.clone(), second])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();
        let before = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();

        let mut changed = first;
        changed.title = "Updated".into();
        TrackRepository::new(&store)
            .upsert_batch(&[changed])
            .unwrap();
        assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 2);

        let after = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();
        let pending: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM identity_invalidation WHERE server_id = 's1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_ne!(before.0, after.0);
        assert_eq!(pending, 0);
    }

    #[test]
    fn incremental_tombstone_recomputes_remaining_album_identity() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_artists", |conn| {
                conn.execute_batch(
                    "INSERT INTO artist(server_id, id, name, synced_at) VALUES \
                       ('s1', 'artist-1', 'Artist One', 1), \
                       ('s1', 'artist-2', 'Artist Two', 1);",
                )
            })
            .unwrap();
        TrackRepository::new(&store)
            .upsert_batch(&[
                physical_album_track_row(
                    "s1", "t1", "First", "Artist One", "artist-1", "Album", "album-1",
                    "Artist One", "lib",
                ),
                physical_album_track_row(
                    "s1", "t2", "Second", "Artist Two", "artist-2", "Album", "album-1",
                    "Artist Two", "lib",
                ),
            ])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();
        let fallback = concrete_physical_album_key("s1", "album-1");
        assert_eq!(
            store
                .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
                .unwrap()
                .unwrap()
                .1
                .as_deref(),
            Some(fallback.as_str())
        );

        TrackRepository::new(&store)
            .apply_tombstone_results("s1", "", &[], &["t2".into()])
            .unwrap();
        assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 1);

        let expected = build_album_key(Some("Artist One"), "Album").unwrap();
        let remaining = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();
        let (deleted_key_count, projection_identity): (i64, String) = store
            .with_read_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM cluster.track_cluster_key \
                         WHERE server_id = 's1' AND track_id = 't2'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT identity_key FROM album_browse_projection \
                         WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'album-1'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!(remaining.1.as_deref(), Some(expected.as_str()));
        assert_eq!(deleted_key_count, 0);
        assert_eq!(projection_identity, expected);
    }

    #[test]
    fn incremental_artist_rename_updates_tracks_and_album_projection() {
        let store = LibraryStore::open_in_memory();
        let artist_index = |name: &str| ArtistIndex {
            last_modified_ms: Some(1),
            ignored_articles: None,
            index: vec![IndexBucket {
                name: "A".into(),
                artist: vec![ArtistRef {
                    id: "artist-1".into(),
                    name: name.into(),
                    album_count: Some(1),
                    cover_art: None,
                }],
            }],
        };
        ArtistRepository::new(&store)
            .upsert_index("s1", &artist_index("Old Name"), 1)
            .unwrap();
        TrackRepository::new(&store)
            .upsert_batch(&[physical_album_track_row(
                "s1", "t1", "Track", "Alias", "artist-1", "Album", "album-1", "Alias", "lib",
            )])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        ArtistRepository::new(&store)
            .upsert_index("s1", &artist_index("New Name"), 2)
            .unwrap();
        assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 1);

        let row = store
            .with_read_conn(|conn| read_cluster_row(conn, "s1", "t1"))
            .unwrap()
            .unwrap();
        let expected_album = build_album_key(Some("New Name"), "Album").unwrap();
        let projection_identity: String = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT identity_key FROM album_browse_projection \
                     WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'album-1'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        assert_eq!(row.2.as_deref(), norm_part("New Name").as_deref());
        assert_eq!(row.1.as_deref(), Some(expected_album.as_str()));
        assert_eq!(projection_identity, expected_album);
    }

    #[test]
    fn incremental_track_remap_prunes_old_identity_and_album_scope() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist(server_id, id, name, synced_at) \
                     VALUES ('s1', 'artist-1', 'Artist', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let mut old = physical_album_track_row(
            "s1", "old", "Track", "Artist", "artist-1", "Old Album", "old-album", "Artist",
            "lib",
        );
        old.content_hash = Some("stable-hash".into());
        TrackRepository::new(&store)
            .upsert_batch(&[old])
            .unwrap();
        rebuild_cluster_keys(&store, Some("s1")).unwrap();

        let mut replacement = physical_album_track_row(
            "s1", "new", "Track", "Artist", "artist-1", "New Album", "new-album", "Artist",
            "lib",
        );
        replacement.content_hash = Some("stable-hash".into());
        let remap = TrackRepository::new(&store)
            .upsert_batch_with_remap(&[replacement], true)
            .unwrap();
        assert_eq!(remap.remapped.len(), 1);
        assert_eq!(ensure_cluster_keys_built(&store, "s1").unwrap(), 1);

        let (old_key_count, new_key_count, old_album_count, new_album_count): (i64, i64, i64, i64) =
            store
                .with_read_conn(|conn| {
                    Ok((
                        conn.query_row(
                            "SELECT COUNT(*) FROM cluster.track_cluster_key \
                             WHERE server_id = 's1' AND track_id = 'old'",
                            [],
                            |row| row.get(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM cluster.track_cluster_key \
                             WHERE server_id = 's1' AND track_id = 'new'",
                            [],
                            |row| row.get(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM album_browse_projection \
                             WHERE server_id = 's1' AND album_id = 'old-album'",
                            [],
                            |row| row.get(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM album_browse_projection \
                             WHERE server_id = 's1' AND album_id = 'new-album'",
                            [],
                            |row| row.get(0),
                        )?,
                    ))
                })
                .unwrap();
        assert_eq!((old_key_count, new_key_count), (0, 1));
        assert_eq!((old_album_count, new_album_count), (0, 1));
    }

    #[test]
    fn cluster_attach_visible_on_read_connection() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track_row("s1", "t1", "T", Some("A"), "Al", None, 42, "lib")])
            .unwrap();
        rebuild_cluster_keys(&store, None).unwrap();

        let count: i64 = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM cluster.track_cluster_key WHERE server_id = 's1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(count, 1);
    }
}

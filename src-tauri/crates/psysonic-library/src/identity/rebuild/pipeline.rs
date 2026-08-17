use rusqlite::{params, Connection};

use super::ranks::{
    capture_invalidated_rank_partitions, recompute_affected_occurrence_ranks,
    recompute_all_occurrence_ranks, reset_affected_rank_partitions,
};
use super::{concrete_physical_album_key, dirty_meta_key, set_cluster_meta, DIRTY_META_PREFIX};
use crate::identity::keys::{build_album_key, build_track_cluster_keys};
use crate::identity::norm::norm_part;

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
    let mut keys =
        build_track_cluster_keys(artist.as_deref(), &title, &album, album_artist.as_deref());
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

pub(super) fn rebuild_cluster_keys_on_conn(
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
    super::super::invalidation::clear(&tx, server_id)?;
    set_cluster_meta(&tx)?;
    tx.commit()?;
    Ok(upserted)
}

pub(super) fn apply_identity_invalidations_on_conn(
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
    super::super::invalidation::clear(&tx, Some(server_id))?;
    tx.commit()?;
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

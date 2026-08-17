use rusqlite::{params, Transaction};

fn occurrence_rank_order_sql() -> &'static str {
    "CASE WHEN t.disc_number IS NULL THEN 1 ELSE 0 END, t.disc_number, \
     CASE WHEN t.track_number IS NULL THEN 1 ELSE 0 END, t.track_number, \
     COALESCE(t.server_path, ''), ck.track_id"
}

pub(super) fn recompute_all_occurrence_ranks(
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

pub(super) fn reset_affected_rank_partitions(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS identity_rank_partition ( \
           cluster_key TEXT NOT NULL, \
           duration_bucket INTEGER NOT NULL, \
           PRIMARY KEY (cluster_key, duration_bucket) \
         ) WITHOUT ROWID; \
         DELETE FROM temp.identity_rank_partition;",
    )
}

pub(super) const CAPTURE_INVALIDATED_RANK_PARTITIONS_SQL: &str =
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

pub(super) fn capture_invalidated_rank_partitions(
    tx: &Transaction<'_>,
    server_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(CAPTURE_INVALIDATED_RANK_PARTITIONS_SQL, params![server_id])?;
    Ok(())
}

pub(super) fn recompute_affected_occurrence_ranks(
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

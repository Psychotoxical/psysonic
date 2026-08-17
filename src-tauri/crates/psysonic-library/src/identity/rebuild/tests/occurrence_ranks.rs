use super::*;

#[test]
fn incremental_tombstone_reranks_remaining_track_occurrence() {
    let store = LibraryStore::open_in_memory();
    let mut first = track_row(
        "s1",
        "t1",
        "Tyrion",
        Some("Narrator"),
        "Book",
        Some("Narrator"),
        300,
        "lib",
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
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
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

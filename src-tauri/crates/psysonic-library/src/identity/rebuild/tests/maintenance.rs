use super::*;

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
        vec![
            "dirty-server",
            "journal-server",
            "sync-server",
            "track-server"
        ]
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

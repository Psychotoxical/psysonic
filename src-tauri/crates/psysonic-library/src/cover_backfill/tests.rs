use super::*;
use crate::store::LibraryStore;

fn seed_track(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    album_id: &str,
    cover: Option<&str>,
) {
    store
            .with_conn_mut("test_seed", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, duration_sec, deleted, synced_at, raw_json,
                      cover_art_id
                    ) VALUES (?1, ?2, 't', 'al', ?3, 200, 0, 1, '{}', ?4)",
                    rusqlite::params![server_id, track_id, album_id, cover],
                )?;
                Ok(())
            })
            .unwrap();
}

#[test]
fn backfill_includes_navidrome_bare_album_id() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "srv", "tr1", "0DurV2S7arIOBQVEknOPWX", None);
    let batch = collect_cover_backfill_batch(
        &store,
        "srv",
        Path::new("/tmp/empty-cover-root"),
        "srv-host",
        None,
        Some(10),
    )
    .unwrap();
    assert_eq!(batch.cover_ids, vec!["0DurV2S7arIOBQVEknOPWX".to_string()]);
    assert_eq!(batch.items[0].cache_kind, "album");
    assert_eq!(
        batch.items[0].fetch_cover_art_id,
        "al-0DurV2S7arIOBQVEknOPWX_0"
    );
}

#[test]
fn backfill_uses_track_album_id_when_cover_art_null() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "srv", "tr1", "al-99", None);
    let batch = collect_cover_backfill_batch(
        &store,
        "srv",
        Path::new("/tmp/empty-cover-root"),
        "srv-host",
        None,
        Some(10),
    )
    .unwrap();
    assert_eq!(batch.cover_ids, vec!["al-99".to_string()]);
}

#[test]
fn backfill_uses_stored_cover_art_id_for_fetch() {
    let store = LibraryStore::open_in_memory();
    seed_track(
        &store,
        "srv",
        "tr1",
        "ca78bec6a62f3cb0ff31b2682ba05410",
        Some("al-ca78bec6a62f3cb0ff31b2682ba05410_60fc987f"),
    );
    let batch = collect_cover_backfill_batch(
        &store,
        "srv",
        Path::new("/tmp/empty-cover-root"),
        "srv-host",
        None,
        Some(10),
    )
    .unwrap();
    assert_eq!(
        batch.items[0].cache_entity_id,
        "ca78bec6a62f3cb0ff31b2682ba05410"
    );
    assert_eq!(
        batch.items[0].fetch_cover_art_id,
        "al-ca78bec6a62f3cb0ff31b2682ba05410_60fc987f"
    );
}

#[test]
fn backfill_skips_when_canonical_800_exists() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "srv", "tr1", "al-partial", None);
    let root = std::env::temp_dir().join("psysonic-cover-backfill-test");
    let host = "srv-host";
    let id_dir = cover_cache_layout::cover_dir(&root, host, "album", "al-partial");
    std::fs::create_dir_all(&id_dir).unwrap();
    std::fs::write(id_dir.join("128.webp"), b"x").unwrap();

    let batch = collect_cover_backfill_batch(&store, "srv", &root, host, None, Some(10)).unwrap();
    assert_eq!(batch.cover_ids, vec!["al-partial".to_string()]);

    std::fs::write(id_dir.join("800.webp"), b"canonical").unwrap();
    let batch2 = collect_cover_backfill_batch(&store, "srv", &root, host, None, Some(10)).unwrap();
    assert!(batch2.cover_ids.is_empty());

    let _ = std::fs::remove_dir_all(root.join(host));
}

#[test]
fn collect_missing_excludes_cached_includes_missing() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "srv", "tr1", "al-have", None);
    seed_track(&store, "srv", "tr2", "al-need", None);
    let root = std::env::temp_dir().join("psysonic-missing-targets-test");
    let host = "srv-host";
    let have_dir = cover_cache_layout::cover_dir(&root, host, "album", "al-have");
    std::fs::create_dir_all(&have_dir).unwrap();
    std::fs::write(
        have_dir.join(format!("{LIBRARY_COVER_CANONICAL_TIER}.webp")),
        b"x",
    )
    .unwrap();

    let missing = collect_missing_cover_targets(&store, "srv", &root, host).unwrap();
    let ids: Vec<_> = missing.iter().map(|i| i.cache_entity_id.as_str()).collect();
    assert!(ids.contains(&"al-need"), "missing cover should be queued");
    assert!(!ids.contains(&"al-have"), "cached cover must be skipped");

    let _ = std::fs::remove_dir_all(root.join(host));
}

#[test]
fn backfill_includes_per_disc_mf_when_discs_differ() {
    let store = LibraryStore::open_in_memory();
    store
            .with_conn_mut("seed_box", |conn| {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, synced_at, raw_json)
                     VALUES ('srv', 'al-box', 'Box', 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number, duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES ('srv', 'tr1', 't', 'Box', 'al-box', 1, 200, 0, 1, '{}', 'mf-a')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number, duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES ('srv', 'tr2', 't', 'Box', 'al-box', 2, 200, 0, 1, '{}', 'mf-b')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    let batch = collect_cover_backfill_batch(
        &store,
        "srv",
        Path::new("/tmp/empty-cover-root"),
        "srv-host",
        None,
        Some(10),
    )
    .unwrap();
    let ids: Vec<_> = batch
        .items
        .iter()
        .map(|i| i.cache_entity_id.as_str())
        .collect();
    assert!(ids.contains(&"mf-a"));
    assert!(ids.contains(&"mf-b"));
}

#[test]
fn backfill_includes_artists_from_track_without_artist_table() {
    let store = LibraryStore::open_in_memory();
    store
            .with_conn_mut("test_artist_track", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, artist_id, duration_sec, deleted, synced_at, raw_json
                    ) VALUES ('srv', 'tr1', 't', 'al', 'al-1', 'ar-from-track', 200, 0, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    let batch = collect_cover_backfill_batch(
        &store,
        "srv",
        Path::new("/tmp/empty-cover-root"),
        "srv-host",
        None,
        Some(10),
    )
    .unwrap();
    assert_eq!(batch.items.len(), 2);
    assert!(batch
        .items
        .iter()
        .any(|i| i.cache_kind == "album" && i.cache_entity_id == "al-1"));
    assert!(batch
        .items
        .iter()
        .any(|i| i.cache_kind == "artist" && i.cache_entity_id == "ar-from-track"));
}

#[test]
fn catalog_cursor_kind_then_id_orders_artists_after_albums() {
    let store = LibraryStore::open_in_memory();
    store
            .with_conn_mut("seed", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, artist_id, duration_sec, deleted, synced_at, raw_json
                    ) VALUES ('srv', 'tr1', 't', 'al', 'al-z-last', 'ar-1', 200, 0, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    let batch = collect_cover_backfill_batch(
        &store,
        "srv",
        Path::new("/tmp/x"),
        "host",
        Some("album\x1fal-z-last"),
        Some(10),
    )
    .unwrap();
    assert_eq!(batch.items.len(), 1);
    assert_eq!(batch.items[0].cache_kind, "artist");
    assert_eq!(batch.items[0].cache_entity_id, "ar-1");
}

#[test]
fn count_distinct_includes_albums_and_artists_not_mf() {
    let store = LibraryStore::open_in_memory();
    seed_track(&store, "srv", "tr1", "al-1", Some("mf-1"));
    store
            .with_conn_mut("test_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at, raw_json)
                     VALUES ('srv', 'ar-1', 'A', 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, artist_id, duration_sec, deleted, synced_at, raw_json
                    ) VALUES ('srv', 'tr2', 't', 'al', 'al-2', 'ar-1', 200, 0, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    let n = count_distinct_cover_ids(&store, "srv").unwrap();
    assert_eq!(n, 3); // al-1, al-2, ar-1 — mf-1 is not an entity id
}

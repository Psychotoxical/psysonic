use super::*;
use crate::store::LibraryStore;

fn seed_album(store: &LibraryStore, server_id: &str, album_id: &str, cover_art: Option<&str>) {
    store
        .with_conn_mut("seed_album", |conn| {
            conn.execute(
                "INSERT INTO album (
                      server_id, id, name, cover_art_id, synced_at, raw_json
                    ) VALUES (?1, ?2, 'A', ?3, 1, '{}')",
                rusqlite::params![server_id, album_id, cover_art],
            )?;
            Ok(())
        })
        .unwrap();
}

fn seed_track(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    album_id: &str,
    disc: i64,
    cover: Option<&str>,
) {
    store
        .with_conn_mut("seed_track", |conn| {
            conn.execute(
                "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number,
                      duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES (?1, ?2, 't', 'A', ?3, ?4, 200, 0, 1, '{}', ?5)",
                rusqlite::params![server_id, track_id, album_id, disc, cover],
            )?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn resolve_album_uses_bare_id_and_stored_cover_art() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "ca78bec6", Some("al-ca78bec6_60fc987f"));
    let e = resolve_album_cover_entry(&store, "srv", "ca78bec6")
        .unwrap()
        .unwrap();
    assert_eq!(e.cache_entity_id, "ca78bec6");
    assert_eq!(e.fetch_cover_art_id, "al-ca78bec6_60fc987f");
}

// #1252: album row without cover id — use first track mf when present.
#[test]
fn resolve_album_falls_back_to_track_mf_when_row_cover_null() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-nocover", None);
    seed_track(&store, "srv", "tr1", "al-nocover", 1, Some("mf-cover"));
    let e = resolve_album_cover_entry(&store, "srv", "al-nocover")
        .unwrap()
        .unwrap();
    assert_eq!(e.cache_entity_id, "al-nocover");
    assert_eq!(e.fetch_cover_art_id, "mf-cover");
}

#[test]
fn resolve_album_without_album_row_uses_track_only_backfill() {
    let store = LibraryStore::open_in_memory();
    seed_track(
        &store,
        "srv",
        "tr1",
        "2lsdR1ogDKiFcAD6Pcvk4f",
        1,
        Some("mf-fis8alFzjMGlcncxrvmpUV_67afa52a"),
    );
    let e = resolve_album_cover_entry(&store, "srv", "2lsdR1ogDKiFcAD6Pcvk4f")
        .unwrap()
        .unwrap();
    assert_eq!(e.cache_entity_id, "2lsdR1ogDKiFcAD6Pcvk4f");
    assert_eq!(e.fetch_cover_art_id, "mf-fis8alFzjMGlcncxrvmpUV_67afa52a");
}

#[test]
fn resolve_album_keeps_row_cover_over_track_cover() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-rowcover", Some("al-rowcover_art"));
    seed_track(&store, "srv", "tr1", "al-rowcover", 1, Some("mf-cover"));
    let e = resolve_album_cover_entry(&store, "srv", "al-rowcover")
        .unwrap()
        .unwrap();
    assert_eq!(e.fetch_cover_art_id, "al-rowcover_art");
}

#[test]
fn resolve_track_defaults_to_album_bucket() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-1", None);
    seed_track(&store, "srv", "tr1", "al-1", 1, Some("mf-a"));
    let e = resolve_track_cover_entry(&store, "srv", "tr1")
        .unwrap()
        .unwrap();
    assert_eq!(e.cache_entity_id, "al-1");
    assert_eq!(e.fetch_cover_art_id, "mf-a");
}

#[test]
fn backfill_album_slots_include_each_disc_mf() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-box", None);
    seed_track(&store, "srv", "tr1", "al-box", 1, Some("mf-a"));
    seed_track(&store, "srv", "tr2", "al-box", 2, Some("mf-b"));
    let items = cover_backfill_items_for_album(&store, "srv", "al-box").unwrap();
    let ids: Vec<_> = items.iter().map(|i| i.cache_entity_id.as_str()).collect();
    assert!(ids.contains(&"mf-a"));
    assert!(ids.contains(&"mf-b"));
}

#[test]
fn distinct_disc_covers_change_cache_entity() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-box", None);
    seed_track(&store, "srv", "tr1", "al-box", 1, Some("mf-a"));
    seed_track(&store, "srv", "tr2", "al-box", 2, Some("mf-b"));
    assert!(album_has_distinct_disc_covers(&store, "srv", "al-box").unwrap());
    let e = resolve_track_cover_entry(&store, "srv", "tr2")
        .unwrap()
        .unwrap();
    assert_eq!(e.cache_entity_id, "mf-b");
}

// Navidrome gives every song its own `mf-<id>` coverArt. Many tracks on a
// single disc must NOT count as distinct disc covers, or backfill would warm
// one cover per track instead of one per album.
#[test]
fn per_song_ids_within_one_disc_are_not_distinct() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-nav", None);
    seed_track(&store, "srv", "tr1", "al-nav", 1, Some("mf-1"));
    seed_track(&store, "srv", "tr2", "al-nav", 1, Some("mf-2"));
    seed_track(&store, "srv", "tr3", "al-nav", 1, Some("mf-3"));
    assert!(!album_has_distinct_disc_covers(&store, "srv", "al-nav").unwrap());
    let items = cover_backfill_items_for_album(&store, "srv", "al-nav").unwrap();
    let ids: Vec<_> = items.iter().map(|i| i.cache_entity_id.as_str()).collect();
    assert_eq!(ids, vec!["al-nav"]);
}

#[test]
fn album_disc_count_reports_distinct_discs() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-single", None);
    seed_track(&store, "srv", "s1", "al-single", 1, Some("mf-1"));
    seed_track(&store, "srv", "s2", "al-single", 1, Some("mf-2"));
    assert_eq!(album_disc_count(&store, "srv", "al-single").unwrap(), 1);

    seed_album(&store, "srv", "al-multi", None);
    seed_track(&store, "srv", "m1", "al-multi", 1, Some("mf-a"));
    seed_track(&store, "srv", "m2", "al-multi", 2, Some("mf-b"));
    seed_track(&store, "srv", "m3", "al-multi", 3, Some("mf-c"));
    assert_eq!(album_disc_count(&store, "srv", "al-multi").unwrap(), 3);

    assert_eq!(album_disc_count(&store, "srv", "al-missing").unwrap(), 0);
}

// A NULL disc number collapses to disc 1 — a track with no disc tag alongside a
// real disc-2 track must still count as a 2-disc album, not 1.
#[test]
fn album_disc_count_treats_null_disc_as_one() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-null", None);
    store
        .with_conn_mut("seed_null_disc", |conn| {
            conn.execute(
                "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number,
                      duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES ('srv', 'n1', 't', 'A', 'al-null', NULL, 200, 0, 1, '{}', 'mf-a')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    seed_track(&store, "srv", "n2", "al-null", 2, Some("mf-b"));
    assert_eq!(album_disc_count(&store, "srv", "al-null").unwrap(), 2);
}

#[test]
fn describe_entity_labels_album_and_artist() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn_mut("seed_describe", |conn| {
            conn.execute(
                "INSERT INTO album (server_id, id, name, artist, synced_at, raw_json)
                     VALUES ('srv', 'al-1', 'Discovery', 'Daft Punk', 1, '{}')",
                [],
            )?;
            conn.execute(
                "INSERT INTO artist (server_id, id, name, synced_at, raw_json)
                     VALUES ('srv', 'ar-1', 'Daft Punk', 1, '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        describe_cover_entity(&store, "srv", "album", "al-1").as_deref(),
        Some("album \"Discovery\" — Daft Punk"),
    );
    assert_eq!(
        describe_cover_entity(&store, "srv", "artist", "ar-1").as_deref(),
        Some("artist \"Daft Punk\""),
    );
    assert_eq!(
        describe_cover_entity(&store, "srv", "album", "al-missing"),
        None
    );
}

// Multi-disc, but each disc still exposes per-song ids (not a shared disc
// cover) → per-song art, so backfill collapses to the single album cover.
#[test]
fn per_song_ids_across_discs_are_not_distinct() {
    let store = LibraryStore::open_in_memory();
    seed_album(&store, "srv", "al-nav2", None);
    seed_track(&store, "srv", "tr1", "al-nav2", 1, Some("mf-1"));
    seed_track(&store, "srv", "tr2", "al-nav2", 1, Some("mf-2"));
    seed_track(&store, "srv", "tr3", "al-nav2", 2, Some("mf-3"));
    seed_track(&store, "srv", "tr4", "al-nav2", 2, Some("mf-4"));
    assert!(!album_has_distinct_disc_covers(&store, "srv", "al-nav2").unwrap());
    let items = cover_backfill_items_for_album(&store, "srv", "al-nav2").unwrap();
    let ids: Vec<_> = items.iter().map(|i| i.cache_entity_id.as_str()).collect();
    assert_eq!(ids, vec!["al-nav2"]);
}

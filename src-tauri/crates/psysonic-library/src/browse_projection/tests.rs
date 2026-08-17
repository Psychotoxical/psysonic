use super::*;
use crate::dto::{
    LibraryScopeBrowseEntity, LibraryScopeBrowseRequest, LibraryScopePair, LibrarySortClause,
    SortDir,
};
use crate::repos::{TrackRepository, TrackRow};

fn track(id: &str, album_id: &str, album: &str, library_id: &str) -> TrackRow {
    TrackRow {
        server_id: "s1".into(),
        id: id.into(),
        title: id.into(),
        title_sort: None,
        artist: Some("Artist".into()),
        artist_id: Some("artist".into()),
        album: album.into(),
        album_id: Some(album_id.into()),
        album_artist: Some("Artist".into()),
        duration_sec: 120,
        track_number: None,
        disc_number: None,
        year: Some(2024),
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
fn album_track(
    server_id: &str,
    id: &str,
    artist: &str,
    artist_id: &str,
    album_id: &str,
    album: &str,
    album_artist: &str,
    library_id: &str,
) -> TrackRow {
    let mut row = track(id, album_id, album, library_id);
    row.server_id = server_id.into();
    row.artist = Some(artist.into());
    row.artist_id = Some(artist_id.into());
    row.album_artist = Some(album_artist.into());
    row
}

fn insert_artist(store: &LibraryStore, server_id: &str, artist_id: &str, name: &str) {
    store
        .with_conn_mut("test.browse_projection.artist", |conn| {
            conn.execute(
                "INSERT INTO artist(server_id, id, name, synced_at) VALUES (?1, ?2, ?3, 1)",
                params![server_id, artist_id, name],
            )?;
            Ok(())
        })
        .unwrap();
}

fn browse_albums(
    store: &LibraryStore,
    scopes: Vec<LibraryScopePair>,
) -> Vec<crate::dto::LibraryAlbumDto> {
    crate::scope_browse::browse(
        store,
        &LibraryScopeBrowseRequest {
            entity: LibraryScopeBrowseEntity::Album,
            scopes,
            sort: vec![LibrarySortClause {
                field: "name".into(),
                dir: SortDir::Asc,
            }],
            limit: 20,
            cursor: None,
        },
    )
    .unwrap()
    .albums
}

#[test]
fn ingest_refreshes_only_affected_album_projection() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("t1", "a1", "Album One", "lib")])
        .unwrap();
    let name: String = store.with_read_conn(|conn| conn.query_row(
            "SELECT name FROM album_browse_projection WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'a1'",
            [], |row| row.get(0),
        )).unwrap();
    assert_eq!(name, "Album One");

    TrackRepository::new(&store)
        .upsert_batch(&[track("t1", "a1", "Album Renamed", "lib")])
        .unwrap();
    let name: String = store.with_read_conn(|conn| conn.query_row(
            "SELECT name FROM album_browse_projection WHERE server_id = 's1' AND library_id = 'lib' AND album_id = 'a1'",
            [], |row| row.get(0),
        )).unwrap();
    assert_eq!(name, "Album Renamed");
}

#[test]
fn backfill_processes_tracks_without_album_ids_before_advancing_cursor() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("no-album", "", "Ignored", "lib"),
            track("t1", "a1", "Album One", "lib"),
        ])
        .unwrap();
    store
        .with_conn_mut("test.clear_projection_marker", |conn| {
            conn.execute("DELETE FROM album_browse_projection", [])?;
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![MIGRATION_ID],
            )?;
            Ok(())
        })
        .unwrap();

    run_backfill_impl(&store, None).unwrap();
    assert!(is_ready(&store).unwrap());
    let count: i64 = store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM album_browse_projection WHERE album_id = 'a1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn partial_incremental_projection_does_not_imply_completion() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("t1", "a1", "Album One", "lib"),
            track("t2", "a2", "Album Two", "lib"),
        ])
        .unwrap();
    store
        .with_conn_mut("test.partial_projection", |conn| {
            conn.execute(
                "DELETE FROM album_browse_projection WHERE album_id = 'a2'",
                [],
            )?;
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![MIGRATION_ID],
            )?;
            Ok(())
        })
        .unwrap();

    let status = inspect_album(&store).unwrap();
    assert!(status.needed);
    assert_eq!(status.total_tracks, 2);
    assert_eq!(status.done_tracks, 0);
    assert!(!is_ready(&store).unwrap());

    run_backfill_impl(&store, None).unwrap();
    assert!(is_ready(&store).unwrap());
    let count: i64 = store
        .with_read_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM album_browse_projection", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn ordinary_browse_links_a_compilation_card_to_the_album_artist() {
    // The ordinary All Albums page reads this projection, which stores the display
    // credit ("Various Artists") next to `MAX(t.artist_id)` — a guest performer. The
    // card must link to the album-artist entity instead, recovered from the album
    // even when the projection's representative track carries no `albumArtistId`.
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "va", "Various Artists");
    let mut representative = album_track(
        "s1",
        "t1",
        "Performer One",
        "perf1",
        "comp",
        "Comp",
        "Various Artists",
        "lib",
    );
    representative.raw_json = "{}".into();
    let mut sibling = album_track(
        "s1",
        "t2",
        "Performer Two",
        "perf2",
        "comp",
        "Comp",
        "Various Artists",
        "lib",
    );
    sibling.raw_json = r#"{"albumArtistId":"va"}"#.into();
    TrackRepository::new(&store)
        .upsert_batch(&[representative, sibling])
        .unwrap();

    let albums = browse_albums(
        &store,
        vec![LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some("lib".into()),
        }],
    );
    let card = albums
        .iter()
        .find(|album| album.id == "comp")
        .expect("comp missing");
    assert_eq!(card.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        card.artist_id.as_deref(),
        Some("va"),
        "the All Albums card must open the album artist, not a track performer"
    );
}

#[test]
fn ordinary_browse_reconciles_partial_keys_to_one_canonical_album_partition() {
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "artist-1", "Metallica");
    insert_artist(&store, "s2", "artist-2", "Metallica");
    TrackRepository::new(&store)
        .upsert_batch(&[album_track(
            "s1",
            "t1",
            "Metallica",
            "artist-1",
            "album-1",
            "S&M2",
            "Metallica & San Francisco Symphony",
            "lib-a",
        )])
        .unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();

    TrackRepository::new(&store)
        .upsert_batch(&[
            album_track(
                "s1",
                "t2",
                "Metallica",
                "artist-1",
                "album-1",
                "S&M2",
                "Metallica",
                "lib-b",
            ),
            album_track(
                "s2",
                "t3",
                "Metallica",
                "artist-2",
                "album-2",
                "S&M2",
                "Metallica",
                "lib-c",
            ),
        ])
        .unwrap();

    let albums = browse_albums(
        &store,
        vec![
            LibraryScopePair {
                server_id: "s1".into(),
                library_id: Some("lib-a".into()),
            },
            LibraryScopePair {
                server_id: "s1".into(),
                library_id: Some("lib-b".into()),
            },
            LibraryScopePair {
                server_id: "s2".into(),
                library_id: Some("lib-c".into()),
            },
        ],
    );
    assert_eq!(albums.len(), 1);
    assert_eq!(albums[0].server_id, "s1");
    assert_eq!(albums[0].id, "album-1");

    let keys = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT identity_key FROM album_browse_projection \
                     WHERE album_id IN ('album-1', 'album-2')",
            )?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(keys.len(), 1);
}

#[test]
fn completed_backfill_reconciles_physical_projection_keys_before_readiness() {
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "artist-1", "Artist");
    insert_artist(&store, "s2", "artist-2", "Artist");
    TrackRepository::new(&store)
        .upsert_batch(&[
            album_track(
                "s1", "t1", "Artist", "artist-1", "album-1", "Shared", "Artist", "lib-a",
            ),
            album_track(
                "s2", "t2", "Artist", "artist-2", "album-2", "Shared", "Artist", "lib-b",
            ),
        ])
        .unwrap();
    crate::identity::rebuild_cluster_keys(&store, None).unwrap();
    store
        .with_conn_mut("test.reset_projection", |conn| {
            conn.execute("DELETE FROM album_browse_projection", [])?;
            conn.execute(
                "DELETE FROM library_data_migration WHERE id = ?1",
                params![MIGRATION_ID],
            )?;
            Ok(())
        })
        .unwrap();

    run_backfill_impl(&store, None).unwrap();

    assert!(is_ready(&store).unwrap());
    let keys = store
        .with_read_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT DISTINCT identity_key FROM album_browse_projection ORDER BY identity_key",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(keys.len(), 1);
    assert!(!keys[0].starts_with("physical:"));
}

#[test]
fn ordinary_browse_keeps_ambiguous_physical_albums_separate() {
    let store = LibraryStore::open_in_memory();
    for (server, artist_id, name) in [
        ("s1", "s1-a", "Artist A"),
        ("s1", "s1-b", "Artist B"),
        ("s2", "s2-a", "Artist A"),
        ("s2", "s2-b", "Artist B"),
    ] {
        insert_artist(&store, server, artist_id, name);
    }
    TrackRepository::new(&store)
        .upsert_batch(&[
            album_track(
                "s1",
                "s1-t1",
                "Artist A",
                "s1-a",
                "s1-album",
                "Split",
                "Various Artists",
                "lib-a",
            ),
            album_track(
                "s1",
                "s1-t2",
                "Artist B",
                "s1-b",
                "s1-album",
                "Split",
                "Various Artists",
                "lib-a",
            ),
            album_track(
                "s2",
                "s2-t1",
                "Artist A",
                "s2-a",
                "s2-album",
                "Split",
                "Various Artists",
                "lib-b",
            ),
            album_track(
                "s2",
                "s2-t2",
                "Artist B",
                "s2-b",
                "s2-album",
                "Split",
                "Various Artists",
                "lib-b",
            ),
        ])
        .unwrap();

    let albums = browse_albums(
        &store,
        vec![
            LibraryScopePair {
                server_id: "s1".into(),
                library_id: Some("lib-a".into()),
            },
            LibraryScopePair {
                server_id: "s2".into(),
                library_id: Some("lib-b".into()),
            },
        ],
    );
    assert_eq!(albums.len(), 2);
    assert_eq!(
        albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        vec!["s1-album", "s2-album"]
    );
}

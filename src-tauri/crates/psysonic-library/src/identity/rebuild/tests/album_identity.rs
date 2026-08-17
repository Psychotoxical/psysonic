use super::*;

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
            conn.execute(
                "UPDATE track SET artist_id = 'artist-1' WHERE server_id = 's1'",
                [],
            )?;
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
                "s1",
                "t1",
                "One",
                "Main Act",
                "artist-main",
                "Record",
                "album-1",
                "Main Act",
                "lib-a",
            ),
            physical_album_track_row(
                "s1",
                "t2",
                "Two",
                "Guest Act",
                "artist-guest",
                "Record",
                "album-1",
                "Main Act",
                "lib-a",
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
                "s1",
                "t1",
                "One",
                "Various Artists",
                "artist-va",
                "Greatest",
                "album-1",
                "Various Artists",
                "lib-a",
            ),
            physical_album_track_row(
                "s1",
                "t2",
                "Two",
                "Some Band",
                "artist-band",
                "Greatest",
                "album-1",
                "Various Artists",
                "lib-a",
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
                    "s1",
                    "t2",
                    "Two",
                    "Some Band",
                    "artist-band",
                    "Greatest",
                    "album-1",
                    label,
                    "lib-a",
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

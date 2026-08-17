use super::*;

fn request(
    scopes: Vec<LibraryScopePair>,
    limit: u32,
    cursor: Option<String>,
) -> LibraryScopeBrowseRequest {
    LibraryScopeBrowseRequest {
        entity: LibraryScopeBrowseEntity::Album,
        scopes,
        sort: vec![
            LibrarySortClause {
                field: "name".into(),
                dir: crate::dto::SortDir::Asc,
            },
            LibrarySortClause {
                field: "artist".into(),
                dir: crate::dto::SortDir::Asc,
            },
        ],
        limit,
        cursor,
    }
}

fn track_request(
    scopes: Vec<LibraryScopePair>,
    limit: u32,
    cursor: Option<String>,
) -> LibraryScopeBrowseRequest {
    LibraryScopeBrowseRequest {
        entity: LibraryScopeBrowseEntity::Track,
        scopes,
        sort: vec![LibrarySortClause {
            field: "title".into(),
            dir: crate::dto::SortDir::Asc,
        }],
        limit,
        cursor,
    }
}

fn insert_track(
    store: &LibraryStore,
    server_id: &str,
    library_id: &str,
    track_id: &str,
    title: &str,
    cluster_key: Option<&str>,
) {
    store.with_conn_mut("test.scope_browse.track_seed", |conn| {
            conn.execute(
                "INSERT INTO track (server_id, id, title, artist, album, library_id, synced_at, raw_json) \
                 VALUES (?1, ?2, ?3, 'Artist', 'Album', ?4, 1, '{}')",
                rusqlite::params![server_id, track_id, title, library_id],
            )?;
            if let Some(cluster_key) = cluster_key {
                conn.execute(
                    "INSERT INTO cluster.track_cluster_key \
                     (server_id, library_id, track_id, cluster_key, duration_sec) \
                     VALUES (?1, ?2, ?3, ?4, 100)",
                    rusqlite::params![server_id, library_id, track_id, cluster_key],
                )?;
            }
            Ok(())
        }).unwrap();
}

fn insert_projection(
    store: &LibraryStore,
    server_id: &str,
    library_id: &str,
    album_id: &str,
    name: &str,
    identity_key: Option<&str>,
) {
    store.with_conn_mut("test.scope_browse.seed", |conn| {
            conn.execute(
                "INSERT INTO album_browse_projection ( \
                   server_id, library_id, album_id, identity_key, name, artist, artist_id, song_count, \
                   duration_sec, year, genre, cover_art_id, starred_at, synced_at, representative_track_id \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'Artist', NULL, 1, 1, 2024, NULL, NULL, NULL, 1, ?3)",
                rusqlite::params![server_id, library_id, album_id, identity_key, name],
            )?;
            conn.execute(
                "INSERT INTO library_data_migration (id, cursor_rowid, started_at, completed_at) \
                 VALUES ('scope_browse_album_projection_v1', 0, 1, 1) \
                 ON CONFLICT(id) DO UPDATE SET completed_at = 1",
                [],
            )?;
            Ok(())
        }).unwrap();
}

#[test]
fn whole_server_streams_include_empty_library_and_exact_empty_stays_narrow() {
    let store = LibraryStore::open_in_memory();
    insert_projection(&store, "s1", "", "empty-album", "Alpha", Some("empty"));
    insert_projection(
        &store,
        "s1",
        "lib-b",
        "tagged-album",
        "Bravo",
        Some("tagged"),
    );
    insert_track(
        &store,
        "s1",
        "",
        "empty-track",
        "Alpha",
        Some("empty-track"),
    );
    insert_track(
        &store,
        "s1",
        "lib-b",
        "tagged-track",
        "Bravo",
        Some("tagged-track"),
    );

    let whole = vec![LibraryScopePair {
        server_id: "s1".into(),
        library_id: None,
    }];
    let albums = browse(&store, &request(whole.clone(), 10, None)).unwrap();
    assert_eq!(
        albums
            .albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        vec!["empty-album", "tagged-album"]
    );
    let tracks = browse(&store, &track_request(whole, 10, None)).unwrap();
    assert_eq!(
        tracks
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>(),
        vec!["empty-track", "tagged-track"]
    );

    let exact_empty = vec![LibraryScopePair {
        server_id: "s1".into(),
        library_id: Some(String::new()),
    }];
    let albums = browse(&store, &request(exact_empty.clone(), 10, None)).unwrap();
    assert_eq!(albums.albums.len(), 1);
    assert_eq!(albums.albums[0].id, "empty-album");
    let tracks = browse(&store, &track_request(exact_empty, 10, None)).unwrap();
    assert_eq!(tracks.tracks.len(), 1);
    assert_eq!(tracks.tracks[0].id, "empty-track");
}

#[test]
fn priority_scope_wins_even_when_its_duplicate_sorts_later() {
    let store = LibraryStore::open_in_memory();
    insert_projection(&store, "high", "lib", "high-dup", "Zulu", Some("same"));
    insert_projection(&store, "low", "lib", "low-dup", "Alpha", Some("same"));
    insert_projection(&store, "low", "lib", "low-unique", "Bravo", Some("other"));
    let response = browse(
        &store,
        &request(
            vec![
                LibraryScopePair {
                    server_id: "high".into(),
                    library_id: Some("lib".into()),
                },
                LibraryScopePair {
                    server_id: "low".into(),
                    library_id: Some("lib".into()),
                },
            ],
            10,
            None,
        ),
    )
    .unwrap();

    assert_eq!(
        response
            .albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        vec!["low-unique", "high-dup"],
    );
}

#[test]
fn album_priority_dedup_holds_across_cursor_pages() {
    let store = LibraryStore::open_in_memory();
    insert_projection(&store, "high", "lib", "high-dup", "Zulu", Some("same"));
    insert_projection(&store, "low", "lib", "low-dup", "Alpha", Some("same"));
    insert_projection(&store, "low", "lib", "low-unique", "Bravo", Some("other"));
    let scopes = vec![
        LibraryScopePair {
            server_id: "high".into(),
            library_id: Some("lib".into()),
        },
        LibraryScopePair {
            server_id: "low".into(),
            library_id: Some("lib".into()),
        },
    ];

    let first = browse(&store, &request(scopes.clone(), 1, None)).unwrap();
    assert_eq!(
        first
            .albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        vec!["low-unique"]
    );
    let second = browse(&store, &request(scopes, 1, first.next_cursor)).unwrap();
    assert_eq!(
        second
            .albums
            .iter()
            .map(|album| album.id.as_str())
            .collect::<Vec<_>>(),
        vec!["high-dup"]
    );
}

#[test]
fn cursor_keeps_each_scope_position_without_skipping_tied_global_order() {
    let store = LibraryStore::open_in_memory();
    insert_projection(&store, "a", "lib", "a-bravo", "Bravo", Some("a-bravo"));
    insert_projection(&store, "a", "lib", "a-delta", "Delta", Some("a-delta"));
    insert_projection(&store, "b", "lib", "b-alpha", "Alpha", Some("b-alpha"));
    insert_projection(
        &store,
        "b",
        "lib",
        "b-charlie",
        "Charlie",
        Some("b-charlie"),
    );
    let scopes = vec![
        LibraryScopePair {
            server_id: "a".into(),
            library_id: Some("lib".into()),
        },
        LibraryScopePair {
            server_id: "b".into(),
            library_id: Some("lib".into()),
        },
    ];

    let first = browse(&store, &request(scopes.clone(), 2, None)).unwrap();
    assert_eq!(
        first
            .albums
            .iter()
            .map(|album| album.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Alpha", "Bravo"],
    );
    let second = browse(&store, &request(scopes, 2, first.next_cursor)).unwrap();
    assert_eq!(
        second
            .albums
            .iter()
            .map(|album| album.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Charlie", "Delta"],
    );
}

#[test]
fn track_priority_scope_wins_even_when_its_duplicate_sorts_later() {
    let store = LibraryStore::open_in_memory();
    insert_track(&store, "high", "lib", "high-dup", "Same", Some("same"));
    insert_track(&store, "low", "lib", "low-dup", "Same", Some("same"));
    insert_track(&store, "low", "lib", "low-unique", "Bravo", Some("other"));
    let response = browse(
        &store,
        &track_request(
            vec![
                LibraryScopePair {
                    server_id: "high".into(),
                    library_id: Some("lib".into()),
                },
                LibraryScopePair {
                    server_id: "low".into(),
                    library_id: Some("lib".into()),
                },
            ],
            10,
            None,
        ),
    )
    .unwrap();

    assert_eq!(
        response
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>(),
        vec!["low-unique", "high-dup"],
    );
}

#[test]
fn track_cursor_keeps_each_scope_position_without_skipping_tied_global_order() {
    let store = LibraryStore::open_in_memory();
    insert_track(&store, "a", "lib", "a-bravo", "Bravo", None);
    insert_track(&store, "a", "lib", "a-delta", "Delta", None);
    insert_track(&store, "b", "lib", "b-alpha", "Alpha", None);
    insert_track(&store, "b", "lib", "b-charlie", "Charlie", None);
    let scopes = vec![
        LibraryScopePair {
            server_id: "a".into(),
            library_id: Some("lib".into()),
        },
        LibraryScopePair {
            server_id: "b".into(),
            library_id: Some("lib".into()),
        },
    ];

    let first = browse(&store, &track_request(scopes.clone(), 2, None)).unwrap();
    assert_eq!(
        first
            .tracks
            .iter()
            .map(|track| track.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Alpha", "Bravo"],
    );
    let second = browse(&store, &track_request(scopes, 2, first.next_cursor)).unwrap();
    assert_eq!(
        second
            .tracks
            .iter()
            .map(|track| track.title.as_str())
            .collect::<Vec<_>>(),
        vec!["Charlie", "Delta"],
    );
}

#[test]
fn track_priority_dedup_holds_across_cursor_pages() {
    let store = LibraryStore::open_in_memory();
    insert_track(&store, "high", "lib", "high-dup", "Same", Some("same"));
    insert_track(&store, "low", "lib", "low-dup", "Same", Some("same"));
    let scopes = vec![
        LibraryScopePair {
            server_id: "high".into(),
            library_id: Some("lib".into()),
        },
        LibraryScopePair {
            server_id: "low".into(),
            library_id: Some("lib".into()),
        },
    ];

    let candidates = vec![
        query_track_scope_candidates(&store, &scopes[0], 0, None, 10).unwrap(),
        query_track_scope_candidates(&store, &scopes[1], 1, None, 10).unwrap(),
    ];
    assert_eq!(
        track_identity_priorities(&store, &scopes, &candidates)
            .unwrap()
            .get("same:20:0"),
        Some(&0)
    );

    let first = browse(&store, &track_request(scopes.clone(), 1, None)).unwrap();
    assert_eq!(
        first
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>(),
        vec!["high-dup"]
    );
    let second = browse(&store, &track_request(scopes, 1, first.next_cursor)).unwrap();
    assert!(second.tracks.is_empty());
    assert!(!second.has_more);
}

#[test]
fn same_server_occurrence_ranks_survive_across_cursor_pages() {
    let store = LibraryStore::open_in_memory();
    insert_track(&store, "s1", "lib-a", "chapter-1", "Tyrion", Some("tyrion"));
    insert_track(&store, "s1", "lib-b", "chapter-2", "Tyrion", Some("tyrion"));
    store
        .with_conn_mut("test.scope_browse.rank", |conn| {
            conn.execute(
                "UPDATE cluster.track_cluster_key SET occurrence_rank = 1 \
                     WHERE server_id = 's1' AND track_id = 'chapter-2'",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let scopes = vec![
        LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some("lib-a".into()),
        },
        LibraryScopePair {
            server_id: "s1".into(),
            library_id: Some("lib-b".into()),
        },
    ];

    let first = browse(&store, &track_request(scopes.clone(), 1, None)).unwrap();
    assert_eq!(
        first
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>(),
        vec!["chapter-1"]
    );
    let second = browse(&store, &track_request(scopes, 1, first.next_cursor)).unwrap();
    assert_eq!(
        second
            .tracks
            .iter()
            .map(|track| track.id.as_str())
            .collect::<Vec<_>>(),
        vec!["chapter-2"]
    );
}

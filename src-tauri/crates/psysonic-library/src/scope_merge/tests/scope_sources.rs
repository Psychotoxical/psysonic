#[test]
fn scope_normalization_preserves_empty_library_and_rejects_overlap() {
    let scopes = vec![
        scope_pair("s1", ""),
        scope_pair("s1", ""),
        whole_scope("s2"),
    ];
    assert_eq!(
        normalize_scope_pairs(&scopes).unwrap(),
        vec![scope_pair("s1", ""), whole_scope("s2")]
    );
    assert_eq!(
        non_empty_scopes(&scopes).unwrap_err(),
        "duplicate scope pair"
    );

    let overlap = vec![whole_scope("s1"), scope_pair("s1", "lib-a")];
    assert!(non_empty_scopes(&overlap)
        .unwrap_err()
        .contains("cannot mix whole-server and exact-library scopes"));
}

#[test]
fn whole_server_scope_includes_empty_library_rows_without_broad_or_predicate() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "exact",
                "Exact",
                Some("Artist"),
                "Exact Album",
                "exact-album",
                Some("artist"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s2",
                "empty",
                "Empty",
                Some("Artist"),
                "Empty Album",
                "empty-album",
                Some("artist"),
                101,
                "",
                None,
                None,
                None,
            ),
            track(
                "s2",
                "tagged",
                "Tagged",
                Some("Artist"),
                "Tagged Album",
                "tagged-album",
                Some("artist"),
                102,
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    let scopes = vec![scope_pair("s1", "lib-a"), whole_scope("s2")];
    let (cte, binds) = scope_cte_sql(&scopes);
    assert!(cte.contains("exact_scope"));
    assert!(cte.contains("whole_scope"));
    assert!(cte.contains("UNION ALL"));
    assert!(!cte.contains("IS NULL OR"));
    let sql = format!(
        "{cte} SELECT t.id, s.pr FROM scoped_track s \
             INNER JOIN track t ON t.rowid = s.rowid ORDER BY s.pr, t.id"
    );
    let rows = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(binds.iter()), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>();
            rows
        })
        .unwrap();
    assert_eq!(
        rows,
        vec![
            ("exact".into(), 0),
            ("empty".into(), 1),
            ("tagged".into(), 1)
        ]
    );

    let exact_empty = list_albums(
        &store,
        &LibraryScopeListRequest {
            scopes: vec![scope_pair("s2", "")],
            sort: None,
            limit: Some(10),
            offset: None,
        },
    )
    .unwrap();
    assert_eq!(exact_empty.len(), 1);
    assert_eq!(exact_empty[0].id, "empty-album");
}

#[test]
fn source_resolver_track_matches_browse_partition_and_pair_priority() {
    let store = LibraryStore::open_in_memory();
    let mut high = track(
        "s1",
        "t-high",
        "Shared",
        Some("Artist"),
        "Album",
        "al-high",
        Some("ar-high"),
        104,
        "lib-high",
        None,
        None,
        None,
    );
    high.suffix = Some("flac".into());
    high.bit_rate = Some(1_000);
    high.size_bytes = Some(30_000_000);
    high.starred_at = Some(1_700_000_000);
    high.user_rating = Some(5);
    let mut low = track(
        "s2",
        "t-low",
        "Shared",
        Some("Artist"),
        "Album",
        "al-low",
        Some("ar-low"),
        104,
        "",
        None,
        None,
        None,
    );
    low.suffix = Some("mp3".into());
    low.bit_rate = Some(320);
    low.size_bytes = Some(8_000_000);
    let boundary = track(
        "s3",
        "t-boundary",
        "Shared",
        Some("Artist"),
        "Album",
        "al-boundary",
        Some("ar-boundary"),
        105,
        "lib-boundary",
        None,
        None,
        None,
    );
    seed_and_rebuild(&store, &[high, low, boundary]);

    let scopes = vec![
        whole_scope("s2"),
        scope_pair("s1", "lib-high"),
        whole_scope("s3"),
    ];
    let sources = resolve_entity_sources(
        &store,
        &LibraryResolveEntitySourcesRequest {
            entity_type: LibrarySourceEntityType::Track,
            anchor_server_id: "s1".into(),
            anchor_id: "t-high".into(),
            scopes: scopes.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        sources
            .iter()
            .map(|source| source.id.as_str())
            .collect::<Vec<_>>(),
        vec!["t-low", "t-high"]
    );
    assert_eq!(sources[0].library_id, "");
    assert_eq!(sources[0].priority, 0);
    assert_eq!(sources[1].priority, 1);
    assert_eq!(sources[1].duration_sec, Some(104));
    assert_eq!(sources[1].suffix.as_deref(), Some("flac"));
    assert_eq!(sources[1].bit_rate, Some(1_000));
    assert_eq!(sources[1].size_bytes, Some(30_000_000));
    assert_eq!(sources[1].starred_at, Some(1_700_000_000));
    assert_eq!(sources[1].user_rating, Some(5));

    let browse = search_tracks(
        &store,
        &LibraryScopeSearchRequest {
            scopes,
            query: "Shared".into(),
            limit: Some(10),
        },
    )
    .unwrap();
    assert_eq!(
        browse.len(),
        2,
        "the 105-second boundary is a separate partition"
    );
    assert_eq!(browse[0].id, "t-low");
}

#[test]
fn source_resolver_album_and_artist_use_browse_identity() {
    let store = LibraryStore::open_in_memory();
    seed_and_rebuild(
        &store,
        &[
            track(
                "s1",
                "t-a",
                "One",
                Some("Shared Artist"),
                "Shared Album",
                "al-a",
                Some("ar-a"),
                100,
                "lib-a",
                None,
                None,
                None,
            ),
            track(
                "s2",
                "t-b",
                "Two",
                Some("Shared Artist"),
                "Shared Album",
                "al-b",
                Some("ar-b"),
                110,
                "lib-b",
                None,
                None,
                None,
            ),
        ],
    );
    store
            .with_conn_mut("test.source_resolver_album_metadata", |conn| {
                conn.execute(
                    "INSERT INTO album(server_id, id, name, duration_sec, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al-a', 'Shared Album', 100, 11, 1, '{}'), \
                            ('s2', 'al-b', 'Shared Album', 110, 22, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    let scopes = vec![whole_scope("s2"), scope_pair("s1", "lib-a")];

    let albums = resolve_entity_sources(
        &store,
        &LibraryResolveEntitySourcesRequest {
            entity_type: LibrarySourceEntityType::Album,
            anchor_server_id: "s1".into(),
            anchor_id: "al-a".into(),
            scopes: scopes.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        albums
            .iter()
            .map(|source| source.id.as_str())
            .collect::<Vec<_>>(),
        vec!["al-b", "al-a"]
    );
    assert_eq!(albums[0].priority, 0);
    assert_eq!(albums[0].duration_sec, Some(110));
    assert_eq!(albums[0].starred_at, Some(22));

    let artists = resolve_entity_sources(
        &store,
        &LibraryResolveEntitySourcesRequest {
            entity_type: LibrarySourceEntityType::Artist,
            anchor_server_id: "s1".into(),
            anchor_id: "ar-a".into(),
            scopes,
        },
    )
    .unwrap();
    assert_eq!(
        artists
            .iter()
            .map(|source| source.id.as_str())
            .collect::<Vec<_>>(),
        vec!["ar-b", "ar-a"]
    );
    assert!(artists.iter().all(|source| source.duration_sec.is_none()));
}

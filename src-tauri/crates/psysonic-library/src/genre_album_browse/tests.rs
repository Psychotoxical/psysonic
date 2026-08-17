use super::*;
use crate::dto::SortDir;
use crate::repos::{TrackRepository, TrackRow};

fn track(server: &str, id: &str, album_id: &str, genre: &str) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: format!("T{id}"),
        title_sort: None,
        artist: Some("Artist".into()),
        artist_id: Some("ar1".into()),
        album: album_id.into(),
        album_id: Some(album_id.into()),
        album_artist: None,
        duration_sec: 200,
        track_number: Some(1),
        disc_number: Some(1),
        year: Some(2000),
        genre: Some(genre.into()),
        suffix: None,
        bit_rate: None,
        size_bytes: None,
        cover_art_id: None,
        starred_at: None,
        user_rating: None,
        play_count: None,
        played_at: None,
        server_path: None,
        library_id: Some("lib1".into()),
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

#[test]
fn genre_filtered_compilation_links_to_the_album_artist_via_an_excluded_sibling() {
    // Identity is a property of the whole album, not of the rows that passed the
    // genre predicate: the matching track carries no `albumArtistId`, only a sibling
    // filtered out by the genre does. The card must still link to the VA entity.
    let store = LibraryStore::open_in_memory();
    let mut matching = track("s1", "t1", "comp", "Rock");
    matching.artist = Some("Performer One".into());
    matching.artist_id = Some("perf1".into());
    matching.album_artist = Some("Various Artists".into());
    let mut excluded = track("s1", "t2", "comp", "Jazz");
    excluded.artist = Some("Performer Two".into());
    excluded.artist_id = Some("perf2".into());
    excluded.album_artist = Some("Various Artists".into());
    excluded.raw_json = r#"{"albumArtistId":"va"}"#.into();
    TrackRepository::new(&store)
        .upsert_batch(&[matching, excluded])
        .unwrap();

    let rock = list_albums_by_genre(
        &store,
        &LibraryGenreAlbumsRequest {
            server_id: "s1".into(),
            genre: "Rock".into(),
            library_scope: Some("lib1".into()),
            library_scopes: None,
            sort: vec![LibrarySortClause {
                field: "name".into(),
                dir: SortDir::Asc,
            }],
            limit: 10,
            offset: 0,
            include_total: false,
            count_only: false,
        },
    )
    .unwrap();
    let card = rock
        .albums
        .iter()
        .find(|a| a.id == "comp")
        .expect("comp missing");
    assert_eq!(card.artist.as_deref(), Some("Various Artists"));
    assert_eq!(
        card.artist_id.as_deref(),
        Some("va"),
        "the album-artist id must come from the album, not from the filtered rows"
    );
}

#[test]
fn list_albums_by_genre_respects_library_scope_and_total() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "al_a", "Rock"),
            track("s1", "t2", "al_b", "Rock"),
            {
                let mut t = track("s1", "t3", "al_c", "Rock");
                t.library_id = Some("lib2".into());
                t
            },
        ])
        .unwrap();

    let scoped = list_albums_by_genre(
        &store,
        &LibraryGenreAlbumsRequest {
            server_id: "s1".into(),
            genre: "Rock".into(),
            library_scope: Some("lib1".into()),
            library_scopes: None,
            sort: vec![LibrarySortClause {
                field: "name".into(),
                dir: SortDir::Asc,
            }],
            limit: 10,
            offset: 0,
            include_total: true,
            count_only: false,
        },
    )
    .unwrap();
    assert_eq!(scoped.total, Some(2));
    assert_eq!(scoped.albums.len(), 2);

    let all = list_albums_by_genre(
        &store,
        &LibraryGenreAlbumsRequest {
            server_id: "s1".into(),
            genre: "Rock".into(),
            library_scope: None,
            library_scopes: None,
            sort: vec![],
            limit: 1,
            offset: 0,
            include_total: true,
            count_only: false,
        },
    )
    .unwrap();
    assert_eq!(all.total, Some(3));
    assert!(all.has_more);
}

#[test]
fn count_only_returns_the_total_without_album_rows() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "al_a", "Rock"),
            track("s1", "t2", "al_b", "Rock"),
        ])
        .unwrap();

    let response = list_albums_by_genre(
        &store,
        &LibraryGenreAlbumsRequest {
            server_id: "s1".into(),
            genre: "Rock".into(),
            library_scope: Some("lib1".into()),
            library_scopes: None,
            sort: vec![],
            limit: 50,
            offset: 0,
            include_total: true,
            count_only: true,
        },
    )
    .unwrap();

    assert_eq!(response.total, Some(2));
    assert!(response.albums.is_empty());
    assert!(!response.has_more);
}

#[test]
fn scoped_genre_query_drives_from_the_genre_index() {
    let store = LibraryStore::open_in_memory();
    let scopes = vec![LibraryScopePair {
        server_id: "s1".into(),
        library_id: Some("lib1".into()),
    }];
    let (cte, binds) = scoped_genre_album_cte(&scopes, "Rock");
    let sql = format!("EXPLAIN QUERY PLAN {cte} SELECT COUNT(*) FROM ranked WHERE album_rank = 1");

    let details = store
        .with_read_conn(|conn| {
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(binds.iter()), |row| {
                row.get::<_, String>(3)
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();

    assert!(
        details
            .iter()
            .any(|detail| detail.contains("idx_track_genre_browse")),
        "query plan must use the genre-first browse index: {details:?}"
    );
    assert!(
        !details.iter().any(|detail| detail == "SCAN t"),
        "query plan must not drive from a full track scan: {details:?}"
    );
}

#[test]
fn list_albums_by_atomic_genre_from_compound_tag() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track(
            "s1",
            "t1",
            "al_a",
            "Noise Metal/Dark Ambient/Experimental Black Metal",
        )])
        .unwrap();

    let dark = list_albums_by_genre(
        &store,
        &LibraryGenreAlbumsRequest {
            server_id: "s1".into(),
            genre: "Dark Ambient".into(),
            library_scope: None,
            library_scopes: None,
            sort: vec![],
            limit: 10,
            offset: 0,
            include_total: true,
            count_only: false,
        },
    )
    .unwrap();
    assert_eq!(dark.total, Some(1));
    assert_eq!(dark.albums.len(), 1);
    assert_eq!(dark.albums[0].id, "al_a");

    let noise = list_albums_by_genre(
        &store,
        &LibraryGenreAlbumsRequest {
            server_id: "s1".into(),
            genre: "Noise Metal".into(),
            library_scope: None,
            library_scopes: None,
            sort: vec![],
            limit: 10,
            offset: 0,
            include_total: true,
            count_only: false,
        },
    )
    .unwrap();
    assert_eq!(noise.total, Some(1));
}

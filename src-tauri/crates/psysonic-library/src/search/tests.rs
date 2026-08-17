use super::*;
use crate::repos::{TrackRepository, TrackRow};
use std::collections::HashSet;

fn row(server: &str, id: &str, title: &str, artist: &str, album: &str) -> TrackRow {
    TrackRow {
        server_id: server.into(),
        id: id.into(),
        title: title.into(),
        title_sort: None,
        artist: Some(artist.into()),
        artist_id: None,
        album: album.into(),
        album_id: None,
        album_artist: Some(artist.into()),
        duration_sec: 200,
        track_number: None,
        disc_number: None,
        year: None,
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
        library_id: None,
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

fn row_with_lib(
    server: &str,
    id: &str,
    title: &str,
    artist: &str,
    album: &str,
    library_id: Option<&str>,
) -> TrackRow {
    let mut r = row(server, id, title, artist, album);
    r.library_id = library_id.map(str::to_string);
    r
}

#[test]
fn match_finds_track_by_title() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            row("s1", "t1", "Aurora", "Anna", "Skylines"),
            row("s1", "t2", "Sunset", "Beth", "Skylines"),
        ])
        .unwrap();
    let hits = search_tracks(&store, "s1", "aurora", 10, &[]).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "t1");
}

#[test]
fn match_filters_by_server_id() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            row("s1", "t1", "Aurora", "Anna", "Skylines"),
            row("s2", "t1", "Aurora", "Anna", "Skylines"),
        ])
        .unwrap();
    let hits = search_tracks(&store, "s2", "aurora", 10, &[]).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].server_id, "s2");
}

#[test]
fn match_skips_deleted_rows() {
    let store = LibraryStore::open_in_memory();
    let repo = TrackRepository::new(&store);
    repo.upsert_batch(&[row("s1", "t1", "Aurora", "Anna", "Skylines")])
        .unwrap();
    let mut gone = row("s1", "t1", "Aurora", "Anna", "Skylines");
    gone.deleted = true;
    repo.upsert_batch(&[gone]).unwrap();
    let hits = search_tracks(&store, "s1", "aurora", 10, &[]).unwrap();
    assert!(hits.is_empty());
}

#[test]
fn match_library_scope_narrows_single_id() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            row_with_lib("s1", "t1", "Scoped Song", "A", "Al1", Some("lib1")),
            row_with_lib("s1", "t2", "Scoped Song", "B", "Al2", Some("lib2")),
        ])
        .unwrap();
    let hits = search_tracks(&store, "s1", "scoped", 10, &["lib1".into()]).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "t1");
}

#[test]
fn match_library_scope_narrows_multi_id() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            row_with_lib("s1", "t1", "Scoped Song", "A", "Al1", Some("lib1")),
            row_with_lib("s1", "t2", "Scoped Song", "B", "Al2", Some("lib2")),
            row_with_lib("s1", "t3", "Scoped Song", "C", "Al3", Some("lib3")),
        ])
        .unwrap();
    let hits = search_tracks(&store, "s1", "scoped", 10, &["lib1".into(), "lib3".into()]).unwrap();
    assert_eq!(hits.len(), 2);
    let ids: HashSet<_> = hits.iter().map(|h| h.id.as_str()).collect();
    assert_eq!(ids, HashSet::from(["t1", "t3"]));
}

#[test]
fn match_fts_first_returns_correct_hit_on_large_fixture() {
    let store = LibraryStore::open_in_memory();
    let mut batch = Vec::new();
    for i in 0..80 {
        batch.push(row(
            "s1",
            &format!("t_noise_{i}"),
            "Noise Track",
            "Filler Artist",
            "Filler Album",
        ));
    }
    batch.push(row(
        "s1",
        "t_target",
        "Unique Aurora Title",
        "Target Artist",
        "Target Album",
    ));
    TrackRepository::new(&store).upsert_batch(&batch).unwrap();
    let hits = search_tracks(&store, "s1", "aurora", 10, &[]).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "t_target");
}

#[test]
fn library_scope_in_sql_produces_sargable_in_clause() {
    assert_eq!(library_scope_in_sql("t", 2), "t.library_id IN (?, ?)");
}

#[test]
fn fts_column_prefix_query_scopes_to_one_column() {
    assert_eq!(
        fts_column_prefix_query("artist", "metal").as_deref(),
        Some("artist : \"metal\"*")
    );
}

#[test]
fn fts_prefix_token_or_expr_matches_any_word() {
    assert_eq!(
        fts_prefix_token_or_expr("love supreme").as_deref(),
        Some("\"love\"* OR \"supreme\"*")
    );
}

#[test]
fn fts_album_prefix_any_token_match_query_or_across_album_fields() {
    assert_eq!(
        fts_album_prefix_any_token_match_query("dark side").as_deref(),
        Some("(album : (\"dark\"* OR \"side\"*) OR album_artist : (\"dark\"* OR \"side\"*))")
    );
}

#[test]
fn fts_prefix_token_expr_ands_multiword_prefixes() {
    assert_eq!(
        fts_prefix_token_expr("arch enemy").as_deref(),
        Some("\"arch\"* \"enemy\"*")
    );
}

#[test]
fn fts_track_prefix_match_query_or_across_display_columns() {
    let q = fts_track_prefix_match_query("metal").unwrap();
    assert!(q.contains("title : \"metal\"*"));
    assert!(q.contains("artist : \"metal\"*"));
    assert!(!q.contains("genre"));
}

#[test]
fn fts_album_prefix_match_query_includes_album_artist() {
    assert_eq!(
        fts_album_prefix_match_query("metal").as_deref(),
        Some("(album : \"metal\"* OR album_artist : \"metal\"*)")
    );
}

#[test]
fn fts_album_title_prefix_match_query_is_album_column_only() {
    assert_eq!(
        fts_album_title_prefix_match_query("metal").as_deref(),
        Some("album : \"metal\"*")
    );
}

#[test]
fn fts_track_match_query_or_across_display_columns() {
    let q = fts_track_match_query("manowar").unwrap();
    assert!(q.contains("title : \"manowar\""));
    assert!(q.contains("artist : \"manowar\""));
    assert!(!q.contains("genre"));
}

#[test]
fn fts_query_meets_min_len_requires_two_graphemes() {
    assert!(!fts_query_meets_min_len("a"));
    assert!(!fts_query_meets_min_len("а"));
    assert!(fts_query_meets_min_len("ab"));
    assert!(fts_query_meets_min_len("ма"));
}

#[test]
fn fts_query_quotes_tokens_and_doubles_inner_quotes() {
    assert_eq!(
        fts_query("hello world").as_deref(),
        Some("\"hello\" \"world\"")
    );
    assert_eq!(fts_query("a\"b").as_deref(), Some("\"a\"\"b\""));
}

#[test]
fn fts_query_is_none_for_blank_input() {
    assert!(fts_query("").is_none());
    assert!(fts_query("   ").is_none());
}

#[test]
fn fts_prefix_token_or_expr_rejects_syntax_metachar_tokens() {
    assert!(fts_prefix_token_or_expr("1=2").is_none());
    assert!(fts_prefix_token_or_expr("1=1").is_none());
    assert!(fts_prefix_token_or_expr("M=c").is_none());
    assert!(fts_prefix_token_or_expr("V()>P").is_none());
    assert!(fts_prefix_token_or_expr("**").is_none());
    assert!(fts_prefix_token_or_expr("****").is_none());
}

#[test]
fn fts_prefix_token_or_expr_allows_censorship_stars_in_titles() {
    assert_eq!(
        fts_prefix_token_or_expr("***Flawless").as_deref(),
        Some("\"***Flawless\"*")
    );
    assert_eq!(
        fts_prefix_token_or_expr("B********").as_deref(),
        Some("\"B********\"*")
    );
}

#[test]
fn fts_prefix_token_or_expr_still_builds_safe_tokens() {
    assert_eq!(
        fts_prefix_token_or_expr("love supreme").as_deref(),
        Some("\"love\"* OR \"supreme\"*")
    );
    assert_eq!(fts_prefix_token_or_expr("25").as_deref(), Some("\"25\"*"));
}

#[test]
fn aliased_track_columns_prefixes_every_column() {
    let cols = aliased_track_columns("t");
    assert!(cols.starts_with("t.server_id, t.id, t.title"));
    assert!(cols.ends_with("t.raw_json"));
    // One alias per column — count matches the shared column list.
    assert_eq!(
        cols.matches("t.").count(),
        crate::repos::track_columns().split(',').count()
    );
}

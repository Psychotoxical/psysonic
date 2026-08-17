use super::support::{insert_artist, insert_artist_with_album_count, req, track};
use crate::advanced_search::run_advanced_search;
use crate::dto::{ArtistCreditMode, LibrarySortClause, SortDir};
use crate::filter::EntityKind;
use crate::repos::TrackRepository;
use crate::store::LibraryStore;

#[test]
fn text_prefix_query_matches_partial_artist_name() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "Enter Sandman", "Metallica", "Metallica"),
            track("s1", "t2", "Other", "Other Artist", "Other Album"),
        ])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.query = Some("metal".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].artist.as_deref(), Some("Metallica"));
}

#[test]
fn text_query_matches_track_via_fts() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[
            track("s1", "t1", "Aurora", "Anna", "Skylines"),
            track("s1", "t2", "Sunset", "Beth", "Skylines"),
        ])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    r.query = Some("aurora".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.tracks.len(), 1);
    assert_eq!(resp.tracks[0].id, "t1");
    assert_eq!(resp.totals.tracks, 1);
    assert!(resp.applied_filters.contains(&"text".to_string()));
    assert_eq!(resp.source, "local");
}

#[test]
fn text_query_matches_album_and_artist_via_like() {
    let store = LibraryStore::open_in_memory();
    super::support::insert_album(&store, "s1", "al1", "Aurora Nights", None, None);
    super::support::insert_album(&store, "s1", "al2", "Other", None, None);
    insert_artist(&store, "s1", "ar1", "Aurora Quartet");
    let mut r = req("s1", &[EntityKind::Album, EntityKind::Artist]);
    r.query = Some("aurora".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al1");
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar1");
}

#[test]
fn artist_text_query_is_case_insensitive_for_cyrillic_name_sort() {
    let store = LibraryStore::open_in_memory();
    store
        .with_conn("misc", |c| {
            c.execute(
                "INSERT INTO artist (server_id, id, name, name_sort, album_count, synced_at, raw_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, '{}')",
                rusqlite::params!["s1", "ar_kino", "Кино", "кино", 3_i64],
            )
        })
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.query = Some("КИН".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar_kino");
}

#[test]
fn artist_text_query_is_case_insensitive_for_latin_display_name() {
    let store = LibraryStore::open_in_memory();
    insert_artist(&store, "s1", "ar1", "Metallica");
    let mut r = req("s1", &[EntityKind::Artist]);
    r.query = Some("METAL".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar1");
}

#[test]
fn text_query_derives_album_and_artist_from_tracks_when_tables_empty() {
    let store = LibraryStore::open_in_memory();
    let mut t1 = track("s1", "t1", "Song One", "Aurora Quartet", "Aurora Nights");
    t1.cover_art_id = Some("cv1".into());
    TrackRepository::new(&store)
        .upsert_batch(&[
            t1,
            track("s1", "t2", "Song Two", "Other Artist", "Other Album"),
        ])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Album, EntityKind::Artist]);
    r.query = Some("aurora".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.albums.len(), 1);
    assert_eq!(resp.albums[0].id, "al_Aurora Nights");
    assert_eq!(resp.albums[0].cover_art_id.as_deref(), Some("cv1"));
    // Artist rows come from the `artist` table only (#1209) — not track fallthrough.
    assert!(resp.artists.is_empty());
}

#[test]
fn artist_credit_album_mode_excludes_backfill_only_rows() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_va", "Various Artists", Some(12));
    insert_artist_with_album_count(&store, "s1", "ar_guest", "Soundtrack Guest", None);
    let mut r = req("s1", &[EntityKind::Artist]);
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar_va");
}

#[test]
fn artist_credit_track_mode_includes_backfill_rows() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_va", "Various Artists", Some(12));
    insert_artist_with_album_count(&store, "s1", "ar_guest", "Soundtrack Guest", None);
    let mut r = req("s1", &[EntityKind::Artist]);
    r.artist_credit_mode = Some(ArtistCreditMode::Track);
    r.sort = vec![LibrarySortClause {
        field: "name".into(),
        dir: SortDir::Asc,
    }];
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 2);
    assert_eq!(resp.artists[0].id, "ar_guest");
    assert_eq!(resp.artists[1].id, "ar_va");
}

#[test]
fn artist_credit_album_mode_text_search_uses_artist_table_only() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_va", "Various Artists", Some(12));
    insert_artist_with_album_count(&store, "s1", "ar_guest", "Soundtrack Guest", None);
    let mut r = req("s1", &[EntityKind::Artist]);
    r.query = Some("guest".into());
    r.artist_credit_mode = Some(ArtistCreditMode::Album);
    let resp = run_advanced_search(&store, &r).unwrap();
    assert!(resp.artists.is_empty());
    let mut r2 = req("s1", &[EntityKind::Artist]);
    r2.query = Some("guest".into());
    r2.artist_credit_mode = Some(ArtistCreditMode::Track);
    let resp2 = run_advanced_search(&store, &r2).unwrap();
    assert_eq!(resp2.artists.len(), 1);
    assert_eq!(resp2.artists[0].id, "ar_guest");
}

#[test]
fn artist_letter_bucket_filters_by_name_sort_prefix() {
    let store = LibraryStore::open_in_memory();
    insert_artist_with_album_count(&store, "s1", "ar_a", "Alpha", Some(1));
    insert_artist_with_album_count(&store, "s1", "ar_m", "Mike", Some(1));
    store
        .with_conn("misc", |c| {
            c.execute(
                "UPDATE artist SET name_sort = 'alpha' WHERE id = 'ar_a'",
                [],
            )?;
            c.execute("UPDATE artist SET name_sort = 'mike' WHERE id = 'ar_m'", [])
        })
        .unwrap();
    let mut r = req("s1", &[EntityKind::Artist]);
    r.artist_letter_bucket = Some("M".into());
    let resp = run_advanced_search(&store, &r).unwrap();
    assert_eq!(resp.artists.len(), 1);
    assert_eq!(resp.artists[0].id, "ar_m");
}

#[test]
fn special_chars_in_query_do_not_crash_fts() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "Hello World", "A", "B")])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    // Each of these is a raw FTS5 syntax error if passed unescaped; the
    // builder must quote them into safe terms so the call returns Ok.
    for q in ["\"", "AND", "foo*", "a OR b", "((", "near/"] {
        r.query = Some(q.to_string());
        assert!(
            run_advanced_search(&store, &r).is_ok(),
            "query `{q}` must not raise an FTS syntax error"
        );
    }
}

#[test]
fn quoted_token_query_still_matches_clean_terms() {
    let store = LibraryStore::open_in_memory();
    TrackRepository::new(&store)
        .upsert_batch(&[track("s1", "t1", "Hello World", "A", "B")])
        .unwrap();
    let mut r = req("s1", &[EntityKind::Track]);
    // Multi-token query AND-s its terms — both present → one hit.
    r.query = Some("hello world".into());
    assert_eq!(run_advanced_search(&store, &r).unwrap().tracks.len(), 1);
}

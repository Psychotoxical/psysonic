use super::*;
use crate::repos::{TrackRepository, TrackRow};

/// Seed a track with the metadata the recap aggregates over.
#[allow(clippy::too_many_arguments)]
fn recap_track(
    store: &LibraryStore,
    server_id: &str,
    track_id: &str,
    title: &str,
    artist: &str,
    album: &str,
    album_id: Option<&str>,
    genre: Option<&str>,
    suffix: Option<&str>,
    cover_art_id: Option<&str>,
) {
    TrackRepository::new(store)
        .upsert_batch(&[TrackRow {
            server_id: server_id.into(),
            id: track_id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some(artist.into()),
            artist_id: None,
            album: album.into(),
            album_id: album_id.map(Into::into),
            album_artist: None,
            duration_sec: 200,
            track_number: None,
            disc_number: None,
            year: None,
            genre: genre.map(Into::into),
            suffix: suffix.map(Into::into),
            bit_rate: None,
            size_bytes: None,
            cover_art_id: cover_art_id.map(Into::into),
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
        }])
        .expect("seed track");
}

/// Mid-day, mid-year instants so the local-time bucketing cannot cross a year
/// boundary regardless of the machine's timezone.
const MID_2023_MS: i64 = 1_688_212_800_000; // 2023-07-01T12:00:00Z
const MID_2024_MS: i64 = 1_719_835_200_000; // 2024-07-01T12:00:00Z

fn insert_session(
    repo: &PlaySessionRepository<'_>,
    server_id: &str,
    track_id: &str,
    started_at_ms: i64,
    listened_sec: f64,
) {
    repo.insert(&PlaySessionInputDto {
        server_id: server_id.into(),
        track_id: track_id.into(),
        started_at_ms,
        listened_sec,
        position_max_sec: listened_sec,
        end_reason: "ended".into(),
        duration_sec_hint: None,
    })
    .expect("insert session");
}

#[test]
fn year_recap_ranks_and_aggregates() {
    let store = LibraryStore::open_in_memory();
    // Artist Alpha owns two tracks on album "First" (flac, Rock, with cover);
    // artist Beta owns one track on album "Second" (mp3, Jazz, no ids).
    recap_track(
        &store, "s1", "t1", "Song One", "Alpha", "First",
        Some("al-1"), Some("Rock"), Some("flac"), Some("cov-1"),
    );
    recap_track(
        &store, "s1", "t2", "Song Two", "Alpha", "First",
        Some("al-1"), Some("Rock"), Some("flac"), Some("cov-1"),
    );
    recap_track(
        &store, "s1", "t3", "Song Three", "Beta", "Second",
        None, Some("Jazz"), Some("mp3"), None,
    );
    let repo = PlaySessionRepository::new(&store);

    let hour = 3_600_000_i64;
    let day = 24 * hour;
    // Day 1: Alpha twice (600 s + 300 s lossless), Beta once (400 s lossy).
    insert_session(&repo, "s1", "t1", MID_2024_MS, 600.0);
    insert_session(&repo, "s1", "t2", MID_2024_MS + hour, 300.0);
    insert_session(&repo, "s1", "t3", MID_2024_MS + 2 * hour, 400.0);
    // Day 3: one shorter play, so day 1 stays the busiest.
    insert_session(&repo, "s1", "t3", MID_2024_MS + 2 * day, 100.0);

    let recap = repo.year_recap(2024).expect("recap");

    assert_eq!(recap.top_artists.len(), 2);
    assert_eq!(recap.top_artists[0].name, "Alpha");
    assert_eq!(recap.top_artists[0].play_count, 2);
    assert!((recap.top_artists[0].listened_sec - 900.0).abs() < 1e-6);
    assert_eq!(recap.top_artists[1].name, "Beta");

    assert_eq!(recap.top_albums.len(), 2);
    assert_eq!(recap.top_albums[0].name, "First");
    assert_eq!(recap.top_albums[0].server_id.as_deref(), Some("s1"));
    assert_eq!(recap.top_albums[0].album_id.as_deref(), Some("al-1"));
    assert_eq!(recap.top_albums[0].cover_art_id.as_deref(), Some("cov-1"));
    assert_eq!(recap.top_albums[0].secondary.as_deref(), Some("Alpha"));

    assert_eq!(recap.top_tracks[0].name, "Song One");
    assert_eq!(recap.top_tracks[0].secondary.as_deref(), Some("Alpha"));

    // Artist-spotlight extras belong to the leading artist (Alpha).
    assert_eq!(recap.top_artist_tracks.len(), 2);
    assert_eq!(recap.top_artist_tracks[0].name, "Song One");
    assert_eq!(recap.top_artist_tracks[0].play_count, 1);
    assert_eq!(recap.top_artist_tracks[1].name, "Song Two");
    // Alpha's two plays sit an hour apart — two sessions under the 30-min gap.
    assert_eq!(recap.top_artist_session_count, 2);
    // The heaviest of the four year sessions is the lone 600 s play.
    assert!((recap.longest_session_sec - 600.0).abs() < 1e-6);

    assert_eq!(recap.top_genres[0].name, "Rock");
    assert_eq!(recap.top_genres[1].name, "Jazz");

    assert!((recap.total_listened_sec - 1400.0).abs() < 1e-6);
    assert!((recap.lossless_listened_sec - 900.0).abs() < 1e-6);

    assert_eq!(recap.hourly_play_counts.len(), 24);
    let hourly_sum: u32 = recap.hourly_play_counts.iter().sum();
    assert_eq!(hourly_sum, 4);

    let busiest = recap.busiest_day.expect("busiest day");
    assert_eq!(busiest.play_count, 3);
    assert!((busiest.listened_sec - 1300.0).abs() < 1e-6);
}

#[test]
fn year_recap_new_artist_count_spans_full_history() {
    let store = LibraryStore::open_in_memory();
    recap_track(&store, "s1", "t1", "Old Song", "Alpha", "First", None, None, None, None);
    recap_track(&store, "s1", "t2", "New Song", "Beta", "Second", None, None, None, None);
    let repo = PlaySessionRepository::new(&store);

    // Alpha was first heard in 2023; only Beta debuts in 2024.
    insert_session(&repo, "s1", "t1", MID_2023_MS, 120.0);
    insert_session(&repo, "s1", "t1", MID_2024_MS, 120.0);
    insert_session(&repo, "s1", "t2", MID_2024_MS, 120.0);

    let recap = repo.year_recap(2024).expect("recap");
    assert_eq!(recap.new_artist_count, 1);

    let prior = repo.year_recap(2023).expect("prior recap");
    assert_eq!(prior.new_artist_count, 1);
}

#[test]
fn year_recap_empty_year_is_all_zeroes() {
    let store = LibraryStore::open_in_memory();
    recap_track(&store, "s1", "t1", "Song", "Alpha", "First", None, None, None, None);
    let repo = PlaySessionRepository::new(&store);
    insert_session(&repo, "s1", "t1", MID_2024_MS, 120.0);

    let recap = repo.year_recap(2020).expect("recap");
    assert!(recap.top_artists.is_empty());
    assert!(recap.top_albums.is_empty());
    assert!(recap.top_tracks.is_empty());
    assert!(recap.top_genres.is_empty());
    assert!(recap.top_artist_tracks.is_empty());
    assert_eq!(recap.top_artist_session_count, 0);
    assert_eq!(recap.total_listened_sec, 0.0);
    assert_eq!(recap.lossless_listened_sec, 0.0);
    assert_eq!(recap.longest_session_sec, 0.0);
    assert_eq!(recap.new_artist_count, 0);
    assert!(recap.busiest_day.is_none());
    assert_eq!(recap.hourly_play_counts.iter().sum::<u32>(), 0);
}

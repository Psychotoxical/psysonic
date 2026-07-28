//! Global chronological album feeds over an ordered multi-server library scope.

use rusqlite::types::Value as SqlValue;
use rusqlite::params_from_iter;

use crate::album_compilation_filter::pick_album_group_artist;
use crate::browse_support::{overlay_album_artist_links, overlay_album_starred_at_rows};
use crate::dto::{
    GenreAlbumCountDto, LibraryAlbumDto, LibraryMainstageAlbumFeed,
    LibraryMainstageAlbumsRequest, LibraryMainstageAlbumsResponse, LibraryScopePair,
};
use crate::scope_merge::{
    non_empty_scopes, scope_cte_sql, ALBUM_DEDUP_KEY, ALBUM_PICK_KEY,
};
use crate::search::PAGE_LIMIT_MAX;
use crate::store::LibraryStore;

const CANDIDATE_MULTIPLIER: u32 = 8;
const CANDIDATE_MARGIN: u32 = 128;
const MAX_CANDIDATE_LIMIT: u32 = 65_536;

fn candidate_limit(offset: u32, fetch_limit: u32) -> u32 {
    offset
        .saturating_add(fetch_limit)
        .saturating_mul(CANDIDATE_MULTIPLIER)
        .saturating_add(CANDIDATE_MARGIN)
}

fn candidate_columns(feed_at: &str, priority: usize) -> String {
    format!(
        "t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
         t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.id, \
         {priority} AS pr, ck.album_key, {ALBUM_DEDUP_KEY} AS album_dedup, \
         {feed_at} AS feed_at"
    )
}

fn new_release_candidates_sql(scopes: &[LibraryScopePair], genre_count: usize) -> String {
    scopes
        .iter()
        .enumerate()
        .map(|(priority, pair)| {
            let columns = candidate_columns("t.server_created_at", priority);
            let library_predicate = if pair.library_id.is_some() {
                " AND t.library_id = ?"
            } else {
                ""
            };
            let genre_predicate = if genre_count == 0 {
                String::new()
            } else {
                let placeholders = (0..genre_count).map(|_| "?").collect::<Vec<_>>().join(", ");
                format!(
                    " AND EXISTS (SELECT 1 FROM track_genre tg \
                     WHERE tg.server_id = t.server_id AND tg.track_id = t.id \
                       AND tg.genre COLLATE NOCASE IN ({placeholders}))"
                )
            };
            format!(
                "SELECT * FROM ( \
                   SELECT {columns} \
                   FROM track t INDEXED BY idx_track_library_created_album \
                   LEFT JOIN cluster.track_cluster_key ck \
                     ON ck.server_id = t.server_id AND ck.track_id = t.id \
                    WHERE t.server_id = ? {library_predicate} \
                     AND t.deleted = 0 AND t.server_created_at IS NOT NULL \
                      AND t.album_id IS NOT NULL AND t.album_id != '' {genre_predicate} \
                   ORDER BY t.server_created_at DESC, t.album_id ASC, t.id ASC \
                   LIMIT ? \
                 )"
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ")
}

fn recently_played_candidates_sql() -> String {
    let columns = candidate_columns("ps.started_at_ms", 0);
    format!(
        "SELECT {columns} \
         FROM play_session ps INDEXED BY idx_play_session_started \
         INNER JOIN track t INDEXED BY sqlite_autoindex_track_1 \
           ON t.server_id = ps.server_id AND t.id = ps.track_id \
         INNER JOIN scope matched_scope \
           ON matched_scope.server_id = t.server_id \
          AND matched_scope.library_id = t.library_id \
         LEFT JOIN cluster.track_cluster_key ck \
           ON ck.server_id = t.server_id AND ck.track_id = t.id \
         WHERE t.deleted = 0 AND t.album_id IS NOT NULL AND t.album_id != '' \
         ORDER BY ps.started_at_ms DESC \
         LIMIT ?"
    )
    .replace("0 AS pr", "matched_scope.pr AS pr")
}

fn build_mainstage_query(
    scopes: &[LibraryScopePair],
    feed: LibraryMainstageAlbumFeed,
    genres: &[String],
    bounded_candidates: u32,
    result_offset: u32,
    result_limit: u32,
) -> (String, Vec<SqlValue>) {
    let (cte, mut binds) = scope_cte_sql(scopes);
    let candidates_sql = match feed {
        LibraryMainstageAlbumFeed::NewReleases => {
            for pair in scopes {
                binds.push(SqlValue::Text(pair.server_id.clone()));
                if let Some(library_id) = &pair.library_id {
                    binds.push(SqlValue::Text(library_id.clone()));
                }
                for genre in genres {
                    binds.push(SqlValue::Text(genre.clone()));
                }
                binds.push(SqlValue::Integer(i64::from(bounded_candidates)));
            }
            new_release_candidates_sql(scopes, genres.len())
        }
        LibraryMainstageAlbumFeed::RecentlyPlayed => {
            binds.push(SqlValue::Integer(i64::from(bounded_candidates)));
            recently_played_candidates_sql()
        }
    };

    let sql = format!(
        "{cte}, \
         candidates AS MATERIALIZED ({candidates_sql}), \
         candidate_groups AS ( \
           SELECT album_dedup, MAX(feed_at) AS feed_at, MAX(album_key) AS album_key \
           FROM candidates GROUP BY album_dedup \
         ), \
         representative_pool AS ( \
           SELECT t.server_id, t.album_id, t.album, t.artist, t.artist_id, t.album_artist, \
                  t.year, t.genre, t.cover_art_id, t.starred_at, t.synced_at, t.id, \
                  s.pr, grouped.album_dedup \
           FROM candidate_groups grouped \
           CROSS JOIN scope s \
           CROSS JOIN cluster.track_cluster_key ck INDEXED BY idx_ck_scope_album \
             ON ck.server_id = s.server_id AND ck.library_id = s.library_id \
            AND ck.album_key = grouped.album_key \
           INNER JOIN track t INDEXED BY sqlite_autoindex_track_1 \
             ON t.server_id = ck.server_id AND t.id = ck.track_id \
           WHERE grouped.album_key IS NOT NULL AND t.deleted = 0 \
             AND t.library_id = s.library_id \
             AND t.album_id IS NOT NULL AND t.album_id != '' \
           UNION ALL \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, id, pr, album_dedup \
           FROM candidates WHERE album_key IS NULL \
         ), \
         representatives AS ( \
           SELECT server_id, album_id, album, artist, artist_id, album_artist, \
                  year, genre, cover_art_id, starred_at, synced_at, album_dedup, \
                  MIN({ALBUM_PICK_KEY}) AS _pick \
           FROM representative_pool GROUP BY album_dedup \
         ) \
          SELECT representative.server_id, representative.album_id, representative.album, \
                 representative.artist, representative.artist_id, representative.album_artist, \
                  representative.year, representative.genre, representative.cover_art_id, \
                  representative.starred_at, representative.synced_at, \
                  grouped.feed_at, \
                  (SELECT COUNT(*) FROM candidates) AS candidate_count \
         FROM representatives representative \
         INNER JOIN candidate_groups grouped \
           ON grouped.album_dedup = representative.album_dedup \
         ORDER BY grouped.feed_at DESC, representative.album COLLATE NOCASE ASC, \
                  representative.server_id ASC, representative.album_id ASC \
         LIMIT ? OFFSET ?"
    );
    binds.push(SqlValue::Integer(i64::from(result_limit)));
    binds.push(SqlValue::Integer(i64::from(result_offset)));
    (sql, binds)
}

fn new_release_genre_counts(
    conn: &rusqlite::Connection,
    scopes: &[LibraryScopePair],
) -> rusqlite::Result<Vec<GenreAlbumCountDto>> {
    let (cte, binds) = scope_cte_sql(scopes);
    let sql = format!(
        "{cte} \
         SELECT tg.genre, COUNT(DISTINCT t.album_id), COUNT(DISTINCT t.id) \
         FROM scope s CROSS JOIN track t \
           ON t.server_id = s.server_id AND t.library_id = s.library_id \
         INNER JOIN track_genre tg ON tg.server_id = t.server_id AND tg.track_id = t.id \
         WHERE t.deleted = 0 AND t.server_created_at IS NOT NULL \
           AND t.album_id IS NOT NULL AND t.album_id != '' \
         GROUP BY tg.genre COLLATE NOCASE \
         ORDER BY COUNT(DISTINCT t.album_id) DESC, tg.genre COLLATE NOCASE ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
        Ok(GenreAlbumCountDto {
            value: row.get(0)?,
            album_count: row.get::<_, i64>(1)?.max(0) as u32,
            song_count: row.get::<_, i64>(2)?.max(0) as u32,
        })
    })?.collect::<rusqlite::Result<Vec<_>>>();
    rows
}

fn map_mainstage_album(
    r: &rusqlite::Row<'_>,
    include_catalog_created_at: bool,
) -> rusqlite::Result<(LibraryAlbumDto, u32)> {
    // Credit name only — `overlay_album_artist_links` resolves which entity that credit
    // links to once the feed's rows are known, from the whole physical album.
    let track_artist: Option<String> = r.get(3)?;
    let album_artist: Option<String> = r.get(5)?;
    Ok((
        LibraryAlbumDto {
            server_id: r.get(0)?,
            id: r.get(1)?,
            name: r.get(2)?,
            artist: pick_album_group_artist(track_artist, album_artist),
            artist_id: r.get(4)?,
            song_count: None,
            duration_sec: None,
            year: r.get(6)?,
            genre: r.get(7)?,
            cover_art_id: r.get(8)?,
            starred_at: r.get(9)?,
            synced_at: r.get(10)?,
            raw_json: if include_catalog_created_at {
                serde_json::json!({ "createdMs": r.get::<_, i64>(11)? })
            } else {
                serde_json::Value::Null
            },
        },
        r.get(12)?,
    ))
}

pub fn list_mainstage_albums(
    store: &LibraryStore,
    request: &LibraryMainstageAlbumsRequest,
) -> Result<LibraryMainstageAlbumsResponse, String> {
    let scopes = non_empty_scopes(&request.scopes)?;

    let limit = request.limit.unwrap_or(30).clamp(1, PAGE_LIMIT_MAX);
    let offset = request.offset.unwrap_or(0);
    let fetch_limit = limit.saturating_add(1);
    let requested_results = offset.saturating_add(fetch_limit);
    let initial_candidates = candidate_limit(offset, fetch_limit);

    let (result, timing) = store.with_mainstage_read_conn_timed(|conn| {
        let genre_counts_start = std::time::Instant::now();
        let genre_counts = if request.include_genre_counts
            && request.feed == LibraryMainstageAlbumFeed::NewReleases
        {
            new_release_genre_counts(conn, scopes)?
        } else {
            Vec::new()
        };
        let genre_counts_ms = genre_counts_start.elapsed().as_millis();
        let feed_start = std::time::Instant::now();
        let mut bounded_candidates = initial_candidates;
        loop {
            let (sql, binds) = build_mainstage_query(
                scopes,
                request.feed,
                &request.genres,
                bounded_candidates,
                0,
                requested_results,
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(binds.iter()), |row| {
                    map_mainstage_album(row, request.feed == LibraryMainstageAlbumFeed::NewReleases)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let candidate_count = rows.first().map(|(_, count)| *count).unwrap_or(0);
            let candidate_capacity = match request.feed {
                LibraryMainstageAlbumFeed::NewReleases => {
                    bounded_candidates.saturating_mul(scopes.len() as u32)
                }
                LibraryMainstageAlbumFeed::RecentlyPlayed => bounded_candidates,
            };
            if rows.len() < requested_results as usize
                && candidate_count >= candidate_capacity
                && bounded_candidates < MAX_CANDIDATE_LIMIT
            {
                bounded_candidates = bounded_candidates
                    .saturating_mul(2)
                    .min(MAX_CANDIDATE_LIMIT);
                continue;
            }
            let mut albums = rows
                .into_iter()
                .skip(offset as usize)
                .map(|(album, _)| album)
                .collect::<Vec<_>>();
            let has_more = albums.len() > limit as usize;
            albums.truncate(limit as usize);
            overlay_album_starred_at_rows(conn, &mut albums);
            overlay_album_artist_links(conn, &mut albums);
            let result_count = albums.len();
            return Ok((
                LibraryMainstageAlbumsResponse { albums, has_more, genre_counts },
                genre_counts_ms,
                feed_start.elapsed().as_millis(),
                bounded_candidates,
                result_count,
            ));
        }
    })?;
    let (response, genre_counts_ms, feed_ms, bounded_candidates, result_count) = result;
    if psysonic_core::logging::should_log_debug() {
        // `lockWaitMs` separates "this query is slow" from "this query waited
        // for someone else's". The feeds, their genre counts, the hot-release
        // overlay and the sidebar badge all share this connection, so the two
        // look identical from the frontend — it only ever sees total duration.
        crate::app_deprintln!(
            "[frontend][mainstage-browse] {}",
            serde_json::json!({
                "feed": request.feed,
                "scopeCount": scopes.len(),
                "includeGenreCounts": request.include_genre_counts,
                "genreCountMs": genre_counts_ms,
                "feedMs": feed_ms,
                "lockWaitMs": timing.lock_wait_ms,
                "blockedBy": timing
                    .blocked_by
                    .map(|owner| format!("{}:{}", owner.file, owner.line))
                    .unwrap_or_else(|| "none".to_string()),
                "candidateLimit": bounded_candidates,
                "resultCount": result_count,
            })
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{LibraryScopePair, PlaySessionInputDto};
    use crate::identity::ensure_cluster_keys_built;
    use crate::repos::{PlaySessionRepository, TrackRepository, TrackRow};
    use rusqlite::params;
    use std::time::{Duration, Instant};

    fn scope(server_id: &str, library_id: &str) -> LibraryScopePair {
        LibraryScopePair {
            server_id: server_id.into(),
            library_id: Some(library_id.into()),
        }
    }

    fn whole_scope(server_id: &str) -> LibraryScopePair {
        LibraryScopePair {
            server_id: server_id.into(),
            library_id: None,
        }
    }

    fn track(
        server_id: &str,
        id: &str,
        album: &str,
        album_id: &str,
        library_id: &str,
        created_at: Option<i64>,
    ) -> TrackRow {
        TrackRow {
            server_id: server_id.into(),
            id: id.into(),
            title: format!("Track {id}"),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: Some(format!("artist-{server_id}")),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some("Artist".into()),
            duration_sec: 180,
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(2026),
            genre: None,
            suffix: Some("flac".into()),
            bit_rate: None,
            size_bytes: None,
            cover_art_id: Some(format!("cover-{album_id}")),
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
            server_created_at: created_at,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn request(
        scopes: Vec<LibraryScopePair>,
        feed: LibraryMainstageAlbumFeed,
    ) -> LibraryMainstageAlbumsRequest {
        LibraryMainstageAlbumsRequest {
            scopes,
            feed,
            limit: Some(30),
            offset: None,
            genres: Vec::new(),
            include_genre_counts: true,
        }
    }

    fn play(store: &LibraryStore, server_id: &str, track_id: &str, started_at_ms: i64) {
        PlaySessionRepository::new(store)
            .insert(&PlaySessionInputDto {
                server_id: server_id.into(),
                track_id: track_id.into(),
                started_at_ms,
                listened_sec: 20.0,
                position_max_sec: 20.0,
                end_reason: "skip".into(),
                duration_sec_hint: None,
            })
            .unwrap();
    }

    fn insert_artist(store: &LibraryStore, server_id: &str) {
        store
            .with_conn_mut("test.mainstage_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at) VALUES (?1, ?2, 'Artist', 1) \
                     ON CONFLICT(server_id, id) DO NOTHING",
                    params![server_id, format!("artist-{server_id}")],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn new_releases_are_globally_ordered_and_exclude_null_created_at() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t-old", "Old", "a-old", "l1", Some(100)),
                track("s2", "t-new", "New", "a-new", "l2", Some(300)),
                track("s1", "t-mid", "Mid", "a-mid", "l1", Some(200)),
                track("s2", "t-null", "Unknown", "a-null", "l2", None),
            ])
            .unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(
                vec![scope("s1", "l1"), scope("s2", "l2")],
                LibraryMainstageAlbumFeed::NewReleases,
            ),
        )
        .unwrap();
        assert_eq!(
            response.albums.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            vec!["New", "Mid", "Old"]
        );
        assert_eq!(response.albums[0].raw_json["createdMs"], 300);
    }

    #[test]
    fn new_release_va_card_links_to_the_album_artist_not_a_performer() {
        // Reported on the mainstage: clicking "Various Artists" on a New Releases card
        // opened a random performer from the compilation. The card credit is the
        // album-artist, so the linked id must follow it (album-artist id from
        // raw_json.albumArtistId), not the representative track's performer id.
        let store = LibraryStore::open_in_memory();
        let mut t = track("s1", "t1", "Christmas Comp", "comp1", "l1", Some(300));
        t.artist = Some("A Guest Performer".into());
        t.artist_id = Some("perf1".into());
        t.album_artist = Some("Various Artists".into());
        t.raw_json = r#"{"albumArtistId":"va"}"#.into();
        TrackRepository::new(&store).upsert_batch(&[t]).unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::NewReleases),
        )
        .unwrap();
        let card = response.albums.iter().find(|a| a.id == "comp1").unwrap();
        assert_eq!(card.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            card.artist_id.as_deref(),
            Some("va"),
            "the VA card must link to the album-artist entity, not a track performer"
        );
    }

    #[test]
    fn new_release_va_card_recovers_the_album_artist_id_from_a_sibling_track() {
        // Realistic partial tagging: the representative track (smallest ALBUM_PICK_KEY)
        // carries no albumArtistId, a sibling carries "va". The card must still link to
        // the VA entity (recovered via `MAX(...) OVER (PARTITION BY album_dedup)`), not
        // go unlinked. The window is not a GROUP BY aggregate, so the credit *name*,
        // cover and year still come from the single-MIN(_pick) representative row.
        let store = LibraryStore::open_in_memory();
        let mut t1 = track("s1", "t1", "Comp", "comp1", "l1", Some(300));
        t1.artist = Some("Performer One".into());
        t1.artist_id = Some("perf1".into());
        t1.album_artist = Some("Various Artists".into());
        t1.raw_json = "{}".into(); // representative: no album-artist id
        let mut t2 = track("s1", "t2", "Comp", "comp1", "l1", Some(300));
        t2.artist = Some("Performer Two".into());
        t2.artist_id = Some("perf2".into());
        t2.album_artist = Some("Various Artists".into());
        t2.raw_json = r#"{"albumArtistId":"va"}"#.into();
        TrackRepository::new(&store).upsert_batch(&[t1, t2]).unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::NewReleases),
        )
        .unwrap();
        let card = response.albums.iter().find(|a| a.id == "comp1").unwrap();
        // Credit name comes from the representative (t1); the link is recovered.
        assert_eq!(card.artist.as_deref(), Some("Various Artists"));
        assert_eq!(
            card.artist_id.as_deref(),
            Some("va"),
            "the VA link must be recovered from a sibling when the representative lacks it"
        );
    }

    #[test]
    fn whole_server_new_releases_include_empty_library_rows() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t-empty", "Empty", "a-empty", "", Some(100)),
                track("s1", "t-tagged", "Tagged", "a-tagged", "lib-b", Some(200)),
            ])
            .unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(vec![whole_scope("s1")], LibraryMainstageAlbumFeed::NewReleases),
        )
        .unwrap();
        assert_eq!(
            response.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(),
            vec!["a-tagged", "a-empty"]
        );
    }

    #[test]
    fn recently_played_does_not_expose_play_time_as_catalog_created_at() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "t1", "Album", "a1", "l1", Some(100))])
            .unwrap();
        play(&store, "s1", "t1", 999);

        let response = list_mainstage_albums(
            &store,
            &request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::RecentlyPlayed),
        )
        .unwrap();

        assert_eq!(response.albums[0].raw_json, serde_json::Value::Null);
    }

    #[test]
    fn only_selected_libraries_contribute() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t-selected", "Selected", "a1", "wanted", Some(100)),
                track("s1", "t-hidden", "Hidden", "a2", "other", Some(999)),
            ])
            .unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(vec![scope("s1", "wanted")], LibraryMainstageAlbumFeed::NewReleases),
        )
        .unwrap();
        assert_eq!(response.albums.len(), 1);
        assert_eq!(response.albums[0].name, "Selected");
    }

    #[test]
    fn genre_filter_and_counts_stay_within_dated_selected_release_scope() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "rock", "Rock release", "a-rock", "l1", Some(200)),
                track("s2", "jazz", "Jazz release", "a-jazz", "l2", Some(300)),
                track("s1", "missing-date", "Undated", "a-undated", "l1", None),
                track("s1", "outside", "Outside", "a-outside", "other", Some(400)),
            ])
            .unwrap();
        store
            .with_conn_mut("test.mainstage_genres", |conn| {
                for (server, track_id, genre) in [
                    ("s1", "rock", "Rock"),
                    ("s2", "jazz", "Jazz"),
                    ("s1", "missing-date", "Ambient"),
                    ("s1", "outside", "Metal"),
                ] {
                    conn.execute(
                        "INSERT INTO track_genre (server_id, track_id, genre, album_id, library_id) \
                         VALUES (?1, ?2, ?3, (SELECT album_id FROM track WHERE server_id = ?1 AND id = ?2), \
                                 (SELECT library_id FROM track WHERE server_id = ?1 AND id = ?2))",
                        rusqlite::params![server, track_id, genre],
                    )?;
                }
                Ok(())
            })
            .unwrap();

        let mut req = request(
            vec![scope("s1", "l1"), scope("s2", "l2")],
            LibraryMainstageAlbumFeed::NewReleases,
        );
        req.genres = vec!["rock".into()];
        let response = list_mainstage_albums(&store, &req).unwrap();

        assert_eq!(response.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(), ["a-rock"]);
        assert_eq!(
            response.genre_counts.iter().map(|row| (row.value.as_str(), row.album_count)).collect::<Vec<_>>(),
            [("Jazz", 1), ("Rock", 1)],
        );
    }

    #[test]
    fn home_feed_skips_genre_counts_when_not_requested() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[track("s1", "rock", "Rock release", "a-rock", "l1", Some(200))])
            .unwrap();
        store
            .with_conn_mut("test.mainstage_skip_genres", |conn| {
                conn.execute(
                    "INSERT INTO track_genre (server_id, track_id, genre, album_id, library_id) \
                     VALUES ('s1', 'rock', 'Rock', 'a-rock', 'l1')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let mut req = request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::NewReleases);
        req.include_genre_counts = false;
        let response = list_mainstage_albums(&store, &req).unwrap();

        assert_eq!(response.albums.len(), 1);
        assert!(response.genre_counts.is_empty());
    }

    #[test]
    fn recently_played_collapses_repeated_sessions_and_uses_latest_global_time() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t-a", "Album A", "a", "l1", Some(1)),
                track("s2", "t-b", "Album B", "b", "l2", Some(1)),
            ])
            .unwrap();
        play(&store, "s1", "t-a", 100);
        play(&store, "s1", "t-a", 400);
        play(&store, "s2", "t-b", 300);

        let response = list_mainstage_albums(
            &store,
            &request(
                vec![scope("s1", "l1"), scope("s2", "l2")],
                LibraryMainstageAlbumFeed::RecentlyPlayed,
            ),
        )
        .unwrap();
        assert_eq!(response.albums.len(), 2);
        assert_eq!(response.albums[0].name, "Album A");
        assert_eq!(response.albums[1].name, "Album B");
    }

    #[test]
    fn duplicate_album_uses_priority_owner_but_global_feed_timestamp() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t-priority", "Shared", "priority-id", "l1", Some(100)),
                track("s2", "t-later", "Shared", "later-id", "l2", Some(500)),
            ])
            .unwrap();
        insert_artist(&store, "s1");
        insert_artist(&store, "s2");
        ensure_cluster_keys_built(&store, "s1").unwrap();
        ensure_cluster_keys_built(&store, "s2").unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(
                vec![scope("s1", "l1"), scope("s2", "l2")],
                LibraryMainstageAlbumFeed::NewReleases,
            ),
        )
        .unwrap();
        assert_eq!(response.albums.len(), 1);
        assert_eq!(response.albums[0].server_id, "s1");
        assert_eq!(response.albums[0].id, "priority-id");
    }

    #[test]
    fn missing_cluster_keys_use_non_merge_fallback_without_rebuild() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "Shared", "a1", "l1", Some(200)),
                track("s2", "t2", "Shared", "a2", "l2", Some(100)),
            ])
            .unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(
                vec![scope("s1", "l1"), scope("s2", "l2")],
                LibraryMainstageAlbumFeed::NewReleases,
            ),
        )
        .unwrap();
        assert_eq!(response.albums.len(), 2);

        let key_count: i64 = store
            .with_read_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM cluster.track_cluster_key", [], |row| {
                    row.get(0)
                })
            })
            .unwrap();
        assert_eq!(key_count, 0, "latency-sensitive browse must not rebuild keys");
    }

    #[test]
    fn pagination_fetches_one_extra_for_has_more() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t1", "One", "a1", "l1", Some(300)),
                track("s1", "t2", "Two", "a2", "l1", Some(200)),
                track("s1", "t3", "Three", "a3", "l1", Some(100)),
            ])
            .unwrap();
        let mut req = request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::NewReleases);
        req.limit = Some(2);

        let first = list_mainstage_albums(&store, &req).unwrap();
        assert_eq!(first.albums.len(), 2);
        assert!(first.has_more);

        req.offset = Some(2);
        let second = list_mainstage_albums(&store, &req).unwrap();
        assert_eq!(second.albums.len(), 1);
        assert!(!second.has_more);
    }

    #[test]
    fn candidate_window_expands_when_one_album_dominates_newest_tracks() {
        let store = LibraryStore::open_in_memory();
        let mut tracks = (0..220)
            .map(|n| track("s1", &format!("shared-{n}"), "Shared", "shared", "l1", Some(1_000 - n)))
            .collect::<Vec<_>>();
        tracks.push(track("s1", "other", "Other", "other", "l1", Some(700)));
        TrackRepository::new(&store).upsert_batch(&tracks).unwrap();

        let mut req = request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::NewReleases);
        req.limit = Some(2);
        let response = list_mainstage_albums(&store, &req).unwrap();

        assert_eq!(response.albums.len(), 2);
        assert_eq!(response.albums[0].name, "Shared");
        assert_eq!(response.albums[1].name, "Other");
    }

    #[test]
    fn candidate_window_expands_when_one_album_dominates_recent_sessions() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "shared", "Shared", "shared", "l1", Some(1)),
                track("s1", "other", "Other", "other", "l1", Some(1)),
            ])
            .unwrap();
        for started_at_ms in 1..=220 {
            play(&store, "s1", "shared", 1_000 + started_at_ms);
        }
        play(&store, "s1", "other", 700);

        let mut req = request(vec![scope("s1", "l1")], LibraryMainstageAlbumFeed::RecentlyPlayed);
        req.limit = Some(2);
        let response = list_mainstage_albums(&store, &req).unwrap();

        assert_eq!(response.albums.len(), 2);
        assert_eq!(response.albums[0].name, "Shared");
        assert_eq!(response.albums[1].name, "Other");
    }

    #[test]
    fn feed_and_response_serialize_with_ipc_camel_case() {
        assert_eq!(
            serde_json::to_value(LibraryMainstageAlbumFeed::NewReleases).unwrap(),
            "newReleases"
        );
        assert_eq!(
            serde_json::to_value(LibraryMainstageAlbumFeed::RecentlyPlayed).unwrap(),
            "recentlyPlayed"
        );
        let response = LibraryMainstageAlbumsResponse {
            albums: Vec::new(),
            has_more: true,
            genre_counts: Vec::new(),
        };
        assert_eq!(serde_json::to_value(response).unwrap()["hasMore"], true);
    }

    #[test]
    fn album_star_overlay_uses_priority_representative_album_row() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track("s1", "t-priority", "Shared", "priority-id", "l1", Some(100)),
                track("s2", "t-later", "Shared", "later-id", "l2", Some(500)),
            ])
            .unwrap();
        insert_artist(&store, "s1");
        insert_artist(&store, "s2");
        ensure_cluster_keys_built(&store, "s1").unwrap();
        ensure_cluster_keys_built(&store, "s2").unwrap();
        store
            .with_conn("test.mainstage_star", |conn| {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'priority-id', 'Shared', 1234, 1, '{}'), \
                            ('s2', 'later-id', 'Shared', 5678, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let response = list_mainstage_albums(
            &store,
            &request(
                vec![scope("s1", "l1"), scope("s2", "l2")],
                LibraryMainstageAlbumFeed::NewReleases,
            ),
        )
        .unwrap();
        assert_eq!(response.albums[0].server_id, "s1");
        assert_eq!(response.albums[0].starred_at, Some(1234));
    }

    fn query_plan(
        store: &LibraryStore,
        scopes: &[LibraryScopePair],
        feed: LibraryMainstageAlbumFeed,
    ) -> Vec<String> {
        let (sql, binds) = build_mainstage_query(
            scopes,
            feed,
            &[],
            candidate_limit(0, 31),
            0,
            31,
        );
        store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
                let plan = stmt
                    .query_map(params_from_iter(binds.iter()), |row| row.get(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(plan)
            })
            .unwrap()
    }

    #[test]
    fn mainstage_query_plans_use_bounded_feed_indexes() {
        let store = LibraryStore::open_in_memory();
        let scopes = vec![scope("s1", "l1"), scope("s2", "l2")];

        let releases = query_plan(&store, &scopes, LibraryMainstageAlbumFeed::NewReleases);
        assert!(
            releases
                .iter()
                .any(|line| line.contains("idx_track_library_created_album")),
            "New Releases plan did not use created index: {releases:#?}"
        );
        assert!(
            !releases
                .iter()
                .any(|line| line == "SCAN t" || line.contains("SCAN track")),
            "New Releases plan contains an unindexed track scan: {releases:#?}"
        );

        let recent = query_plan(&store, &scopes, LibraryMainstageAlbumFeed::RecentlyPlayed);
        assert!(
            recent
                .iter()
                .any(|line| line.contains("idx_play_session_started")),
            "Recently Played plan did not drive from newest sessions: {recent:#?}"
        );
        assert!(
            recent
                .iter()
                .any(|line| line.contains("sqlite_autoindex_track_1")),
            "Recently Played plan did not use the track primary key: {recent:#?}"
        );
    }

    #[test]
    fn large_scoped_feeds_stay_bounded() {
        const TRACKS: i64 = 214_000;
        const SESSIONS: i64 = 40_000;
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_mainstage_perf", |conn| {
                conn.execute_batch(
                    "DROP TRIGGER track_ai; DROP TRIGGER track_ad; DROP TRIGGER track_au;",
                )?;
                let tx = conn.transaction()?;
                {
                    let mut insert_track = tx.prepare(
                        "INSERT INTO track (server_id, id, title, artist, artist_id, album, \
                         album_id, album_artist, duration_sec, year, genre, cover_art_id, \
                         library_id, server_created_at, deleted, synced_at, raw_json) \
                         VALUES (?1, ?2, ?3, 'Artist', 'artist', ?4, ?5, 'Artist', 180, \
                                 2026, 'Rock', ?6, ?7, ?8, 0, 1, '{}')",
                    )?;
                    for n in 0..TRACKS {
                        let server = if n % 2 == 0 { "s1" } else { "s2" };
                        let library = if n % 2 == 0 { "l1" } else { "l2" };
                        let album = n / 10;
                        insert_track.execute(params![
                            server,
                            format!("track-{n}"),
                            format!("Track {n}"),
                            format!("Album {album}"),
                            format!("album-{album}"),
                            format!("cover-{album}"),
                            library,
                            n,
                        ])?;
                    }
                }
                {
                    let mut insert_session = tx.prepare(
                        "INSERT INTO play_session \
                         (server_id, track_id, started_at_ms, listened_sec, position_max_sec, \
                          completion, end_reason) \
                         VALUES (?1, ?2, ?3, 20.0, 20.0, 'partial', 'skip')",
                    )?;
                    for n in 0..SESSIONS {
                        let track_number = TRACKS - 1 - n;
                        let server = if track_number % 2 == 0 { "s1" } else { "s2" };
                        insert_session.execute(params![
                            server,
                            format!("track-{track_number}"),
                            n,
                        ])?;
                    }
                }
                tx.commit()?;
                Ok(())
            })
            .unwrap();

        let scopes = vec![scope("s1", "l1"), scope("s2", "l2")];
        let release_request = request(scopes.clone(), LibraryMainstageAlbumFeed::NewReleases);
        let started = Instant::now();
        let releases = list_mainstage_albums(&store, &release_request).unwrap();
        let release_elapsed = started.elapsed();

        let recent_request = request(scopes, LibraryMainstageAlbumFeed::RecentlyPlayed);
        let started = Instant::now();
        let recent = list_mainstage_albums(&store, &recent_request).unwrap();
        let recent_elapsed = started.elapsed();

        eprintln!(
            "mainstage 214k fixture: releases={release_elapsed:?}, recent={recent_elapsed:?}"
        );
        assert_eq!(releases.albums.len(), 30);
        assert_eq!(recent.albums.len(), 30);
        assert!(releases.albums.iter().all(|album| album.song_count.is_none()));
        assert!(
            release_elapsed < Duration::from_millis(500),
            "New Releases regressed to an unbounded query: {release_elapsed:?}"
        );
        assert!(
            recent_elapsed < Duration::from_millis(500),
            "Recently Played regressed to an unbounded query: {recent_elapsed:?}"
        );
    }
}

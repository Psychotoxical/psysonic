//! Narrow local read for Favorites initial paint.
//!
//! This deliberately avoids the generic Advanced Search pipeline: favorites only
//! need rows with persisted album/track stars, not FTS, scope merging, or totals.

use rusqlite::params;

use crate::dto::{LibraryAlbumDto, LibraryTrackDto};
use crate::repos::{row_to_track_row, track_columns};
use crate::store::LibraryStore;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStarredResponse {
    pub albums: Vec<LibraryAlbumDto>,
    pub tracks: Vec<LibraryTrackDto>,
    pub read_lock_wait_ms: u64,
    pub sql_ms: u64,
    pub blocked_by: Option<String>,
}

pub fn list_starred(store: &LibraryStore, server_id: &str) -> Result<LibraryStarredResponse, String> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Ok(LibraryStarredResponse {
            albums: Vec::new(),
            tracks: Vec::new(),
            read_lock_wait_ms: 0,
            sql_ms: 0,
            blocked_by: None,
        });
    }

    let ((albums, tracks), timing) = store
        .with_read_conn_timed(|conn| {
            let albums = {
                let mut stmt = conn.prepare(
                    "SELECT server_id, id, name, artist, artist_id, song_count, duration_sec, year, \
                            genre, cover_art_id, starred_at, synced_at, raw_json \
                     FROM album \
                     WHERE server_id = ?1 AND starred_at IS NOT NULL \
                     ORDER BY starred_at DESC, id ASC",
                )?;
                let rows = stmt.query_map(params![server_id], |row| {
                    let raw_json: Option<String> = row.get(12)?;
                    Ok(LibraryAlbumDto {
                        server_id: row.get(0)?,
                        id: row.get(1)?,
                        name: row.get(2)?,
                        artist: row.get(3)?,
                        artist_id: row.get(4)?,
                        song_count: row.get(5)?,
                        duration_sec: row.get(6)?,
                        year: row.get(7)?,
                        genre: row.get(8)?,
                        cover_art_id: row.get(9)?,
                        starred_at: row.get(10)?,
                        synced_at: row.get(11)?,
                        raw_json: raw_json
                            .and_then(|raw| serde_json::from_str(&raw).ok())
                            .unwrap_or(serde_json::Value::Null),
                    })
                })?;
                let mut rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
                // The `album` row keeps the server's legacy `artistId`, a representative
                // performer on a compilation — resolve the link from the tracks instead.
                crate::browse_support::overlay_album_artist_links(conn, &mut rows);
                rows
            };

            let tracks = {
                let sql = format!(
                    "SELECT {} FROM track \
                     WHERE server_id = ?1 AND deleted = 0 AND starred_at IS NOT NULL \
                     ORDER BY starred_at DESC, id ASC",
                    track_columns(),
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![server_id], row_to_track_row)?;
                rows
                    .map(|row| row.map(|track| LibraryTrackDto::from_row(&track)))
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };

            Ok((albums, tracks))
        })
        .map_err(|error| error.to_string())
        ?;
    Ok(LibraryStarredResponse {
        albums,
        tracks,
        read_lock_wait_ms: timing.lock_wait_ms,
        sql_ms: timing.exec_ms,
        blocked_by: timing.blocked_by.map(|owner| format!("{}:{}", owner.file, owner.line)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

    fn track(id: &str, starred_at: Option<i64>) -> TrackRow {
        TrackRow {
            server_id: "s1".into(),
            id: id.into(),
            title: id.into(),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: Some("artist".into()),
            album: "Album".into(),
            album_id: Some("album".into()),
            album_artist: Some("Artist".into()),
            duration_sec: 1,
            track_number: None,
            disc_number: None,
            year: None,
            genre: None,
            suffix: None,
            bit_rate: None,
            size_bytes: None,
            cover_art_id: None,
            starred_at,
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

    #[test]
    fn lists_only_persisted_album_and_track_stars() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn("test", |conn| {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'album-starred', 'Starred', 20, 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO album (server_id, id, name, synced_at, raw_json) \
                     VALUES ('s1', 'album-plain', 'Plain', 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        TrackRepository::new(&store)
            .upsert_batch(&[track("track-starred", Some(10)), track("track-plain", None)])
            .unwrap();

        let response = list_starred(&store, "s1").unwrap();

        assert_eq!(response.albums.iter().map(|album| album.id.as_str()).collect::<Vec<_>>(), ["album-starred"]);
        assert_eq!(response.tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(), ["track-starred"]);
    }

    #[test]
    fn album_star_query_uses_the_partial_index() {
        let store = LibraryStore::open_in_memory();
        let plan = store
            .with_read_conn(|conn| {
                let mut stmt = conn.prepare(
                    "EXPLAIN QUERY PLAN SELECT id FROM album \
                     WHERE server_id = ?1 AND starred_at IS NOT NULL \
                     ORDER BY starred_at DESC, id ASC",
                )?;
                let rows = stmt.query_map(params!["s1"], |row| row.get::<_, String>(3))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .join(" ");

        assert!(plan.contains("idx_album_starred"), "query plan: {plan}");
    }
}

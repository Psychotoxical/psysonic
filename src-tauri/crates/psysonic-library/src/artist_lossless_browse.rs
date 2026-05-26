//! Artist discography slice — lossless albums and tracks from the local index.

use crate::dto::{
    LibraryAlbumDto, LibraryArtistLosslessBrowseRequest, LibraryArtistLosslessBrowseResponse,
    LibraryTrackDto,
};
use crate::lossless_formats::track_is_lossless_sql;
use crate::search::{aliased_track_columns, library_scope_equals_sql};
use crate::store::LibraryStore;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

pub fn get_artist_lossless_browse(
    store: &LibraryStore,
    req: &LibraryArtistLosslessBrowseRequest,
) -> Result<LibraryArtistLosslessBrowseResponse, String> {
    if !crate::dto::track_index_nonempty(store, &req.server_id)? {
        return Ok(empty_response());
    }

    let lossless_sql = track_is_lossless_sql("t");
    let mut track_where = vec![
        "t.deleted = 0".to_string(),
        "t.server_id = ?1".to_string(),
        "t.artist_id = ?2".to_string(),
        lossless_sql,
    ];
    let mut track_params: Vec<SqlValue> = vec![
        SqlValue::Text(req.server_id.clone()),
        SqlValue::Text(req.artist_id.clone()),
    ];

    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_equals_sql("t");
        track_where.push(clause);
        track_params.push(SqlValue::Text(scope));
    }

    let track_where_sql = track_where.join(" AND ");
    let track_cols = aliased_track_columns("t");
    let tracks_sql = format!(
        "SELECT {track_cols} FROM track t \
         WHERE {track_where_sql} \
         ORDER BY t.album COLLATE NOCASE ASC, \
           COALESCE(t.disc_number, 1) ASC, \
           COALESCE(t.track_number, 0) ASC, \
           t.title COLLATE NOCASE ASC"
    );

    let tracks = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&tracks_sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(track_params.iter()), |r| {
                Ok(LibraryTrackDto::from_row(&crate::repos::row_to_track_row(r)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;

    let mut album_where = vec![
        "t.deleted = 0".to_string(),
        "t.server_id = ?1".to_string(),
        "t.artist_id = ?2".to_string(),
        "t.album_id IS NOT NULL AND t.album_id != ''".to_string(),
        track_is_lossless_sql("t"),
    ];
    let mut album_params: Vec<SqlValue> = vec![
        SqlValue::Text(req.server_id.clone()),
        SqlValue::Text(req.artist_id.clone()),
    ];
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_equals_sql("t");
        album_where.push(clause);
        album_params.push(SqlValue::Text(scope));
    }
    let album_where_sql = album_where.join(" AND ");

    let albums_sql = format!(
        "SELECT \
           la.server_id, \
           la.album_id, \
           COALESCE(a.name, la.album_name), \
           COALESCE(a.artist, la.artist), \
           COALESCE(a.artist_id, la.artist_id), \
           COALESCE(a.song_count, la.track_count), \
           COALESCE(a.duration_sec, la.duration_sec), \
           COALESCE(a.year, la.year), \
           COALESCE(a.genre, la.genre), \
           COALESCE(a.cover_art_id, la.cover_art_id), \
           COALESCE(a.starred_at, la.starred_at), \
           COALESCE(a.synced_at, la.synced_at), \
           a.raw_json \
         FROM ( \
           SELECT \
             t.server_id, \
             t.album_id, \
             MAX(t.album) AS album_name, \
             MAX(t.artist) AS artist, \
             MAX(t.artist_id) AS artist_id, \
             MAX(t.year) AS year, \
             MAX(t.genre) AS genre, \
             MAX(t.cover_art_id) AS cover_art_id, \
             MAX(t.starred_at) AS starred_at, \
             MAX(t.synced_at) AS synced_at, \
             (SELECT COUNT(*) FROM track c \
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id \
                AND c.artist_id = t.artist_id AND c.deleted = 0) AS track_count, \
             (SELECT COALESCE(SUM(c.duration_sec), 0) FROM track c \
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id \
                AND c.artist_id = t.artist_id AND c.deleted = 0) AS duration_sec, \
             MAX(COALESCE(CAST(json_extract(t.raw_json, '$.bitDepth') AS INTEGER), 0)) AS max_bit_depth \
           FROM track t \
           WHERE {album_where_sql} \
           GROUP BY t.server_id, t.album_id \
         ) la \
         LEFT JOIN album a ON a.server_id = la.server_id AND a.id = la.album_id \
         ORDER BY la.max_bit_depth DESC, \
           COALESCE(a.name, la.album_name) COLLATE NOCASE ASC, \
           la.album_id ASC"
    );

    let albums = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&albums_sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(album_params.iter()), map_album_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;

    Ok(LibraryArtistLosslessBrowseResponse {
        albums,
        tracks,
        source: "local".to_string(),
    })
}

fn empty_response() -> LibraryArtistLosslessBrowseResponse {
    LibraryArtistLosslessBrowseResponse {
        albums: Vec::new(),
        tracks: Vec::new(),
        source: "local".to_string(),
    }
}

fn map_album_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
    let raw: Option<String> = r.get(12)?;
    Ok(LibraryAlbumDto {
        server_id: r.get(0)?,
        id: r.get(1)?,
        name: r.get(2)?,
        artist: r.get(3)?,
        artist_id: r.get(4)?,
        song_count: r.get(5)?,
        duration_sec: r.get(6)?,
        year: r.get(7)?,
        genre: r.get(8)?,
        cover_art_id: r.get(9)?,
        starred_at: r.get(10)?,
        synced_at: r.get(11)?,
        raw_json: raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::{TrackRepository, TrackRow};

    fn lossless_track(
        server: &str,
        id: &str,
        artist_id: &str,
        album_id: &str,
        title: &str,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: title.into(),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: Some(artist_id.into()),
            album: "Album".into(),
            album_id: Some(album_id.into()),
            album_artist: Some("Artist".into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(2020),
            genre: None,
            suffix: Some("flac".into()),
            bit_rate: Some(1000),
            size_bytes: None,
            cover_art_id: Some(album_id.into()),
            starred_at: None,
            user_rating: None,
            play_count: Some(5),
            played_at: None,
            server_path: None,
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: r#"{"bitDepth":24}"#.into(),
        }
    }

    #[test]
    fn returns_lossless_albums_and_tracks_for_artist() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                lossless_track("s1", "t1", "ar1", "al1", "One"),
                lossless_track("s1", "t2", "ar1", "al2", "Two"),
            ])
            .unwrap();
        let mut mp3 = lossless_track("s1", "t3", "ar1", "al3", "Three");
        mp3.suffix = Some("mp3".into());
        TrackRepository::new(&store).upsert_batch(&[mp3]).unwrap();

        let resp = get_artist_lossless_browse(
            &store,
            &LibraryArtistLosslessBrowseRequest {
                server_id: "s1".into(),
                artist_id: "ar1".into(),
                library_scope: None,
            },
        )
        .unwrap();

        assert_eq!(resp.albums.len(), 2);
        assert_eq!(resp.tracks.len(), 2);
    }
}

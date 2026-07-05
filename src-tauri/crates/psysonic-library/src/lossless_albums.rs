//! Lossless album browse from the local `track` index (§5.13 extension).
//!
//! Mirrors the frontend allowlist in `src/utils/library/losslessFormats.ts`.

use crate::dto::{LibraryAlbumDto, LibraryLosslessAlbumsRequest, LibraryLosslessAlbumsResponse};
use crate::lossless_formats::track_is_lossless_sql;
use crate::search::library_scope_equals_sql;
use crate::store::LibraryStore;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// Paginated lossless albums for one server. Returns empty when the index has
/// no matching tracks — caller may fall back to the Navidrome song-stream walk.
pub fn list_lossless_albums(
    store: &LibraryStore,
    req: &LibraryLosslessAlbumsRequest,
) -> Result<LibraryLosslessAlbumsResponse, String> {
    if !crate::dto::track_index_nonempty(store, &req.server_id)? {
        return Ok(empty_response());
    }

    let limit = req.limit.max(1);
    let offset = req.offset;
    let lossless_sql = track_is_lossless_sql("t");

    let mut where_clauses = vec![
        "t.deleted = 0".to_string(),
        "t.server_id = ?1".to_string(),
        "t.album_id IS NOT NULL AND t.album_id != ''".to_string(),
        lossless_sql,
    ];
    let mut params: Vec<SqlValue> = vec![SqlValue::Text(req.server_id.clone())];

    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        let clause = library_scope_equals_sql("t");
        where_clauses.push(clause);
        params.push(SqlValue::Text(scope));
    }

    let where_sql = where_clauses.join(" AND ");
    let la_artist = crate::album_compilation_filter::sql_track_group_display_artist("la");
    let sql = format!(
        "SELECT \
           la.server_id, \
           la.album_id, \
           COALESCE(a.name, la.album_name), \
           COALESCE(a.artist, {la_artist}), \
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
             MAX(t.album_artist) AS album_artist, \
             MAX(t.artist_id) AS artist_id, \
             MAX(t.year) AS year, \
             MAX(t.genre) AS genre, \
             MAX(t.cover_art_id) AS cover_art_id, \
             MAX(t.starred_at) AS starred_at, \
             MAX(t.synced_at) AS synced_at, \
             (SELECT COUNT(*) FROM track c \
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id AND c.deleted = 0) AS track_count, \
             (SELECT COALESCE(SUM(c.duration_sec), 0) FROM track c \
              WHERE c.server_id = t.server_id AND c.album_id = t.album_id AND c.deleted = 0) AS duration_sec, \
             MAX(COALESCE(CAST(json_extract(t.raw_json, '$.bitDepth') AS INTEGER), 0)) AS max_bit_depth \
           FROM track t \
           WHERE {where_sql} \
           GROUP BY t.server_id, t.album_id \
         ) la \
         LEFT JOIN album a ON a.server_id = la.server_id AND a.id = la.album_id \
         ORDER BY la.max_bit_depth DESC, \
           COALESCE(a.name, la.album_name) COLLATE NOCASE ASC, \
           la.album_id ASC \
         LIMIT ? OFFSET ?"
    );

    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    let albums = store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })?;

    let has_more = albums.len() as u32 == limit;
    Ok(LibraryLosslessAlbumsResponse {
        albums,
        has_more,
        source: "local".to_string(),
    })
}

fn empty_response() -> LibraryLosslessAlbumsResponse {
    LibraryLosslessAlbumsResponse {
        albums: Vec::new(),
        has_more: false,
        source: "local".to_string(),
    }
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LibraryAlbumDto> {
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

    fn track_with_suffix(
        server: &str,
        id: &str,
        album_id: &str,
        album: &str,
        suffix: &str,
        bit_depth: i64,
    ) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: format!("Track {id}"),
            title_sort: None,
            artist: Some("Artist".into()),
            artist_id: Some("ar1".into()),
            album: album.into(),
            album_id: Some(album_id.into()),
            album_artist: Some("Artist".into()),
            duration_sec: 200,
            track_number: Some(1),
            disc_number: Some(1),
            year: Some(2020),
            genre: Some("Rock".into()),
            suffix: Some(suffix.into()),
            bit_rate: Some(1000),
            size_bytes: None,
            cover_art_id: Some(album_id.into()),
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
            raw_json: format!(r#"{{"bitDepth":{bit_depth}}}"#),
        }
    }

    fn insert_album(store: &LibraryStore, server: &str, id: &str, name: &str) {
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, artist, song_count, duration_sec, synced_at, raw_json) \
                     VALUES (?1, ?2, ?3, 'Artist', 2, 400, 1, '{}')",
                    rusqlite::params![server, id, name],
                )
            })
            .unwrap();
    }

    fn req(server: &str, limit: u32, offset: u32) -> LibraryLosslessAlbumsRequest {
        LibraryLosslessAlbumsRequest {
            server_id: server.into(),
            library_scope: None,
            limit,
            offset,
        }
    }

    #[test]
    fn returns_albums_with_lossless_suffix_only() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_with_suffix("s1", "t1", "al_flac", "Hi-Res", "flac", 24),
                track_with_suffix("s1", "t2", "al_mp3", "Lossy", "mp3", 0),
            ])
            .unwrap();

        let resp = list_lossless_albums(&store, &req("s1", 50, 0)).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al_flac");
        assert_eq!(resp.albums[0].name, "Hi-Res");
    }

    #[test]
    fn sorts_by_bit_depth_desc_then_name() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_with_suffix("s1", "t1", "al_16", "Sixteen", "flac", 16),
                track_with_suffix("s1", "t2", "al_24", "Twenty-Four", "flac", 24),
            ])
            .unwrap();

        let resp = list_lossless_albums(&store, &req("s1", 50, 0)).unwrap();
        assert_eq!(resp.albums.len(), 2);
        assert_eq!(resp.albums[0].id, "al_24");
        assert_eq!(resp.albums[1].id, "al_16");
    }

    #[test]
    fn prefers_album_table_metadata_when_present() {
        let store = LibraryStore::open_in_memory();
        insert_album(&store, "s1", "al1", "Album Table Name");
        TrackRepository::new(&store)
            .upsert_batch(&[track_with_suffix("s1", "t1", "al1", "Track Title", "flac", 16)])
            .unwrap();

        let resp = list_lossless_albums(&store, &req("s1", 50, 0)).unwrap();
        assert_eq!(resp.albums[0].name, "Album Table Name");
        assert_eq!(resp.albums[0].song_count, Some(2));
    }

    #[test]
    fn library_scope_narrows_results() {
        let store = LibraryStore::open_in_memory();
        let mut a = track_with_suffix("s1", "t1", "al1", "A", "flac", 16);
        a.library_id = Some("lib1".into());
        let mut b = track_with_suffix("s1", "t2", "al2", "B", "flac", 16);
        b.library_id = Some("lib2".into());
        TrackRepository::new(&store)
            .upsert_batch(&[a, b])
            .unwrap();

        let mut scoped = req("s1", 50, 0);
        scoped.library_scope = Some("lib1".into());
        let resp = list_lossless_albums(&store, &scoped).unwrap();
        assert_eq!(resp.albums.len(), 1);
        assert_eq!(resp.albums[0].id, "al1");
    }

    #[test]
    fn pagination_sets_has_more() {
        let store = LibraryStore::open_in_memory();
        TrackRepository::new(&store)
            .upsert_batch(&[
                track_with_suffix("s1", "t1", "al1", "A", "flac", 16),
                track_with_suffix("s1", "t2", "al2", "B", "flac", 16),
                track_with_suffix("s1", "t3", "al3", "C", "flac", 16),
            ])
            .unwrap();

        let page1 = list_lossless_albums(&store, &req("s1", 2, 0)).unwrap();
        assert_eq!(page1.albums.len(), 2);
        assert!(page1.has_more);

        let page2 = list_lossless_albums(&store, &req("s1", 2, 2)).unwrap();
        assert_eq!(page2.albums.len(), 1);
        assert!(!page2.has_more);
    }
}

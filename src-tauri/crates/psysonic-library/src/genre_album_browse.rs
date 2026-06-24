//! Paginated genre → album browse from the local `track` index.
//!
//! Uses the same subquery shape as lossless album browse (single SQL round-trip,
//! LIMIT/OFFSET on grouped rows) instead of the heavier Advanced Search builder.

use crate::dto::{
    LibraryAlbumDto, LibraryGenreAlbumsRequest, LibraryGenreAlbumsResponse, LibrarySortClause,
    SortDir,
};
use crate::search::library_scope_equals_sql;
use crate::store::LibraryStore;
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

fn trimmed_nonempty(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn genre_album_order_sql(sort: &[LibrarySortClause]) -> String {
    let la_artist = crate::album_compilation_filter::sql_track_group_display_artist("la");
    let mut keys: Vec<String> = Vec::new();
    for s in sort {
        let col = match s.field.as_str() {
            "name" => "COALESCE(a.name, la.album_name) COLLATE NOCASE".to_string(),
            "artist" => format!("COALESCE(a.artist, {la_artist}) COLLATE NOCASE"),
            "year" => "COALESCE(a.year, la.year)".to_string(),
            _ => continue,
        };
        let dir = match s.dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        keys.push(format!("{col} {dir}", col = col));
    }
    if keys.is_empty() {
        keys.push("COALESCE(a.name, la.album_name) COLLATE NOCASE ASC".to_string());
    }
    keys.push("la.album_id ASC".to_string());
    format!("ORDER BY {}", keys.join(", "))
}

fn count_genre_albums(
    conn: &rusqlite::Connection,
    where_sql: &str,
    params: &[SqlValue],
    _library_scoped: bool,
) -> Result<u32, rusqlite::Error> {
    let from = "FROM track_genre tg \
         INNER JOIN track t \
           ON t.server_id = tg.server_id AND t.id = tg.track_id AND t.deleted = 0";
    let count_sql = format!("SELECT COUNT(DISTINCT tg.album_id) {from} WHERE {where_sql}");
    let n: i64 = conn.query_row(
        &count_sql,
        rusqlite::params_from_iter(params.iter()),
        |r| r.get(0),
    )?;
    Ok(n.max(0) as u32)
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
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null),
    })
}

/// Paginated albums for one genre. Returns empty when the index has no matching tracks.
pub fn list_albums_by_genre(
    store: &LibraryStore,
    req: &LibraryGenreAlbumsRequest,
) -> Result<LibraryGenreAlbumsResponse, String> {
    if !crate::dto::track_index_nonempty(store, &req.server_id)? {
        return Ok(LibraryGenreAlbumsResponse {
            albums: Vec::new(),
            has_more: false,
            total: None,
            source: "local".to_string(),
        });
    }

    let genre = req.genre.trim();
    if genre.is_empty() {
        return Ok(LibraryGenreAlbumsResponse {
            albums: Vec::new(),
            has_more: false,
            total: None,
            source: "local".to_string(),
        });
    }

    let limit = req.limit.max(1);
    let offset = req.offset;
    let order_sql = genre_album_order_sql(&req.sort);

    let mut where_clauses = vec![
        "tg.server_id = ?1".to_string(),
        "tg.album_id IS NOT NULL AND tg.album_id != ''".to_string(),
        "tg.genre = ?2 COLLATE NOCASE".to_string(),
    ];
    let mut params: Vec<SqlValue> = vec![
        SqlValue::Text(req.server_id.clone()),
        SqlValue::Text(genre.to_string()),
    ];

    let library_scoped = trimmed_nonempty(req.library_scope.as_deref()).is_some();
    if let Some(scope) = trimmed_nonempty(req.library_scope.as_deref()) {
        where_clauses.push(library_scope_equals_sql("t"));
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
             tg.server_id, \
             tg.album_id, \
             MAX(t.album) AS album_name, \
             MAX(t.artist) AS artist, \
             MAX(t.album_artist) AS album_artist, \
             MAX(t.artist_id) AS artist_id, \
             MAX(t.year) AS year, \
             MAX(t.genre) AS genre, \
             MAX(t.cover_art_id) AS cover_art_id, \
             MAX(t.starred_at) AS starred_at, \
             MAX(t.synced_at) AS synced_at, \
             COUNT(*) AS track_count, \
             COALESCE(SUM(t.duration_sec), 0) AS duration_sec \
           FROM track_genre tg \
           INNER JOIN track t \
             ON t.server_id = tg.server_id AND t.id = tg.track_id AND t.deleted = 0 \
           WHERE {where_sql} \
           GROUP BY tg.server_id, tg.album_id \
         ) la \
         LEFT JOIN album a ON a.server_id = la.server_id AND a.id = la.album_id \
         {order_sql} \
         LIMIT ? OFFSET ?"
    );

    let count_params = params.clone();
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));

    store.with_read_conn(|conn| {
        let total = if req.include_total {
            Some(count_genre_albums(conn, &where_sql, &count_params, library_scoped)?)
        } else {
            None
        };

        let mut stmt = conn.prepare(&sql)?;
        let albums = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = albums.len() as u32 == limit;
        Ok(LibraryGenreAlbumsResponse {
            albums,
            has_more,
            total,
            source: "local".to_string(),
        })
    })
}

#[cfg(test)]
mod tests {
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
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
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
                sort: vec![LibrarySortClause {
                    field: "name".into(),
                    dir: SortDir::Asc,
                }],
                limit: 10,
                offset: 0,
                include_total: true,
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
                sort: vec![],
                limit: 1,
                offset: 0,
                include_total: true,
            },
        )
        .unwrap();
        assert_eq!(all.total, Some(3));
        assert!(all.has_more);
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
                sort: vec![],
                limit: 10,
                offset: 0,
                include_total: true,
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
                sort: vec![],
                limit: 10,
                offset: 0,
                include_total: true,
            },
        )
        .unwrap();
        assert_eq!(noise.total, Some(1));
    }
}

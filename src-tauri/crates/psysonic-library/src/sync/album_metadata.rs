//! Persist album-level favorite metadata from `#getAlbum` (`starred_at`).
//!
//! Album user ratings are not stored locally — detail pages reconcile them
//! from the server on visit. Track ingest still mirrors per-song fields.

use psysonic_integration::subsonic::Album;
use rusqlite::params;
use serde_json::Value;

use super::error::SyncError;
use super::mapping::parse_iso_ms_str;
use crate::store::LibraryStore;

fn album_starred_at_from_raw(raw_album: &Value) -> Option<Option<i64>> {
    let starred = raw_album.get("starred")?;
    Some(starred.as_str().and_then(parse_iso_ms_str))
}

/// Upsert `album` row metadata from a `#getAlbum` response. When `starred` is
/// present in `raw_album`, it overwrites `album.starred_at`; omitted keys are
/// left untouched on conflict.
pub(crate) fn upsert_album_from_get_album(
    store: &LibraryStore,
    server_id: &str,
    album: &Album,
    raw_album: &Value,
    synced_at: i64,
) -> Result<(), SyncError> {
    let starred_at = album_starred_at_from_raw(raw_album);
    let starred_flag = i64::from(starred_at.is_some());
    let raw_json = raw_album.to_string();
    let song_count = album
        .song_count
        .or(Some(album.song.len() as i64));
    store
        .with_conn_mut("sync.upsert_album_metadata", |conn| {
            conn.execute(
                "INSERT INTO album (
                   server_id, id, name, artist, artist_id, song_count, duration_sec,
                   year, genre, cover_art_id, starred_at, synced_at, raw_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(server_id, id) DO UPDATE SET
                   name = excluded.name,
                   artist = COALESCE(excluded.artist, album.artist),
                   artist_id = COALESCE(excluded.artist_id, album.artist_id),
                   song_count = COALESCE(excluded.song_count, album.song_count),
                   duration_sec = COALESCE(excluded.duration_sec, album.duration_sec),
                   year = COALESCE(excluded.year, album.year),
                   genre = COALESCE(excluded.genre, album.genre),
                   cover_art_id = COALESCE(excluded.cover_art_id, album.cover_art_id),
                   synced_at = excluded.synced_at,
                   raw_json = excluded.raw_json,
                   starred_at = CASE WHEN ?14 = 1 THEN excluded.starred_at ELSE album.starred_at END",
                params![
                    server_id,
                    album.id,
                    album.name,
                    album.artist,
                    album.artist_id,
                    song_count,
                    album.duration,
                    album.year,
                    album.genre,
                    album.cover_art,
                    starred_at.flatten(),
                    synced_at,
                    raw_json,
                    starred_flag,
                ],
            )?;
            Ok(())
        })
        .map_err(SyncError::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;
    use psysonic_integration::subsonic::Album;

    #[test]
    fn upsert_overwrites_stale_starred_at_when_server_payload_has_starred() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("seed", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Old', NULL, 1, '{}')",
                    [],
                )
            })
            .unwrap();
        let album = Album {
            id: "al1".into(),
            name: "Album".into(),
            artist: None,
            artist_id: None,
            song_count: None,
            duration: None,
            year: None,
            genre: None,
            cover_art: None,
            song: vec![],
        };
        let raw = serde_json::json!({
            "id": "al1",
            "name": "Album",
            "starred": "2024-01-01T00:00:00Z"
        });
        upsert_album_from_get_album(&store, "s1", &album, &raw, 2).unwrap();
        let starred: Option<i64> = store
            .with_conn("read", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(starred.is_some());
    }
}

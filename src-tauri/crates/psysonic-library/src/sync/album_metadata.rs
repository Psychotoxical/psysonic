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
/// present in `raw_album`, it overwrites `album.starred_at`.
///
/// `name`, `artist` and `artist_id` follow `getAlbum` authoritatively — they are
/// overwritten even when the response omits them (writes NULL), so a server-side
/// artist rename heals on resync instead of the old id sticking via `COALESCE`
/// and leaving the album-artist link dead-ending at "Artist not found". Other
/// nullable columns keep their prior value when the response omits them.
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
    let transition = store
        .with_conn_mut("sync.upsert_album_metadata", |conn| {
            let tx = conn.transaction()?;
            let identity_guard =
                crate::navidrome_identity::load_deterministic_write_guard(&tx, server_id)?;
            if let Some(old_id) =
                crate::navidrome_identity::find_deterministic_legacy_id_with_guard(
                    &tx,
                    server_id,
                    &identity_guard,
                    crate::navidrome_identity::EntityKind::Album,
                    &album.id,
                )?
            {
                crate::navidrome_identity::record_deterministic_transition_if_legacy_state(
                    &tx,
                    server_id,
                    "album",
                    &old_id,
                    &album.id,
                )?;
                tx.commit()?;
                return Ok(Some(old_id));
            }
            crate::navidrome_identity::register_inactive_legacy_aliases(
                &tx,
                server_id,
                &identity_guard,
                std::iter::once((
                    crate::navidrome_identity::EntityKind::Album,
                    album.id.as_str(),
                ))
                .chain(album.artist_id.as_deref().map(|id| {
                    (crate::navidrome_identity::EntityKind::Artist, id)
                })),
                synced_at,
            )?;
            tx.execute(
                "INSERT INTO album (
                   server_id, id, name, artist, artist_id, song_count, duration_sec,
                   year, genre, cover_art_id, starred_at, synced_at, raw_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(server_id, id) DO UPDATE SET
                   name = excluded.name,
                   artist = excluded.artist,
                   artist_id = excluded.artist_id,
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
            tx.commit()?;
            Ok(None)
        })
        .map_err(SyncError::Storage)?;
    if let Some(old_id) = transition {
        return Err(SyncError::IdentityTransition(format!(
            "server `{server_id}` changed album id `{old_id}` to canonical id `{}`; migration required",
            album.id
        )));
    }
    Ok(())
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

    fn album_artist(store: &LibraryStore) -> (Option<String>, Option<String>) {
        store
            .with_conn("read", |c| {
                c.query_row(
                    "SELECT artist, artist_id FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    }

    fn seed_album_with_artist(store: &LibraryStore, artist: &str, artist_id: &str) {
        store
            .with_conn_mut("seed", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, artist, artist_id, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', ?1, ?2, 1, '{}')",
                    params![artist, artist_id],
                )
            })
            .unwrap();
    }

    fn get_album_with_artist(artist: Option<&str>, artist_id: Option<&str>) -> Album {
        Album {
            id: "al1".into(),
            name: "Album".into(),
            artist: artist.map(str::to_string),
            artist_id: artist_id.map(str::to_string),
            song_count: None,
            duration: None,
            year: None,
            genre: None,
            cover_art: None,
            song: vec![],
        }
    }

    // A server-side artist rename mints a new artist id; the fresh getAlbum must
    // overwrite the album's stale artist ref so the card link stops dead-ending
    // at "Artist not found" (previously COALESCE kept the pre-rename id).
    #[test]
    fn upsert_refreshes_album_artist_ref_on_rename() {
        let store = LibraryStore::open_in_memory();
        seed_album_with_artist(&store, "Old Name", "ar_old");
        let album = get_album_with_artist(Some("New Name"), Some("ar_new"));
        let raw = serde_json::json!({ "id": "al1", "name": "Album" });

        upsert_album_from_get_album(&store, "s1", &album, &raw, 2).unwrap();

        let (artist, artist_id) = album_artist(&store);
        assert_eq!(artist.as_deref(), Some("New Name"));
        assert_eq!(artist_id.as_deref(), Some("ar_new"));
    }

    // When the server no longer exposes an album-level artist id (e.g. only the
    // structured `artists[]` in raw_json), the stale column value must not stick.
    #[test]
    fn upsert_clears_stale_album_artist_id_when_server_drops_it() {
        let store = LibraryStore::open_in_memory();
        seed_album_with_artist(&store, "Old", "ar_old");
        let album = get_album_with_artist(None, None);
        let raw = serde_json::json!({ "id": "al1", "name": "Album" });

        upsert_album_from_get_album(&store, "s1", &album, &raw, 2).unwrap();

        let (_, artist_id) = album_artist(&store);
        assert!(
            artist_id.is_none(),
            "stale artist_id must not persist when getAlbum omits it"
        );
    }

    #[test]
    fn canonical_album_transition_is_recorded_before_insert() {
        let store = LibraryStore::open_in_memory();
        let old = "11112222333344445555666677778888";
        let new = crate::navidrome_identity::canonical_id(old);
        store
            .with_conn_mut("test.seed_legacy_album_state", |conn| {
                conn.execute(
                    "INSERT INTO album(server_id,id,name,synced_at,raw_json) \
                     VALUES ('s1',?1,'Legacy',1,'{}')",
                    params![old],
                )?;
                conn.execute(
                    "INSERT INTO server_identity_transition \
                     (server_id, canonical_version, state, detected_at) \
                     VALUES ('s1',?1,'legacy',1)",
                    params![crate::navidrome_identity::CANONICAL_ID_VERSION],
                )?;
                Ok(())
            })
            .unwrap();
        let album = Album {
            id: new.clone(),
            name: "Canonical".into(),
            artist: None,
            artist_id: None,
            song_count: Some(0),
            duration: None,
            year: None,
            genre: None,
            cover_art: None,
            song: vec![],
        };

        let error = upsert_album_from_get_album(
            &store,
            "s1",
            &album,
            &serde_json::json!({ "id": new, "name": "Canonical" }),
            2,
        )
        .unwrap_err();

        assert!(matches!(error, SyncError::IdentityTransition(_)));
        store
            .with_read_conn(|conn| {
                let canonical_exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM album WHERE server_id = 's1' AND id = ?1)",
                    params![new],
                    |row| row.get(0),
                )?;
                assert!(!canonical_exists);
                let remap: (String, i64) = conn.query_row(
                    "SELECT new_id, active FROM entity_id_remap \
                     WHERE server_id = 's1' AND entity_kind = 'album' AND old_id = ?1",
                    params![old],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(remap, (new.clone(), 0));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn unrelated_album_id_change_is_not_treated_as_canonical_transition() {
        let store = LibraryStore::open_in_memory();
        seed_album_with_artist(&store, "Artist", "ar_old");
        store
            .with_conn_mut("test.seed_legacy_state", |conn| {
                conn.execute(
                    "INSERT INTO server_identity_transition \
                     (server_id, canonical_version, state, detected_at) \
                     VALUES ('s1',?1,'legacy',1)",
                    params![crate::navidrome_identity::CANONICAL_ID_VERSION],
                )?;
                Ok(())
            })
            .unwrap();
        let album = Album {
            id: "al-unrelated".into(),
            name: "Unrelated".into(),
            artist: None,
            artist_id: None,
            song_count: Some(0),
            duration: None,
            year: None,
            genre: None,
            cover_art: None,
            song: vec![],
        };

        upsert_album_from_get_album(
            &store,
            "s1",
            &album,
            &serde_json::json!({ "id": "al-unrelated", "name": "Unrelated" }),
            2,
        )
        .unwrap();

        let exists = store
            .with_read_conn(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM album WHERE server_id = 's1' AND id = 'al-unrelated')",
                    [],
                    |row| row.get::<_, bool>(0),
                )
            })
            .unwrap();
        assert!(exists);
    }
}

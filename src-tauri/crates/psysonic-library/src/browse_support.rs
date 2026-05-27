//! Album browse helpers: favorites reconcile and catalog year bounds.

use rusqlite::params;
use tauri::State;

use crate::dto::CatalogYearBoundsDto;
use crate::runtime::LibraryRuntime;
use crate::store::LibraryStore;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarredAlbumReconcileItem {
    pub id: String,
    pub starred_at: i64,
}

/// Align `album.starred_at` with server favorites: UPDATE existing rows only
/// (no INSERT / stub rows). Clears local stars absent from `starred_albums`.
#[tauri::command]
pub fn library_reconcile_album_stars(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    starred_albums: Vec<StarredAlbumReconcileItem>,
) -> Result<(), String> {
    reconcile_album_stars(&runtime, &server_id, &starred_albums)
}

pub(crate) fn reconcile_album_stars(
    runtime: &LibraryRuntime,
    server_id: &str,
    starred: &[StarredAlbumReconcileItem],
) -> Result<(), String> {
    runtime
        .store
        .with_conn("misc", |conn| {
            if starred.is_empty() {
                conn.execute(
                    "UPDATE album SET starred_at = NULL \
                     WHERE server_id = ?1 AND starred_at IS NOT NULL",
                    params![server_id],
                )?;
                return Ok(());
            }
            let placeholders = std::iter::repeat_n("?", starred.len())
                .collect::<Vec<_>>()
                .join(", ");
            let clear_sql = format!(
                "UPDATE album SET starred_at = NULL \
                 WHERE server_id = ?1 AND starred_at IS NOT NULL \
                   AND id NOT IN ({placeholders})"
            );
            let mut clear_params: Vec<rusqlite::types::Value> =
                vec![rusqlite::types::Value::Text(server_id.to_string())];
            for item in starred {
                clear_params.push(rusqlite::types::Value::Text(item.id.clone()));
            }
            conn.execute(
                &clear_sql,
                rusqlite::params_from_iter(clear_params.iter()),
            )?;
            for item in starred {
                conn.execute(
                    "UPDATE album SET starred_at = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, item.id, item.starred_at],
                )?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
}

pub(crate) fn catalog_year_bounds_for_server(
    store: &LibraryStore,
    server_id: &str,
) -> Result<CatalogYearBoundsDto, String> {
    store
        .with_read_conn(|conn| {
            let min_year: Option<i64> = conn.query_row(
                "SELECT MIN(year) FROM track \
                 WHERE server_id = ?1 AND deleted = 0 AND year IS NOT NULL AND year > 0",
                params![server_id],
                |r| r.get(0),
            )?;
            let max_year: Option<i64> = conn.query_row(
                "SELECT MAX(year) FROM track \
                 WHERE server_id = ?1 AND deleted = 0 AND year IS NOT NULL AND year > 0",
                params![server_id],
                |r| r.get(0),
            )?;
            let min_year = min_year.map(|y| y as i32);
            let max_year = max_year.map(|y| y as i32);
            Ok(CatalogYearBoundsDto { min_year, max_year })
        })
        .map_err(|e| e.to_string())
}

/// Min/max album years from the local track catalog (for Albums browse filter spinners).
#[tauri::command]
pub fn library_get_catalog_year_bounds(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<CatalogYearBoundsDto, String> {
    catalog_year_bounds_for_server(&runtime.store, &server_id)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::repos::TrackRepository;
    use crate::runtime::LibraryRuntime;
    use crate::store::LibraryStore;

    use super::{catalog_year_bounds_for_server, reconcile_album_stars, StarredAlbumReconcileItem};

    fn make_row(server: &str, id: &str, album_id: &str, track: i64) -> crate::repos::TrackRow {
        crate::repos::TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: format!("T{id}"),
            title_sort: None,
            artist: Some("A".into()),
            artist_id: Some("ar".into()),
            album: album_id.into(),
            album_id: Some(album_id.into()),
            album_artist: None,
            duration_sec: 200,
            track_number: Some(track),
            disc_number: Some(1),
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
            content_hash: None,
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    fn runtime(store: Arc<LibraryStore>) -> LibraryRuntime {
        LibraryRuntime::new(store)
    }

    #[test]
    fn reconcile_album_stars_clears_stale_and_sets_existing_rows() {
        let store = Arc::new(LibraryStore::open_in_memory());
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al_old', 'Old', 1, 1, '{}'), \
                            ('s1', 'al_keep', 'Keep', 1, 1, '{}'), \
                            ('s1', 'al_new', 'New', NULL, 1, '{}')",
                    [],
                )
            })
            .unwrap();
        let rt = runtime(store.clone());
        reconcile_album_stars(
            &rt,
            "s1",
            &[StarredAlbumReconcileItem {
                id: "al_keep".into(),
                starred_at: 99,
            }],
        )
        .unwrap();
        let old: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al_old'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let keep: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al_keep'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let new: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al_new'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(old.is_none());
        assert_eq!(keep, Some(99));
        assert!(new.is_none());
    }

    #[test]
    fn catalog_year_bounds_from_indexed_tracks() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut old = make_row("s1", "t1", "al1", 1);
        old.year = Some(1985);
        let mut recent = make_row("s1", "t2", "al2", 1);
        recent.year = Some(2018);
        TrackRepository::new(&store)
            .upsert_batch(&[old, recent])
            .unwrap();
        let bounds = catalog_year_bounds_for_server(&store, "s1").unwrap();
        assert_eq!(bounds.min_year, Some(1985));
        assert_eq!(bounds.max_year, Some(2018));
    }

    #[test]
    fn reconcile_album_stars_clears_all_when_server_list_empty() {
        let store = Arc::new(LibraryStore::open_in_memory());
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'A', 5, 1, '{}')",
                    [],
                )
            })
            .unwrap();
        let rt = runtime(store.clone());
        reconcile_album_stars(&rt, "s1", &[]).unwrap();
        let starred_at: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(starred_at.is_none());
    }
}

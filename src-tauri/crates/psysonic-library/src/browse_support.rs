//! Album browse helpers: favorites reconcile and catalog year bounds.

use rusqlite::params;
use tauri::State;

use crate::dto::CatalogYearBoundsDto;
use crate::dto::GenreAlbumCountDto;
use crate::runtime::LibraryRuntime;
use crate::search::library_scope_equals_sql;
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
        .with_conn("browse.reconcile_album_stars", |conn| {
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

pub(crate) fn genre_album_counts_for_server(
    store: &LibraryStore,
    server_id: &str,
    library_scope: Option<&str>,
) -> Result<Vec<GenreAlbumCountDto>, String> {
    store
        .with_read_conn(|conn| {
            let mut sql = String::from(
                "SELECT tg.genre, COUNT(DISTINCT tg.album_id) AS album_count, \
                        COUNT(DISTINCT tg.track_id) AS song_count \
                 FROM track_genre tg \
                 INNER JOIN track t \
                   ON t.server_id = tg.server_id AND t.id = tg.track_id AND t.deleted = 0 \
                 WHERE tg.server_id = ?1 \
                   AND tg.album_id IS NOT NULL AND tg.album_id != ''",
            );
            let mut params: Vec<rusqlite::types::Value> =
                vec![rusqlite::types::Value::Text(server_id.to_string())];
            if let Some(scope) = library_scope.filter(|s| !s.trim().is_empty()) {
                sql.push_str(&format!(" AND {}", library_scope_equals_sql("t")));
                params.push(rusqlite::types::Value::Text(scope.to_string()));
            }
            sql.push_str(
                " GROUP BY tg.genre COLLATE NOCASE \
                 HAVING album_count > 0 \
                 ORDER BY album_count DESC, tg.genre COLLATE NOCASE ASC",
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                    Ok(GenreAlbumCountDto {
                        value: r.get::<_, String>(0)?,
                        album_count: r.get::<_, i64>(1)?.max(0) as u32,
                        song_count: r.get::<_, i64>(2)?.max(0) as u32,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .map_err(|e| e.to_string())
}

/// Distinct album counts per track genre — same grouping as genre album browse.
#[tauri::command]
pub fn library_get_genre_album_counts(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    library_scope: Option<String>,
) -> Result<Vec<GenreAlbumCountDto>, String> {
    genre_album_counts_for_server(
        &runtime.store,
        &server_id,
        library_scope.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::repos::TrackRepository;
    use crate::runtime::LibraryRuntime;
    use crate::store::LibraryStore;

    use super::{
        catalog_year_bounds_for_server, genre_album_counts_for_server, reconcile_album_stars,
        StarredAlbumReconcileItem,
    };

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
    fn genre_album_counts_group_distinct_albums_per_genre() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut rock_one: Vec<_> = (0..3)
            .map(|i| {
                let mut t = make_row("s1", &format!("r{i}"), "al_rock_one", i + 1);
                t.genre = Some("Rock".into());
                t
            })
            .collect();
        let mut rock_two = make_row("s1", "r3", "al_rock_two", 1);
        rock_two.genre = Some("Rock".into());
        let mut jazz = make_row("s1", "j1", "al_jazz", 1);
        jazz.genre = Some("Jazz".into());
        rock_one.push(rock_two);
        rock_one.push(jazz);
        TrackRepository::new(&store)
            .upsert_batch(&rock_one)
            .unwrap();

        let counts = genre_album_counts_for_server(&store, "s1", None).unwrap();
        assert_eq!(counts.len(), 2);
        assert_eq!(counts[0].value, "Rock");
        assert_eq!(counts[0].album_count, 2);
        assert_eq!(counts[0].song_count, 4);
        assert_eq!(counts[1].value, "Jazz");
        assert_eq!(counts[1].album_count, 1);
        assert_eq!(counts[1].song_count, 1);
    }

    #[test]
    fn genre_album_counts_respect_library_scope() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut scoped = make_row("s1", "r1", "al_a", 1);
        scoped.genre = Some("Rock".into());
        scoped.library_id = Some("lib1".into());
        let mut other = make_row("s1", "r2", "al_b", 1);
        other.genre = Some("Rock".into());
        other.library_id = Some("lib2".into());
        TrackRepository::new(&store)
            .upsert_batch(&[scoped, other])
            .unwrap();

        let counts = genre_album_counts_for_server(&store, "s1", Some("lib1")).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].value, "Rock");
        assert_eq!(counts[0].album_count, 1);
        assert_eq!(counts[0].song_count, 1);
    }

    #[test]
    fn genre_album_counts_scope_reads_library_id_from_track_raw_json() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut scoped = make_row("s1", "r1", "al_a", 1);
        scoped.genre = Some("Rock".into());
        scoped.library_id = None;
        scoped.raw_json = r#"{"libraryId":"lib1"}"#.into();
        let mut other = make_row("s1", "r2", "al_b", 1);
        other.genre = Some("Rock".into());
        other.library_id = None;
        other.raw_json = r#"{"libraryId":"lib2"}"#.into();
        TrackRepository::new(&store)
            .upsert_batch(&[scoped, other])
            .unwrap();

        let counts = genre_album_counts_for_server(&store, "s1", Some("lib1")).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].album_count, 1);
    }

    #[test]
    fn genre_album_counts_drop_genre_after_track_retag() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut track = make_row("s1", "t1", "al1", 1);
        track.genre = Some("ruspop".into());
        TrackRepository::new(&store)
            .upsert_batch(&[track.clone()])
            .unwrap();
        let counts = genre_album_counts_for_server(&store, "s1", None).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].value, "ruspop");

        track.genre = Some("Pop".into());
        TrackRepository::new(&store).upsert_batch(&[track]).unwrap();
        let counts = genre_album_counts_for_server(&store, "s1", None).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].value, "Pop");
    }

    #[test]
    fn genre_album_counts_ignore_orphan_track_genre_rows() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut live = make_row("s1", "live", "al1", 1);
        live.genre = Some("Rock".into());
        let mut stale = make_row("s1", "gone", "al_stale", 1);
        stale.genre = Some("ruspop".into());
        TrackRepository::new(&store)
            .upsert_batch(&[live, stale])
            .unwrap();
        store
            .with_conn("test", |conn| {
                conn.execute(
                    "UPDATE track SET deleted = 1 WHERE server_id = 's1' AND id = 'gone'",
                    [],
                )
            })
            .unwrap();

        let counts = genre_album_counts_for_server(&store, "s1", None).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].value, "Rock");
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

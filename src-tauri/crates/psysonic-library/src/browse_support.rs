//! Album browse helpers: favorites reconcile and catalog year bounds.

use rusqlite::{params, OptionalExtension};
use serde_json::{Map, Value};
use tauri::State;

use crate::dto::CatalogYearBoundsDto;
use crate::dto::GenreAlbumCountDto;
use crate::dto::LibraryAlbumDto;
use crate::runtime::LibraryRuntime;
use crate::store::LibraryStore;
use crate::sync::mapping::format_iso_ms_z;
use crate::search::{
    library_scope_in_sql, library_scope_sargable_equals_sql, normalized_library_scopes,
    push_library_scope_binds,
};

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StarredAlbumReconcileItem {
    pub id: String,
    pub starred_at: i64,
}

/// Align `album.starred_at` with server favorites: UPDATE existing rows only
/// (no INSERT / stub rows). Clears local stars absent from `starred_albums`.
#[tauri::command]
#[specta::specta]
pub fn library_reconcile_album_stars(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    starred_albums: Vec<StarredAlbumReconcileItem>,
) -> Result<(), String> {
    reconcile_album_stars(&runtime, &server_id, &starred_albums)
}

/// Read album-level favorite timestamp (`album.starred_at`), not track stars.
pub(crate) fn read_album_starred_at(
    conn: &rusqlite::Connection,
    server_id: &str,
    album_id: &str,
) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT starred_at FROM album WHERE server_id = ?1 AND id = ?2",
        params![server_id, album_id],
        |r| r.get(0),
    )
    .optional()
    .map(|row| row.flatten())
}

/// Replace track-aggregated stars with `album.starred_at` per row (multi-server safe).
pub(crate) fn overlay_album_starred_at_rows(
    conn: &rusqlite::Connection,
    albums: &mut [LibraryAlbumDto],
) {
    for album in albums.iter_mut() {
        album.starred_at =
            read_album_starred_at(conn, &album.server_id, &album.id).unwrap_or(None);
    }
}

/// Album browse/detail: `starred_at` reflects album favorites only (`album.starred_at`).
pub(crate) fn overlay_album_level_starred_at(
    store: &LibraryStore,
    server_id: &str,
    albums: &mut [LibraryAlbumDto],
) -> Result<(), String> {
    if albums.is_empty() {
        return Ok(());
    }
    store
        .with_read_conn(|conn| {
            for album in albums.iter_mut() {
                album.starred_at =
                    read_album_starred_at(conn, server_id, &album.id).unwrap_or(None);
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
}

/// Patch-on-use for album favorites — mirrors `apply_track_patch` (UPDATE only).
pub(crate) fn apply_album_patch(
    runtime: &LibraryRuntime,
    server_id: &str,
    album_id: &str,
    patch: &Value,
) -> Result<(), String> {
    let starred_at = patch.get("starredAt").map(|v| v.as_i64());
    runtime
        .store
        .with_conn("browse.patch_album", |conn| {
            if let Some(v) = starred_at {
                conn.execute(
                    "UPDATE album SET starred_at = ?3 \
                     WHERE server_id = ?1 AND id = ?2",
                    params![server_id, album_id, v],
                )?;
                sync_album_raw_json_starred(conn, server_id, album_id, v)?;
            }
            Ok(())
        })
        .map_err(|e| e.to_string())
}

fn sync_album_raw_json_starred(
    conn: &rusqlite::Connection,
    server_id: &str,
    album_id: &str,
    starred_at: Option<i64>,
) -> rusqlite::Result<()> {
    let raw_str: Option<String> = conn
        .query_row(
            "SELECT raw_json FROM album WHERE server_id = ?1 AND id = ?2",
            params![server_id, album_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let mut raw = raw_str
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let Value::Object(ref mut map) = raw else {
        return Ok(());
    };
    match starred_at {
        None => {
            map.remove("starred");
        }
        Some(ms) => {
            if let Some(iso) = format_iso_ms_z(ms) {
                map.insert("starred".into(), Value::String(iso));
            }
        }
    }
    conn.execute(
        "UPDATE album SET raw_json = ?3 WHERE server_id = ?1 AND id = ?2",
        params![server_id, album_id, raw.to_string()],
    )?;
    Ok(())
}

// NOT specta-collected: serde_json::Value patch arg (same as library_patch_track).
#[tauri::command]
pub fn library_patch_album(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    album_id: String,
    patch: Value,
) -> Result<(), String> {
    apply_album_patch(&runtime, &server_id, &album_id, &patch)
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
#[specta::specta]
pub fn library_get_catalog_year_bounds(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
) -> Result<CatalogYearBoundsDto, String> {
    let trace = psysonic_core::logging::should_log_albums_browse_trace();
    let t0 = std::time::Instant::now();
    let result = catalog_year_bounds_for_server(&runtime.store, &server_id);
    if trace {
        let step_ms = t0.elapsed().as_millis();
        let (min_year, max_year) = result
            .as_ref()
            .map(|b| (b.min_year, b.max_year))
            .unwrap_or((None, None));
        crate::app_deprintln!(
            "[frontend][albums-browse] {}",
            serde_json::json!({
                "step": "rust_catalog_year_bounds",
                "elapsedMs": 0,
                "details": {
                    "stepMs": step_ms,
                    "serverId": server_id,
                    "minYear": min_year,
                    "maxYear": max_year,
                    "ok": result.is_ok(),
                }
            })
        );
    }
    result
}

pub(crate) fn genre_album_counts_for_server(
    store: &LibraryStore,
    server_id: &str,
    library_scopes: &[String],
) -> Result<Vec<GenreAlbumCountDto>, String> {
    let scopes = normalized_library_scopes(library_scopes);
    store
        .with_read_conn(|conn| {
            let mut sql = String::from(
                "SELECT tg.genre, COUNT(DISTINCT tg.album_id) AS album_count, \
                        COUNT(DISTINCT tg.track_id) AS song_count \
                 FROM track t \
                 INNER JOIN track_genre tg \
                   ON tg.server_id = t.server_id AND tg.track_id = t.id \
                 WHERE t.server_id = ?1 \
                   AND t.deleted = 0 \
                   AND tg.album_id IS NOT NULL AND tg.album_id != ''",
            );
            let mut params: Vec<rusqlite::types::Value> =
                vec![rusqlite::types::Value::Text(server_id.to_string())];
            if scopes.len() == 1 {
                sql.push_str(&format!(" AND {}", library_scope_sargable_equals_sql("t")));
                push_library_scope_binds(&mut params, &scopes);
            } else if scopes.len() > 1 {
                sql.push_str(&format!(" AND {}", library_scope_in_sql("t", scopes.len())));
                push_library_scope_binds(&mut params, &scopes);
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
#[specta::specta]
pub fn library_get_genre_album_counts(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    library_scope: Option<String>,
    library_scopes: Option<Vec<String>>,
) -> Result<Vec<GenreAlbumCountDto>, String> {
    let trace = psysonic_core::logging::should_log_albums_browse_trace();
    let scopes = if let Some(scopes) = library_scopes {
        normalized_library_scopes(&scopes)
    } else if let Some(scope) = library_scope.as_deref().filter(|s| !s.trim().is_empty()) {
        vec![scope.to_string()]
    } else {
        vec![]
    };
    let trace_scopes = scopes.clone();
    let t0 = std::time::Instant::now();
    let result = genre_album_counts_for_server(&runtime.store, &server_id, &scopes);
    if trace {
        let step_ms = t0.elapsed().as_millis();
        let genre_count = result.as_ref().map(|rows| rows.len()).unwrap_or(0);
        crate::app_deprintln!(
            "[frontend][albums-browse] {}",
            serde_json::json!({
                "step": "rust_genre_album_counts",
                "elapsedMs": 0,
                "details": {
                    "stepMs": step_ms,
                    "serverId": server_id,
                    "libraryScopes": trace_scopes,
                    "genreCount": genre_count,
                    "ok": result.is_ok(),
                }
            })
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::repos::TrackRepository;
    use crate::runtime::LibraryRuntime;
    use crate::store::LibraryStore;

    use super::{
        apply_album_patch, catalog_year_bounds_for_server, genre_album_counts_for_server,
        overlay_album_level_starred_at, reconcile_album_stars, StarredAlbumReconcileItem,
    };
    use crate::dto::LibraryAlbumDto;

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
            replay_gain_peak: None,
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
    fn apply_album_patch_sets_and_clears_starred_at() {
        let store = Arc::new(LibraryStore::open_in_memory());
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', NULL, 1, '{}')",
                    [],
                )
            })
            .unwrap();
        let rt = runtime(store.clone());
        apply_album_patch(&rt, "s1", "al1", &serde_json::json!({ "starredAt": 1700 })).unwrap();
        let starred: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(starred, Some(1700));

        apply_album_patch(&rt, "s1", "al1", &serde_json::json!({ "starredAt": null })).unwrap();
        let cleared: Option<i64> = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT starred_at FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(cleared, None);
        let raw: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert!(!raw.contains("starred"));
    }

    #[test]
    fn apply_album_patch_clears_stale_starred_in_raw_json() {
        let store = Arc::new(LibraryStore::open_in_memory());
        store
            .with_conn("misc", |c| {
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', 100, 1, \
                     '{\"id\":\"al1\",\"starred\":\"2024-01-01T00:00:00Z\"}')",
                    [],
                )
            })
            .unwrap();
        let rt = runtime(store.clone());
        apply_album_patch(&rt, "s1", "al1", &serde_json::json!({ "starredAt": null })).unwrap();
        let raw: String = store
            .with_conn("misc", |c| {
                c.query_row(
                    "SELECT raw_json FROM album WHERE server_id = 's1' AND id = 'al1'",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(parsed.get("starred").is_none());
    }

    #[test]
    fn overlay_album_level_starred_at_ignores_track_stars() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al1", 1)])
            .unwrap();
        store
            .with_conn("misc", |c| {
                c.execute(
                    "UPDATE track SET starred_at = 999 WHERE server_id = 's1' AND id = 'tr_1'",
                    [],
                )?;
                c.execute(
                    "INSERT INTO album (server_id, id, name, starred_at, synced_at, raw_json) \
                     VALUES ('s1', 'al1', 'Album', NULL, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let mut albums = vec![LibraryAlbumDto {
            server_id: "s1".into(),
            id: "al1".into(),
            name: "Album".into(),
            artist: None,
            artist_id: None,
            song_count: Some(1),
            duration_sec: Some(200),
            year: None,
            genre: None,
            cover_art_id: None,
            starred_at: Some(999),
            synced_at: 1,
            raw_json: serde_json::Value::Null,
        }];
        overlay_album_level_starred_at(&store, "s1", &mut albums).unwrap();
        assert_eq!(albums[0].starred_at, None);

        apply_album_patch(
            &runtime(store.clone()),
            "s1",
            "al1",
            &serde_json::json!({ "starredAt": 1700 }),
        )
        .unwrap();
        overlay_album_level_starred_at(&store, "s1", &mut albums).unwrap();
        assert_eq!(albums[0].starred_at, Some(1700));
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

        let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
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

        let counts = genre_album_counts_for_server(&store, "s1", &[String::from("lib1")]).unwrap();
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
        scoped.library_id = Some("lib1".into());
        let mut other = make_row("s1", "r2", "al_b", 1);
        other.genre = Some("Rock".into());
        other.library_id = Some("lib2".into());
        TrackRepository::new(&store)
            .upsert_batch(&[scoped, other])
            .unwrap();

        let counts = genre_album_counts_for_server(&store, "s1", &[String::from("lib1")]).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].album_count, 1);
    }

    #[test]
    fn genre_album_counts_multi_library_scope_in_one_query() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut lib1 = make_row("s1", "r1", "al_a", 1);
        lib1.genre = Some("Rock".into());
        lib1.library_id = Some("lib1".into());
        let mut lib2 = make_row("s1", "r2", "al_b", 1);
        lib2.genre = Some("Pop".into());
        lib2.library_id = Some("lib2".into());
        TrackRepository::new(&store)
            .upsert_batch(&[lib1, lib2])
            .unwrap();

        let counts = genre_album_counts_for_server(
            &store,
            "s1",
            &[String::from("lib1"), String::from("lib2")],
        )
        .unwrap();
        assert_eq!(counts.len(), 2);
        // Equal album_count → ORDER BY tg.genre COLLATE NOCASE ASC: "Pop" before "Rock".
        assert_eq!(counts[0].value, "Pop");
        assert_eq!(counts[1].value, "Rock");
    }

    #[test]
    fn genre_album_counts_drop_genre_after_track_retag() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let mut track = make_row("s1", "t1", "al1", 1);
        track.genre = Some("ruspop".into());
        TrackRepository::new(&store)
            .upsert_batch(&[track.clone()])
            .unwrap();
        let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].value, "ruspop");

        track.genre = Some("Pop".into());
        TrackRepository::new(&store).upsert_batch(&[track]).unwrap();
        let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
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

        let counts = genre_album_counts_for_server(&store, "s1", &[]).unwrap();
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

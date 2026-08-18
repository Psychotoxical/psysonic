//! Album browse helpers: favorites reconcile and catalog year bounds.

use rusqlite::{params, OptionalExtension};
use serde_json::{Map, Value};
use tauri::State;

use crate::album_compilation_filter::pick_album_group_artist_id;
use crate::dto::CatalogYearBoundsDto;
use crate::dto::GenreAlbumCountDto;
use crate::dto::LibraryAlbumDto;
use crate::runtime::LibraryRuntime;
use crate::search::{
    library_scope_in_sql, library_scope_sargable_equals_sql, normalized_library_scopes,
    push_library_scope_binds,
};
use crate::store::LibraryStore;
use crate::sync::mapping::format_iso_ms_z;

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
        album.starred_at = read_album_starred_at(conn, &album.server_id, &album.id).unwrap_or(None);
    }
}

/// Resolve which entity each album card's credit links to, read back from the
/// **complete physical album** `(server_id, album_id)` instead of one representative
/// track.
///
/// Album-artist tagging lives on tracks and is often partial, so any recovery computed
/// inside a browse query is only as good as that query's own row pool. Reading the pair
/// back per physical album keeps three things true that such a pool cannot: the id
/// belongs to the same server as the returned `server_id` (artist ids are server-local
/// while cross-server dedup merges equivalent albums), every sibling track counts even
/// when a genre/search predicate excluded it, and compound-select arms cannot disagree
/// with each other. Costs one indexed range scan per returned card — `idx_track_album`
/// is partial, hence the mandatory `deleted = 0` predicate — in the same shape as
/// [`overlay_album_starred_at_rows`].
pub(crate) fn overlay_album_artist_links(
    conn: &rusqlite::Connection,
    albums: &mut [LibraryAlbumDto],
) {
    if albums.is_empty() {
        return;
    }
    let sql = format!(
        "SELECT MAX(t.album_artist), MAX({album_artist_id}), \
                COUNT(*), COALESCE(SUM(t.duration_sec), 0), MIN(t.server_created_at) \
         FROM track t \
         WHERE t.server_id = ?1 AND t.album_id = ?2 AND t.deleted = 0",
        album_artist_id = crate::scope_merge::album_artist_id_expr("t.raw_json"),
    );
    let Ok(mut stmt) = conn.prepare_cached(&sql) else {
        return;
    };
    for album in albums.iter_mut() {
        let owner = stmt
            .query_row(params![album.server_id, album.id], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })
            .optional()
            .unwrap_or(None);
        let Some((album_artist, album_artist_id, song_count, duration_sec, created_ms)) = owner
        else {
            continue;
        };
        // The displayed credit decides, because that is the name on the card; the
        // album-artist tag only answers whether this album has an album-artist credit
        // at all. A card crediting the track performer therefore keeps its own id.
        let tagged = album_artist.is_some_and(|value| !value.trim().is_empty());
        let credit = if tagged {
            album.artist.as_deref()
        } else {
            None
        };
        album.artist_id =
            pick_album_group_artist_id(album.artist_id.take(), credit, album_artist_id);
        overlay_album_size_and_added(album, song_count, duration_sec, created_ms);
    }
}

/// Fill in the three per-album figures no single browse query can supply for
/// every surface — track count, total runtime, and when the album arrived — from
/// the aggregates its caller already read off the complete physical album.
///
/// Each browse path is short a different one, and for its own reason. A feed that
/// selects a *window* of tracks (mainstage takes the most recently added) never
/// sees a whole release, so counting inside that query would report the window;
/// those callers leave both totals unset. The materialised
/// `album_browse_projection` behind All Albums and the lossless walk carry the
/// totals but have no column for the arrival date at all. Fields that already
/// carry a value are left alone: where a query could compute one, its value
/// matches that query's own semantics — a genre-filtered browse counts what it
/// counted on purpose.
///
/// `created_ms` is `MIN(server_created_at)`: the column answers when the album
/// arrived, so it must not move when one late track lands years afterwards — a
/// re-tag that recreates a single row would otherwise date the whole release to
/// today and mark it as new. The mainstage feed orders by the *newest* track
/// instead, which is its own concern; it sets its `createdMs` from that key
/// before this runs and keeps it, since a present value is never replaced.
///
/// This rides along with [`overlay_album_artist_links`] rather than taking a scan
/// of its own: both read the same `(server_id, album_id)` range over the same
/// `deleted = 0` rows, so the figures cost no additional lookup. Reading them per
/// physical album — not per library — matches that neighbour and reports the
/// release the user is looking at.
fn overlay_album_size_and_added(
    album: &mut LibraryAlbumDto,
    song_count: i64,
    duration_sec: i64,
    created_ms: Option<i64>,
) {
    // COUNT over an album with no live tracks left is a row that should not be on
    // this page at all — leave it untouched rather than stamping it with zeroes
    // that read like real values.
    if song_count <= 0 {
        return;
    }
    if album.song_count.is_none() {
        album.song_count = Some(song_count);
    }
    if album.duration_sec.is_none() {
        album.duration_sec = Some(duration_sec.max(0));
    }
    if let Some(created_ms) = created_ms {
        set_album_raw_created_ms(album, created_ms);
    }
}

/// `raw_json.createdMs` when the row already carries one (mainstage sets it from
/// its own feed key).
fn album_raw_created_ms(album: &LibraryAlbumDto) -> Option<i64> {
    album.raw_json.get("createdMs").and_then(Value::as_i64)
}

/// Adds `createdMs` without disturbing a `raw_json` payload the row already has,
/// and never overwrites one that is present.
fn set_album_raw_created_ms(album: &mut LibraryAlbumDto, created_ms: i64) {
    if album_raw_created_ms(album).is_some() {
        return;
    }
    // Only an absent payload becomes a fresh object. A row carrying something that
    // is not an object holds a shape this function does not understand, and
    // dropping it to make room for one field would lose more than it adds.
    if album.raw_json.is_null() {
        let mut map = Map::new();
        map.insert("createdMs".to_string(), Value::from(created_ms));
        album.raw_json = Value::Object(map);
        return;
    }
    if let Some(map) = album.raw_json.as_object_mut() {
        map.insert("createdMs".to_string(), Value::from(created_ms));
    }
}

/// [`overlay_album_artist_links`] for callers that hold the store rather than a
/// connection.
pub(crate) fn overlay_album_artist_links_for_store(
    store: &LibraryStore,
    albums: &mut [LibraryAlbumDto],
) -> Result<(), String> {
    if albums.is_empty() {
        return Ok(());
    }
    store
        .with_read_conn(|conn| {
            overlay_album_artist_links(conn, albums);
            Ok(())
        })
        .map_err(|e| e.to_string())
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
            conn.execute(&clear_sql, rusqlite::params_from_iter(clear_params.iter()))?;
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
#[path = "browse_support/tests.rs"]
mod tests;

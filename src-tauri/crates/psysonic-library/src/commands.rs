//! Tauri commands — read-only surface for PR-5a (spec §7.1). Mutating
//! commands + sync lifecycle land in PR-5b. All commands take a
//! `State<LibraryRuntime>` so the top crate's `setup()` can wire one
//! shared `Arc<LibraryStore>` across the whole IPC surface.

use rusqlite::params;
use tauri::State;

use crate::dto::{
    local_tracks_max_updated_ms, LibraryTrackDto, LibraryTracksEnvelope, OfflinePathDto,
    SyncStateDto, TrackArtifactDto, TrackFactDto, TrackRefDto,
};
use crate::repos::TrackRepository;
use crate::runtime::LibraryRuntime;
use crate::search::search_tracks;

/// Cap for `library_get_tracks_batch` per spec §7.1 ("max 100 refs/call").
const TRACKS_BATCH_LIMIT: usize = 100;

#[tauri::command]
pub fn library_get_status(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    library_scope: Option<String>,
) -> Result<SyncStateDto, String> {
    let scope = library_scope.unwrap_or_default();
    let row: Option<SyncStateRow> = runtime
        .store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT sync_phase, capability_flags, library_tier, last_full_sync_at, \
                 last_delta_sync_at, next_poll_at, server_last_scan_iso, \
                 indexes_last_modified_ms, artists_last_modified_ms, local_track_count, \
                 server_track_count, last_error \
                 FROM sync_state WHERE server_id = ?1 AND library_scope = ?2",
                params![server_id, scope],
                |r| {
                    Ok(SyncStateRow {
                        sync_phase: r.get(0)?,
                        capability_flags: r.get::<_, i64>(1)?.max(0) as u32,
                        library_tier: r.get(2)?,
                        last_full_sync_at: r.get(3)?,
                        last_delta_sync_at: r.get(4)?,
                        next_poll_at: r.get(5)?,
                        server_last_scan_iso: r.get(6)?,
                        indexes_last_modified_ms: r.get(7)?,
                        artists_last_modified_ms: r.get(8)?,
                        local_track_count: r.get(9)?,
                        server_track_count: r.get(10)?,
                        last_error: r.get(11)?,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| e.to_string())?;

    let local_tracks_max_updated_ms = local_tracks_max_updated_ms(&runtime.store, &server_id)?;
    let row = row.unwrap_or_default();
    // `SyncStateRepository::ensure` is intentionally NOT called from
    // the read path — `library_get_status` on a fresh server returns
    // an "idle / unknown" stub without writing a row. PR-5b writes
    // the row when `bind_session` lands.
    Ok(SyncStateDto {
        server_id,
        library_scope: scope,
        sync_phase: row.sync_phase,
        capability_flags: row.capability_flags,
        library_tier: row.library_tier,
        last_full_sync_at: row.last_full_sync_at,
        last_delta_sync_at: row.last_delta_sync_at,
        next_poll_at: row.next_poll_at,
        server_last_scan_iso: row.server_last_scan_iso,
        indexes_last_modified_ms: row.indexes_last_modified_ms,
        artists_last_modified_ms: row.artists_last_modified_ms,
        local_track_count: row.local_track_count,
        server_track_count: row.server_track_count,
        last_error: row.last_error,
        local_tracks_max_updated_ms,
    })
}

#[tauri::command]
pub fn library_search(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
    library_scope: Option<String>,
) -> Result<LibraryTracksEnvelope, String> {
    let _ = library_scope; // PR-5a accepts the arg for forward-compat; filter is wired in §5.13
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let offset = offset.unwrap_or(0);
    // `search_tracks` returns lean `TrackHit` rows for FTS; PR-5a
    // re-fetches the full `TrackRow` per hit so the DTO carries every
    // hot column. Acceptable for `limit ≤ 100`; PR-5d wires a single-
    // statement SQL builder via the FilterRegistry.
    let hits = search_tracks(&runtime.store, &server_id, &query, limit as i64 + offset as i64)?;
    let mut paged: Vec<TrackRefDto> = hits
        .into_iter()
        .skip(offset as usize)
        .map(|h| TrackRefDto {
            server_id: h.server_id,
            track_id: h.id,
            content_hash: None,
        })
        .collect();
    paged.truncate(limit as usize);

    let total = paged.len() as u32;
    let tracks = hydrate_refs(&runtime, &paged)?;
    Ok(LibraryTracksEnvelope { tracks, total })
}

#[tauri::command]
pub fn library_get_track(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
) -> Result<Option<LibraryTrackDto>, String> {
    let repo = TrackRepository::new(&runtime.store);
    Ok(repo
        .find_one(&server_id, &track_id)?
        .map(|row| LibraryTrackDto::from_row(&row)))
}

#[tauri::command]
pub fn library_get_tracks_batch(
    runtime: State<'_, LibraryRuntime>,
    refs: Vec<TrackRefDto>,
) -> Result<Vec<LibraryTrackDto>, String> {
    if refs.len() > TRACKS_BATCH_LIMIT {
        return Err(format!(
            "library_get_tracks_batch: refs exceeds cap ({} > {})",
            refs.len(),
            TRACKS_BATCH_LIMIT
        ));
    }
    hydrate_refs(&runtime, &refs)
}

#[tauri::command]
pub fn library_get_tracks_by_album(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    album_id: String,
) -> Result<Vec<LibraryTrackDto>, String> {
    let rows = TrackRepository::new(&runtime.store).find_by_album(&server_id, &album_id)?;
    Ok(rows.iter().map(LibraryTrackDto::from_row).collect())
}

#[tauri::command]
pub fn library_get_artifact(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    artifact_kind: String,
    source_kind: Option<String>,
    source_id: Option<String>,
    format: Option<String>,
) -> Result<Option<TrackArtifactDto>, String> {
    runtime
        .store
        .with_conn(|conn| {
            // Compose a flexible WHERE — source_kind / source_id /
            // format optional so PR-7's lyrics path can call without
            // a pinned `source_id` (returns the first match).
            let mut sql = String::from(
                "SELECT server_id, track_id, artifact_kind, format, source_kind, source_id, \
                 language, content_text, content_bytes, not_found, content_hash, fetched_at, \
                 expires_at FROM track_artifact \
                 WHERE server_id = ?1 AND track_id = ?2 AND artifact_kind = ?3",
            );
            if source_kind.is_some() {
                sql.push_str(" AND source_kind = ?4");
            }
            if source_id.is_some() {
                sql.push_str(" AND source_id = ?5");
            }
            if format.is_some() {
                sql.push_str(" AND format = ?6");
            }
            sql.push_str(" ORDER BY fetched_at DESC LIMIT 1");

            let mut stmt = conn.prepare(&sql)?;
            let mut bound: Vec<rusqlite::types::Value> = vec![
                rusqlite::types::Value::Text(server_id.clone()),
                rusqlite::types::Value::Text(track_id.clone()),
                rusqlite::types::Value::Text(artifact_kind.clone()),
            ];
            if let Some(sk) = &source_kind {
                bound.push(rusqlite::types::Value::Text(sk.clone()));
            }
            if let Some(si) = &source_id {
                bound.push(rusqlite::types::Value::Text(si.clone()));
            }
            if let Some(fmt) = &format {
                bound.push(rusqlite::types::Value::Text(fmt.clone()));
            }

            stmt.query_row(rusqlite::params_from_iter(bound.iter()), |r| {
                Ok(TrackArtifactDto {
                    server_id: r.get(0)?,
                    track_id: r.get(1)?,
                    artifact_kind: r.get(2)?,
                    format: r.get(3)?,
                    source_kind: r.get(4)?,
                    source_id: r.get(5)?,
                    language: r.get(6)?,
                    content_text: r.get(7)?,
                    content_bytes: r.get(8)?,
                    not_found: r.get::<_, i64>(9)? != 0,
                    content_hash: r.get(10)?,
                    fetched_at: r.get(11)?,
                    expires_at: r.get(12)?,
                })
            })
            .optional()
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_get_facts(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
    fact_kinds: Option<Vec<String>>,
) -> Result<Vec<TrackFactDto>, String> {
    runtime
        .store
        .with_conn(|conn| {
            let kinds = fact_kinds.unwrap_or_default();
            if kinds.is_empty() {
                let mut stmt = conn.prepare(
                    "SELECT server_id, track_id, fact_kind, value_real, value_int, value_text, \
                     unit, source_kind, source_id, confidence, content_hash, fetched_at, expires_at \
                     FROM track_fact \
                     WHERE server_id = ?1 AND track_id = ?2 \
                     ORDER BY fact_kind ASC, fetched_at DESC",
                )?;
                let rows: rusqlite::Result<Vec<TrackFactDto>> = stmt
                    .query_map(params![server_id, track_id], row_to_fact_dto)?
                    .collect();
                rows
            } else {
                // ANY value match across the provided fact_kinds.
                let placeholders =
                    (0..kinds.len()).map(|i| format!("?{}", i + 3)).collect::<Vec<_>>().join(", ");
                let sql = format!(
                    "SELECT server_id, track_id, fact_kind, value_real, value_int, value_text, \
                     unit, source_kind, source_id, confidence, content_hash, fetched_at, expires_at \
                     FROM track_fact \
                     WHERE server_id = ?1 AND track_id = ?2 AND fact_kind IN ({placeholders}) \
                     ORDER BY fact_kind ASC, fetched_at DESC"
                );
                let mut stmt = conn.prepare(&sql)?;
                let mut bound: Vec<rusqlite::types::Value> = vec![
                    rusqlite::types::Value::Text(server_id.clone()),
                    rusqlite::types::Value::Text(track_id.clone()),
                ];
                for k in &kinds {
                    bound.push(rusqlite::types::Value::Text(k.clone()));
                }
                let rows: rusqlite::Result<Vec<TrackFactDto>> = stmt
                    .query_map(rusqlite::params_from_iter(bound.iter()), row_to_fact_dto)?
                    .collect();
                rows
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_get_offline_path(
    runtime: State<'_, LibraryRuntime>,
    server_id: String,
    track_id: String,
) -> Result<OfflinePathDto, String> {
    let path = runtime
        .store
        .with_conn(|conn| {
            conn.query_row(
                "SELECT local_path FROM track_offline \
                 WHERE server_id = ?1 AND track_id = ?2",
                params![server_id, track_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })
        .map_err(|e| e.to_string())?;
    Ok(OfflinePathDto {
        server_id,
        track_id,
        missing: path.is_none(),
        local_path: path,
    })
}

// ── helpers ──────────────────────────────────────────────────────────

fn hydrate_refs(
    runtime: &LibraryRuntime,
    refs: &[TrackRefDto],
) -> Result<Vec<LibraryTrackDto>, String> {
    let pairs: Vec<(String, String)> = refs
        .iter()
        .map(|r| (r.server_id.clone(), r.track_id.clone()))
        .collect();
    let rows = TrackRepository::new(&runtime.store).find_batch(&pairs)?;
    Ok(rows.iter().map(LibraryTrackDto::from_row).collect())
}

fn row_to_fact_dto(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackFactDto> {
    Ok(TrackFactDto {
        server_id: row.get(0)?,
        track_id: row.get(1)?,
        fact_kind: row.get(2)?,
        value_real: row.get(3)?,
        value_int: row.get(4)?,
        value_text: row.get(5)?,
        unit: row.get(6)?,
        source_kind: row.get(7)?,
        source_id: row.get(8)?,
        confidence: row.get(9)?,
        content_hash: row.get(10)?,
        fetched_at: row.get(11)?,
        expires_at: row.get(12)?,
    })
}

#[derive(Default)]
struct SyncStateRow {
    sync_phase: String,
    capability_flags: u32,
    library_tier: String,
    last_full_sync_at: Option<i64>,
    last_delta_sync_at: Option<i64>,
    next_poll_at: Option<i64>,
    server_last_scan_iso: Option<String>,
    indexes_last_modified_ms: Option<i64>,
    artists_last_modified_ms: Option<i64>,
    local_track_count: Option<i64>,
    server_track_count: Option<i64>,
    last_error: Option<String>,
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::TrackRow;
    use crate::store::LibraryStore;
    use std::sync::Arc;

    fn make_row(server: &str, id: &str, album_id: &str, track_no: i64) -> TrackRow {
        TrackRow {
            server_id: server.into(),
            id: id.into(),
            title: format!("Track {id}"),
            title_sort: None,
            artist: Some("A".into()),
            artist_id: Some("ar1".into()),
            album: "Album".into(),
            album_id: Some(album_id.into()),
            album_artist: Some("A".into()),
            duration_sec: 240,
            track_number: Some(track_no),
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
            server_path: Some(format!("/path/{id}.flac")),
            library_id: None,
            isrc: None,
            mbid_recording: None,
            bpm: None,
            replay_gain_track_db: None,
            replay_gain_album_db: None,
            content_hash: Some(format!("hash-{id}")),
            server_updated_at: None,
            server_created_at: None,
            deleted: false,
            synced_at: 1,
            raw_json: "{}".into(),
        }
    }

    // The command functions take `tauri::State` which we can't easily
    // construct in unit tests without a Tauri runtime. The tests below
    // exercise the *underlying* logic by calling the equivalent
    // `LibraryRuntime` + repo paths directly. Integration coverage with
    // a real Tauri app lives outside this crate (PR-5c devtools test).

    fn runtime(store: Arc<LibraryStore>) -> LibraryRuntime {
        LibraryRuntime::new(store)
    }

    #[test]
    fn get_status_returns_defaults_when_no_row_exists() {
        let store = Arc::new(LibraryStore::open_in_memory());
        let rt = runtime(store);
        // Simulate command body — same logic as `library_get_status`.
        let local_max = local_tracks_max_updated_ms(&rt.store, "s1").unwrap();
        assert!(local_max.is_none());
    }

    #[test]
    fn library_track_dto_from_row_preserves_hot_columns() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[make_row("s1", "tr_1", "al_1", 5)])
            .unwrap();
        let found = TrackRepository::new(&store).find_one("s1", "tr_1").unwrap().unwrap();
        let dto = LibraryTrackDto::from_row(&found);
        assert_eq!(dto.id, "tr_1");
        assert_eq!(dto.album_id.as_deref(), Some("al_1"));
        assert_eq!(dto.track_number, Some(5));
    }

    #[test]
    fn find_by_album_orders_by_disc_then_track_then_id() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[
                make_row("s1", "tr_b", "al_1", 2),
                make_row("s1", "tr_a", "al_1", 1),
                make_row("s1", "tr_c", "al_2", 1),
            ])
            .unwrap();
        let album1 = TrackRepository::new(&store).find_by_album("s1", "al_1").unwrap();
        let ids: Vec<&str> = album1.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["tr_a", "tr_b"]);
    }

    #[test]
    fn find_batch_preserves_input_order_and_drops_unknowns() {
        let store = Arc::new(LibraryStore::open_in_memory());
        TrackRepository::new(&store)
            .upsert_batch(&[
                make_row("s1", "tr_1", "al_1", 1),
                make_row("s1", "tr_2", "al_1", 2),
            ])
            .unwrap();
        let pairs = vec![
            ("s1".to_string(), "tr_2".to_string()),
            ("s1".to_string(), "tr_missing".to_string()),
            ("s1".to_string(), "tr_1".to_string()),
        ];
        let rows = TrackRepository::new(&store).find_batch(&pairs).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["tr_2", "tr_1"]);
    }

    #[test]
    fn batch_limit_constant_matches_spec_cap() {
        assert_eq!(TRACKS_BATCH_LIMIT, 100);
    }
}

use serde_json::Value;

use crate::dto::{LibraryTrackDto, TrackRefDto};
use crate::repos::TrackRepository;
use crate::runtime::LibraryRuntime;
use crate::store::LibraryStore;

/// Cap for `library_get_tracks_batch` per spec §7.1 ("max 100 refs/call").
pub(super) const TRACKS_BATCH_LIMIT: usize = 100;

#[derive(Default)]
pub(super) struct SyncStateRow {
    pub(super) sync_phase: String,
    pub(super) capability_flags: u32,
    pub(super) library_tier: String,
    pub(super) last_full_sync_at: Option<i64>,
    pub(super) last_delta_sync_at: Option<i64>,
    pub(super) next_poll_at: Option<i64>,
    pub(super) server_last_scan_iso: Option<String>,
    pub(super) indexes_last_modified_ms: Option<i64>,
    pub(super) artists_last_modified_ms: Option<i64>,
    pub(super) ignored_articles: Option<String>,
    pub(super) local_track_count: Option<i64>,
    pub(super) server_track_count: Option<i64>,
    pub(super) last_error: Option<String>,
}

pub(super) fn parse_ingest_cursor(raw: &Value) -> (Option<String>, Option<String>, Option<u32>) {
    if raw.as_object().is_none_or(|o| o.is_empty()) {
        return (None, None, None);
    }
    let strategy = raw
        .get("strategy")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let phase = raw
        .get("phase")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let ingested = raw
        .get("ingested_count")
        .and_then(|v| v.as_u64())
        .map(|n| n.min(u32::MAX as u64) as u32);
    (strategy, phase, ingested)
}

/// Avoid full-table `COUNT(*)` while `initial_sync` is writing — use the
/// cheap cursor / snapshot counters updated on each cursor persist instead.
pub(super) fn resolve_local_track_count(
    row: &SyncStateRow,
    cursor_ingested_count: Option<u32>,
    has_local_tracks: bool,
    store: &LibraryStore,
    server_id: &str,
    library_scope: &str,
) -> Option<i64> {
    if row.sync_phase == "initial_sync" {
        let snapshot = row.local_track_count.unwrap_or(0);
        let cursor = cursor_ingested_count.map(i64::from).unwrap_or(0);
        let best = snapshot.max(cursor);
        return if best > 0 {
            Some(best)
        } else {
            row.local_track_count
        };
    }
    match row.local_track_count {
        Some(n) if n > 0 => Some(n),
        _ if has_local_tracks => TrackRepository::new(store)
            .count_live_tracks_in_scope(server_id, library_scope)
            .ok(),
        _ => row.local_track_count,
    }
}

/// Ordered multi-scope wins; else single `library_scope`; empty = all libraries.
pub(super) fn effective_library_scopes(
    library_scope: Option<&str>,
    library_scopes: Option<&[String]>,
) -> Vec<String> {
    if let Some(list) = library_scopes {
        return crate::search::normalized_library_scopes(list);
    }
    crate::search::normalized_library_scopes(
        &library_scope
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
    )
}

pub(super) fn hydrate_refs(
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

pub(super) fn upsert_songs_from_api(
    store: &LibraryStore,
    server_id: &str,
    songs: Vec<serde_json::Value>,
) -> Result<u32, String> {
    use crate::sync::subsonic_song_to_track_row;
    use psysonic_integration::subsonic::Song;

    if songs.is_empty() {
        return Ok(0);
    }
    let synced_at = super::now_unix_ms();
    let repo = TrackRepository::new(store);
    let mut rows = Vec::with_capacity(songs.len());
    for raw in songs {
        let song: Song = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        rows.push(subsonic_song_to_track_row(
            server_id, &song, &raw, synced_at, None,
        ));
    }
    repo.upsert_batch(&rows)?;
    Ok(rows.len() as u32)
}

#[cfg(test)]
mod tests;

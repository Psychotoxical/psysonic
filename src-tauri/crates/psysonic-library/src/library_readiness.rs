//! When the local library index is safe for background analysis backfill.

use crate::dto::local_tracks_max_updated_ms;
use crate::repos::{sync_state::SyncStateRepository, TrackRepository};
use crate::store::LibraryStore;

/// Mirrors frontend `libraryStatusIsReady` / `libraryIsReady` (spec §9.3).
pub fn library_server_is_ready(store: &LibraryStore, server_id: &str) -> Result<bool, String> {
    let repo = SyncStateRepository::new(store);
    let phase = repo
        .get_sync_phase(server_id, "")
        .map_err(|e| e.to_string())?;

    let Some(phase) = phase else {
        return Ok(has_any_local_tracks(store, server_id));
    };

    if phase == "ready" {
        return Ok(true);
    }
    if phase == "initial_sync" {
        let local = repo
            .get_local_track_count(server_id, "")
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        let server = repo
            .get_server_track_count(server_id, "")
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if server > 0 && (local as f64 / server as f64) >= 0.95 {
            return Ok(true);
        }
        return Ok(false);
    }
    if phase == "idle" {
        if has_any_local_tracks(store, server_id) {
            return Ok(true);
        }
        if repo
            .has_last_full_sync_at(server_id, "")
            .map_err(|e| e.to_string())?
        {
            return Ok(true);
        }
        if local_tracks_max_updated_ms(store, server_id)?
            .is_some_and(|ms| ms > 0)
        {
            return Ok(true);
        }
        let local = repo
            .get_local_track_count(server_id, "")
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        return Ok(local > 0);
    }
    Ok(false)
}

fn has_any_local_tracks(store: &LibraryStore, server_id: &str) -> bool {
    TrackRepository::new(store)
        .count_live_tracks(server_id)
        .map(|n| n > 0)
        .unwrap_or(false)
}

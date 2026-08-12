//! Persist Subsonic `getArtists` / `getIndexes` bodies into the local `artist` table.

use crate::repos::{ArtistRepository, SyncStateRepository};
use crate::store::LibraryStore;
use psysonic_integration::subsonic::ArtistIndex;

use super::error::SyncError;

/// Persist a `getArtists` body and return how many artist rows it confirmed
/// (`upsert_index` count). Callers use a non-zero count as the "this was a real,
/// authoritative `getArtists` pass" signal that gates the orphan prune — an
/// empty/partial body must not drive a prune, because `backfill_from_tracks`
/// would still advance the freshest `synced_at` from a lone track.
pub fn apply_artist_index(
    store: &LibraryStore,
    server_id: &str,
    library_scope: &str,
    index: &ArtistIndex,
) -> Result<u32, SyncError> {
    let synced_at = super::now_unix_ms();
    let ignored = crate::artist_sort::ignored_articles_or_default(
        index.ignored_articles.as_deref(),
    );
    let sync_state = SyncStateRepository::new(store);
    sync_state
        .set_ignored_articles(server_id, library_scope, ignored)
        .map_err(SyncError::Storage)?;
    let repo = ArtistRepository::new(store);
    let (confirmed, transition) = repo
        .upsert_index(server_id, index, synced_at)
        .map_err(SyncError::Storage)?;
    if let Some(transition) = transition {
        return Err(SyncError::IdentityTransition(format!(
            "server `{}` changed artist id `{}` to canonical id `{}`; migration required",
            transition.server_id, transition.old_id, transition.new_id
        )));
    }
    repo.backfill_from_tracks(server_id, ignored, synced_at).map_err(SyncError::Storage)?;
    if let Some(ms) = index.last_modified_ms {
        sync_state
            .set_artists_last_modified_ms(server_id, library_scope, ms)
            .map_err(SyncError::Storage)?;
    }
    Ok(confirmed)
}

/// Prune `artist` browse rows the latest `getArtists` pass no longer confirms
/// and that have no live track — otherwise a server-side rename leaves a ghost
/// that opens to "Artist not found". Only call after a confirmed pass (see
/// [`apply_artist_index`]).
pub fn prune_orphan_artists_after_confirmed_pass(store: &LibraryStore, server_id: &str) {
    match crate::orphan_cleanup::prune_orphan_artists_for_server(store, server_id) {
        Ok(pruned) if pruned > 0 => {
            crate::app_eprintln!("[library-sync] pruned {pruned} orphan artist(s)");
        }
        Ok(_) => {}
        Err(e) => crate::app_eprintln!("[library-sync] orphan artist prune failed: {e}"),
    }
}

//! Post-sync library membership tagging for whole-server bulk ingests.
//!
//! Large Navidrome libraries ingest via OpenSubsonic `search3` without
//! `libraryId` on each track. After a sync job completes, this pass pages
//! `getAlbumList2` per music folder and tags `track.library_id` by album
//! membership without re-ingesting tracks or touching `resync_gen`/tombstones.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use psysonic_integration::subsonic::{MusicFolder, SubsonicClient};
use rusqlite::OptionalExtension;

use crate::repos::TrackRepository;
use crate::store::LibraryStore;

use super::error::SyncError;
use super::ingest_parallel::next_album_list_offset;
use super::now_unix_ms;
use super::progress::{Progress, ProgressEvent};

const ALBUM_PAGE_SIZE: u32 = 500;
const MAX_ALBUM_LIST_REQUESTS_PER_PASS: u32 = 8;

/// Summary of a library-tagging pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagReport {
    pub folders_processed: u32,
    pub albums_processed: u32,
    pub tracks_tagged: u64,
    pub untagged_remaining: u64,
    pub skipped: bool,
    pub completed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TagStateRow {
    folders_hash: String,
    last_untagged_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TagCursorRow {
    folders_hash: String,
    next_folder_id: String,
    next_album_offset: u32,
}

/// Stable fingerprint of the server's music-folder list for gating.
pub(crate) fn folders_hash(folders: &[MusicFolder]) -> String {
    let mut pairs: Vec<(String, String)> = folders
        .iter()
        .map(|f| (f.id.clone(), f.name.clone()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    pairs
        .into_iter()
        .map(|(id, name)| format!("{id}:{name}"))
        .collect::<Vec<_>>()
        .join("|")
}

/// Skip when nothing is untagged, or a prior pass made no progress on the
/// same folder set (avoids re-paging album-less tracks forever).
pub(crate) fn should_run_tagging_pass(
    untagged: u64,
    prior: Option<&TagStateRow>,
    cursor_active: bool,
    folders_hash: &str,
) -> bool {
    if untagged == 0 {
        return false;
    }
    if cursor_active {
        return true;
    }
    if let Some(p) = prior {
        if p.last_untagged_count == untagged && p.folders_hash == folders_hash {
            return false;
        }
    }
    true
}

fn read_tag_cursor(
    store: &LibraryStore,
    server_id: &str,
) -> Result<Option<TagCursorRow>, SyncError> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT folders_hash, next_folder_id, next_album_offset \
                 FROM library_tag_cursor WHERE server_id = ?1",
                rusqlite::params![server_id],
                |row| {
                    Ok(TagCursorRow {
                        folders_hash: row.get(0)?,
                        next_folder_id: row.get(1)?,
                        next_album_offset: row.get::<_, i64>(2)?.max(0) as u32,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| SyncError::Storage(e.to_string()))
}

fn read_tag_state(store: &LibraryStore, server_id: &str) -> Result<Option<TagStateRow>, SyncError> {
    store
        .with_read_conn(|conn| {
            conn.query_row(
                "SELECT folders_hash, last_untagged_count FROM library_tag_state WHERE server_id = ?1",
                rusqlite::params![server_id],
                |row| {
                    Ok(TagStateRow {
                        folders_hash: row.get(0)?,
                        last_untagged_count: row.get::<_, i64>(1)?.max(0) as u64,
                    })
                },
            )
            .optional()
        })
        .map_err(|e| SyncError::Storage(e.to_string()))
}

fn write_tag_cursor(
    store: &LibraryStore,
    server_id: &str,
    folders_hash: &str,
    next_folder_id: &str,
    next_album_offset: u32,
) -> Result<(), SyncError> {
    let now = now_unix_ms();
    store
        .with_conn_mut("library_tag.write_cursor", |conn| {
            conn.execute(
                "INSERT INTO library_tag_cursor \
                   (server_id, folders_hash, next_folder_id, next_album_offset, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(server_id) DO UPDATE SET \
                   folders_hash = excluded.folders_hash, \
                   next_folder_id = excluded.next_folder_id, \
                   next_album_offset = excluded.next_album_offset, \
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    server_id,
                    folders_hash,
                    next_folder_id,
                    next_album_offset as i64,
                    now
                ],
            )
        })
        .map_err(|e| SyncError::Storage(e.to_string()))?;
    Ok(())
}

fn write_tag_completion(
    store: &LibraryStore,
    server_id: &str,
    folders_hash: &str,
    untagged: u64,
) -> Result<(), SyncError> {
    let now = now_unix_ms();
    store
        .with_conn_mut("library_tag.write_completion", |conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO library_tag_state \
                   (server_id, folders_hash, last_untagged_count, completed_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(server_id) DO UPDATE SET \
                   folders_hash = excluded.folders_hash, \
                   last_untagged_count = excluded.last_untagged_count, \
                   completed_at = excluded.completed_at",
                rusqlite::params![server_id, folders_hash, untagged as i64, now],
            )?;
            tx.execute(
                "DELETE FROM library_tag_cursor WHERE server_id = ?1",
                rusqlite::params![server_id],
            )?;
            tx.commit()
        })
        .map_err(|e| SyncError::Storage(e.to_string()))
}

fn check_cancel(cancel: Option<&Arc<AtomicBool>>) -> Result<(), SyncError> {
    if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
        return Err(SyncError::Cancelled);
    }
    Ok(())
}

/// Best-effort post-sync pass: enumerate music folders, page scoped album
/// lists, and fill empty `track.library_id` values by album membership.
///
/// When `require_untagged` is true (delta sync), returns immediately if no
/// untagged tracks exist. Initial sync passes `false` so the gating logic
/// still runs after folder enumeration.
pub async fn tag_library_membership(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    progress: Arc<dyn Progress + Send + Sync>,
    require_untagged: bool,
) -> Result<TagReport, SyncError> {
    let tracks = TrackRepository::new(store);
    let untagged = tracks
        .count_untagged_tracks(server_id)
        .map_err(SyncError::Storage)?;
    let cursor = read_tag_cursor(store, server_id)?;

    if require_untagged && untagged == 0 {
        if let Some(cursor) = cursor.as_ref() {
            write_tag_completion(store, server_id, &cursor.folders_hash, 0)?;
        }
        return Ok(TagReport {
            folders_processed: 0,
            albums_processed: 0,
            tracks_tagged: 0,
            untagged_remaining: 0,
            skipped: true,
            completed: true,
        });
    }

    let folders = subsonic
        .get_music_folders()
        .await
        .map_err(SyncError::from)?;
    if folders.is_empty() {
        return Ok(TagReport {
            folders_processed: 0,
            albums_processed: 0,
            tracks_tagged: 0,
            untagged_remaining: untagged,
            skipped: true,
            completed: true,
        });
    }

    let mut folders = folders;
    folders.sort_by(|a, b| a.id.cmp(&b.id));
    let hash = folders_hash(&folders);
    let prior = read_tag_state(store, server_id)?;
    let active_cursor = cursor.as_ref().filter(|cursor| cursor.folders_hash == hash);
    if !should_run_tagging_pass(untagged, prior.as_ref(), active_cursor.is_some(), &hash) {
        return Ok(TagReport {
            folders_processed: 0,
            albums_processed: 0,
            tracks_tagged: 0,
            untagged_remaining: untagged,
            skipped: true,
            completed: true,
        });
    }

    progress.emit(ProgressEvent::PhaseChanged {
        phase: "library_tag".to_string(),
    });

    let mut folders_processed = 0u32;
    let mut albums_processed = 0u32;
    let mut tracks_tagged = 0u64;
    let mut requests_made = 0u32;
    let mut completed = true;
    let (start_folder_index, start_offset) = active_cursor
        .and_then(|cursor| {
            folders
                .iter()
                .position(|folder| folder.id == cursor.next_folder_id)
                .map(|index| (index, cursor.next_album_offset))
        })
        .unwrap_or((0, 0));

    'folders: for (folder_index, folder) in folders.iter().enumerate().skip(start_folder_index) {
        check_cancel(cancel.as_ref())?;
        let mut offset = if folder_index == start_folder_index {
            start_offset
        } else {
            0
        };
        loop {
            check_cancel(cancel.as_ref())?;
            if requests_made >= MAX_ALBUM_LIST_REQUESTS_PER_PASS {
                write_tag_cursor(store, server_id, &hash, &folder.id, offset)?;
                completed = false;
                break 'folders;
            }
            let page = subsonic
                .get_album_list2(
                    "alphabeticalByName",
                    ALBUM_PAGE_SIZE,
                    offset,
                    Some(folder.id.as_str()),
                )
                .await
                .map_err(SyncError::from)?;
            requests_made += 1;
            if page.is_empty() {
                folders_processed += 1;
                if let Some(next_folder) = folders.get(folder_index + 1) {
                    write_tag_cursor(store, server_id, &hash, &next_folder.id, 0)?;
                }
                break;
            }
            let album_ids: Vec<String> = page.iter().map(|a| a.id.clone()).collect();
            albums_processed += album_ids.len() as u32;
            let tagged = tracks
                .tag_library_by_album_ids(server_id, &folder.id, &album_ids)
                .map_err(SyncError::Storage)?;
            tracks_tagged += tagged;

            offset = next_album_list_offset(offset, page.len()).unwrap_or(offset);
            write_tag_cursor(store, server_id, &hash, &folder.id, offset)?;
        }
    }

    let untagged_remaining = tracks
        .count_untagged_tracks(server_id)
        .map_err(SyncError::Storage)?;
    if completed {
        write_tag_completion(store, server_id, &hash, untagged_remaining)?;
    }

    Ok(TagReport {
        folders_processed,
        albums_processed,
        tracks_tagged,
        untagged_remaining,
        skipped: false,
        completed,
    })
}

/// Post-sync library tagging — best-effort; never fails the caller (sync job
/// or background scheduler tick).
pub async fn run_tag_pass_best_effort(
    store: &LibraryStore,
    subsonic: &SubsonicClient,
    server_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    progress: Arc<dyn Progress + Send + Sync>,
    require_untagged: bool,
) {
    match tag_library_membership(
        store,
        subsonic,
        server_id,
        cancel,
        progress,
        require_untagged,
    )
    .await
    {
        Ok(report) if !report.skipped => {
            crate::app_eprintln!(
                "[library-tag] server `{server_id}`: tagged {} tracks across {} folders ({} albums), {} untagged left, completed={}",
                report.tracks_tagged,
                report.folders_processed,
                report.albums_processed,
                report.untagged_remaining,
                report.completed,
            );
        }
        Ok(_) => {}
        Err(SyncError::Cancelled) => {}
        Err(e) => {
            crate::app_eprintln!(
                "[library-tag] server `{server_id}`: best-effort pass failed: {e}"
            );
        }
    }
}

#[cfg(test)]
mod tests;

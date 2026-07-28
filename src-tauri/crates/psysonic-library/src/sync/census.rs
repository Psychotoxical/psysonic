//! Album census — reconcile the local index against the server's inventory.
//!
//! The delta only ever moves forward: it fetches what changed since a watermark
//! and skips everything below it. That makes it blind in both directions. A
//! deletion never appears in a changed-list, so it lingers until something goes
//! looking for it; and a row the ingest missed once sits below the watermark
//! forever, because nothing re-reads that range.
//!
//! Both are the same missing capability — nothing compares the two catalogues.
//! The census does, at album granularity, which is cheap enough to run on a
//! schedule: one `getAlbumList2` page run covers a whole server, and the local
//! side comes from `album_browse_projection`, which the ingest and sweep paths
//! already maintain.
//!
//! Two rules make this safe to run unattended, and they exist because the
//! resync sweep taught us what happens without them:
//!
//! 1. **Act only on a complete enumeration.** A page run that failed halfway
//!    tells us nothing about the albums it never reached. Half a census is not
//!    a census.
//! 2. **An absent album is a candidate, not a verdict.** Removal happens only
//!    after a direct `getAlbum` confirms the album is gone, and only within a
//!    cap on how much a single run may take out.

use std::collections::HashMap;

use crate::store::LibraryStore;

/// Ceiling on how much of a server's catalogue one census may remove. A run
/// that wants to delete more than this is far likelier to be a broken
/// enumeration than a user who deleted that much between two passes.
pub const CENSUS_REMOVAL_CAP_PERCENT: usize = 20;

/// One album as either side of the census sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumInventoryEntry {
    pub album_id: String,
    pub song_count: i64,
    pub duration_sec: i64,
}

/// What the two inventories disagree about. Nothing here is acted on directly:
/// `absent_on_server` still needs per-album confirmation, and the counts are a
/// hint that one album deserves a closer look, not a diff of its tracks.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct CensusDiff {
    /// The server lists it, the index does not — a gap to fetch.
    pub missing_locally: Vec<String>,
    /// The index holds it, the server's enumeration does not — a removal
    /// candidate, pending confirmation.
    pub absent_on_server: Vec<String>,
    /// Both sides have it and disagree on song count or total duration.
    pub needs_track_check: Vec<String>,
}

impl CensusDiff {
    pub fn is_empty(&self) -> bool {
        self.missing_locally.is_empty()
            && self.absent_on_server.is_empty()
            && self.needs_track_check.is_empty()
    }
}

/// Compare the two inventories. Both sides are keyed by the server's album id,
/// so this is a set comparison plus a per-album shape check; ordering and
/// duplicates on either side do not matter.
pub fn diff_inventories(
    local: &[AlbumInventoryEntry],
    server: &[AlbumInventoryEntry],
) -> CensusDiff {
    let local_by_id: HashMap<&str, &AlbumInventoryEntry> = local
        .iter()
        .map(|entry| (entry.album_id.as_str(), entry))
        .collect();
    let server_by_id: HashMap<&str, &AlbumInventoryEntry> = server
        .iter()
        .map(|entry| (entry.album_id.as_str(), entry))
        .collect();

    let mut diff = CensusDiff::default();
    for entry in server {
        match local_by_id.get(entry.album_id.as_str()) {
            None => diff.missing_locally.push(entry.album_id.clone()),
            Some(ours) => {
                // Duration catches the case a count cannot: one track removed
                // and another added between two passes leaves the count intact.
                if ours.song_count != entry.song_count || ours.duration_sec != entry.duration_sec {
                    diff.needs_track_check.push(entry.album_id.clone());
                }
            }
        }
    }
    for entry in local {
        if !server_by_id.contains_key(entry.album_id.as_str()) {
            diff.absent_on_server.push(entry.album_id.clone());
        }
    }

    diff.missing_locally.sort();
    diff.absent_on_server.sort();
    diff.needs_track_check.sort();
    diff
}

/// Whether a run may act on this many removals at all. `local_albums == 0`
/// means there is nothing to protect and nothing to remove.
pub fn removal_is_within_cap(candidates: usize, local_albums: usize, cap_percent: usize) -> bool {
    if candidates == 0 {
        return true;
    }
    if local_albums == 0 {
        return false;
    }
    candidates.saturating_mul(100) <= local_albums.saturating_mul(cap_percent)
}

/// The index's own album inventory for one server, aggregated across its
/// libraries so it lines up with a server-wide album list. Reads
/// `album_browse_projection` rather than aggregating `track`: measured on a
/// 175k-track library, 13 ms against 403 ms, and this runs on the shared read
/// connection where a slow query starves every browse surface behind it.
pub fn local_album_inventory(
    store: &LibraryStore,
    server_id: &str,
) -> Result<Vec<AlbumInventoryEntry>, String> {
    store.with_read_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT album_id, SUM(song_count), SUM(duration_sec) \
             FROM album_browse_projection \
             WHERE server_id = ?1 \
             GROUP BY album_id",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![server_id], |row| {
                Ok(AlbumInventoryEntry {
                    album_id: row.get(0)?,
                    song_count: row.get(1)?,
                    duration_sec: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, songs: i64, duration: i64) -> AlbumInventoryEntry {
        AlbumInventoryEntry {
            album_id: id.into(),
            song_count: songs,
            duration_sec: duration,
        }
    }

    #[test]
    fn identical_inventories_produce_nothing() {
        let side = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];
        assert!(diff_inventories(&side, &side).is_empty());
    }

    #[test]
    fn an_album_only_the_server_has_is_a_gap() {
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 10, 2000), entry("al-2", 4, 800)];

        let diff = diff_inventories(&local, &server);
        assert_eq!(diff.missing_locally, vec!["al-2"]);
        assert!(diff.absent_on_server.is_empty());
    }

    #[test]
    fn an_album_only_the_index_has_is_a_removal_candidate() {
        let local = vec![entry("al-1", 10, 2000), entry("al-gone", 7, 1400)];
        let server = vec![entry("al-1", 10, 2000)];

        let diff = diff_inventories(&local, &server);
        assert_eq!(diff.absent_on_server, vec!["al-gone"]);
        assert!(diff.missing_locally.is_empty());
    }

    #[test]
    fn a_changed_song_count_asks_for_a_closer_look() {
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 11, 2200)];

        assert_eq!(
            diff_inventories(&local, &server).needs_track_check,
            vec!["al-1"]
        );
    }

    #[test]
    fn one_track_swapped_for_another_still_shows_up() {
        // The case a count alone cannot see: same number of songs, different
        // total duration because the replacement is not the same recording.
        let local = vec![entry("al-1", 10, 2000)];
        let server = vec![entry("al-1", 10, 2043)];

        assert_eq!(
            diff_inventories(&local, &server).needs_track_check,
            vec!["al-1"]
        );
    }

    #[test]
    fn the_cap_refuses_a_run_that_would_gut_the_library() {
        // 3000 of 12,746 albums is not a user deleting music between two
        // passes; it is an enumeration that went wrong.
        assert!(!removal_is_within_cap(3_000, 12_746, CENSUS_REMOVAL_CAP_PERCENT));
    }

    #[test]
    fn the_cap_lets_an_ordinary_cleanup_through() {
        assert!(removal_is_within_cap(30, 12_746, CENSUS_REMOVAL_CAP_PERCENT));
        assert!(removal_is_within_cap(0, 0, CENSUS_REMOVAL_CAP_PERCENT));
    }

    #[test]
    fn nothing_local_means_nothing_to_remove() {
        assert!(!removal_is_within_cap(5, 0, CENSUS_REMOVAL_CAP_PERCENT));
    }

    #[test]
    fn local_inventory_aggregates_an_album_across_libraries() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test.seed_projection", |conn| {
                conn.execute(
                    "INSERT INTO album_browse_projection \
                     (server_id, library_id, album_id, name, song_count, duration_sec, \
                      synced_at, representative_track_id) \
                     VALUES ('s1', 'lib-a', 'al-1', 'Split', 4, 800, 1, 't1'), \
                            ('s1', 'lib-b', 'al-1', 'Split', 6, 1200, 1, 't2'), \
                            ('s1', 'lib-a', 'al-2', 'Other', 3, 600, 1, 't3'), \
                            ('s2', 'lib-a', 'al-9', 'Elsewhere', 9, 900, 1, 't9')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        let mut inventory = local_album_inventory(&store, "s1").unwrap();
        inventory.sort_by(|a, b| a.album_id.cmp(&b.album_id));

        assert_eq!(
            inventory,
            vec![entry("al-1", 10, 2000), entry("al-2", 3, 600)],
            "an album in two libraries counts once, with its songs summed"
        );
    }
}

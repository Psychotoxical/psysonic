use std::collections::HashSet;

use crate::store::LibraryStore;

use super::CENSUS_MIN_REMOVAL_CAP_ALBUMS;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumInventoryEntry {
    pub album_id: String,
    pub song_count: Option<i64>,
    pub duration_sec: Option<i64>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CensusDiff {
    pub missing_locally: Vec<String>,
    pub absent_on_server: Vec<String>,
}

impl CensusDiff {
    pub fn is_empty(&self) -> bool {
        self.missing_locally.is_empty() && self.absent_on_server.is_empty()
    }
}

pub fn diff_inventories(
    local: &[AlbumInventoryEntry],
    server: &[AlbumInventoryEntry],
) -> CensusDiff {
    let local_by_id: HashSet<&str> = local.iter().map(|entry| entry.album_id.as_str()).collect();
    let server_by_id: HashSet<&str> = server.iter().map(|entry| entry.album_id.as_str()).collect();

    let mut diff = CensusDiff::default();
    let mut missing_locally = HashSet::new();
    for entry in server {
        if !local_by_id.contains(entry.album_id.as_str()) {
            missing_locally.insert(entry.album_id.clone());
        }
    }
    diff.missing_locally.extend(missing_locally);
    let mut absent_on_server = HashSet::new();
    for entry in local {
        if !server_by_id.contains(entry.album_id.as_str()) {
            absent_on_server.insert(entry.album_id.clone());
        }
    }
    diff.absent_on_server.extend(absent_on_server);
    diff.missing_locally.sort();
    diff.absent_on_server.sort();
    diff
}

pub fn removal_is_within_cap(candidates: usize, local_albums: usize, cap_percent: usize) -> bool {
    if candidates == 0 {
        return true;
    }
    if local_albums == 0 {
        return false;
    }
    let percentage_limit = local_albums.saturating_mul(cap_percent).div_ceil(100);
    let limit = percentage_limit
        .max(CENSUS_MIN_REMOVAL_CAP_ALBUMS)
        .min(local_albums);
    candidates <= limit
}

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

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct CensusReport {
    pub server_albums: usize,
    pub local_albums: usize,
    pub gaps_filled: usize,
    pub albums_removed: usize,
    pub deferred: usize,
    pub stale_projections_dropped: usize,
    pub removal_refused: bool,
    pub enumeration_incomplete: bool,
    pub budget_exhausted: bool,
}

impl CensusReport {
    pub fn changed_index(&self) -> bool {
        self.albums_removed > 0 || self.gaps_filled > 0 || self.stale_projections_dropped > 0
    }
}

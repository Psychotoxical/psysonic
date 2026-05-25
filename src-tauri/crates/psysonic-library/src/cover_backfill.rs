//! Library cursor scan for background cover disk warm-up.
//!
//! Cover IDs for backfill come from **track** + **album** rows using
//! `COALESCE(cover_art_id, album_id)` (album table id as fallback).
//! Artist IDs are excluded — `getCoverArt` with `artist_id` often 404s and stalled the queue.

use std::path::Path;

use crate::store::LibraryStore;

const DEFAULT_BATCH: u32 = 32;
const MAX_BATCH: u32 = 48;
const SCAN_PAGE: i64 = 256;
const MAX_SCAN_PAGES: usize = 16;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverBackfillBatchDto {
    pub cover_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub exhausted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverProgressDto {
    pub total_distinct: i64,
    pub pending: i64,
    pub done: i64,
}

const COVER_ID_SUBQUERY: &str = "
    SELECT DISTINCT COALESCE(NULLIF(TRIM(album_id), ''), NULLIF(TRIM(cover_art_id), '')) AS id
    FROM track
    WHERE server_id = ?1 AND deleted = 0
      AND (
        NULLIF(TRIM(album_id), '') IS NOT NULL
        OR NULLIF(TRIM(cover_art_id), '') IS NOT NULL
      )
    UNION
    SELECT DISTINCT COALESCE(NULLIF(TRIM(id), ''), NULLIF(TRIM(cover_art_id), '')) AS id
    FROM album
    WHERE server_id = ?1
      AND (
        NULLIF(TRIM(id), '') IS NOT NULL
        OR NULLIF(TRIM(cover_art_id), '') IS NOT NULL
      )";

pub const COVER_FETCH_FAIL_MARKER: &str = ".fetch-failed";

/// Recent HTTP failure — skip in backfill cursor so slots go to fetchable album art.
pub fn cover_fetch_recently_failed(cover_dir: &Path) -> bool {
    let marker = cover_dir.join(COVER_FETCH_FAIL_MARKER);
    let Ok(meta) = std::fs::metadata(&marker) else {
        return false;
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    modified
        .elapsed()
        .map(|e| e < std::time::Duration::from_secs(30 * 60))
        .unwrap_or(true)
}

/// Remove `.fetch-failed` markers so the next library pass retries HTTP.
pub fn clear_cover_fetch_failures(cover_root: &Path, server_index_key: &str) -> u32 {
    let server_dir = cover_root.join(server_index_key);
    let Ok(entries) = std::fs::read_dir(&server_dir) else {
        return 0;
    };
    let mut cleared = 0u32;
    for id_dir in entries.flatten() {
        let marker = id_dir.path().join(COVER_FETCH_FAIL_MARKER);
        if marker.is_file() && std::fs::remove_file(&marker).is_ok() {
            cleared += 1;
        }
    }
    cleared
}

fn fetch_cover_id_page(
    store: &LibraryStore,
    library_server_id: &str,
    after: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT id FROM ({COVER_ID_SUBQUERY})
             WHERE id > ?2
             ORDER BY id ASC
             LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql)?;
        let ids = stmt
            .query_map(rusqlite::params![library_server_id, after, limit], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    })
}

pub fn count_distinct_cover_ids(store: &LibraryStore, library_server_id: &str) -> Result<i64, String> {
    store.with_read_conn(|conn| {
        let sql = format!("SELECT COUNT(*) FROM ({COVER_ID_SUBQUERY})");
        conn.query_row(&sql, rusqlite::params![library_server_id], |row| row.get(0))
    })
}

/// Library warm-up target tier — HTTP fetch size and progress heuristic.
pub const LIBRARY_COVER_CANONICAL_TIER: u32 = 800;

/// WebP ladder written by aggressive backfill (must match `cover_cache::DERIVE_TIERS`).
pub const LIBRARY_COVER_DERIVE_TIERS: [u32; 4] = [128, 256, 512, 800];

fn tier_file_ready(dir: &Path, tier: u32) -> bool {
    let path = dir.join(format!("{tier}.webp"));
    path.is_file() && path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

fn cover_ladder_complete_on_disk(dir: &Path) -> bool {
    LIBRARY_COVER_DERIVE_TIERS
        .iter()
        .all(|&tier| tier_file_ready(dir, tier))
}

pub fn cover_canonical_cached_on_disk(
    cover_root: &Path,
    server_index_key: &str,
    cover_art_id: &str,
) -> bool {
    let dir = cover_root.join(server_index_key).join(cover_art_id);
    tier_file_ready(&dir, LIBRARY_COVER_CANONICAL_TIER)
}

pub fn cover_ladder_cached_on_disk(
    cover_root: &Path,
    server_index_key: &str,
    cover_art_id: &str,
) -> bool {
    let dir = cover_root.join(server_index_key).join(cover_art_id);
    cover_ladder_complete_on_disk(&dir)
}

pub fn collect_cover_backfill_batch(
    store: &LibraryStore,
    library_server_id: &str,
    cover_root: &Path,
    server_index_key: &str,
    cursor: Option<&str>,
    limit: Option<u32>,
) -> Result<LibraryCoverBackfillBatchDto, String> {
    let want = limit.unwrap_or(DEFAULT_BATCH).min(MAX_BATCH) as usize;
    let mut after = cursor.map(str::to_string).unwrap_or_default();
    let mut pending = Vec::with_capacity(want);
    let mut sql_exhausted = false;

    for _ in 0..MAX_SCAN_PAGES {
        if pending.len() >= want {
            break;
        }
        let page = fetch_cover_id_page(store, library_server_id, &after, SCAN_PAGE)?;
        if page.is_empty() {
            sql_exhausted = true;
            break;
        }
        for id in &page {
            after.clone_from(id);
            let dir = cover_root.join(server_index_key).join(id);
            if cover_canonical_cached_on_disk(cover_root, server_index_key, id)
                || cover_fetch_recently_failed(&dir)
            {
                continue;
            }
            pending.push(id.clone());
            if pending.len() >= want {
                break;
            }
        }
        if (page.len() as i64) < SCAN_PAGE {
            sql_exhausted = true;
            break;
        }
    }

    Ok(LibraryCoverBackfillBatchDto {
        cover_ids: pending,
        next_cursor: if sql_exhausted { None } else { Some(after) },
        exhausted: sql_exhausted,
    })
}

/// Distinct library cover IDs still missing canonical `800.webp` (not raw dir count on disk).
pub fn count_pending_canonical_covers(
    store: &LibraryStore,
    library_server_id: &str,
    cover_root: &Path,
    server_index_key: &str,
) -> Result<i64, String> {
    let mut after = String::new();
    let mut pending = 0i64;
    loop {
        let page = fetch_cover_id_page(store, library_server_id, &after, SCAN_PAGE)?;
        if page.is_empty() {
            break;
        }
        for id in &page {
            after.clone_from(id);
            if !cover_canonical_cached_on_disk(cover_root, server_index_key, id) {
                pending += 1;
            }
        }
        if (page.len() as i64) < SCAN_PAGE {
            break;
        }
    }
    Ok(pending)
}

/// UI progress — fast approximate counts (no full-library disk walk).
pub fn collect_cover_progress(
    store: &LibraryStore,
    library_server_id: &str,
    _cover_root: &Path,
    _server_index_key: &str,
    cached_dirs_with_canonical: i64,
) -> Result<LibraryCoverProgressDto, String> {
    let total = count_distinct_cover_ids(store, library_server_id)?;
    let done = cached_dirs_with_canonical.min(total);
    Ok(LibraryCoverProgressDto {
        total_distinct: total,
        pending: (total - done).max(0),
        done,
    })
}

/// Accurate pending count — expensive; run off the UI thread only.
#[allow(dead_code)]
pub fn collect_cover_progress_accurate(
    store: &LibraryStore,
    library_server_id: &str,
    cover_root: &Path,
    server_index_key: &str,
) -> Result<LibraryCoverProgressDto, String> {
    let total = count_distinct_cover_ids(store, library_server_id)?;
    let pending = count_pending_canonical_covers(
        store,
        library_server_id,
        cover_root,
        server_index_key,
    )?;
    let done = (total - pending).max(0);
    Ok(LibraryCoverProgressDto {
        total_distinct: total,
        pending,
        done,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::LibraryStore;

    fn seed_track(store: &LibraryStore, server_id: &str, track_id: &str, album_id: &str, cover: Option<&str>) {
        store
            .with_conn_mut("test_seed", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, duration_sec, deleted, synced_at, raw_json,
                      cover_art_id
                    ) VALUES (?1, ?2, 't', 'al', ?3, 200, 0, 1, '{}', ?4)",
                    rusqlite::params![server_id, track_id, album_id, cover],
                )?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn backfill_uses_track_album_id_when_cover_art_null() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "al-99", None);
        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            Path::new("/tmp/empty-cover-root"),
            "srv-host",
            None,
            Some(10),
        )
        .unwrap();
        assert_eq!(batch.cover_ids, vec!["al-99".to_string()]);
    }

    #[test]
    fn backfill_skips_when_canonical_800_exists() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "al-partial", None);
        let root = std::env::temp_dir().join("psysonic-cover-backfill-test");
        let host = "srv-host";
        let id_dir = root.join(host).join("al-partial");
        std::fs::create_dir_all(&id_dir).unwrap();
        std::fs::write(id_dir.join("128.webp"), b"x").unwrap();

        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            &root,
            host,
            None,
            Some(10),
        )
        .unwrap();
        assert_eq!(batch.cover_ids, vec!["al-partial".to_string()]);

        std::fs::write(id_dir.join("800.webp"), b"canonical").unwrap();
        let batch2 = collect_cover_backfill_batch(
            &store,
            "srv",
            &root,
            host,
            None,
            Some(10),
        )
        .unwrap();
        assert!(batch2.cover_ids.is_empty());

        let _ = std::fs::remove_dir_all(root.join(host));
    }

    #[test]
    fn count_distinct_includes_artist_ids() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "al-1", Some("cv-1"));
        store
            .with_conn_mut("test_artist", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, artist_id, duration_sec, deleted, synced_at, raw_json
                    ) VALUES ('srv', 'tr2', 't', 'al', 'al-2', 'ar-1', 200, 0, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let n = count_distinct_cover_ids(&store, "srv").unwrap();
        assert_eq!(n, 2); // cv-1, al-1 — artist ids excluded from backfill catalog
    }
}

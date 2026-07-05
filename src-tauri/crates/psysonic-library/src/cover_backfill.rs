//! Library cursor scan for background cover disk warm-up.
//!
//! Catalog rows come from SQLite (`album` / `artist` tables) with explicit `kind`.
//! On-disk paths — `psysonic_core::cover_cache_layout`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use psysonic_core::cover_cache_layout::{self, is_fetch_only_cover_id};
use crate::cover_resolve::{
    cover_backfill_items_for_album, resolve_album_cover_entry, resolve_artist_cover_entry,
    CoverEntryDto,
};
use crate::store::LibraryStore;

const DEFAULT_BATCH: u32 = 32;
/// Upper bound on items collected per `collect_cover_backfill_batch` call. The
/// catalog scan (`fetch_catalog_page` GROUP BY over the cover UNION) is O(catalog)
/// per page, so larger batches amortize that cost across more downloads and keep
/// the backfill download pool fed. Per-call page count stays bounded by
/// `MAX_SCAN_PAGES`, so a sparse backlog cannot inflate scan cost here.
const MAX_BATCH: u32 = 256;
const SCAN_PAGE: i64 = 256;
const MAX_SCAN_PAGES: usize = 16;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoverBackfillItem {
    pub cache_kind: String,
    pub cache_entity_id: String,
    pub fetch_cover_art_id: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverBackfillBatchDto {
    pub items: Vec<CoverBackfillItem>,
    /// Entity ids only — compatibility shim for older callers.
    pub cover_ids: Vec<String>,
    pub next_cursor: Option<String>,
    pub exhausted: bool,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCoverProgressDto {
    pub total_distinct: i64,
    pub pending: i64,
    pub done: i64,
}

/// `kind`, entity `id`, and HTTP `getCoverArt` id (Navidrome `cover_art_id` or fallback to entity id).
///
/// The `artist` table is often empty (IS-4 only stores a watermark). Artists are also taken from
/// `track.artist_id` and `album.artist_id` so backfill matches library browse / prefetch.
const COVER_CATALOG_SUBQUERY: &str = "
    SELECT 'album' AS kind,
           TRIM(id) AS id,
           COALESCE(NULLIF(TRIM(cover_art_id), ''), TRIM(id)) AS fetch_id
    FROM album
    WHERE server_id = ?1 AND NULLIF(TRIM(id), '') IS NOT NULL
    UNION ALL
    SELECT 'album',
           TRIM(album_id),
           COALESCE(NULLIF(TRIM(cover_art_id), ''), TRIM(album_id))
    FROM track
    WHERE server_id = ?1 AND deleted = 0 AND NULLIF(TRIM(album_id), '') IS NOT NULL
    UNION ALL
    SELECT 'artist',
           TRIM(id),
           TRIM(id)
    FROM artist
    WHERE server_id = ?1 AND NULLIF(TRIM(id), '') IS NOT NULL
    UNION ALL
    SELECT 'artist',
           TRIM(artist_id),
           TRIM(artist_id)
    FROM track
    WHERE server_id = ?1 AND deleted = 0 AND NULLIF(TRIM(artist_id), '') IS NOT NULL
    UNION ALL
    SELECT 'artist',
           TRIM(artist_id),
           TRIM(artist_id)
    FROM album
    WHERE server_id = ?1 AND NULLIF(TRIM(artist_id), '') IS NOT NULL";

/// Composite catalog cursor: `{kind}\x1f{id}` — avoids skipping rows when ids collide across kinds.
const CURSOR_SEP: char = '\x1f';

fn format_catalog_cursor(kind: &str, id: &str) -> String {
    format!("{kind}{CURSOR_SEP}{id}")
}

fn parse_catalog_cursor(cursor: &str) -> (String, String) {
    if let Some((kind, id)) = cursor.split_once(CURSOR_SEP) {
        return (kind.to_string(), id.to_string());
    }
    // Legacy id-only cursors (pre composite): continue album scan by id.
    ("album".to_string(), cursor.to_string())
}

pub const COVER_FETCH_FAIL_MARKER: &str = ".fetch-failed";

/// Recent HTTP failure — skip in backfill cursor so slots go to fetchable album art.
fn dto_to_backfill_item(dto: CoverEntryDto) -> CoverBackfillItem {
    CoverBackfillItem {
        cache_kind: dto.cache_kind,
        cache_entity_id: dto.cache_entity_id,
        fetch_cover_art_id: dto.fetch_cover_art_id,
    }
}

/// Re-resolve catalog row through `cover_resolve` (multi-CD per-disc `mf-*` slots, …).
fn expand_backfill_items(
    store: &LibraryStore,
    library_server_id: &str,
    item: CoverBackfillItem,
) -> Result<Vec<CoverBackfillItem>, String> {
    match item.cache_kind.as_str() {
        "album" => Ok(cover_backfill_items_for_album(
            store,
            library_server_id,
            &item.cache_entity_id,
        )?
        .into_iter()
        .map(dto_to_backfill_item)
        .collect()),
        "artist" => Ok(resolve_artist_cover_entry(store, library_server_id, &item.cache_entity_id)?
            .into_iter()
            .map(dto_to_backfill_item)
            .collect()),
        _ => {
            let has_album_row: bool = store.with_read_conn(|conn| {
                conn.query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM album WHERE server_id = ?1 AND id = ?2
                     )",
                    rusqlite::params![library_server_id, item.cache_entity_id],
                    |row| row.get(0),
                )
            })?;
            if has_album_row {
                Ok(resolve_album_cover_entry(store, library_server_id, &item.cache_entity_id)?
                    .into_iter()
                    .map(dto_to_backfill_item)
                    .collect())
            } else {
                Ok(vec![item])
            }
        }
    }
}

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
    let server_dir = cover_cache_layout::cover_server_dir(cover_root, server_index_key);
    let mut cleared = 0u32;
    for kind in cover_cache_layout::SEGMENT_KINDS {
        let kind_dir = server_dir.join(kind);
        let Ok(entries) = std::fs::read_dir(&kind_dir) else {
            continue;
        };
        for ent in entries.flatten() {
            if !ent.path().is_dir() {
                continue;
            }
            let marker = ent.path().join(COVER_FETCH_FAIL_MARKER);
            if marker.is_file() && std::fs::remove_file(&marker).is_ok() {
                cleared += 1;
            }
        }
    }
    cleared
}

fn fetch_catalog_page(
    store: &LibraryStore,
    library_server_id: &str,
    after: &str,
    limit: i64,
) -> Result<Vec<CoverBackfillItem>, String> {
    store.with_read_conn(|conn| {
        let (after_kind, after_id) = parse_catalog_cursor(after);
        let sql = format!(
            "SELECT kind, id, fetch_id FROM (
                SELECT kind, id, MAX(fetch_id) AS fetch_id
                FROM ({COVER_CATALOG_SUBQUERY})
                GROUP BY kind, id
             )
             WHERE kind > ?2 OR (kind = ?2 AND id > ?3)
             ORDER BY kind ASC, id ASC
             LIMIT ?4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                rusqlite::params![library_server_id, after_kind, after_id, limit],
                |row| {
                let kind: String = row.get(0)?;
                let id: String = row.get(1)?;
                let fetch_id: String = row.get(2)?;
                Ok(CoverBackfillItem {
                    cache_kind: kind,
                    cache_entity_id: id.clone(),
                    fetch_cover_art_id: fetch_id,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|item| {
                !item.cache_entity_id.is_empty()
                    && !is_fetch_only_cover_id(&item.cache_entity_id)
            })
            .collect())
    })
}

/// All distinct cover catalog rows in ONE query (no cursor pagination, so the
/// expensive `GROUP BY` over the cover UNION runs once per pass instead of once
/// per page). Caller expands + disk-diffs the result.
pub fn fetch_all_catalog_rows(
    store: &LibraryStore,
    library_server_id: &str,
) -> Result<Vec<CoverBackfillItem>, String> {
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT kind, id, MAX(fetch_id) AS fetch_id
             FROM ({COVER_CATALOG_SUBQUERY})
             GROUP BY kind, id
             ORDER BY kind ASC, id ASC"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params![library_server_id], |row| {
                let kind: String = row.get(0)?;
                let id: String = row.get(1)?;
                let fetch_id: String = row.get(2)?;
                Ok(CoverBackfillItem {
                    cache_kind: kind,
                    cache_entity_id: id,
                    fetch_cover_art_id: fetch_id,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|item| {
                !item.cache_entity_id.is_empty() && !is_fetch_only_cover_id(&item.cache_entity_id)
            })
            .collect())
    })
}

/// One-pass on-disk snapshot of a server's cover bucket: which entities already
/// have the canonical tier, and which carry a recent `.fetch-failed` marker.
///
/// Built once per pass so the catalog diff is pure in-memory set math — no
/// per-row `stat` syscalls hammering the filesystem on every album/artist. Keys
/// are `(kind, sanitized_entity_id)` to match on-disk directory names.
#[derive(Debug, Default)]
pub struct CoverDiskSnapshot {
    present: HashSet<(String, String)>,
    failed: HashSet<(String, String)>,
}

impl CoverDiskSnapshot {
    fn key(kind: &str, entity_id: &str) -> (String, String) {
        (
            kind.to_string(),
            cover_cache_layout::sanitize_path_segment(entity_id),
        )
    }

    /// Canonical tier already on disk for this entity.
    pub fn is_cached(&self, kind: &str, entity_id: &str) -> bool {
        self.present.contains(&Self::key(kind, entity_id))
    }

    /// Recent `.fetch-failed` marker — skip so slots go to fetchable art.
    pub fn is_recently_failed(&self, kind: &str, entity_id: &str) -> bool {
        self.failed.contains(&Self::key(kind, entity_id))
    }
}

/// Walk the server's cover bucket once (`album/` and `artist/`) and record the
/// cached plus recently-failed entities. Cheap exactly when it matters most: an
/// empty cache yields an empty `read_dir`, so the heavy backfill diff costs zero
/// per-item `stat`s instead of one (or more) per catalog row.
pub fn snapshot_cover_disk(cover_root: &Path, server_index_key: &str) -> CoverDiskSnapshot {
    let server_dir = cover_cache_layout::cover_server_dir(cover_root, server_index_key);
    let mut snap = CoverDiskSnapshot::default();
    for kind in cover_cache_layout::SEGMENT_KINDS {
        let kind_dir = server_dir.join(kind);
        let Ok(entries) = std::fs::read_dir(&kind_dir) else {
            continue;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
                continue;
            };
            if !path.is_dir() {
                continue;
            }
            let key = (kind.to_string(), name);
            if cover_cache_layout::entity_dir_has_canonical_tier(&path) {
                snap.present.insert(key.clone());
            }
            if cover_fetch_recently_failed(&path) {
                snap.failed.insert(key);
            }
        }
    }
    snap
}

/// Diff catalog rows against a pre-built disk snapshot → the subset still needing
/// a download. No filesystem access here: the snapshot already captured disk
/// state once. Rows whose raw id is cached/failed are skipped without expanding;
/// the rest get `expand_backfill_items` (DB) to resolve multi-disc `mf-*` /
/// artist entities, which are then diffed against the same snapshot.
pub fn diff_missing_against_snapshot(
    store: &LibraryStore,
    library_server_id: &str,
    snapshot: &CoverDiskSnapshot,
    rows: Vec<CoverBackfillItem>,
) -> Result<Vec<CoverBackfillItem>, String> {
    let mut out = Vec::new();
    for row in rows {
        if snapshot.is_cached(&row.cache_kind, &row.cache_entity_id)
            || snapshot.is_recently_failed(&row.cache_kind, &row.cache_entity_id)
        {
            continue;
        }
        for normalized in expand_backfill_items(store, library_server_id, row)? {
            if normalized.cache_entity_id.is_empty() {
                continue;
            }
            if snapshot.is_cached(&normalized.cache_kind, &normalized.cache_entity_id)
                || snapshot.is_recently_failed(&normalized.cache_kind, &normalized.cache_entity_id)
            {
                continue;
            }
            out.push(normalized);
        }
    }
    Ok(out)
}

/// One-shot worklist of every cover target still missing its canonical tier:
/// DB catalog snapshot minus the on-disk snapshot. The worker streams the diff
/// in chunks against a shared snapshot; tests use this whole-catalog form.
pub fn collect_missing_cover_targets(
    store: &LibraryStore,
    library_server_id: &str,
    cover_root: &Path,
    server_index_key: &str,
) -> Result<Vec<CoverBackfillItem>, String> {
    let rows = fetch_all_catalog_rows(store, library_server_id)?;
    let snapshot = snapshot_cover_disk(cover_root, server_index_key);
    diff_missing_against_snapshot(store, library_server_id, &snapshot, rows)
}

pub fn count_distinct_cover_ids(store: &LibraryStore, library_server_id: &str) -> Result<i64, String> {
    store.with_read_conn(|conn| {
        let sql = format!(
            "SELECT COUNT(*) FROM (
                SELECT kind, id FROM ({COVER_CATALOG_SUBQUERY})
                GROUP BY kind, id
             )"
        );
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

fn cover_cache_dir(cover_root: &Path, server_index_key: &str, kind: &str, entity_id: &str) -> PathBuf {
    cover_cache_layout::cover_dir(cover_root, server_index_key, kind, entity_id)
}

pub fn cover_canonical_cached_on_disk(
    cover_root: &Path,
    server_index_key: &str,
    cache_kind: &str,
    cache_entity_id: &str,
) -> bool {
    let dir = cover_cache_dir(cover_root, server_index_key, cache_kind, cache_entity_id);
    tier_file_ready(&dir, LIBRARY_COVER_CANONICAL_TIER)
}

pub fn cover_ladder_cached_on_disk(
    cover_root: &Path,
    server_index_key: &str,
    cache_kind: &str,
    cache_entity_id: &str,
) -> bool {
    let dir = cover_cache_dir(cover_root, server_index_key, cache_kind, cache_entity_id);
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
        let page = fetch_catalog_page(store, library_server_id, &after, SCAN_PAGE)?;
        let page_len = page.len();
        if page.is_empty() {
            sql_exhausted = true;
            break;
        }
        for item in page {
            after = format_catalog_cursor(&item.cache_kind, &item.cache_entity_id);
            for normalized in expand_backfill_items(store, library_server_id, item)? {
                if cover_canonical_cached_on_disk(
                    cover_root,
                    server_index_key,
                    &normalized.cache_kind,
                    &normalized.cache_entity_id,
                ) || cover_fetch_recently_failed(&cover_cache_dir(
                    cover_root,
                    server_index_key,
                    &normalized.cache_kind,
                    &normalized.cache_entity_id,
                )) {
                    continue;
                }
                pending.push(normalized);
                if pending.len() >= want {
                    break;
                }
            }
            if pending.len() >= want {
                break;
            }
        }
        if (page_len as i64) < SCAN_PAGE {
            sql_exhausted = true;
            break;
        }
    }

    let cover_ids = pending
        .iter()
        .map(|i| i.cache_entity_id.clone())
        .collect();

    Ok(LibraryCoverBackfillBatchDto {
        items: pending,
        cover_ids,
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
        let page = fetch_catalog_page(store, library_server_id, &after, SCAN_PAGE)?;
        if page.is_empty() {
            break;
        }
        let page_len = page.len();
        for item in page {
            after = format_catalog_cursor(&item.cache_kind, &item.cache_entity_id);
            for normalized in expand_backfill_items(store, library_server_id, item)? {
                if !cover_canonical_cached_on_disk(
                    cover_root,
                    server_index_key,
                    &normalized.cache_kind,
                    &normalized.cache_entity_id,
                ) {
                    pending += 1;
                }
            }
        }
        if (page_len as i64) < SCAN_PAGE {
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
    fn backfill_includes_navidrome_bare_album_id() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "0DurV2S7arIOBQVEknOPWX", None);
        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            Path::new("/tmp/empty-cover-root"),
            "srv-host",
            None,
            Some(10),
        )
        .unwrap();
        assert_eq!(batch.cover_ids, vec!["0DurV2S7arIOBQVEknOPWX".to_string()]);
        assert_eq!(batch.items[0].cache_kind, "album");
        assert_eq!(batch.items[0].fetch_cover_art_id, "0DurV2S7arIOBQVEknOPWX");
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
    fn backfill_uses_stored_cover_art_id_for_fetch() {
        let store = LibraryStore::open_in_memory();
        seed_track(
            &store,
            "srv",
            "tr1",
            "ca78bec6a62f3cb0ff31b2682ba05410",
            Some("al-ca78bec6a62f3cb0ff31b2682ba05410_60fc987f"),
        );
        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            Path::new("/tmp/empty-cover-root"),
            "srv-host",
            None,
            Some(10),
        )
        .unwrap();
        assert_eq!(batch.items[0].cache_entity_id, "ca78bec6a62f3cb0ff31b2682ba05410");
        assert_eq!(
            batch.items[0].fetch_cover_art_id,
            "al-ca78bec6a62f3cb0ff31b2682ba05410_60fc987f"
        );
    }

    #[test]
    fn backfill_skips_when_canonical_800_exists() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "al-partial", None);
        let root = std::env::temp_dir().join("psysonic-cover-backfill-test");
        let host = "srv-host";
        let id_dir = cover_cache_layout::cover_dir(&root, host, "album", "al-partial");
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
    fn collect_missing_excludes_cached_includes_missing() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "al-have", None);
        seed_track(&store, "srv", "tr2", "al-need", None);
        let root = std::env::temp_dir().join("psysonic-missing-targets-test");
        let host = "srv-host";
        let have_dir = cover_cache_layout::cover_dir(&root, host, "album", "al-have");
        std::fs::create_dir_all(&have_dir).unwrap();
        std::fs::write(
            have_dir.join(format!("{LIBRARY_COVER_CANONICAL_TIER}.webp")),
            b"x",
        )
        .unwrap();

        let missing = collect_missing_cover_targets(&store, "srv", &root, host).unwrap();
        let ids: Vec<_> = missing.iter().map(|i| i.cache_entity_id.as_str()).collect();
        assert!(ids.contains(&"al-need"), "missing cover should be queued");
        assert!(!ids.contains(&"al-have"), "cached cover must be skipped");

        let _ = std::fs::remove_dir_all(root.join(host));
    }

    #[test]
    fn backfill_includes_per_disc_mf_when_discs_differ() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("seed_box", |conn| {
                conn.execute(
                    "INSERT INTO album (server_id, id, name, synced_at, raw_json)
                     VALUES ('srv', 'al-box', 'Box', 1, '{}')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number, duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES ('srv', 'tr1', 't', 'Box', 'al-box', 1, 200, 0, 1, '{}', 'mf-a')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, disc_number, duration_sec, deleted, synced_at, raw_json, cover_art_id
                    ) VALUES ('srv', 'tr2', 't', 'Box', 'al-box', 2, 200, 0, 1, '{}', 'mf-b')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            Path::new("/tmp/empty-cover-root"),
            "srv-host",
            None,
            Some(10),
        )
        .unwrap();
        let ids: Vec<_> = batch
            .items
            .iter()
            .map(|i| i.cache_entity_id.as_str())
            .collect();
        assert!(ids.contains(&"mf-a"));
        assert!(ids.contains(&"mf-b"));
    }

    #[test]
    fn backfill_includes_artists_from_track_without_artist_table() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("test_artist_track", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, artist_id, duration_sec, deleted, synced_at, raw_json
                    ) VALUES ('srv', 'tr1', 't', 'al', 'al-1', 'ar-from-track', 200, 0, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            Path::new("/tmp/empty-cover-root"),
            "srv-host",
            None,
            Some(10),
        )
        .unwrap();
        assert_eq!(batch.items.len(), 2);
        assert!(batch.items.iter().any(|i| i.cache_kind == "album" && i.cache_entity_id == "al-1"));
        assert!(
            batch
                .items
                .iter()
                .any(|i| i.cache_kind == "artist" && i.cache_entity_id == "ar-from-track")
        );
    }

    #[test]
    fn catalog_cursor_kind_then_id_orders_artists_after_albums() {
        let store = LibraryStore::open_in_memory();
        store
            .with_conn_mut("seed", |conn| {
                conn.execute(
                    "INSERT INTO track (
                      server_id, id, title, album, album_id, artist_id, duration_sec, deleted, synced_at, raw_json
                    ) VALUES ('srv', 'tr1', 't', 'al', 'al-z-last', 'ar-1', 200, 0, 1, '{}')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let batch = collect_cover_backfill_batch(
            &store,
            "srv",
            Path::new("/tmp/x"),
            "host",
            Some("album\x1fal-z-last"),
            Some(10),
        )
        .unwrap();
        assert_eq!(batch.items.len(), 1);
        assert_eq!(batch.items[0].cache_kind, "artist");
        assert_eq!(batch.items[0].cache_entity_id, "ar-1");
    }

    #[test]
    fn count_distinct_includes_albums_and_artists_not_mf() {
        let store = LibraryStore::open_in_memory();
        seed_track(&store, "srv", "tr1", "al-1", Some("mf-1"));
        store
            .with_conn_mut("test_artist", |conn| {
                conn.execute(
                    "INSERT INTO artist (server_id, id, name, synced_at, raw_json)
                     VALUES ('srv', 'ar-1', 'A', 1, '{}')",
                    [],
                )?;
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
        assert_eq!(n, 3); // al-1, al-2, ar-1 — mf-1 is not an entity id
    }
}

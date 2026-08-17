use super::*;

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
            let Some(name) = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string)
            else {
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
